const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage, shell, globalShortcut, Notification } = require('electron');

const WIDTH = 420;
const HEIGHT = 260;
const PRELOAD = path.join(__dirname, 'preload.js');

let win;
let overlay;
let tray;
let trayStateTimer = null;
let pendingTrayState = null;
let lastTrayUpdate = 0;
let lastTrayMenuSig = '';

/* ---------- tiny persistent store (no deps, survives updates) ---------- */
const storePath = () => path.join(app.getPath('userData'), 'focus-notch.json');
function loadStore() {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8'));
  } catch {
    return { focusMin: 25, breakMin: 5, launchAtLogin: false, stats: { sessions: 0, minutes: 0, day: '', daySessions: 0 }, onboarded: false };
  }
}
function saveStore(s) {
  try { fs.mkdirSync(path.dirname(storePath()), { recursive: true }); fs.writeFileSync(storePath(), JSON.stringify(s)); } catch {}
}
let store = loadStore();
function todayKey() { return new Date().toISOString().slice(0, 10); }
if (store.stats.day !== todayKey()) { store.stats.day = todayKey(); store.stats.daySessions = 0; saveStore(store); }

function showNotch() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const [x] = win.getPosition();
  win.setPosition(x, display.bounds.y);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.moveTop();
  win.focus();
  win.webContents.send('expand', true);
}
function toggleNotch() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide(); else showNotch();
}
function quitApp() {
  try { globalShortcut.unregisterAll(); } catch {}
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
      label: 'Session length', submenu: [15, 25, 45, 60].map((m) => ({
        label: `${m} min`, type: 'radio', checked: store.focusMin === m,
        click: () => { store.focusMin = m; saveStore(store); send('settings', { focusMin: m, breakMin: store.breakMin }); rebuildTrayMenu(pendingTrayState); },
      })),
    },
    { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: showNotch },
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
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: showNotch },
        { type: 'separator' },
        { label: 'Hide Focus Notch', accelerator: 'CmdOrCtrl+H', click: () => win && win.hide() },
        { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' },
        { label: 'Quit Focus Notch', accelerator: 'CmdOrCtrl+Q', click: quitApp },
      ],
    },
    {
      label: 'Session',
      submenu: [
        { label: 'Start / Pause', accelerator: 'Space', click: () => send('cmd', 'toggle') },
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
        { label: 'Show / Hide Notch', accelerator: 'Alt+Space', click: toggleNotch },
        { role: 'toggleDevTools' },
      ],
    },
  ]));
}

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, 'assets', 'trayTemplate.png'));
  try { image.setTemplateImage(true); } catch {}
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  applyTrayState({ running: false });
  lastTrayUpdate = Date.now();
  rebuildTrayMenu({ running: false });
  tray.on('click', toggleNotch);
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
  win.setIgnoreMouseEvents(true, { forward: true });
  win.on('hide', () => { lastTrayMenuSig = ''; rebuildTrayMenu(pendingTrayState); });
  win.on('show', () => { lastTrayMenuSig = ''; rebuildTrayMenu(pendingTrayState); });
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
    webPreferences: { preload: PRELOAD, contextIsolation: true },
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

ipcMain.on('overlay-vignette', (_e, on) => toOverlay('vignette', on));
ipcMain.on('overlay-celebrate', (_e, opts) => toOverlay('celebrate', opts || {}));
ipcMain.on('set-tray-state', (_e, state) => setTrayState(state));
ipcMain.on('set-ignore-mouse', (_e, ignore) => { if (win) win.setIgnoreMouseEvents(ignore, { forward: true }); });
ipcMain.on('notify', (_e, { title, body }) => {
  try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch {}
});
ipcMain.on('session-complete', (_e, { mode, minutes }) => {
  if (store.stats.day !== todayKey()) { store.stats.day = todayKey(); store.stats.daySessions = 0; }
  store.stats.sessions += 1;
  store.stats.daySessions += 1;
  store.stats.minutes += Number(minutes) || 0;
  store.lastMode = mode;
  saveStore(store);
  lastTrayMenuSig = '';
  rebuildTrayMenu(pendingTrayState);
});
ipcMain.on('settings-save', (_e, s) => {
  if (s.focusMin) store.focusMin = s.focusMin;
  if (s.breakMin) store.breakMin = s.breakMin;
  if (typeof s.launchAtLogin === 'boolean') { store.launchAtLogin = s.launchAtLogin; try { app.setLoginItemSettings({ openAtLogin: s.launchAtLogin }); } catch {} }
  saveStore(store);
  lastTrayMenuSig = '';
  rebuildTrayMenu(pendingTrayState);
});
ipcMain.handle('settings-load', () => ({ ...store, storePath: storePath() }));

let dragGrab = null;
ipcMain.on('drag-start', () => {
  if (!win) return;
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragGrab = { dx: cursor.x - wx, dy: cursor.y - wy };
});
ipcMain.on('drag-move', () => {
  if (!win || !dragGrab) return;
  const cursor = screen.getCursorScreenPoint();
  win.setPosition(cursor.x - dragGrab.dx, Math.max(0, cursor.y - dragGrab.dy));
});
ipcMain.on('quit-app', quitApp);

app.whenReady().then(() => {
  createTray();
  createOverlay();
  createNotch();
  buildAppMenu();
  win.once('ready-to-show', () => { overlay.moveTop(); win.moveTop(); });
  try {
    app.setLoginItemSettings({ openAtLogin: !!store.launchAtLogin });
    globalShortcut.register('Alt+Space', toggleNotch);
  } catch {}
  if (!store.onboarded) {
    store.onboarded = true; saveStore(store);
    win.once('ready-to-show', () => setTimeout(showNotch, 600));
  }
  screen.on('display-metrics-changed', fitOverlay);
  screen.on('display-added', fitOverlay);
  screen.on('display-removed', fitOverlay);
  app.on('activate', showNotch);
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch {} });
