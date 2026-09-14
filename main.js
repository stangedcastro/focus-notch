const fs = require('fs');
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, nativeImage } = require('electron');

const WIDTH = 420;
const HEIGHT = 180;
const PRELOAD = __dirname + '/preload.js';

let win;      // the notch
let overlay;  // full-screen ambient layer (vignette + completion bloom)
let tray;     // keep a strong reference for the lifetime of the app
let trayStateTimer = null;
let pendingTrayState = null;
let lastTrayUpdate = 0;

function showNotch() {
  if (!win || win.isDestroyed()) return;
  const display = screen.getDisplayMatching(win.getBounds());
  const [x] = win.getPosition();
  win.setPosition(x, display.bounds.y);
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.moveTop();
  win.focus();
}

// The notch sits at screen-saver level over the menu bar, so it covers whatever
// status items live behind it — including this app's own tray icon. That is fine:
// the tray exists for when the notch is hidden, so clicking it toggles.
function toggleNotch() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) win.hide(); else showNotch();
}

function quitApp() {
  if (overlay && !overlay.isDestroyed()) overlay.destroy();
  app.exit(0);
}

function trayClock(remaining) {
  const value = typeof remaining === 'string'
    ? remaining.split(':').reduce((total, part) => total * 60 + Number(part), 0)
    : Number(remaining);
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
}

function applyTrayState(state) {
  if (!tray) return;
  if (!state || !state.running) {
    tray.setToolTip('Pomodoro');
    tray.setTitle('', { fontType: 'monospacedDigit' });
    return;
  }

  const mode = String(state.mode || 'focus').toLowerCase() === 'break' ? 'Break' : 'Focus';
  const clock = trayClock(state.remaining);
  tray.setToolTip(`${clock} · ${mode}`);
  tray.setTitle(clock, { fontType: 'monospacedDigit' });
}

function setTrayState(state) {
  pendingTrayState = state;
  const elapsed = Date.now() - lastTrayUpdate;
  if (elapsed < 1000) {
    if (!trayStateTimer) trayStateTimer = setTimeout(() => {
      trayStateTimer = null;
      setTrayState(pendingTrayState);
    }, 1000 - elapsed);
    return;
  }
  lastTrayUpdate = Date.now();
  applyTrayState(pendingTrayState);
}

function createTray() {
  // createFromPath picks up the @2x sibling automatically and is far more
  // reliable than assembling representations by hand (which can silently
  // produce an empty image and a blank menu-bar slot).
  const image = nativeImage.createFromPath(__dirname + '/assets/trayTemplate.png');
  image.setTemplateImage(true);

  tray = new Tray(image);
  applyTrayState({ running: false });
  lastTrayUpdate = Date.now();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Notch', click: showNotch },
    { label: 'Hide Notch', click: () => win && !win.isDestroyed() && win.hide() },
    { label: 'Quit', click: quitApp },
  ]));
  tray.on('click', toggleNotch);
}

/* ---------------------------------------------------------------
   the notch — sits at the LITERAL top edge, above the menu bar.
   `bounds` (not workArea) is the whole display, so y = bounds.y is
   the physical top; workArea starts below the menu bar.
   --------------------------------------------------------------- */
function createNotch() {
  const { bounds } = screen.getPrimaryDisplay();
  const x = Math.round(bounds.x + (bounds.width - WIDTH) / 2);

  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    x,
    y: bounds.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    acceptFirstMouse: true,
    // without this macOS clamps the window down below the menu bar
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
    },
  });

  // above the menu bar (level 1000) and above the ambient overlay
  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile('index.html');

  // macOS sometimes clamps the initial y below the menu bar before the
  // elevated window level takes effect — force it back to the true top.
  win.setPosition(x, bounds.y);

  // The window is a 420x180 transparent box but only the notch shape is real
  // UI. Start click-through so the menu bar underneath stays usable; the
  // renderer flips this off while the cursor is actually over the island.
  // `forward: true` is what keeps mousemove flowing so it can tell.
  win.setIgnoreMouseEvents(true, { forward: true });
}

/* ---------------------------------------------------------------
   ambient overlay — covers the entire display (menu bar + dock
   included), never focusable, never clickable.
   --------------------------------------------------------------- */
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();

  overlay = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    skipTaskbar: true,
    focusable: false,
    fullscreenable: false,
    acceptFirstMouse: false,
    enableLargerThanScreen: true,
    show: false,
    type: 'panel',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
    },
  });

  // never intercepts the cursor — no forwarding needed, it wants no input at all
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

ipcMain.on('set-ignore-mouse', (_evt, ignore) => {
  if (win) win.setIgnoreMouseEvents(ignore, { forward: true });
});

// manual window drag: records the grab offset, then follows the cursor.
// Lets a tap stay a click (handled in renderer) while a drag moves the window.
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
  // settle z-order: overlay under, notch on top
  win.once('ready-to-show', () => { overlay.moveTop(); win.moveTop(); });
  screen.on('display-metrics-changed', fitOverlay);
  screen.on('display-added', fitOverlay);
  screen.on('display-removed', fitOverlay);
});

app.on('window-all-closed', () => app.quit());
