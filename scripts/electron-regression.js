const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, Menu } = require('electron');

const project = path.resolve(__dirname, '..');
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-notch-electron-ui-'));
const evidenceDir = path.join(project, 'review', 'evidence');
const store = {
  focusMin: 25, breakMin: 5, launchAtLogin: false, trayIcon: true,
  sound: true, vignette: true, shortcut: 'Alt+Space', tasks: [], armedTaskId: null,
  stats: { sessions: 0, minutes: 0, day: 'test', daySessions: 0 },
};
const effects = { sessionCalls: [], notices: [], celebrations: [], capture: false, dragStarts:0, dragMoves:0, dragEnds:0, settingsWrites:[], ignoredMouse:[], focusInitiations:[] };
const acceptedSessions = new Set();
let cleaned = false;
let failNextTaskSave = false;
let failNextCompletion = false;
let failNextSetting = false;
let holdNextSetting = false;
let releaseHeldSetting = null;

app.setPath('userData', path.join(dataRoot, 'user-data'));
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

ipcMain.handle('settings-load', () => ({ ...store, tasks: store.tasks.map((task) => ({ ...task })) }));
ipcMain.handle('settings-save', async (_event, patch) => {
  effects.settingsWrites.push({ ...patch });
  if (holdNextSetting) {
    holdNextSetting = false;
    await new Promise((resolve) => { releaseHeldSetting = resolve; });
  }
  if (failNextSetting) { failNextSetting = false; throw new Error('Simulated settings save failure'); }
  Object.assign(store, patch);
  return { ...store };
});
ipcMain.handle('tasks-save', (_event, { tasks, armedTaskId }) => {
  if (failNextTaskSave) { failNextTaskSave = false; throw new Error('Simulated task save failure'); }
  store.tasks = tasks.map((task) => {
    const previous = store.tasks.find((saved) => saved.id === task.id);
    return { ...task, done: previous ? previous.done : task.done };
  });
  store.armedTaskId = armedTaskId;
  return { tasks: store.tasks.map((task) => ({ ...task })), armedTaskId };
});
ipcMain.handle('session-complete', (_event, data) => {
  effects.sessionCalls.push({ ...data });
  if (failNextCompletion) { failNextCompletion = false; throw new Error('Simulated completion save failure'); }
  const duplicate = acceptedSessions.has(data.sessionId);
  if (duplicate) return { duplicate: true, tasks: store.tasks, stats: store.stats };
  acceptedSessions.add(data.sessionId);
  if (data.mode === 'focus') {
    store.stats.sessions += 1;
    store.stats.minutes += data.minutes;
    store.stats.daySessions += 1;
    const task = store.tasks.find((item) => item.id === data.taskId);
    if (task) task.done += 1;
  }
  return { duplicate: false, tasks: store.tasks.map((task) => ({ ...task })), stats: { ...store.stats } };
});
ipcMain.handle('shortcut-capture', (_event, capturing) => { effects.capture = capturing; return { capturing, shortcut: store.shortcut }; });
for (const channel of ['set-ignore-mouse', 'set-tray-state', 'overlay-vignette', 'overlay-celebrate', 'notify', 'drag-start', 'drag-move', 'drag-end', 'overlay-focus-init', 'quit-app']) {
  ipcMain.on(channel, (_event, payload) => {
    if (channel === 'set-ignore-mouse') effects.ignoredMouse.push(payload);
    if (channel === 'overlay-celebrate') effects.celebrations.push(payload);
    if (channel === 'notify') effects.notices.push(payload);
    if (channel === 'drag-start') effects.dragStarts += 1;
    if (channel === 'drag-move') effects.dragMoves += 1;
    if (channel === 'drag-end') effects.dragEnds += 1;
    if (channel === 'overlay-focus-init') effects.focusInitiations.push(payload);
  });
}

const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
let win;
async function js(script) { try { return await win.webContents.executeJavaScript(script); } catch (error) { throw new Error(`executeJavaScript failed for ${script}: ${error.message}`, { cause:error }); } }
async function click(selector) {
  await js(`(() => { const target=document.querySelector(${JSON.stringify(selector)}); if (!target) throw new Error('Missing click target: '+${JSON.stringify(selector)}); if (target.disabled) throw new Error('Disabled click target: '+${JSON.stringify(selector)}); target.click(); })()`);
  await pause();
}
async function bounds(selector) {
  return js(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height} })()`);
}
async function realMouse(type, x, y) {
  win.webContents.sendInputEvent({ type, x:Math.round(x), y:Math.round(y), button:'left', clickCount:1 });
  await pause(35);
}
async function realClick(selector) {
  const r = await bounds(selector); const x = r.x + r.width / 2, y = r.y + r.height / 2;
  await realMouse('mouseDown', x, y); await realMouse('mouseUp', x, y); await pause();
}
async function realDrag(selector, dx, dy = 0, anchorX = .5, anchorY = .5) {
  const r = await bounds(selector); const x = r.x + r.width * anchorX, y = r.y + r.height * anchorY;
  await realMouse('mouseDown', x, y); await realMouse('mouseMove', x + dx, y + dy); await realMouse('mouseUp', x + dx, y + dy); await pause();
}
async function waitFor(script, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await js(script)) return;
    await pause(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function waitForMain(predicate, label, timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await pause(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function nativeCommand(cmd) { win.webContents.send('expand', true); win.webContents.send('cmd', cmd); }
async function screenshot(name) {
  await pause(450);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(evidenceDir, `${name}.png`), image.toPNG());
}
async function assertNoScroll(label) {
  const geometry = await js(`(() => ({scrollTop:document.scrollingElement.scrollTop,scrollLeft:document.scrollingElement.scrollLeft,islandTop:document.querySelector('#island').getBoundingClientRect().top,islandScroll:document.querySelector('#island').scrollTop}))()`);
  assert.deepEqual(geometry, { scrollTop: 0, scrollLeft: 0, islandTop: 0, islandScroll: 0 }, `${label} should not scroll the notch or document`);
}
async function pressSpace() {
  for (const type of ['keyDown', 'char', 'keyUp']) {
    win.webContents.sendInputEvent({ type, keyCode: 'Space', ...(type === 'char' ? { characters: ' ' } : {}) });
  }
  await pause(100);
}
async function enter() {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
  await pause(250);
}

async function run() {
  await app.whenReady();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]));
  fs.mkdirSync(evidenceDir, { recursive: true });
  win = new BrowserWindow({
    width: 420, height: 290, frame: false, transparent: true,
    show: true, backgroundColor: '#00000000',
    webPreferences: { preload: path.join(project, 'preload.js'), contextIsolation: true, backgroundThrottling: false },
  });
  win.setPosition(40, 40);
  win.webContents.on('render-process-gone', (_event, details) => console.error('Renderer exited', details));
  win.webContents.on('console-message', (_event, details) => { if (details.level >= 2) console.error('Renderer console error', details.message); });
  await win.loadFile(path.join(project, 'index.html'));
  await waitFor(`document.querySelector('#clockButton')?.textContent === '25:00' && document.querySelector('#island').classList.contains('expanded')`, 'initial timer boot');
  await waitFor(`document.querySelector('#viewTimer').classList.contains('active')`, 'timer screen');
  const fontStatus = await js(`document.fonts.load('400 13px Rinter').then(faces => ({loaded:faces.some(face => face.family === 'Rinter'), family:getComputedStyle(document.body).fontFamily, check:document.fonts.check('400 13px Rinter')}))`);
  assert.equal(fontStatus.loaded, true, `Rinter font face loaded: ${JSON.stringify(fontStatus)}`);
  assert.equal(fontStatus.check, true, 'Rinter is available to the timer UI');
  assert.match(fontStatus.family, /^Rinter/);
  await click('#timerAdd');
  await waitFor(`document.activeElement.id === 'newTaskTitle' && document.querySelector('#newTaskTitle').value === ''`, 'timer plus opens a fresh task draft');
  await click('[data-back="timer"]');
  await waitFor(`document.querySelector('#viewTimer').classList.contains('active')`, 'timer plus draft returns to timer');
  win.webContents.send('expand', false);
  await waitFor(`!document.querySelector('#island').classList.contains('expanded')`, 'boot collapse');
  await waitFor(`document.querySelector('#island').getBoundingClientRect().width === 196 && document.querySelector('#island').getBoundingClientRect().height === 32`, 'collapsed geometry settles');
  const initialBounds = await js(`(() => { const r=document.querySelector('#island').getBoundingClientRect(); return [r.width,r.height] })()`);
  assert.deepEqual(initialBounds, [196, 32]);
  assert.equal(await js(`getComputedStyle(document.querySelector("#viewTimer")).visibility`), "hidden", "Expanded timer controls must not show over the collapsed pill");
  assert.equal(store.focusMin, 25);
  assert.equal(store.breakMin, 5);
  assert.equal(store.stats.sessions, 0);
  await screenshot('timer-pill-ready');
  const dragBase = effects.dragStarts, verticalEnds = effects.dragEnds;
  await realDrag('#pill', 0, 18);
  await waitForMain(() => effects.dragStarts === dragBase + 1 && effects.dragEnds === verticalEnds + 1, 'vertical pill gesture is consumed as native drag');
  assert.equal(effects.dragStarts, dragBase + 1, 'vertical pill movement starts a native drag after the four-pixel threshold');
  assert.equal(await js(`document.querySelector('#island').classList.contains('expanded')`), false, 'vertical pill drag does not also activate its click');
  const dragStartsBefore = effects.dragStarts;
  const dragEndsBefore = effects.dragEnds;
  await realDrag('#pill', 30, 0);
  await waitForMain(() => effects.dragStarts === dragStartsBefore + 1, 'real horizontal pill drag starts');
  assert.equal(effects.dragStarts, dragStartsBefore + 1, 'horizontal pill movement begins one native drag');
  assert(effects.dragMoves > 0, 'horizontal pill movement sends native drag updates');
  assert.equal(effects.dragEnds, dragEndsBefore + 1, 'horizontal pill movement releases native drag');
  assert.equal(await js(`document.querySelector('#island').classList.contains('expanded')`), false, 'dragging the pill does not also activate its click');
  await realClick('#pill');
  assert.equal(await js(`document.querySelector('#island').classList.contains('expanded')`), true, 'a fresh native pill click immediately after dragging still expands');
  await pause(140);
  let storedFocusBeforeDrag = store.focusMin;
  let writesBeforeDrag = effects.settingsWrites.length;
  await js(`(() => { const target=document.querySelector('#clockButton'), mk=(type,x)=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:43,pointerType:'mouse',button:0,clientX:x,clientY:72}); target.dispatchEvent(mk('pointerdown',20)); window.dispatchEvent(mk('pointermove',26)); window.dispatchEvent(mk('pointercancel',26)); })()`);
  assert.equal(store.focusMin, storedFocusBeforeDrag, 'cancelled duration scrub does not persist');
  assert.equal(effects.settingsWrites.length, writesBeforeDrag, 'cancelled duration scrub issues no save');
  await js(`(() => { const target=document.querySelector('#clockButton'), mk=(type,x)=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:44,pointerType:'mouse',button:0,clientX:x,clientY:72}); target.dispatchEvent(mk('pointerdown',20)); document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true})); window.dispatchEvent(mk('pointerup',56)); })()`);
  assert.equal(store.focusMin, storedFocusBeforeDrag, 'Escape cancels an active scrub without writing');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
  await click('#pill');
  failNextSetting = true;
  await js(`(() => { const target=document.querySelector('#clockButton'), mk=(type,x)=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:46,pointerType:'mouse',button:0,clientX:x,clientY:72}); target.dispatchEvent(mk('pointerdown',20)); window.dispatchEvent(mk('pointermove',56)); window.dispatchEvent(mk('pointerup',56)); })()`);
  await waitFor(`document.querySelector('#notice').textContent.includes('Simulated settings save failure')`, 'duration scrub save failure');
  assert.equal(store.focusMin, 25, 'failed scrub retains last accepted duration');
  assert.equal(await js(`document.querySelector('#clockButton').textContent`), '25:00', 'failed scrub restores the accepted number');
  await js(`document.querySelector('#notice').hidden=true`);
  writesBeforeDrag = effects.settingsWrites.length;
  await realDrag('#clockButton', 36);
  await waitForMain(() => store.focusMin === 31, 'real pointer duration scrub persists once');
  assert(effects.ignoredMouse.includes(false), 'click-through is disabled during pointer capture');
  await waitFor(`!document.querySelector('#durationInput')`, 'scrub release does not open inline editor');
  await realClick('#clockButton');
  await waitFor(`document.querySelector('#durationInput')`, 'fresh native click immediately after scrub enters edit');
  await js(`document.querySelector('#durationInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
  assert.equal(effects.settingsWrites.length, writesBeforeDrag + 1, 'duration scrub sends one settings save and blocks competing edits');
  const dragStartsBeforeNumber = effects.dragStarts;
  await js(`(() => { const target=document.querySelector('#clockButton'), mk=(type,x)=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:45,pointerType:'mouse',button:0,clientX:x,clientY:72}); target.dispatchEvent(mk('pointerdown',56)); window.dispatchEvent(mk('pointermove',20)); window.dispatchEvent(mk('pointerup',20)); })()`);
  await waitForMain(() => store.focusMin === 25, 'duration scrub returns to accepted timer');
  assert.equal(effects.dragStarts, dragStartsBeforeNumber, 'duration scrub never invokes native notch dragging');
  const clampMoves = async (id, from, to) => {
    await js(`(() => { const target=document.querySelector('#clockButton'), mk=(type,x)=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:${id},pointerType:'mouse',button:0,clientX:x,clientY:72}); target.dispatchEvent(mk('pointerdown',${from})); window.dispatchEvent(mk('pointermove',${to})); window.dispatchEvent(mk('pointerup',${to})); })()`);
  };
  await clampMoves(47, 20, 1020); await waitForMain(() => store.focusMin === 90, 'duration scrub clamps to 90');
  await clampMoves(48, 1020, 20); await waitForMain(() => store.focusMin === 1, 'duration scrub clamps to 1');
  await clampMoves(49, 20, 164); await waitForMain(() => store.focusMin === 25, 'duration scrub returns to base');
  holdNextSetting = true;
  await realDrag('#clockButton', 12);
  await waitForMain(() => Boolean(releaseHeldSetting), 'held scrub setting save');
  assert.equal(await js(`document.querySelector('#clockButton').textContent`), '27:00', 'held save keeps the scrub preview visible');
  const callsBeforeHeldStart = effects.sessionCalls.length;
  nativeCommand('start-focus');
  await pause(180);
  assert.equal(await js(`document.querySelector('#island').classList.contains('running')`), false, 'start is ignored while a duration scrub save is pending');
  assert.equal(effects.sessionCalls.length, callsBeforeHeldStart);
  releaseHeldSetting(); releaseHeldSetting = null;
  await waitForMain(() => store.focusMin === 27, 'held scrub accepted');
  await clampMoves(50, 20, 8); await waitForMain(() => store.focusMin === 25, 'restore accepted test duration');
  await js(`document.querySelector('#openMenu').click()`);
  await waitFor(`document.querySelector('#viewSettings').classList.contains('active')`, 'dots direct settings');
  await js(`document.querySelector('[data-back="timer"]').click()`);
  win.webContents.send('navigate', 'create');
  await waitFor(`document.activeElement.id === 'newTaskTitle'`, 'collapsed native create route');
  await assertNoScroll('collapsed create focus');
  win.webContents.send('expand', false);
  await pause(450);
  win.webContents.send('expand', true);
  await waitFor(`document.querySelector('#island').classList.contains('expanded')`, 'timer expansion before immediate duration edit');
  await click('#clockButton');
  await assertNoScroll('immediate duration edit after collapse');
  await js(`document.querySelector('#durationInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
  await waitFor(`!document.querySelector('#durationInput')`, 'cancel immediate duration edit');
  win.webContents.send('expand', false);
  await pause(450);
  win.webContents.send('navigate', 'shortcut');
  await waitForMain(() => effects.capture, 'shortcut capture from collapsed native route');
  await assertNoScroll('collapsed shortcut capture');
  await js(`document.querySelector('#shortcutField').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
  await waitForMain(() => !effects.capture, 'cancel collapsed shortcut capture');
  win.webContents.send('expand', false);
  await pause(450);
  await click('#pill');
  await assertNoScroll('timer expand after create focus');
  await pause(450);
  assert.deepEqual(await js(`(() => { const r=document.querySelector('#island').getBoundingClientRect(); return [Math.round(r.width),Math.round(r.height)] })()`), [312, 103]);
  await screenshot('timer-ready');

  await click('#openMenu');
  await waitFor(`document.querySelector('#viewSettings').classList.contains('active')`, 'dots open settings directly');
  assert.equal(await js(`!document.querySelector('#viewMenu')`), true, 'intermediary menu screen was removed');
  const settingsBounds = await js(`(() => { const r=document.querySelector('#island').getBoundingClientRect(); return [Math.round(r.width),Math.round(r.height)] })()`);
  assert.deepEqual(settingsBounds, [332, 250], 'settings opens at its final screen size');
  const settingsDragStarts = effects.dragStarts, settingsDragEnds = effects.dragEnds;
  await realDrag('#island', 22, 0, .5, .04);
  await waitForMain(() => effects.dragStarts === settingsDragStarts + 1 && effects.dragEnds === settingsDragEnds + 1, 'expanded settings canopy drag');
  assert.equal(effects.dragStarts, settingsDragStarts + 1, 'empty top canopy on Settings begins native window drag');
  await screenshot('settings-direct');
  await click('[data-back="timer"]');
  await click('#timerTask');
  assert.equal(await js(`getComputedStyle(document.querySelector('#emptyTasks')).display !== 'none'`), true);
  assert.equal(await js(`getComputedStyle(document.querySelector('#taskAdd')).display === 'none'`), true);
  await screenshot('tasks-empty');
  await click('#emptyAdd');
  await waitFor(`document.activeElement.id === 'newTaskTitle'`, 'task title focus');
  await screenshot('task-create');
  await js(`(() => { const input=document.querySelector('#newTaskTitle'); input.value='Write a test'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  failNextTaskSave = true;
  await click('#addTask');
  await waitFor(`document.querySelector('#notice').textContent.includes('Simulated task save failure')`, 'task save failure');
  assert.equal(await js(`document.querySelector('#viewCreate').classList.contains('active')`), true);
  assert.equal(await js(`document.querySelector('#newTaskTitle').value`), 'Write a test');
  assert.equal(store.tasks.length, 0, 'failed task write is not persisted');
  await click('#addTask');
  await waitFor(`document.querySelector('#timerTask').textContent === 'Write a test'`, 'saved task selection');
  assert.equal(store.tasks.length, 1);
  const firstTaskId = store.armedTaskId;

  await click('#clockButton');
  await assertNoScroll('duration editor focus');
  assert.equal(await js(`document.querySelector('#durationInput').classList.contains('clock')`), false);
  const editorBounds = await js(`(() => { const island=document.querySelector('#island').getBoundingClientRect(),r=document.querySelector('#durationInput').getBoundingClientRect(); return [r.left-island.left,r.top-island.top,r.right-island.left,r.bottom-island.top] })()`);
  assert(editorBounds[0] >= 12 && editorBounds[2] < 160 && editorBounds[3] <= 103, `duration editor bounds: ${editorBounds}`);
  await screenshot('duration-edit');
  await js(`(() => { const input=document.querySelector('#durationInput'); input.value='24'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await enter();
  await waitFor(`document.querySelector('#clockButton')?.textContent === '24:00'`, 'duration commit');
  await js(`document.querySelector('#clockSlot').dispatchEvent(new WheelEvent('wheel',{deltaY:-1,bubbles:true,cancelable:true}))`);
  await waitFor(`document.querySelector('#clockButton')?.textContent === '25:00'`, 'wheel duration increment');

  const initialFocusSignals = effects.focusInitiations.length;
  await js(`document.querySelector('#playButton').focus({preventScroll:true})`);
  await pressSpace();
  await waitFor(`document.querySelector('#island').classList.contains('running') && !document.querySelector('#island').classList.contains('expanded')`, 'running pill');
  await waitForMain(() => effects.focusInitiations.length === initialFocusSignals + 1, 'new focus start effect');
  const firstFocusEffectId = effects.focusInitiations.at(-1);
  assert.match(firstFocusEffectId, /^[0-9a-f-]{36}$/i, 'focus start carries its session ID');
  assert.equal(await js(`document.querySelector('#playButton').title`), 'Pause timer', 'focused primary Space starts exactly once');
  assert.equal(await js(`[...document.querySelectorAll('.view')].every(v=>v.inert && v.getAttribute('aria-hidden')==='true')`), true, 'collapsed views are inert');
  await screenshot('timer-running-pill');
  await click('#pill');
  await click('#timerAdd');
  await waitFor(`document.activeElement.id === 'newTaskTitle'`, 'second task title focus');
  await js(`(() => { const input=document.querySelector('#newTaskTitle'); input.value='Plan'; input.dispatchEvent(new Event('input',{bubbles:true})); input.focus(); })()`);
  await pressSpace();
  assert.equal(await js(`document.querySelector('#newTaskTitle').value`), 'Plan ');
  win.focus(); win.webContents.focus();
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'A', modifiers: ['meta'] });
  await pause(100);
  let selectedTitleRange = await js(`(() => { const i=document.querySelector('#newTaskTitle'); return [i.selectionStart,i.selectionEnd,i.value.length] })()`);
  if (selectedTitleRange[0] !== 0 || selectedTitleRange[1] !== selectedTitleRange[2]) {
    win.webContents.selectAll();
    await pause(100);
    selectedTitleRange = await js(`(() => { const i=document.querySelector('#newTaskTitle'); return [i.selectionStart,i.selectionEnd,i.value.length] })()`);
    if (selectedTitleRange[0] === 0 && selectedTitleRange[1] === selectedTitleRange[2]) console.warn('Cmd+A key synthesis was not delivered to macOS menu accelerators; verified focused Edit > Select All command instead.');
  }
  assert.deepEqual(selectedTitleRange, [0, 5, 5], 'Edit > Select All selects the editable task title');
  win.webContents.insertText('Plan next session');
  await pause(100);
  assert.equal(await js(`document.querySelector('#newTaskTitle').value`), 'Plan next session', 'native text input replaces selected task title');
  await screenshot('task-create-running');
  await click('#addTask');
  await waitFor(`document.querySelector('#viewTimer').classList.contains('active') && document.querySelector('#island').classList.contains('running')`, 'running task creation return');
  assert.equal(store.tasks.length, 2);
  assert.equal(store.armedTaskId, firstTaskId, 'creation during a run preserves the armed task');
  assert.equal(await js(`document.querySelector('#timerTask').textContent`), 'Write a test');
  const addedTaskId = store.tasks.find((task) => task.title === 'Plan next session')?.id;
  assert(addedTaskId, 'Space key was inserted into the task title');
  await screenshot('timer-running-expanded');
  await js(`document.querySelector('#playButton').focus({preventScroll:true})`);
  await pressSpace();
  await waitFor(`!document.querySelector('#island').classList.contains('running')`, 'pause session');
  await waitForMain(() => effects.focusInitiations.at(-1) === null, 'pause cancels focus start effect');
  const pausedTime = await js(`document.querySelector('#clockButton').textContent`);
  await pause(1200);
  assert.equal(await js(`document.querySelector('#clockButton').textContent`), pausedTime, 'paused countdown stays fixed');
  await click('#playButton');
  await waitFor(`document.querySelector('#island').classList.contains('running')`, 'resume same session');
  assert.equal(effects.focusInitiations.filter(Boolean).length, initialFocusSignals + 1, 'resume does not retrigger the focus start effect');
  await click('#playButton');
  await waitFor(`!document.querySelector('#island').classList.contains('running')`, 'pause resumed session');
  await click('#resetButton');
  await waitForMain(() => effects.focusInitiations.at(-1) === null, 'reset cancels focus start effect');
  await waitFor(`document.querySelector('#clockButton').textContent === '25:00'`, 'reset restores current focus length');
  await click('.mode[data-mode="break"]');
  await click('.mode[data-mode="focus"]');
  await waitForMain(() => effects.focusInitiations.at(-1) === null, 'mode changes cancel focus start effect');
  assert.equal(effects.sessionCalls.length, 0, 'pause/resume/reset does not count a completion');
  await click('#timerTask');
  failNextTaskSave = true;
  await click(`.task-row[aria-label^="Plan next session"]`);
  await waitFor(`document.querySelector('#notice').textContent.includes('Simulated task save failure')`, 'failed task selection');
  assert.equal(await js(`document.querySelector('#viewTasks').classList.contains('active')`), true, 'failed task selection stays on task list');
  assert.equal(store.armedTaskId, firstTaskId, 'failed task selection preserves armed task');
  await click(`.task-row[aria-label^="Plan next session"]`);
  await waitFor(`document.querySelector('#timerTask').textContent === 'Plan next session'`, 'task selection');
  assert.equal(store.armedTaskId, addedTaskId);

  await click('#clockButton');
  await js(`(() => { const input=document.querySelector('#durationInput'); input.value='1'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await enter();
  await waitFor(`document.querySelector('#clockButton')?.textContent === '01:00'`, 'one-minute timer setting');
  const focusEffectsBeforeResetStart = effects.focusInitiations.filter(Boolean).length;
  await click('#playButton');
  await waitFor(`document.querySelector('#island').classList.contains('running')`, 'start selected task');
  await waitForMain(() => effects.focusInitiations.filter(Boolean).length === focusEffectsBeforeResetStart + 1, 'reset creates a fresh focus start effect');
  assert.notEqual(effects.focusInitiations.filter(Boolean).at(-1), firstFocusEffectId, 'reset and restart use a new focus session ID');
  nativeCommand('toggle');
  await waitFor(`document.querySelector('#island').classList.contains('expanded')`, 'native menu command expands timer');
  await click('#openMenu');
  failNextSetting = true;
  await click('[data-setting-toggle="launchAtLogin"]');
  await waitFor(`document.querySelector('#notice').textContent.includes('Simulated settings save failure')`, 'settings failure status');
  assert.equal(await js(`document.querySelector('[data-setting-toggle="launchAtLogin"]').getAttribute('aria-pressed')`), 'false', 'failed preference remains unchanged');
  await screenshot('settings');
  holdNextSetting = true;
  await click('[data-setting-step="focusMin"][data-delta="5"]');
  await waitForMain(() => Boolean(releaseHeldSetting), 'held settings write');
  win.webContents.send('cmd', 'start-focus');
  await waitFor(`document.querySelector('#island').classList.contains('running')`, 'start during pending duration write');
  failNextSetting = true;
  releaseHeldSetting();
  releaseHeldSetting = null;
  await waitFor(`document.querySelector('#notice').textContent.includes('Simulated settings save failure')`, 'duration write rejection');
  assert.equal(await js(`document.querySelector('#focusValue').textContent`), '1m');
  await click('#pill');
  await click('#timerAdd');
  await waitFor(`document.activeElement.id === 'newTaskTitle'`, 'running task-create screen');
  assert.equal(await js(`document.querySelector('#island').classList.contains('running')`), true);
  await js(`(() => { const input=document.querySelector('#newTaskTitle'); input.value='Another'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click('#addTask');
  await waitFor(`document.querySelector('#viewTimer').classList.contains('active')`, 'create returns to timer during run');
  assert.equal(store.armedTaskId, addedTaskId);
  assert.equal(await js(`document.querySelector('#timerTask').textContent`), 'Plan next session');
  await screenshot('running-task-preserved');
  await click('#openMenu');
  await click('[data-setting-step="focusMin"][data-delta="5"]');
  await waitFor(`document.querySelector('#focusValue').textContent === '6m'`, 'accepted setting change during active session');
  await js(`window.__fakeNow=Date.now();window.__realDateNow=Date.now.bind(Date);Date.now=()=>window.__fakeNow;window.__fakeNow+=61000`);
  const focusEffectsBeforeNaturalEnd = effects.focusInitiations.filter(Boolean).length;
  await waitFor(`document.querySelector('#island').classList.contains('completed')`, 'natural focus completion');
  await waitForMain(() => effects.focusInitiations.at(-1) === null, 'natural focus completion cancels the start effect');
  await waitForMain(() => effects.sessionCalls.some((call) => call.mode === 'focus'), 'natural focus completion write');
  assert.equal(effects.sessionCalls.find((call) => call.mode === 'focus').minutes, 1, 'natural completion records the session-start duration snapshot');
  assert.equal(store.stats.sessions, 1);
  assert.equal(store.stats.minutes, 1);
  assert.equal(store.tasks.find((task) => task.id === addedTaskId).done, 1);
  await screenshot('focus-complete-natural');
  await click('#playButton');
  await waitFor(`document.querySelector('#island').classList.contains('break-mode') && document.querySelector('#island').classList.contains('running')`, 'completion action starts next break immediately');
  assert.equal(effects.focusInitiations.filter(Boolean).length, focusEffectsBeforeNaturalEnd, 'break sessions do not trigger the focus start effect');
  const beforeBreakStats = { ...store.stats };
  assert.equal(await js(`document.querySelector('#playButton').title`), 'Pause timer', 'completion action begins one break session');
  await screenshot('break-running');
  await js(`window.__fakeNow=Date.now();window.__realDateNow=Date.now.bind(Date);Date.now=()=>window.__fakeNow;window.__fakeNow+=301000`);
  await waitFor(`document.querySelector('#island').classList.contains('completed')`, 'natural break completion');
  await waitForMain(() => effects.sessionCalls.some((call) => call.mode === 'break'), 'break completion write');
  assert.deepEqual(store.stats, beforeBreakStats, 'break completion does not increment focus stats');
  await screenshot('break-complete');
  const focusEffectsBeforeBreakEnd = effects.focusInitiations.filter(Boolean).length;
  await click('#playButton');
  await waitFor(`!document.querySelector('#island').classList.contains('break-mode') && document.querySelector('#island').classList.contains('running')`, 'break completion action starts focus immediately');
  await waitForMain(() => effects.focusInitiations.filter(Boolean).length === focusEffectsBeforeBreakEnd + 1, 'explicit next focus starts a new effect');
  await click('#playButton');
  await waitFor(`!document.querySelector('#island').classList.contains('running')`, 'pause next focus before retry fixture');
  await click('#resetButton');
  await click('#clockButton');
  await js(`(() => { const input=document.querySelector('#durationInput'); input.value='1'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await js(`document.querySelector('#durationInput').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true,cancelable:true}))`);
  await waitForMain(() => store.focusMin === 1, 'one-minute duration save for retry test');
  await waitFor(`document.querySelector('#clockButton')?.textContent === '01:00'`, 'one-minute focus for retry test');
  await click('#playButton');
  await waitFor(`document.querySelector('#island').classList.contains('running')`, 'start focus for retry failure');
  failNextCompletion = true;
  const statsBeforeRetry = { ...store.stats };
  const celebrationsBeforeRetry = effects.celebrations.length;
  const focusStartsBeforeFailedCompletion = effects.focusInitiations.filter(Boolean).length;
  await click('#resetButton');
  await waitFor(`document.querySelector('#notice').textContent.includes('Could not save session')`, 'completion save failure');
  assert.equal(await js(`document.querySelector('#island').classList.contains('completed')`), true, 'failed completion remains available for retry');
  assert.equal(effects.focusInitiations.filter(Boolean).length, focusStartsBeforeFailedCompletion, 'finishing a session does not start another focus effect');
  const failedCall = effects.sessionCalls.at(-1);
  assert.equal(failedCall.minutes, 0, 'early finish records actual elapsed whole minutes');
  nativeCommand('start-break');
  await pause(200);
  assert.equal(await js(`document.querySelector('#island').classList.contains('completed')`), true, 'native mode action cannot discard an unsaved completion');
  assert.equal(effects.celebrations.length, celebrationsBeforeRetry, 'failed completion emits no celebration');
  await screenshot('focus-completion-retry');
  await click('#playButton');
  await waitFor(`!document.querySelector('#notice').textContent.includes('Could not save session') && document.querySelector('#playButton').title === 'Start break'`, 'completion retry success stays in completion');
  assert.equal(effects.sessionCalls.at(-1).sessionId, failedCall.sessionId, 'retry reuses one stable completion id');
  assert.equal(effects.focusInitiations.filter(Boolean).length, focusStartsBeforeFailedCompletion, 'retry does not replay the focus start effect');
  assert.equal(store.stats.sessions, statsBeforeRetry.sessions + 1);
  assert.equal(store.stats.minutes, statsBeforeRetry.minutes);
  assert.equal(store.tasks.find((task) => task.id === addedTaskId).done, 2);
  assert.equal(effects.celebrations.length, celebrationsBeforeRetry + 1);
  assert.equal(effects.notices.length, effects.celebrations.length);
  await screenshot('focus-complete');
  await click('#playButton');
  await waitFor(`document.querySelector('#island').classList.contains('break-mode') && document.querySelector('#island').classList.contains('running')`, 'retry follow-up action starts break');
  const breakColor = await js(`getComputedStyle(document.querySelector('#clockButton')).color`);
  assert.notEqual(breakColor, 'rgb(244, 244, 246)', 'break numeral uses green accent');
  await screenshot('break-ready');

  await click('#openMenu');
  await click('#shortcutValue');
  await waitForMain(() => effects.capture, 'native shortcut capture suspension');
  await assertNoScroll('shortcut capture focus');
  await screenshot('shortcut-capture');
  await js(`document.querySelector('#shortcutField').dispatchEvent(new KeyboardEvent('keydown',{key:'∆',code:'KeyJ',altKey:true,bubbles:true,cancelable:true}))`);
  assert.equal(await js(`document.querySelector('#shortcutField').textContent`), '⌥ J', 'shortcut maps physical code rather than Option-produced glyph');
  await js(`document.querySelector('#shortcutField').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))`);
  await waitForMain(() => !effects.capture, 'capture cancel restores native shortcut');
  await waitFor(`document.querySelector('#viewSettings').classList.contains('active')`, 'settings after capture cancel');

  if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const toggleSelector = '[data-setting-toggle="trayIcon"]';
  if (await js(`document.querySelector(${JSON.stringify(toggleSelector)}).getAttribute('aria-pressed') !== 'true'`)) await click(toggleSelector);
  const reduced = await js(`(() => { const b=document.querySelector(${JSON.stringify(toggleSelector)}); return { on:b.getAttribute('aria-pressed'), x:getComputedStyle(b,'::before').transform, island:getComputedStyle(document.querySelector('#island')).transitionDuration } })()`);
  assert.equal(reduced.on, 'true');
  assert.match(reduced.x, /matrix\(1,\s*0,\s*0,\s*1,\s*12,\s*0\)/, `checked toggle remains in its on position under reduced motion (${reduced.x})`);
  assert.equal(reduced.island, '0s', 'reduced motion removes notch morph movement');

  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });

  await click('[data-back="timer"]');
  if (await js(`document.querySelector('#island').classList.contains('running')`)) { await click('#playButton'); await waitFor(`!document.querySelector('#island').classList.contains('running')`, 'pause before long-title task fixture'); }
  await click('.mode[data-mode="focus"]');
  await click('#timerTask');
  await click('#taskAdd');
  await js(`(() => { const input=document.querySelector('#newTaskTitle'); input.value='A'.repeat(120); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await click('#addTask');
  await waitFor(`document.querySelector('#timerTask').textContent.length === 120`, 'long title task creation');
  store.tasks.push(...Array.from({ length: 12 }, (_, index) => ({ id: `overflow-${index}`, title: `Overflow task ${index + 1}`, estimate: 3, done: 0, archived: false })));
  await win.webContents.reload();
  await waitFor(`document.querySelector('#clockButton')?.textContent === '01:00'`, 'reload restores accepted timer preference');
  assert.equal(await js(`document.querySelector('#timerTask').textContent`), 'A'.repeat(120), 'reload restores armed task and long title');
  await click('#timerTask');
  const listGeometry = await js(`(() => ({scrollHeight:document.querySelector('#taskList').scrollHeight,clientHeight:document.querySelector('#taskList').clientHeight,longTitleStyle:getComputedStyle([...document.querySelectorAll('.task-row')].find(r=>r.getAttribute('aria-label').startsWith('A'.repeat(20))).querySelector('.row-title')).textOverflow,rowCount:document.querySelectorAll('.task-row').length}))()`);
  assert(listGeometry.scrollHeight > listGeometry.clientHeight, 'task list scrolls when it overflows');
  assert.equal(listGeometry.longTitleStyle, 'ellipsis');
  assert.equal(listGeometry.rowCount, 16, 'tasks persist and render after reload');

  console.log(`Electron DOM regression passed. Screenshots: ${evidenceDir}; isolated userData: ${path.join(dataRoot, 'user-data')}`);
}

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (win && !win.isDestroyed()) win.destroy();
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

run().then(() => app.quit(), (error) => {
  console.error(error.stack || error);
  cleanup();
  app.exit(1);
});
app.on('will-quit', cleanup);
