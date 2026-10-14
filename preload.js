const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notch', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setTrayState: (state) => ipcRenderer.send('set-tray-state', state),
  quit: () => ipcRenderer.send('quit-app'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  setVignette: (on) => ipcRenderer.send('overlay-vignette', on),
  initiateFocus: (sessionId) => ipcRenderer.send('overlay-focus-init', sessionId),
  celebrate: (opts) => ipcRenderer.send('overlay-celebrate', opts),
  notify: (msg) => ipcRenderer.send('notify', msg),
  complete: (info) => ipcRenderer.invoke('session-complete', info),
  saveSettings: (s) => ipcRenderer.invoke('settings-save', s),
  saveTasks: (tasks, armedTaskId) => ipcRenderer.invoke('tasks-save', { tasks, armedTaskId }),
  setShortcutCapture: (capturing) => ipcRenderer.invoke('shortcut-capture', capturing),
  loadSettings: () => ipcRenderer.invoke('settings-load'),
  onCmd: (cb) => ipcRenderer.on('cmd', (_e, cmd) => cb(cmd)),
  onExpand: (cb) => ipcRenderer.on('expand', (_e, v) => cb(v)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
  onNavigate: (cb) => ipcRenderer.on('navigate', (_e, screen) => cb(screen)),
  onCaptureRestored: (cb) => ipcRenderer.on('capture-restored', cb),
});

contextBridge.exposeInMainWorld('overlay', {
  onVignette: (cb) => ipcRenderer.on('vignette', (_e, on) => cb(on)),
  onCelebrate: (cb) => ipcRenderer.on('celebrate', (_e, opts) => cb(opts)),
  onInitiateFocus: (cb) => ipcRenderer.on('focus-init', (_e, opts) => cb(opts)),
});
