const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Module = require('module');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-notch-native-'));
const today = new Date().toISOString().slice(0, 10);
const dataFile = path.join(userData, 'focus-notch.json');
fs.writeFileSync(dataFile, JSON.stringify({
  focusMin: 45, breakMin: 5, onboarded: true, legacyField: 'preserve me',
  stats: { sessions: 2, minutes: 90, day: today, daySessions: 2 },
}));

let failShortcut = null;
let failLogin = false;
let mismatchLogin = false;
let failBeep = false;
let loginAtLaunch = false;
let beepCount = 0;
let trayCount = 0;
let destroyedTrayCount = 0;
let menuTemplate;
let notchWindow;
const overlayMessages = [];
const shortcuts = new Set();
const handlers = new Map();
const ipcEvents = new Map();
const displayEvents = new Map();
let cursor = { x: 0, y: 0 };
let displayBounds = { x: 0, y: 0, width: 1440, height: 900 };

class FakeWindow extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.bounds = { x: options.x || 0, y: options.y || 0, width: options.width, height: options.height };
    this.visible = false; this.destroyed = false; this.webContents = { send: (channel, payload) => { if (options.width !== 420) overlayMessages.push({ channel, payload }); }, once: (_event, cb) => setImmediate(cb) };
    if (!notchWindow && options.width === 420) notchWindow = this;
  }
  loadFile() {} setAlwaysOnTop() {} setVisibleOnAllWorkspaces() {} setIgnoreMouseEvents() {}
  setPosition(x, y) { this.bounds.x = x; this.bounds.y = y; this.emit('move'); }
  setBounds(bounds) { this.bounds = bounds; } getBounds() { return this.bounds; }
  getPosition() { return [this.bounds.x, this.bounds.y]; }
  isDestroyed() { return this.destroyed; } isMinimized() { return false; }
  isVisible() { return this.visible; } show() { this.visible = true; } hide() { this.visible = false; }
  restore() {} moveTop() {} focus() {} showInactive() {} destroy() { this.destroyed = true; }
}
class FakeTray extends EventEmitter {
  constructor() { super(); trayCount++; }
  setToolTip() {} setTitle() {} setContextMenu() {}
  destroy() { destroyedTrayCount++; }
}
class FakeNotification { static isSupported() { return false; } }
const menu = { buildFromTemplate: (template) => template, setApplicationMenu: (template) => { menuTemplate = template; } };
const electron = {
  app: {
    getPath: () => userData, whenReady: () => Promise.resolve(), on() {}, exit() {},
    setLoginItemSettings: ({ openAtLogin }) => { if (failLogin) throw new Error('simulated OS denial'); loginAtLaunch = mismatchLogin && openAtLogin ? false : openAtLogin; },
    getLoginItemSettings: () => ({ openAtLogin: loginAtLaunch }),
  },
  BrowserWindow: FakeWindow,
  screen: {
    getPrimaryDisplay: () => ({ bounds: displayBounds }),
    getDisplayMatching: () => ({ bounds: displayBounds }),
    getCursorScreenPoint: () => cursor,
    on: (name, handler) => displayEvents.set(name, handler),
  },
  ipcMain: { on: (name, handler) => ipcEvents.set(name, handler), handle: (name, handler) => handlers.set(name, handler) },
  Tray: FakeTray, Menu: menu,
  nativeImage: { createFromPath: () => ({ setTemplateImage() {}, isEmpty: () => false }), createEmpty: () => ({}) },
  shell: { showItemInFolder() {}, beep: () => { if (failBeep) throw new Error('simulated sound failure'); beepCount++; } },
  globalShortcut: {
    register: (key) => { if (key === failShortcut) return false; shortcuts.add(key); return true; },
    unregister: (key) => shortcuts.delete(key), unregisterAll: () => shortcuts.clear(),
  },
  Notification: FakeNotification,
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) { return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain); };
require('../main');
Module._load = originalLoad;

const call = async (name, value) => handlers.get(name)({}, value);
const pause = () => new Promise((resolve) => setImmediate(resolve));

(async () => {
  await pause();
  let loaded = await call('settings-load');
  assert.equal(loaded.focusMin, 45); assert.equal(loaded.legacyField, 'preserve me');
  assert.deepEqual(loaded.tasks, []); assert.equal(loaded.shortcut, 'Alt+Space');
  assert.deepEqual(notchWindow.options.width, 420); assert.equal(notchWindow.options.height, 290);
  assert.equal(notchWindow.options.y, 0); assert(shortcuts.has('Alt+Space'));
  const initiate = (value) => ipcEvents.get('overlay-focus-init')({}, value);
  initiate({ invalid: true });
  assert.equal(overlayMessages.length, 0, 'Malformed intro is ignored');
  initiate('focus-first'); initiate('focus-first');
  assert.deepEqual(overlayMessages, [{ channel:'focus-init', payload:{ visual:true, sound:true } }], 'Start cue honors enabled preferences and dedupes');
  initiate(null);
  assert.equal(overlayMessages.at(-1).payload, null, 'Pause/reset cancels intro');

  const emitDrag = (name) => ipcEvents.get(name)({});
  cursor = { x: 600, y: 40 };
  emitDrag('drag-start');
  cursor = { x: 740, y: 480 };
  emitDrag('drag-move');
  assert.deepEqual(notchWindow.getPosition(), [650, 0], 'X follows drag; Y stays at screen top');
  emitDrag('drag-end');
  cursor = { x: 900, y: 700 };
  emitDrag('drag-move');
  assert.deepEqual(notchWindow.getPosition(), [650, 0], 'released drag cannot keep moving');
  displayBounds = { x: -1600, y: -900, width: 1600, height: 900 };
  notchWindow.setPosition(-1100, -600);
  assert.equal(notchWindow.getPosition()[1], -900, 'native moves also pin to a negative display origin');
  cursor = { x: -1000, y: -880 };
  emitDrag('drag-start');
  cursor = { x: -800, y: 400 };
  emitDrag('drag-move');
  assert.deepEqual(notchWindow.getPosition(), [-900, -900]);
  cursor = { x: 5000, y: 2000 };
  emitDrag('drag-move');
  assert.deepEqual(notchWindow.getPosition(), [-420, -900], 'right boundary keeps the notch on its display');
  cursor = { x: -5000, y: -2000 };
  emitDrag('drag-move');
  assert.deepEqual(notchWindow.getPosition(), [-1600, -900], 'left boundary keeps the notch on its display');
  displayBounds = { x: 0, y: 0, width: 1440, height: 900 };
  displayEvents.get('display-removed')();
  assert.deepEqual(notchWindow.getPosition(), [0, 0], 'display changes reattach the notch to a valid top edge');
  cursor = { x: 700, y: 20 };
  emitDrag('drag-move');
  assert.deepEqual(notchWindow.getPosition(), [0, 0], 'display changes cancel stale drags');

  await assert.rejects(call('settings-save', { focusMin: 0 }));
  assert.equal((await call('settings-load')).focusMin, 45);
  let saved = await call('tasks-save', { tasks: [{ id: 'task-1', title: '  Draft  ', estimate: 2, done: 0, archived: false }], armedTaskId: 'task-1' });
  assert.equal(saved.tasks[0].title, 'Draft');
  await assert.rejects(call('tasks-save', { tasks: [{ id: 'task-1', title: 'Draft', estimate: 2, done: 0, archived: true }], armedTaskId: 'task-1' }));
  const beforeInvalidTasks = fs.readFileSync(dataFile, 'utf8');
  await assert.rejects(call('tasks-save', { tasks: [{ id: 'task-1', title: 'A', estimate: 1, done: 0, archived: false }, { id: 'task-1', title: 'B', estimate: 1, done: 0, archived: false }], armedTaskId: null }));
  assert.equal(fs.readFileSync(dataFile, 'utf8'), beforeInvalidTasks);

  const oldRename = fs.renameSync;
  fs.renameSync = function (from, to) { if (to === dataFile) throw new Error('simulated disk failure'); return oldRename.call(this, from, to); };
  await assert.rejects(call('tasks-save', { tasks: [], armedTaskId: null }));
  fs.renameSync = oldRename;
  loaded = await call('settings-load'); assert.equal(loaded.tasks[0].id, 'task-1');
  assert.deepEqual(fs.readdirSync(userData).filter((name) => name.endsWith('.tmp')), []);

  const first = await call('session-complete', { mode: 'focus', minutes: 25, taskId: 'task-1', sessionId: 'session-1' });
  assert.equal(first.tasks[0].done, 1); assert.equal(first.stats.sessions, 3);
  const duplicate = await call('session-complete', { mode: 'focus', minutes: 25, taskId: 'task-1', sessionId: 'session-1' });
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.tasks[0].done, 1); assert.equal(duplicate.stats.sessions, 3);
  await call('tasks-save', { tasks: [{ id: 'task-1', title: 'Draft', estimate: 2, done: 0, archived: false }], armedTaskId: 'task-1' });
  assert.equal((await call('settings-load')).tasks[0].done, 1); // stale renderer snapshot cannot erase a completion
  const afterFocus = JSON.stringify((await call('settings-load')).stats);
  await call('session-complete', { mode: 'break', minutes: 5, sessionId: 'break-1' });
  assert.equal(JSON.stringify((await call('settings-load')).stats), afterFocus);
  assert.equal(beepCount, 2);
  await call('session-complete', { mode: 'focus', minutes: 1 }); // Existing renderer payload remains accepted, without task credit.
  assert.equal((await call('settings-load')).tasks[0].done, 1);
  failBeep = true;
  await call('session-complete', { mode: 'focus', minutes: 1, sessionId: 'session-silent' });
  failBeep = false;
  await assert.rejects(call('session-complete', { mode: 'focus', minutes: 91, sessionId: 'invalid-minutes' }));

  failShortcut = 'Ctrl+X';
  await assert.rejects(call('settings-save', { shortcut: 'Ctrl+X' }));
  assert(shortcuts.has('Alt+Space')); assert(!shortcuts.has('Ctrl+X'));
  await assert.rejects(call('settings-save', { shortcut: 'A' }));
  const changed = await call('settings-save', { shortcut: 'Ctrl+Shift+J', trayIcon: false, sound: false, vignette: false });
  assert.equal(changed.shortcut, 'Ctrl+Shift+J'); assert.equal(trayCount, 1); assert.equal(destroyedTrayCount, 1);
  assert(shortcuts.has('Ctrl+Shift+J')); assert(!shortcuts.has('Alt+Space'));
  assert.equal(changed.vignette, false);
  initiate('focus-muted');
  assert.deepEqual(overlayMessages.at(-1), { channel:'focus-init', payload:{ visual:false, sound:false } }, 'Disabled sensory preferences are respected');
  await call('settings-save', { sound:true });
  initiate('focus-audio-only');
  assert.deepEqual(overlayMessages.at(-1).payload, { visual:false, sound:true }, 'Sound can be enabled independently');
  await call('settings-save', { sound:false, vignette:true });
  initiate('focus-visual-only');
  assert.deepEqual(overlayMessages.at(-1).payload, { visual:true, sound:false }, 'Visual can be enabled independently');

  await call('shortcut-capture', true);
  assert(!shortcuts.has('Ctrl+Shift+J'));
  const viewMenu = menuTemplate.find((section) => section.label === 'View').submenu[0];
  assert.equal(viewMenu.accelerator, undefined);
  await call('shortcut-capture', false);
  assert(shortcuts.has('Ctrl+Shift+J'));

  failLogin = true;
  await assert.rejects(call('settings-save', { launchAtLogin: true }));
  assert.equal((await call('settings-load')).launchAtLogin, false);
  failLogin = false;
  mismatchLogin = true;
  await assert.rejects(call('settings-save', { launchAtLogin: true }));
  assert.equal((await call('settings-load')).launchAtLogin, false); assert.equal(loginAtLaunch, false);
  mismatchLogin = false;
  const login = await call('settings-save', { launchAtLogin: true });
  assert.equal(login.launchAtLoginResult, true); assert.equal(loginAtLaunch, true);

  fs.rmSync(userData, { recursive: true, force: true });
  console.log('Native foundations: isolated persistence, validation, rollback, dedupe, tray and shortcut checks passed.');
})().catch((error) => {
  fs.rmSync(userData, { recursive: true, force: true });
  console.error(error);
  process.exitCode = 1;
});
