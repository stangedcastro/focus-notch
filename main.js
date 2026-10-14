const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, shell, globalShortcut, Notification } = require('electron');

const WIDTH = 420;
const HEIGHT = 290;
const PRELOAD = path.join(__dirname, 'preload.js');

let win;
let overlay;
let tray;
let trayStateTimer = null;
let pendingTrayState = null;
let lastTrayUpdate = 0;
let lastTrayMenuSig = '';
let registeredShortcut = null;
let shortcutCapturing = false;
let requestedVignette = false;
let lastFocusInitiationId = null;

/* ---------- tiny persistent store (no deps, survives updates) ---------- */
const storePath = () => path.join(app.getPath('userData'), 'focus-notch.json');
const SIZE_KEYS = ['short', 'medium', 'long'];
const DEFAULT_PRESETS = {
  focus: { short: 15, medium: 30, long: 60 },
  break: { short: 5, medium: 10, long: 15 },
};
function clampMin(value, fallback) {
  return Number.isInteger(value) && value >= 1 && value <= 90 ? value : fallback;
}
function normalizePresets(raw) {
  const out = {
    focus: { ...DEFAULT_PRESETS.focus },
    break: { ...DEFAULT_PRESETS.break },
  };
  for (const mode of ['focus', 'break']) {
    for (const size of SIZE_KEYS) {
      out[mode][size] = clampMin(raw?.[mode]?.[size], DEFAULT_PRESETS[mode][size]);
    }
  }
  return out;
}
function normalizeSize(value, fallback = 'medium') {
  return SIZE_KEYS.includes(value) ? value : fallback;
}
function loadStore() {
  const defaults = {
    focusMin: 30, breakMin: 5, focusSize: 'medium', breakSize: 'short',
    presets: normalizePresets(DEFAULT_PRESETS), launchAtLogin: false,
    stats: { sessions: 0, minutes: 0, day: '', daySessions: 0 }, onboarded: false,
    tasks: [], armedTaskId: null, trayIcon: true, sound: true, vignette: true,
    shortcut: 'Alt+Space', completedSessionIds: [],
  };
  try {
    const saved = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    const presets = normalizePresets(saved.presets);
    const focusSize = normalizeSize(saved.focusSize, 'medium');
    const breakSize = normalizeSize(saved.breakSize, 'short');
    return {
      ...defaults, ...saved,
      presets, focusSize, breakSize,
      focusMin: clampMin(saved.focusMin, presets.focus[focusSize]),
      breakMin: clampMin(saved.breakMin, presets.break[breakSize]),
      stats: { ...defaults.stats, ...(saved.stats || {}) },
      tasks: Array.isArray(saved.tasks) ? saved.tasks : defaults.tasks,
      completedSessionIds: Array.isArray(saved.completedSessionIds) ? saved.completedSessionIds : defaults.completedSessionIds,
    };
  } catch {
    return defaults;
  }
}
function saveStore(s) {
  const target = storePath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temp, JSON.stringify(s), { flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    throw error;
  }
}
let store = loadStore();
function todayKey() { return new Date().toISOString().slice(0, 10); }
if (store.stats.day !== todayKey()) { store.stats.day = todayKey(); store.stats.daySessions = 0; saveStore(store); }

function pinNotchToTop(bounds = null) {
  if (!win || win.isDestroyed()) return;
  const displayBounds = bounds || screen.getDisplayMatching(win.getBounds()).bounds;
  const [x, y] = win.getPosition();
  const nextX = Math.round(Math.max(displayBounds.x, Math.min(x, displayBounds.x + Math.max(0, displayBounds.width - WIDTH))));
  if (x !== nextX || y !== displayBounds.y) win.setPosition(nextX, displayBounds.y);
}

function showNotch() {
  if (!win || win.isDestroyed()) return;
  pinNotchToTop();
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.moveTop();
  win.focus();
  win.webContents.send('expand', true);
}
function toggleNotch() {
  if (!win || win.isDestroyed() || shortcutCapturing) return;
  if (win.isVisible()) win.hide(); else showNotch();
}
function quitApp() {
  try { if (registeredShortcut) globalShortcut.unregister(registeredShortcut); } catch {}
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  app.exit(0);
}

function trayClock(remaining) {
  const value = typeof remaining === 'string'
    ? remaining.split(':').reduce((t, p) => t * 60 + Number(p), 0)
    : Number(remaining);
  const s = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function applyTrayState(state) {
  if (!tray) return;
  if (!state || !state.running) {
    tray.setToolTip('Focus Notch — ready');
    try { tray.setTitle('', { fontType: 'monospacedDigit' }); } catch {}
  } else {
    const mode = String(state.mode || 'focus').toLowerCase() === 'break' ? 'Break' : 'Focus';
    const clock = trayClock(state.remaining);
    tray.setToolTip(`${clock} · ${mode} — Focus Notch`);
    try { tray.setTitle(clock, { fontType: 'monospacedDigit' }); } catch {}
  }
  rebuildTrayMenu(state);
}

function setTrayState(state) {
  pendingTrayState = state;
  const elapsed = Date.now() - lastTrayUpdate;
  if (elapsed < 1000) {
    if (!trayStateTimer) trayStateTimer = setTimeout(() => { trayStateTimer = null; setTrayState(pendingTrayState); }, 1000 - elapsed);
    return;
  }
  lastTrayUpdate = Date.now();
  applyTrayState(pendingTrayState);
}

/* ---------- the sell-ready topbar launcher ---------- */
function rebuildTrayMenu(state = {}) {
  if (!tray) return;
  state ||= {};
  const running = !!state.running;
  const mode = String(state.mode || store.lastMode || 'focus').toLowerCase();
  const clock = trayClock(state.remaining ?? (mode === 'break' ? store.breakMin * 60 : store.focusMin * 60));
  const sig = `${running}|${mode}|${clock.slice(0, 4)}|${store.focusMin}|${store.breakMin}|${win?.isVisible()}`;
  if (sig === lastTrayMenuSig) return;
  lastTrayMenuSig = sig;

  const send = (ch, ...a) => { if (win && !win.isDestroyed()) win.webContents.send(ch, ...a); };
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? `${clock} · ${mode === 'break' ? 'Break' : 'Focus'}` : 'Focus Notch — ready', enabled: false },
    { type: 'separator' },
    running
      ? { label: 'Pause', click: () => send('cmd', 'pause') }
      : { label: `Start Focus · ${store.focusMin}m`, click: () => send('cmd', 'start-focus') },
    running
      ? { label: 'Finish now', click: () => send('cmd', 'finish') }
      : { label: `Start Break · ${store.breakMin}m`, click: () => send('cmd', 'start-break') },
    { label: 'Reset timer', click: () => send('cmd', 'reset') },
    { type: 'separator' },
    { label: win && win.isVisible() ? 'Hide Notch' : 'Show Notch', click: toggleNotch },
    {
      label: 'Focus length', submenu: SIZE_KEYS.map((size) => {
        const m = store.presets.focus[size];
        return {
          label: `${size[0].toUpperCase()}${size.slice(1)} · ${m}m`,
          type: 'radio',
          checked: store.focusSize === size,
          click: () => {
            const next = { ...store, focusSize: size, focusMin: m };
            try { saveStore(next); store = next; } catch { return; }
            send('settings', { focusMin: m, focusSize: size, breakMin: store.breakMin, breakSize: store.breakSize, presets: store.presets });
            rebuildTrayMenu(pendingTrayState);
          },
        };
      }),
    },
    { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => { showNotch(); if (win && !win.isDestroyed()) win.webContents.send('navigate', 'settings'); } },
    { type: 'separator' },
    { label: `Today: ${store.stats.daySessions} sessions`, enabled: false },
    { label: 'Reveal data folder', click: () => shell.showItemInFolder(storePath()) },
    { type: 'separator' },
    { label: 'Quit Focus Notch', click: quitApp },
  ]));
}

/* ---------- native app menu (menu bar when focused) ---------- */
function buildAppMenu() {
  const send = (ch, ...a) => { if (win && !win.isDestroyed()) { showNotch(); win.webContents.send(ch, ...a); } };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Focus Notch',
      submenu: [
        { label: 'About Focus Notch', click: showNotch },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => { showNotch(); if (win && !win.isDestroyed()) win.webContents.send('navigate', 'settings'); } },
        { type: 'separator' },
        { label: 'Hide Focus Notch', accelerator: 'CmdOrCtrl+H', click: () => win && win.hide() },
        { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: 'Quit Focus Notch', accelerator: 'CmdOrCtrl+Q', click: quitApp },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Session',
      submenu: [
        { label: 'Start / Pause', click: () => send('cmd', 'toggle') },
        { label: 'Finish now', click: () => send('cmd', 'finish') },
        { label: 'Reset', accelerator: 'CmdOrCtrl+R', click: () => send('cmd', 'reset') },
        { type: 'separator' },
        { label: 'Focus 25m', click: () => send('cmd', 'start-focus') },
        { label: 'Break 5m', click: () => send('cmd', 'start-break') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Show / Hide Notch', accelerator: shortcutCapturing ? undefined : store.shortcut, click: toggleNotch },
        { role: 'toggleDevTools' },
      ],
    },
  ]));
}

function createTray(force = false) {
  if (tray || (!force && !store.trayIcon)) return;
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  try { image.setTemplateImage(true); } catch {}
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  applyTrayState({ running: false });
  lastTrayUpdate = Date.now();
  rebuildTrayMenu({ running: false });
  tray.on('click', toggleNotch);
}

function setTrayEnabled(enabled) {
  if (enabled) createTray(true);
  else if (tray) { tray.destroy(); tray = null; lastTrayMenuSig = ''; }
}

function setLaunchAtLogin(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
  const actual = app.getLoginItemSettings()?.openAtLogin;
  if (typeof actual !== 'boolean' || actual !== enabled) {
    throw new Error(`Launch at login was not accepted by the OS (requested ${enabled}, received ${String(actual)}).`);
  }
  return actual;
}

function validateShortcut(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Shortcut must be a nonempty accelerator.');
  const parts = value.trim().split('+').map((part) => part.trim());
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  const required = new Set(['alt', 'control', 'ctrl', 'command', 'cmd', 'commandorcontrol', 'cmdorctrl']);
  if (!parts.at(-1) || !modifiers.some((modifier) => required.has(modifier))) {
    throw new Error('Shortcut must include Alt, Control, or Command plus a key.');
  }
  if (parts.some((part) => !part) || new Set(modifiers).size !== modifiers.length) throw new Error('Shortcut contains an empty or repeated modifier.');
  return parts.join('+');
}

function registerShortcut(accelerator) {
  const next = validateShortcut(accelerator);
  if (next === registeredShortcut) return next;
  if (!globalShortcut.register(next, toggleNotch)) throw new Error(`Shortcut is unavailable: ${next}`);
  const previous = registeredShortcut;
  registeredShortcut = next;
  if (previous) globalShortcut.unregister(previous);
  return next;
}

function setShortcutCapture(capturing) {
  if (capturing === shortcutCapturing) return { capturing, shortcut: store.shortcut };
  if (capturing) {
    if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
    registeredShortcut = null;
    shortcutCapturing = true;
    buildAppMenu();
    return { capturing: true, shortcut: store.shortcut };
  }
  shortcutCapturing = false;
  try {
    registerShortcut(store.shortcut);
    buildAppMenu();
    return { capturing: false, shortcut: store.shortcut };
  } catch (error) {
    shortcutCapturing = true;
    buildAppMenu();
    throw error;
  }
}

function createNotch() {
  const { bounds } = screen.getPrimaryDisplay();
  const x = Math.round(bounds.x + (bounds.width - WIDTH) / 2);
  win = new BrowserWindow({
    width: WIDTH, height: HEIGHT, x, y: bounds.y,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    movable: true, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false,
    acceptFirstMouse: true, enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');
  win.setPosition(x, bounds.y);
  win.on('move', () => pinNotchToTop(dragGrab?.bounds));
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on('hide', () => { lastTrayMenuSig = ''; rebuildTrayMenu(pendingTrayState); });
  win.on('show', () => { lastTrayMenuSig = ''; rebuildTrayMenu(pendingTrayState); });
  const restoreShortcutCapture = () => {
    if (!shortcutCapturing) return;
    try { setShortcutCapture(false); win.webContents.send('capture-restored'); }
    catch (error) { console.error(error); }
  };
  win.on('blur', restoreShortcutCapture);
  win.on('hide', restoreShortcutCapture);
}

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    frame: false, transparent: true, hasShadow: false, resizable: false,
    movable: false, minimizable: false, maximizable: false, closable: false,
    skipTaskbar: true, focusable: false, fullscreenable: false,
    acceptFirstMouse: false, enableLargerThanScreen: true, show: false, type: 'panel',
    backgroundColor: '#00000000',
    webPreferences: { preload: PRELOAD, contextIsolation: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
  });
  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, 'screen-saver', 0);
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile('overlay.html');
  overlay.once('ready-to-show', () => overlay.showInactive());
}

function fitOverlay() {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.setBounds(screen.getPrimaryDisplay().bounds);
}

const toOverlay = (channel, payload) => {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, payload);
};

ipcMain.on('overlay-vignette', (_e, on) => { requestedVignette = !!on; toOverlay('vignette', store.vignette && requestedVignette); });
ipcMain.on('overlay-focus-init', (_e, sessionId) => {
  if (sessionId === null) { toOverlay('focus-init', null); return; }
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 128 || sessionId === lastFocusInitiationId) return;
  lastFocusInitiationId = sessionId;
  toOverlay('focus-init', { visual: store.vignette, sound: store.sound });
});
ipcMain.on('overlay-celebrate', (_e, opts) => toOverlay('celebrate', opts || {}));
ipcMain.on('set-tray-state', (_e, state) => setTrayState(state));
ipcMain.on('set-ignore-mouse', (_e, ignore) => { if (win) win.setIgnoreMouseEvents(ignore, { forward: true }); });
ipcMain.on('notify', (_e, { title, body }) => {
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch {}
});
ipcMain.handle('session-complete', (_e, info = {}) => {
  const { mode, minutes, taskId, sessionId } = info;
  if (!['focus', 'break'].includes(mode) || !Number.isInteger(minutes) || minutes < 0 || minutes > 90) throw new Error('Invalid completed session.');
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 128)) throw new Error('Session ID must contain 1 to 128 characters.');
  const candidate = { ...store, stats: { ...store.stats }, tasks: store.tasks.map((task) => ({ ...task })), completedSessionIds: [...store.completedSessionIds] };
  if (sessionId && candidate.completedSessionIds.includes(sessionId)) return { duplicate: true, tasks: candidate.tasks, stats: candidate.stats };
  if (candidate.stats.day !== todayKey()) { candidate.stats.day = todayKey(); candidate.stats.daySessions = 0; }
  if (mode === 'focus') {
    candidate.stats.sessions += 1;
    candidate.stats.daySessions += 1;
    candidate.stats.minutes += Number(minutes) || 0;
    if (sessionId && typeof taskId === 'string') {
      const task = candidate.tasks.find((item) => item.id === taskId && !item.archived);
      if (task) task.done += 1;
    }
  }
  candidate.lastMode = mode;
  if (sessionId) candidate.completedSessionIds = [...candidate.completedSessionIds, sessionId].slice(-2000);
  saveStore(candidate);
  store = candidate;
  if (store.sound) { try { shell.beep(); } catch {} }
  lastTrayMenuSig = '';
  rebuildTrayMenu(pendingTrayState);
  return { duplicate: false, tasks: store.tasks, stats: store.stats };
});
ipcMain.handle('settings-save', (_e, s = {}) => {
  const allowed = new Set(['focusMin', 'breakMin', 'focusSize', 'breakSize', 'presets', 'launchAtLogin', 'trayIcon', 'sound', 'vignette', 'shortcut']);
  for (const key of Object.keys(s)) if (!allowed.has(key)) throw new Error(`Unknown setting: ${key}`);
  const patch = {};
  for (const key of ['focusMin', 'breakMin']) if (key in s) {
    if (!Number.isInteger(s[key]) || s[key] < 1 || s[key] > 90) throw new Error(`${key} must be an integer from 1 to 90.`);
    patch[key] = s[key];
  }
  for (const key of ['focusSize', 'breakSize']) if (key in s) {
    if (!SIZE_KEYS.includes(s[key])) throw new Error(`${key} must be short, medium, or long.`);
    patch[key] = s[key];
  }
  if ('presets' in s) patch.presets = normalizePresets(s.presets);
  for (const key of ['launchAtLogin', 'trayIcon', 'sound', 'vignette']) if (key in s) {
    if (typeof s[key] !== 'boolean') throw new Error(`${key} must be boolean.`);
    patch[key] = s[key];
  }
  if ('shortcut' in s) patch.shortcut = validateShortcut(s.shortcut);
  const previous = store;
  const candidate = { ...store, ...patch };
  let launchAtLoginResult;
  let launchChanged = false, shortcutChanged = false, trayChanged = false;
  try {
    if ('launchAtLogin' in patch) {
      launchChanged = patch.launchAtLogin !== store.launchAtLogin;
      launchAtLoginResult = setLaunchAtLogin(patch.launchAtLogin);
    }
    if (patch.shortcut && patch.shortcut !== store.shortcut) { registerShortcut(patch.shortcut); shortcutChanged = true; }
    if ('trayIcon' in patch && patch.trayIcon !== store.trayIcon) { setTrayEnabled(patch.trayIcon); trayChanged = true; }
    saveStore(candidate);
  } catch (error) {
    if (trayChanged) { try { setTrayEnabled(previous.trayIcon); } catch {} }
    if (shortcutChanged) { try { registerShortcut(previous.shortcut); } catch {} }
    if (launchChanged) { try { setLaunchAtLogin(previous.launchAtLogin); } catch {} }
    throw error;
  }
  store = candidate;
  if ('vignette' in patch) toOverlay('vignette', store.vignette && requestedVignette);
  if (patch.vignette === false || patch.sound === false) toOverlay('focus-init', null);
  if (shortcutChanged && !shortcutCapturing) buildAppMenu();
  lastTrayMenuSig = '';
  rebuildTrayMenu(pendingTrayState);
  return { ...store, launchAtLoginResult: 'launchAtLogin' in patch ? (launchAtLoginResult ?? store.launchAtLogin) : undefined };
});
ipcMain.handle('settings-load', () => ({ ...store, storePath: storePath() }));
ipcMain.handle('tasks-save', (_e, { tasks, armedTaskId = null } = {}) => {
  if (!Array.isArray(tasks)) throw new Error('Tasks must be an array.');
  const ids = new Set();
  const accepted = tasks.map((task) => {
    if (!task || typeof task.id !== 'string' || !task.id.trim() || ids.has(task.id)) throw new Error('Task IDs must be nonempty and unique.');
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.trim().length > 120) throw new Error('Task titles must contain 1 to 120 characters.');
    if (!Number.isInteger(task.estimate) || task.estimate < 1 || task.estimate > 99) throw new Error('Task estimate must be an integer from 1 to 99.');
    if (!Number.isInteger(task.done) || task.done < 0 || typeof task.archived !== 'boolean') throw new Error('Task progress or archive state is invalid.');
    ids.add(task.id);
    const existing = store.tasks.find((saved) => saved.id === task.id);
    const size = normalizeSize(task.size, existing?.size || 'medium');
    return { id: task.id, title: task.title.trim(), estimate: task.estimate, done: existing ? existing.done : task.done, archived: task.archived, size };
  });
  if (armedTaskId !== null && (typeof armedTaskId !== 'string' || !ids.has(armedTaskId) || accepted.find((task) => task.id === armedTaskId)?.archived)) throw new Error('Armed task must identify an active saved task or be null.');
  const candidate = { ...store, tasks: accepted, armedTaskId };
  saveStore(candidate);
  store = candidate;
  return { tasks: store.tasks, armedTaskId: store.armedTaskId };
});
ipcMain.handle('shortcut-capture', (_e, capturing) => {
  if (typeof capturing !== 'boolean') throw new Error('Shortcut capture state must be boolean.');
  return setShortcutCapture(capturing);
});

let dragGrab = null;
ipcMain.on('drag-start', () => {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx] = win.getPosition();
  dragGrab = { dx: cursor.x - wx, bounds: screen.getDisplayMatching(win.getBounds()).bounds };
  pinNotchToTop(dragGrab.bounds);
});
ipcMain.on('drag-move', () => {
  if (!win || !dragGrab) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = dragGrab.bounds;
  const x = Math.round(Math.max(bounds.x, Math.min(cursor.x - dragGrab.dx, bounds.x + Math.max(0, bounds.width - WIDTH))));
  win.setPosition(x, bounds.y);
});
ipcMain.on('drag-end', () => { dragGrab = null; });
ipcMain.on('quit-app', quitApp);

app.whenReady().then(() => {
  createTray();
  createOverlay();
  createNotch();
  buildAppMenu();
  win.once('ready-to-show', () => { overlay.moveTop(); win.moveTop(); });
  try { setLaunchAtLogin(!!store.launchAtLogin); } catch (error) { console.error(error); }
  try { registerShortcut(store.shortcut); } catch (error) { console.error(error); }
  if (!store.onboarded) {
    store.onboarded = true; saveStore(store);
    win.once('ready-to-show', () => setTimeout(showNotch, 600));
  }
  const fitWindows = () => { dragGrab = null; fitOverlay(); pinNotchToTop(); };
  screen.on('display-metrics-changed', fitWindows);
  screen.on('display-added', fitWindows);
  screen.on('display-removed', fitWindows);
  app.on('activate', showNotch);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
