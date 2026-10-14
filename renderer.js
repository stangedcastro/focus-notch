const ICON = {
  play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z"/></svg>',
  reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5.2 5.2L20 7"/></svg>',
};
const MINUTE = 60;
const SIZE_KEYS = ['short', 'medium', 'long'];
const DEFAULT_PRESETS = {
  focus: { short: 15, medium: 30, long: 60 },
  break: { short: 5, medium: 10, long: 15 },
};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const fmt = (seconds) => {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};
const $ = (selector) => document.querySelector(selector);
const normalizeSize = (value, fallback = 'medium') => (SIZE_KEYS.includes(value) ? value : fallback);
const normalizePresets = (raw) => ({
  focus: { ...DEFAULT_PRESETS.focus, ...(raw?.focus || {}) },
  break: { ...DEFAULT_PRESETS.break, ...(raw?.break || {}) },
});
const sizeLabel = (size) => ({ short: 'S', medium: 'M', long: 'L' }[size] || 'M');

const island = $('#island');
const pill = $('#pill');
const pillName = $('#pillName');
const pillTime = $('#pillTime');
const timerTask = $('#timerTask');
const clockSlot = $('#clockSlot');
const timerNote = $('#timerNote');
const playButton = $('#playButton');
const resetButton = $('#resetButton');
const notice = $('#notice');
const views = {
  timer: $('#viewTimer'), tasks: $('#viewTasks'),
  create: $('#viewCreate'), settings: $('#viewSettings'), shortcut: $('#viewShortcut'),
};

let settings = {
  focusMin: 30, breakMin: 5, focusSize: 'medium', breakSize: 'short',
  presets: normalizePresets(DEFAULT_PRESETS),
  launchAtLogin: false, trayIcon: true, sound: true, vignette: true, shortcut: 'Alt+Space',
};
let tasks = [];
let armedTaskId = null;
let stats = { sessions: 0, minutes: 0, day: '', daySessions: 0 };
let state = {
  screen: 'timer', expanded: true, mode: 'focus', remaining: 1800, running: false,
  deadline: 0, sessionId: null, sessionTaskId: null, sessionDurationMinutes: 30, startedAt: 0,
  completion: null, completionSaved: true, completionBusy: false,
  durationEditing: false, durationDraft: '', createSize: 'medium', createDraft: '',
  shortcutCapture: false, shortcutCandidate: '', shortcutPrevious: '',
};
let settingsQueue = Promise.resolve();
let taskQueue = Promise.resolve();
const pendingSettings = {};
let finishingKey = null;
let mouseIgnored = true;
let taskWriteBusy = false;
let completionEffectsSent = false;
let shortcutCaptureRequest = 0;
let durationDrag = null;
let durationDragBusy = false;
let windowDrag = null;
let lastPointerPosition = { x:0, y:0 };

function activeTasks() { return tasks.filter((task) => !task.archived); }
function selectedTask() { return tasks.find((task) => task.id === armedTaskId && !task.archived) || null; }
function durationSeconds(mode = state.mode) { return settings[mode === 'focus' ? 'focusMin' : 'breakMin'] * MINUTE; }
function currentRemaining() { return state.running ? Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000)) : state.remaining; }
function exactRemaining() { return state.running ? Math.max(0, (state.deadline - Date.now()) / 1000) : state.remaining; }
function showNotice(message, error = false) {
  notice.textContent = message || '';
  notice.title = message || '';
  notice.hidden = !message;
  notice.classList.toggle('error', error);
}
function activeControlEditable() {
  const el = document.activeElement;
  return !!el && (el.matches('input,textarea,select,[contenteditable="true"]') || el.closest('[contenteditable="true"]'));
}
function screenBusy() { return state.completionBusy; }
function modeCue() {
  if (state.completion) return state.completion === 'focus' ? 'Session complete' : 'Back to focus';
  if (state.mode === 'break') return 'Take a break';
  return selectedTask()?.title || 'Choose a task';
}
function taskSummary(task) {
  return `${task.done} / ${task.estimate}`;
}
function formatShortcut(value) {
  return String(value || '').split('+').map((part) => ({
    Alt: '⌥', Option: '⌥', Ctrl: '⌃', Control: '⌃', Command: '⌘', Cmd: '⌘',
    CommandOrControl: navigator.platform.includes('Mac') ? '⌘' : 'Ctrl',
    CmdOrCtrl: navigator.platform.includes('Mac') ? '⌘' : 'Ctrl',
    Shift: '⇧', Space: 'Space', Enter: '↩', Escape: 'Esc', Backspace: '⌫', Delete: '⌦',
  }[part] || part)).join(' ');
}

function setExpanded(expanded) {
  state.expanded = !!expanded;
  island.classList.toggle('expanded', state.expanded);
  if (!state.expanded) {
    if (state.shortcutCapture) stopShortcutCapture(false);
    state.screen = 'timer';
    Object.entries(views).forEach(([name, element]) => element.classList.toggle('active', name === 'timer'));
    island.style.setProperty('--view-w', '312px');
    island.style.setProperty('--view-h', '103px');
  }
  render();
}

function setScreen(screen) {
  if (!views[screen]) return;
  if (state.shortcutCapture && screen !== 'shortcut') stopShortcutCapture(false);
  state.screen = screen;
  state.expanded = true;
  island.classList.add('expanded');
  Object.entries(views).forEach(([name, element]) => element.classList.toggle('active', name === screen));
  island.style.setProperty('--view-w', screen === 'timer' ? '312px' : '332px');
  island.style.setProperty('--view-h', screen === 'timer' ? '103px' : screen === 'settings' ? '280px' : '250px');
  render();
  if (screen === 'shortcut') startShortcutCapture();
  else if (screen === 'create') $('#newTaskTitle').focus({ preventScroll: true });
}

function cancelFocusInitiation() { window.notch.initiateFocus?.(null); }

function setMode(mode) {
  if (!['focus', 'break'].includes(mode) || state.running || state.completionBusy || (state.completion && !state.completionSaved)) return;
  if (mode === state.mode && !state.completion) return;
  cancelFocusInitiation();
  state.mode = mode;
  state.completion = null;
  state.completionSaved = true;
  state.remaining = durationSeconds();
  state.sessionId = null;
  state.sessionTaskId = null;
  state.sessionDurationMinutes = settings[mode === 'focus' ? 'focusMin' : 'breakMin'];
  state.startedAt = 0;
  state.durationEditing = false;
  completionEffectsSent = false;
  finishingKey = null;
  render();
}

function resetTimer() {
  if (state.completionBusy) return;
  cancelFocusInitiation();
  state.running = false;
  state.deadline = 0;
  state.remaining = durationSeconds();
  state.sessionId = null;
  state.sessionTaskId = null;
  state.sessionDurationMinutes = settings[state.mode === 'focus' ? 'focusMin' : 'breakMin'];
  state.startedAt = 0;
  state.completion = null;
  state.completionSaved = true;
  completionEffectsSent = false;
  state.durationEditing = false;
  finishingKey = null;
  render();
}

function startTimer() {
  if (taskWriteBusy || durationDrag || durationDragBusy) return;
  if (state.completion) { continueFromCompletion(); return; }
  if (state.completionBusy) return;
  if (state.remaining <= 0) state.remaining = durationSeconds();
  const createsSession = !state.sessionId;
  if (createsSession) {
    state.sessionId = crypto.randomUUID();
    state.sessionTaskId = state.mode === 'focus' ? armedTaskId : null;
    state.sessionDurationMinutes = settings[state.mode === 'focus' ? 'focusMin' : 'breakMin'];
    state.startedAt = Date.now();
    completionEffectsSent = false;
  }
  state.running = true;
  state.deadline = Date.now() + state.remaining * 1000;
  state.expanded = false;
  state.screen = 'timer';
  island.classList.remove('expanded');
  Object.entries(views).forEach(([name, element]) => element.classList.toggle('active', name === 'timer'));
  island.style.setProperty('--view-w', '312px');
  island.style.setProperty('--view-h', '103px');
  render();
  if (createsSession && state.mode === 'focus') window.notch.initiateFocus?.(state.sessionId);
}

function pauseTimer() {
  if (!state.running) return;
  cancelFocusInitiation();
  state.remaining = exactRemaining();
  state.running = false;
  state.deadline = 0;
  render();
}

function toggleTimer() { if (state.running) pauseTimer(); else startTimer(); }

async function finishTimer(natural = false) {
  if (!state.running || state.completionBusy) return;
  cancelFocusInitiation();
  state.remaining = natural ? 0 : exactRemaining();
  state.running = false;
  state.deadline = 0;
  state.completion = state.mode;
  state.completionSaved = false;
  state.completionBusy = true;
  state.expanded = true;
  setScreen('timer');
  island.classList.add('finished');
  island.classList.remove('running');
  setTimeout(() => island.classList.remove('finished'), 2100);
  render();
  const key = state.sessionId || crypto.randomUUID();
  if (finishingKey === key) return;
  finishingKey = key;
  const elapsedMinutes = natural ? state.sessionDurationMinutes : Math.floor(Math.max(0, (state.sessionDurationMinutes * MINUTE - state.remaining) / MINUTE));
  try {
    const result = await window.notch.complete({ mode: state.mode, minutes: elapsedMinutes, taskId: state.sessionTaskId || undefined, sessionId: key });
    if (result?.tasks) mergeTasks(result.tasks);
    if (result?.stats) stats = { ...stats, ...result.stats };
    if (!result?.duplicate && !completionEffectsSent) {
      completionEffectsSent = true;
      window.notch.notify({ title: state.completion === 'focus' ? 'Focus session complete' : 'Break complete', body: 'Your session has been saved.' });
      window.notch.celebrate({ mode: state.completion });
    }
    state.completionSaved = true;
    state.completionBusy = false;
    showNotice('');
  } catch (error) {
    state.completionBusy = false;
    state.completionSaved = false;
    showNotice('Could not save session · press check to retry', true);
  }
  render();
}

async function retryCompletion() {
  if (state.completionBusy || state.completionSaved || !state.completion) return;
  state.completionBusy = true;
  render();
  const key = state.sessionId || finishingKey || crypto.randomUUID();
  try {
    const elapsedMinutes = Math.floor(Math.max(0, (state.sessionDurationMinutes * MINUTE - state.remaining) / MINUTE));
    const result = await window.notch.complete({ mode: state.completion, minutes: elapsedMinutes, taskId: state.sessionTaskId || undefined, sessionId: key });
    if (result?.tasks) mergeTasks(result.tasks);
    if (result?.stats) stats = { ...stats, ...result.stats };
    if (!result?.duplicate && !completionEffectsSent) {
      completionEffectsSent = true;
      window.notch.notify({ title: state.completion === 'focus' ? 'Focus session complete' : 'Break complete', body: 'Your session has been saved.' });
      window.notch.celebrate({ mode: state.completion });
    }
    state.completionSaved = true;
    state.completionBusy = false;
    showNotice('');
  } catch {
    state.completionBusy = false;
    showNotice('Could not save session · press check to retry', true);
  }
  render();
}

function continueFromCompletion() {
  if (!state.completionSaved || state.completionBusy) return;
  if (state.completion === 'focus') {
    state.mode = 'break';
    state.remaining = durationSeconds('break');
  } else {
    state.mode = 'focus';
    state.remaining = durationSeconds('focus');
  }
  state.completion = null;
  state.sessionId = null;
  state.sessionTaskId = null;
  state.sessionDurationMinutes = settings[state.mode === 'focus' ? 'focusMin' : 'breakMin'];
  state.startedAt = 0;
  state.completionSaved = true;
  completionEffectsSent = false;
  finishingKey = null;
  showNotice('');
  setScreen('timer');
  startTimer();
}

function rearmAfterEdit() {
  if (state.running) return;
  state.remaining = durationSeconds();
  state.sessionId = null;
  state.sessionTaskId = null;
  state.sessionDurationMinutes = settings[state.mode === 'focus' ? 'focusMin' : 'breakMin'];
  state.startedAt = 0;
  state.completion = null;
  state.completionSaved = true;
  completionEffectsSent = false;
  finishingKey = null;
}

function mergeTasks(saved) {
  const byId = new Map((saved || []).map((task) => [task.id, task]));
  tasks = tasks.map((task) => {
    const server = byId.get(task.id);
    return server ? { ...task, ...server, done: Math.max(task.done, server.done) } : task;
  });
  for (const task of saved || []) if (!tasks.some((item) => item.id === task.id)) tasks.push(task);
}

function persistTasks(nextTasks, nextArmed) {
  const snapshot = nextTasks.map(({ id, title, estimate, done, archived, size }) => ({
    id, title, estimate, done, archived, size: normalizeSize(size, 'medium'),
  }));
  const request = taskQueue.then(() => window.notch.saveTasks(snapshot, nextArmed));
  taskQueue = request.catch(() => undefined);
  return request;
}

function activeSizeKey(mode = state.mode) {
  return mode === 'focus' ? 'focusSize' : 'breakSize';
}

function applySize(size, mode = state.mode) {
  const key = normalizeSize(size, mode === 'focus' ? 'medium' : 'short');
  const minutes = settings.presets[mode][key];
  const sizeField = mode === 'focus' ? 'focusSize' : 'breakSize';
  const minField = mode === 'focus' ? 'focusMin' : 'breakMin';
  return { [sizeField]: key, [minField]: minutes };
}

function cyclePreset(direction) {
  if (!durationGestureAllowed()) return;
  const sizeField = activeSizeKey();
  const current = normalizeSize(settings[sizeField], state.mode === 'focus' ? 'medium' : 'short');
  const index = SIZE_KEYS.indexOf(current);
  const next = SIZE_KEYS[(index + (direction > 0 ? 1 : -1) + SIZE_KEYS.length) % SIZE_KEYS.length];
  const patch = applySize(next);
  Object.assign(pendingSettings, patch);
  enqueueSetting(patch, patch, () => {
    if (!state.running && !state.completion) rearmAfterEdit();
  });
}

function enqueueSetting(patch, optimistic = {}, onAccepted = null) {
  const request = settingsQueue.then(async () => {
    try {
      const accepted = await window.notch.saveSettings(patch);
      for (const key of Object.keys(patch)) settings[key] = accepted[key];
      for (const key of Object.keys(patch)) if (pendingSettings[key] === optimistic[key]) delete pendingSettings[key];
      showNotice('');
      onAccepted?.();
      render();
      return true;
    } catch (error) {
      for (const key of Object.keys(patch)) if (pendingSettings[key] === optimistic[key]) delete pendingSettings[key];
      showNotice(error?.message || 'Could not save setting', true);
      render();
      return false;
    }
  });
  settingsQueue = request.then(() => undefined, () => undefined);
  return request;
}

async function chooseTask(id) {
  if (state.running || state.completionBusy || taskWriteBusy || (state.completion && !state.completionSaved)) return;
  taskWriteBusy = true;
  renderTaskList();
  try {
    const result = await persistTasks(tasks, id);
    if (result?.tasks) mergeTasks(result.tasks);
    armedTaskId = result?.armedTaskId ?? id;
    rearmAfterEdit();
    showNotice('');
    setScreen('timer');
  } catch (error) {
    showNotice(error?.message || 'Could not save task selection', true);
  } finally { taskWriteBusy = false; renderTaskList(); }
}

async function playTask(id) {
  if (state.running || state.completionBusy || taskWriteBusy || (state.completion && !state.completionSaved)) return;
  const task = tasks.find((item) => item.id === id && !item.archived);
  if (!task) return;
  taskWriteBusy = true;
  renderTaskList();
  try {
    const result = await persistTasks(tasks, id);
    if (result?.tasks) mergeTasks(result.tasks);
    armedTaskId = result?.armedTaskId ?? id;
    const patch = applySize(task.size || 'medium', 'focus');
    Object.assign(pendingSettings, patch);
    const saved = await enqueueSetting(patch, patch);
    if (!saved) throw new Error('Could not set focus length');
    cancelFocusInitiation();
    state.mode = 'focus';
    state.completion = null;
    state.completionSaved = true;
    rearmAfterEdit();
    showNotice('');
    setScreen('timer');
  } catch (error) {
    showNotice(error?.message || 'Could not arm task', true);
  } finally { taskWriteBusy = false; render(); }
}

function renderTaskList() {
  const list = $('#taskList');
  const active = activeTasks();
  list.replaceChildren();
  for (const task of active) {
    const size = normalizeSize(task.size, 'medium');
    const row = document.createElement('div');
    row.className = 'row task-row';
    row.setAttribute('aria-current', String(task.id === armedTaskId));
    const select = document.createElement('button');
    select.className = 'row-title';
    select.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;flex:1;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:0;cursor:pointer';
    select.disabled = state.running || taskWriteBusy;
    select.setAttribute('aria-label', `${task.title}, ${sizeLabel(size)} focus`);
    const check = document.createElement('span'); check.className = 'task-check';
    const title = document.createElement('span'); title.className = 'row-title'; title.textContent = task.title;
    title.title = task.title;
    select.append(check, title);
    select.addEventListener('click', () => chooseTask(task.id));
    const meta = document.createElement('small'); meta.className = 'row-meta'; meta.textContent = sizeLabel(size);
    const play = document.createElement('button');
    play.className = 'task-play';
    play.innerHTML = ICON.play;
    play.disabled = state.running || taskWriteBusy;
    play.title = `Arm ${size} focus`;
    play.setAttribute('aria-label', `Play ${task.title}`);
    play.addEventListener('click', (event) => { event.stopPropagation(); playTask(task.id); });
    row.append(select, meta, play);
    list.append(row);
  }
  const empty = active.length === 0;
  $('#emptyTasks').hidden = !empty;
  $('#emptyAdd').hidden = !empty;
  $('#taskFooter').hidden = empty;
  $('#taskFooter').textContent = `${active.length} active ${active.length === 1 ? 'task' : 'tasks'}`;
  $('#taskAdd').hidden = empty;
}

function setDurationInput(value) {
  state.durationDraft = value;
  const input = $('#durationInput');
  if (input && input !== document.activeElement) input.value = value;
}

function enterDurationEdit() {
  if (state.running || state.completion || state.completionBusy || durationDrag || durationDragBusy) return;
  state.durationEditing = true;
  state.durationDraft = String(settings[state.mode === 'focus' ? 'focusMin' : 'breakMin']);
  renderClock();
  const input = $('#durationInput'); input.focus({ preventScroll: true }); input.select();
}

function commitDuration() {
  if (!state.durationEditing) return;
  const key = state.mode === 'focus' ? 'focusMin' : 'breakMin';
  const value = Number(state.durationDraft);
  if (!Number.isInteger(value) || value < 1 || value > 90) { showNotice('Enter a whole number from 1 to 90', true); $('#durationInput')?.focus({ preventScroll: true }); return; }
  pendingSettings[key] = value;
  enqueueSetting({ [key]: value }, { [key]: value }, () => {
    state.durationEditing = false;
    rearmAfterEdit();
    showNotice('');
  });
}

function cancelDuration() { state.durationEditing = false; showNotice(''); render(); }

function renderClock() {
  const key = state.mode === 'focus' ? 'focusMin' : 'breakMin';
  const adjustable = !state.running && !state.completion && !state.completionBusy && !state.durationEditing && !durationDrag && !durationDragBusy && pendingSettings[key] === undefined;
  clockSlot.dataset.adjustable = String(adjustable);
  const size = normalizeSize(settings[activeSizeKey()], state.mode === 'focus' ? 'medium' : 'short');
  clockSlot.title = adjustable ? `Scroll ${size} · short/medium/long · click to type` : '';
  const slot = clockSlot;
  if (state.durationEditing) {
    timerNote.hidden = true;
    timerNote.classList.remove('adjust-hint');
    if (!$('#durationInput')) {
      slot.replaceChildren();
      const input = document.createElement('input');
      input.className = 'clock-edit'; input.id = 'durationInput'; input.type = 'number';
      input.min = '1'; input.max = '90'; input.step = '1'; input.inputMode = 'numeric'; input.setAttribute('aria-label', 'Timer duration in minutes');
      input.value = state.durationDraft;
      input.addEventListener('input', () => setDurationInput(input.value));
      input.addEventListener('blur', () => { if (state.durationEditing && input.value !== state.durationDraft) setDurationInput(input.value); });
      const unit = document.createElement('span'); unit.className = 'clock-unit'; unit.setAttribute('aria-hidden', 'true'); unit.textContent = 'min';
      slot.append(input, unit);
    }
    return;
  }
  const input = $('#durationInput');
  if (input) {
    const button = document.createElement('button'); button.className = 'clock-button'; button.id = 'clockButton'; button.type = 'button';
    slot.replaceChildren(button);
  }
  const button = $('#clockButton');
  if (!button) return;
  const scrubValue = durationDrag?.activated ? durationDrag.preview : durationDragBusy ? pendingSettings[key] : null;
  const displayed = scrubValue ? scrubValue * MINUTE : state.completion ? 0 : currentRemaining();
  button.textContent = fmt(displayed);
  button.disabled = state.running || !!state.completion || state.completionBusy;
  button.setAttribute('aria-label', scrubValue ? `${scrubValue} minutes` : state.running ? `${fmt(displayed)} remaining` : 'Edit duration');
  button.onclick = enterDurationEdit;
}

function durationKey() { return state.mode === 'focus' ? 'focusMin' : 'breakMin'; }

function requestDurationValue(value, preview = false) {
  const key = durationKey();
  if (!Number.isInteger(value) || value < 1 || value > 90 || state.running || state.completion || state.completionBusy || state.durationEditing || durationDrag || durationDragBusy || pendingSettings[key] !== undefined || value === settings[key]) return false;
  durationDragBusy = true;
  pendingSettings[key] = value;
  if (preview) {
    const button = $('#clockButton');
    if (button) button.textContent = fmt(value * MINUTE);
  }
  renderClock();
  const result = enqueueSetting({ [key]: value }, { [key]: value }, () => {
    rearmAfterEdit();
    showNotice('');
  });
  result.finally(() => {
    durationDragBusy = false;
    render();
  });
  return true;
}

function durationGestureAllowed() {
  const key = durationKey();
  return !state.running && !state.completion && !state.completionBusy && !state.durationEditing &&
    !durationDragBusy && pendingSettings[key] === undefined;
}

function finishDurationDrag(commit, event) {
  if (!durationDrag) return;
  const drag = durationDrag;
  durationDrag = null;
  document.documentElement.classList.remove('duration-dragging');
  try { if (clockSlot.hasPointerCapture(drag.pointerId)) clockSlot.releasePointerCapture(drag.pointerId); } catch {}
  updateMousePassthrough(event);
  if (commit && drag.activated) {
    suppressDurationClick = true;
    setTimeout(() => { suppressDurationClick = false; }, 500);
  }
  if (commit && drag.activated && drag.preview !== drag.startValue) {
    requestDurationValue(drag.preview, true);
  } else {
    render();
  }
}

function renderTimer() {
  const selected = selectedTask();
  timerTask.textContent = modeCue();
  timerTask.title = modeCue();
  timerTask.setAttribute('aria-label', state.mode === 'focus' ? `Choose task, ${modeCue()}` : 'Break');
  timerTask.disabled = state.running || state.completionBusy || !!state.completion;
  timerTask.style.color = state.completion ? 'var(--ink)' : state.mode === 'break' ? 'var(--break)' : selected ? 'var(--task-focus)' : 'var(--mid)';
  const activeMode = state.completion === 'focus' ? 'focus' : state.completion === 'break' ? 'break' : state.mode;
  document.querySelectorAll('.mode').forEach((button) => {
    button.classList.toggle('on', button.dataset.mode === activeMode);
    button.disabled = state.running || state.completionBusy || !!state.completion;
    button.setAttribute('aria-pressed', String(button.dataset.mode === activeMode));
    button.title = state.running ? 'Pause the session to change mode' : '';
  });
  renderClock();
  const complete = !!state.completion;
  const canFinish = state.running && !state.completionBusy;
  const primary = $('#playButton');
  primary.innerHTML = complete ? state.completionSaved ? ICON.play : ICON.done : state.running ? ICON.pause : ICON.play;
  primary.disabled = state.completionBusy;
  primary.title = complete ? state.completionSaved ? (state.completion === 'focus' ? 'Start break' : 'Start focus') : 'Retry saving session' : state.running ? 'Pause timer' : 'Start timer';
  primary.setAttribute('aria-label', primary.title);
  primary.style.background = state.completion ? 'var(--done)' : 'var(--accent)';
  primary.onclick = complete ? state.completionSaved ? continueFromCompletion : retryCompletion : toggleTimer;
  const secondary = $('#resetButton');
  secondary.hidden = complete;
  secondary.disabled = state.completionBusy || complete;
  secondary.title = state.running ? 'Finish session now' : 'Reset timer';
  secondary.setAttribute('aria-label', secondary.title);
  secondary.innerHTML = state.running ? ICON.done : ICON.reset;
  secondary.onclick = state.running ? () => finishTimer(false) : resetTimer;
  timerNote.classList.toggle('task-running-note', false);
  const paused = !state.running && state.remaining !== durationSeconds();
  const showAdjustHint = !complete && !state.running && !paused && !state.durationEditing && !durationDragBusy && !durationDrag && !state.completionBusy;
  if (complete) {
    const task = tasks.find((item) => item.id === state.sessionTaskId);
    timerNote.textContent = state.completion === 'focus' && task ? `${taskSummary(task)} sessions completed` : state.completion === 'focus' ? 'Focus complete' : 'Break complete';
  } else {
    const size = normalizeSize(settings[activeSizeKey()], state.mode === 'focus' ? 'medium' : 'short');
    timerNote.textContent = paused ? 'PAUSED' : showAdjustHint ? `${size.toUpperCase()} · scroll to switch` : '';
  }
  timerNote.classList.toggle('completion-note', complete);
  timerNote.classList.toggle('adjust-hint', showAdjustHint);
  timerNote.style.color = '';
  timerNote.hidden = !complete && (state.running || (!paused && !showAdjustHint));
  $('#openMenu').disabled = state.completionBusy;
  $('#timerAdd').disabled = state.completionBusy;
}

function renderSettings() {
  const presets = settings.presets || DEFAULT_PRESETS;
  $('#focusShortValue').textContent = `${presets.focus.short}m`;
  $('#focusMediumValue').textContent = `${presets.focus.medium}m`;
  $('#focusLongValue').textContent = `${presets.focus.long}m`;
  $('#breakShortValue').textContent = `${presets.break.short}m`;
  $('#breakMediumValue').textContent = `${presets.break.medium}m`;
  $('#breakLongValue').textContent = `${presets.break.long}m`;
  $('#shortcutValue').textContent = formatShortcut(settings.shortcut);
  document.querySelectorAll('[data-setting-toggle]').forEach((button) => {
    const key = button.dataset.settingToggle;
    button.setAttribute('aria-pressed', String(!!settings[key]));
    button.title = `${key}: ${settings[key] ? 'On' : 'Off'}`;
  });
}

function render() {
  island.classList.toggle('running', state.running);
  island.classList.toggle('break-mode', state.mode === 'break' || state.completion === 'break');
  island.classList.toggle('completed', !!state.completion);
  island.dataset.mode = state.mode;
  island.dataset.screen = state.screen;
  island.classList.toggle('expanded', state.expanded);
  island.classList.toggle('timer-open', state.expanded && state.screen === 'timer');
  $('.wrap').classList.toggle('timer-open', state.expanded && state.screen === 'timer');
  const name = state.running && state.mode === 'break' ? 'Take a break' : selectedTask()?.title || (state.mode === 'break' ? 'Take a break' : 'Focus');
  pillName.textContent = name;
  pillTime.textContent = fmt(currentRemaining());
  $('#pill').setAttribute('aria-label', `${name}, ${fmt(currentRemaining())}. Open timer`);
  $('#pill').disabled = state.expanded;
  $('#viewTimer').setAttribute('aria-hidden', String(!state.expanded || state.screen !== 'timer'));
  Object.entries(views).forEach(([screen, element]) => {
    const inactive = !state.expanded || screen !== state.screen;
    element.setAttribute('aria-hidden', String(inactive));
    element.inert = inactive;
  });
  $('#viewTasks').classList.toggle('empty', activeTasks().length === 0);
  $('#shortcutField').textContent = formatShortcut(state.shortcutCapture ? state.shortcutCandidate || state.shortcutPrevious : settings.shortcut);
  $('#shortcutField').setAttribute('aria-label', `Shortcut chord ${$('#shortcutField').textContent}`);
  if ($('#newTaskTitle').value !== state.createDraft) $('#newTaskTitle').value = state.createDraft;
  document.querySelectorAll('[data-create-size]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.createSize === state.createSize));
  });
  const createLines = state.createDraft.split('\n').map((line) => line.trim()).filter(Boolean);
  $('#addTask').disabled = !createLines.length || createLines.some((line) => line.length > 120) || taskWriteBusy;
  $('#taskAdd').hidden = activeTasks().length === 0;
  $('#emptyAdd').hidden = activeTasks().length !== 0;
  renderTaskList();
  renderSettings();
  renderTimer();
  const vignetteOn = state.running && state.mode === 'focus' && settings.vignette;
  if (island.dataset.vignette !== String(vignetteOn)) {
    island.dataset.vignette = String(vignetteOn);
    window.notch.setVignette(vignetteOn);
  }
  const trayKey = `${state.mode}:${state.running}:${Math.ceil(currentRemaining())}`;
  if (trayKey !== render.lastTrayKey) {
    render.lastTrayKey = trayKey;
    window.notch.setTrayState({ mode: state.mode, remaining: currentRemaining(), running: state.running });
  }
}

function updateMousePassthrough(event) {
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) {
    const bounds = island.getBoundingClientRect();
    const canopy = state.expanded && event.clientY - bounds.top <= 26 && !event.target?.closest?.('button,input,textarea,select,[contenteditable="true"]');
    island.classList.toggle('canopy-grab', canopy);
  }
  if (durationDrag || windowDrag) {
    if (mouseIgnored) { mouseIgnored = false; window.notch.setIgnoreMouse(false); }
    return;
  }
  if (Number.isFinite(event?.clientX) && Number.isFinite(event?.clientY)) lastPointerPosition = { x:event.clientX, y:event.clientY };
  const bounds = island.getBoundingClientRect();
  const x = event?.clientX ?? lastPointerPosition.x;
  const y = event?.clientY ?? lastPointerPosition.y;
  const inside = x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
  const ignore = !inside;
  if (ignore !== mouseIgnored) {
    mouseIgnored = ignore;
    window.notch.setIgnoreMouse(ignore);
  }
}

function setCreateSize(size) {
  state.createSize = normalizeSize(size, 'medium');
  render();
}
async function submitTask() {
  if (taskWriteBusy || state.completionBusy) return;
  const titles = state.createDraft.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!titles.length || titles.some((title) => title.length > 120)) return;
  const size = normalizeSize(state.createSize, 'medium');
  const created = titles.map((title) => ({
    id: crypto.randomUUID(), title, estimate: 1, done: 0, archived: false, size,
  }));
  taskWriteBusy = true;
  $('#addTask').disabled = true;
  try {
    const shouldSelect = !state.running && (!state.completion || state.completionSaved);
    const armId = shouldSelect ? created[0].id : armedTaskId;
    const result = await persistTasks([...tasks, ...created], armId);
    if (result?.tasks) mergeTasks(result.tasks);
    if (result && 'armedTaskId' in result) armedTaskId = result.armedTaskId;
    state.createDraft = '';
    state.createSize = 'medium';
    if (shouldSelect) {
      const patch = applySize(size, 'focus');
      Object.assign(pendingSettings, patch);
      await enqueueSetting(patch, patch);
      cancelFocusInitiation();
      state.mode = 'focus';
      rearmAfterEdit();
    }
    setScreen(shouldSelect ? 'timer' : 'tasks');
    showNotice(created.length > 1 ? `Added ${created.length} tasks` : '');
  } catch (error) {
    showNotice(error?.message || 'Could not save task · your draft is still here', true);
  } finally { taskWriteBusy = false; render(); }
}

function captureKey(event) {
  if (!state.shortcutCapture) return;
  if (event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault(); event.stopPropagation(); stopShortcutCapture(true); setScreen('settings'); return;
  }
  if (event.key === 'Enter' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault(); event.stopPropagation(); saveShortcutCandidate(); return;
  }
  if (['Alt', 'Control', 'Meta', 'Shift'].includes(event.key)) return;
  const hasPrimary = event.altKey || event.ctrlKey || event.metaKey;
  if (!hasPrimary) return;
  event.preventDefault(); event.stopPropagation();
  const modifiers = [];
  if (event.altKey) modifiers.push('Alt');
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.metaKey) modifiers.push(navigator.platform.includes('Mac') ? 'Command' : 'Ctrl');
  if (event.shiftKey) modifiers.push('Shift');
  const code = event.code || '';
  const specialKeys = {
    Space: 'Space', Escape: 'Esc', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', Delete: 'Delete',
    Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Tab: 'Tab',
    Equal: 'Plus', NumpadAdd: 'Plus', Minus: '-', NumpadSubtract: '-', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/',
  };
  const key = /^Key[A-Z]$/.test(code) ? code.slice(3)
    : /^Digit\d$/.test(code) ? code.slice(5)
    : /^F([1-9]|1\d|2[0-4])$/.test(code) ? code
    : specialKeys[code];
  if (!key) return;
  state.shortcutCandidate = [...new Set([...modifiers, key])].join('+');
  render();
}

async function startShortcutCapture() {
  const request = ++shortcutCaptureRequest;
  state.shortcutPrevious = settings.shortcut;
  state.shortcutCandidate = '';
  state.shortcutCapture = true;
  try {
    await window.notch.setShortcutCapture(true);
    if (request !== shortcutCaptureRequest || state.screen !== 'shortcut') {
      await window.notch.setShortcutCapture(false);
      return;
    }
    $('#shortcutField').focus({ preventScroll: true });
    render();
  } catch (error) {
    if (request === shortcutCaptureRequest) state.shortcutCapture = false;
    showNotice(error?.message || 'Could not start shortcut capture', true);
    render();
  }
}

async function stopShortcutCapture(cancel) {
  if (!state.shortcutCapture && !cancel) return;
  shortcutCaptureRequest += 1;
  const wasCapturing = state.shortcutCapture;
  state.shortcutCapture = false;
  state.shortcutCandidate = '';
  if (wasCapturing || cancel) {
    try { await window.notch.setShortcutCapture(false); }
    catch (error) { showNotice(error?.message || 'Could not restore shortcut', true); }
  }
  render();
}

async function saveShortcutCandidate() {
  if (!state.shortcutCandidate) { showNotice('Press a shortcut first', true); return; }
  const candidate = state.shortcutCandidate;
  try {
    const result = await window.notch.saveSettings({ shortcut: candidate });
    settings.shortcut = result.shortcut;
    state.shortcutCapture = false;
    state.shortcutCandidate = '';
    await window.notch.setShortcutCapture(false);
    showNotice('');
    setScreen('settings');
  } catch (error) {
    showNotice(error?.message || 'Shortcut is unavailable', true);
    render();
  }
}

function chordForEvent(event) { captureKey(event); }

function beginWindowDrag(event) {
  if (event.button !== 0 || windowDrag || durationDrag) return;
  const inPill = !state.expanded && !!event.target.closest('#pill');
  const bounds = island.getBoundingClientRect();
  const inCanopy = state.expanded && event.clientY - bounds.top <= 26 &&
    !event.target.closest('button,input,textarea,select,[contenteditable="true"]');
  if (!inPill && !inCanopy) return;
  windowDrag = { pointerId:event.pointerId, startX:event.clientX, startY:event.clientY, inPill, activated:false };
  try { island.setPointerCapture(event.pointerId); } catch {}
  window.notch.setIgnoreMouse(false);
  mouseIgnored = false;
}

function finishWindowDrag(commit, event) {
  if (!windowDrag) return;
  const drag = windowDrag;
  windowDrag = null;
  document.documentElement.classList.remove('window-dragging');
  try { if (island.hasPointerCapture(drag.pointerId)) island.releasePointerCapture(drag.pointerId); } catch {}
  if (commit && drag.activated) {
    window.notch.dragEnd();
    suppressWindowClick = true;
    setTimeout(() => { suppressWindowClick = false; }, 500);
  } else if (drag.activated) {
    window.notch.dragEnd();
  }
  updateMousePassthrough(event);
}

let suppressWindowClick = false;
let suppressDurationClick = false;
clockSlot.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || !event.target.closest('#clockButton') || !durationGestureAllowed()) return;
  const startValue = settings[durationKey()];
  durationDrag = { pointerId:event.pointerId, startX:event.clientX, startValue, preview:startValue, activated:false };
  try { clockSlot.setPointerCapture(event.pointerId); } catch {}
  window.notch.setIgnoreMouse(false);
  mouseIgnored = false;
});
island.addEventListener('pointerdown', beginWindowDrag);
window.addEventListener('pointermove', (event) => {
  if (durationDrag && event.pointerId === durationDrag.pointerId) {
    const drag = durationDrag;
    const dx = event.clientX - drag.startX;
    if (!drag.activated && Math.abs(dx) >= 4) {
      drag.activated = true;
      document.documentElement.classList.add('duration-dragging');
      timerNote.hidden = true;
      timerNote.classList.remove('adjust-hint');
    }
    if (drag.activated) {
      event.preventDefault();
      drag.preview = clamp(drag.startValue + Math.round(dx / 6), 1, 90);
      const button = $('#clockButton');
      if (button) {
        button.textContent = fmt(drag.preview * MINUTE);
        button.setAttribute('aria-label', `${drag.preview} minutes`);
      }
    }
  }
  if (windowDrag && event.pointerId === windowDrag.pointerId) {
    const drag = windowDrag;
    const dx = event.clientX - drag.startX;
    if (!drag.activated && Math.hypot(dx, event.clientY - drag.startY) >= 4) {
      drag.activated = true;
      document.documentElement.classList.add('window-dragging');
      window.notch.dragStart();
    }
    if (drag.activated) {
      event.preventDefault();
      window.notch.dragMove();
    }
  }
  if (!durationDrag && !windowDrag) updateMousePassthrough(event);
});
window.addEventListener('pointerup', (event) => {
  if (durationDrag && event.pointerId === durationDrag.pointerId) finishDurationDrag(true, event);
  if (windowDrag && event.pointerId === windowDrag.pointerId) finishWindowDrag(true, event);
});
window.addEventListener('pointercancel', (event) => {
  if (durationDrag && event.pointerId === durationDrag.pointerId) finishDurationDrag(false, event);
  if (windowDrag && event.pointerId === windowDrag.pointerId) finishWindowDrag(false, event);
});
window.addEventListener('blur', () => {
  if (durationDrag) finishDurationDrag(false);
  if (windowDrag) finishWindowDrag(false);
});
document.addEventListener('click', (event) => {
  if (suppressDurationClick && event.target.closest('#clockSlot')) {
    suppressDurationClick = false; event.preventDefault(); event.stopPropagation();
  } else if (suppressWindowClick) {
    suppressWindowClick = false; event.preventDefault(); event.stopPropagation();
  }
}, true);
clockSlot.addEventListener('click', (event) => { if (event.target === clockSlot && event.detail > 0) enterDurationEdit(); });
pill.addEventListener('click', () => { if (suppressWindowClick) return; setScreen('timer'); });
island.addEventListener('click', (event) => {
  if (suppressWindowClick) { event.preventDefault(); event.stopPropagation(); return; }
  if (!state.expanded && event.target === island) { setScreen('timer'); return; }
  if (state.expanded && (event.target === island || event.target.classList?.contains('view'))) setExpanded(false);
});

$('#openMenu').addEventListener('click', () => setScreen('settings'));
timerTask.addEventListener('click', () => { if (!state.running && !state.completion) setScreen('tasks'); });
document.querySelectorAll('[data-screen]').forEach((button) => button.addEventListener('click', () => setScreen(button.dataset.screen)));
document.querySelectorAll('[data-back]').forEach((button) => button.addEventListener('click', () => { if (button.dataset.back === 'settings' && state.screen === 'shortcut') stopShortcutCapture(true); setScreen(button.dataset.back); }));
document.querySelectorAll('.mode').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-create]').forEach((button) => button.addEventListener('click', () => {
  if (state.completionBusy) return;
  state.createDraft = '';
  state.createSize = 'medium';
  setScreen('create');
}));
document.querySelectorAll('[data-create-size]').forEach((button) => {
  button.addEventListener('click', () => setCreateSize(button.dataset.createSize));
});
$('#newTaskTitle').addEventListener('input', (event) => {
  state.createDraft = event.target.value;
  const lines = state.createDraft.split('\n').map((line) => line.trim()).filter(Boolean);
  $('#addTask').disabled = !lines.length || lines.some((line) => line.length > 120) || taskWriteBusy;
});
$('#newTaskTitle').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !$('#addTask').disabled) {
    event.preventDefault();
    submitTask();
  }
});
$('#cancelCreate').addEventListener('click', () => { state.createDraft = ''; state.createSize = 'medium'; setScreen('timer'); });
$('#addTask').addEventListener('click', submitTask);
document.querySelectorAll('[data-preset-step]').forEach((button) => button.addEventListener('click', () => {
  const [mode, size] = String(button.dataset.presetStep || '').split('.');
  if (!['focus', 'break'].includes(mode) || !SIZE_KEYS.includes(size)) return;
  const presets = normalizePresets(pendingSettings.presets || settings.presets);
  const nextValue = clamp(presets[mode][size] + Number(button.dataset.delta), 1, 90);
  if (presets[mode][size] === nextValue) return;
  presets[mode][size] = nextValue;
  const patch = { presets };
  const sizeField = mode === 'focus' ? 'focusSize' : 'breakSize';
  const minField = mode === 'focus' ? 'focusMin' : 'breakMin';
  if ((pendingSettings[sizeField] ?? settings[sizeField]) === size) {
    patch[minField] = nextValue;
    pendingSettings[minField] = nextValue;
  }
  pendingSettings.presets = presets;
  enqueueSetting(patch, patch, () => {
    if (!state.running && !state.completion && state.mode === mode && settings[sizeField] === size) rearmAfterEdit();
  });
}));
document.querySelectorAll('[data-setting-toggle]').forEach((button) => button.addEventListener('click', () => {
  const key = button.dataset.settingToggle;
  const value = !(pendingSettings[key] ?? settings[key]);
  pendingSettings[key] = value;
  enqueueSetting({ [key]: value }, { [key]: value });
}));
$('#shortcutField').addEventListener('keydown', chordForEvent);
$('#clockSlot').addEventListener('wheel', (event) => {
  event.preventDefault();
  cyclePreset(event.deltaY < 0 ? 1 : -1);
}, { passive:false });
clockSlot.addEventListener('keydown', (event) => {
  if (event.target.id !== 'clockButton' || !['ArrowLeft', 'ArrowRight'].includes(event.key) || !durationGestureAllowed()) return;
  event.preventDefault();
  cyclePreset(event.key === 'ArrowRight' ? 1 : -1);
});
document.addEventListener('keydown', (event) => {
  island.classList.add('instant-ui');
  if (state.shortcutCapture) { captureKey(event); return; }
  if (state.durationEditing && event.target.id === 'durationInput') {
    if (event.key === 'Enter') { event.preventDefault(); commitDuration(); }
    else if (event.key === 'Escape') { event.preventDefault(); cancelDuration(); }
    return;
  }
  if (event.key === 'Escape') {
    if (durationDrag) { event.preventDefault(); finishDurationDrag(false, event); return; }
    if (windowDrag) { event.preventDefault(); finishWindowDrag(false, event); return; }
    if (state.screen === 'create') { event.preventDefault(); state.createDraft = ''; state.createSize = 'medium'; setScreen('timer'); return; }
    if (state.screen === 'shortcut') { event.preventDefault(); stopShortcutCapture(true); setScreen('settings'); return; }
    if (state.screen !== 'timer') { event.preventDefault(); setScreen('timer'); return; }
    if (state.expanded) { event.preventDefault(); setExpanded(false); }
    return;
  }
  if (event.code === 'Space' && state.screen === 'timer' && !activeControlEditable() && !event.target.closest('button,input,textarea,select,[contenteditable="true"]')) {
    event.preventDefault(); toggleTimer();
  }
});
window.addEventListener('mousemove', updateMousePassthrough);
document.addEventListener('pointerdown', () => { island.classList.remove('instant-ui'); suppressDurationClick = false; suppressWindowClick = false; }, true);
document.addEventListener('click', (event) => { if (event.detail === 0) island.classList.add('instant-ui'); }, true);
document.querySelector('.stage').addEventListener('click', (event) => {
  if (state.expanded && event.target === event.currentTarget) setExpanded(false);
});

window.notch.onCmd((cmd) => {
  island.classList.add('instant-ui');
  if (state.shortcutCapture || activeControlEditable()) return;
  if (cmd === 'toggle' || cmd === 'pause') { if (cmd === 'pause' && !state.running) return; toggleTimer(); }
  else if (cmd === 'reset') resetTimer();
  else if (cmd === 'finish') { if (state.running) finishTimer(false); }
  else if (cmd === 'start-focus') { if (!state.running) { if (state.mode !== 'focus') setMode('focus'); startTimer(); } }
  else if (cmd === 'start-break') { if (!state.running) { if (state.mode !== 'break') setMode('break'); startTimer(); } }
});
window.notch.onExpand((expanded) => { island.classList.add('instant-ui'); setExpanded(expanded); });
window.notch.onNavigate((screen) => { island.classList.add('instant-ui'); if (views[screen]) setScreen(screen); });
window.notch.onSettings((value) => {
  const changedFocus = Number.isInteger(value.focusMin) && value.focusMin !== settings.focusMin;
  const changedBreak = Number.isInteger(value.breakMin) && value.breakMin !== settings.breakMin;
  if (Number.isInteger(value.focusMin)) settings.focusMin = value.focusMin;
  if (Number.isInteger(value.breakMin)) settings.breakMin = value.breakMin;
  if (value.focusSize) settings.focusSize = normalizeSize(value.focusSize, settings.focusSize);
  if (value.breakSize) settings.breakSize = normalizeSize(value.breakSize, settings.breakSize);
  if (value.presets) settings.presets = normalizePresets(value.presets);
  if (!state.running && !state.completion && ((state.mode === 'focus' && changedFocus) || (state.mode === 'break' && changedBreak))) rearmAfterEdit();
  render();
});
window.notch.onCaptureRestored(() => { state.shortcutCapture = false; state.shortcutCandidate = ''; if (state.screen === 'shortcut') setScreen('settings'); else render(); });

setInterval(() => {
  if (!state.running) return;
  const remaining = currentRemaining();
  if (remaining <= 0) finishTimer(true);
  else { state.remaining = remaining; render(); }
}, 200);

(async function boot() {
  try {
    const saved = await window.notch.loadSettings();
    const presets = normalizePresets(saved.presets);
    const focusSize = normalizeSize(saved.focusSize, 'medium');
    const breakSize = normalizeSize(saved.breakSize, 'short');
    settings = {
      ...settings,
      presets,
      focusSize,
      breakSize,
      focusMin: Number.isInteger(saved.focusMin) ? saved.focusMin : presets.focus[focusSize],
      breakMin: Number.isInteger(saved.breakMin) ? saved.breakMin : presets.break[breakSize],
      launchAtLogin: !!saved.launchAtLogin,
      trayIcon: saved.trayIcon !== false,
      sound: saved.sound !== false,
      vignette: saved.vignette !== false,
      shortcut: saved.shortcut || 'Alt+Space',
    };
    tasks = Array.isArray(saved.tasks)
      ? saved.tasks.map((task) => ({ ...task, size: normalizeSize(task.size, 'medium') }))
      : [];
    armedTaskId = saved.armedTaskId || null;
    stats = { ...stats, ...(saved.stats || {}) };
  } catch (error) { showNotice(error?.message || 'Could not load settings', true); }
  state.remaining = durationSeconds();
  render();
})();
