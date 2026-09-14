const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notch', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setTrayState: (state) => ipcRenderer.send('set-tray-state', state),
  quit: () => ipcRenderer.send('quit-app'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  setVignette: (on) => ipcRenderer.send('overlay-vignette', on),
  celebrate: (opts) => ipcRenderer.send('overlay-celebrate', opts),
  notify: (msg) => ipcRenderer.send('notify', msg),
  complete: (info) => ipcRenderer.send('session-complete', info),
  saveSettings: (s) => ipcRenderer.send('settings-save', s),
  loadSettings: () => ipcRenderer.invoke('settings-load'),
  onCmd: (cb) => ipcRenderer.on('cmd', (_e, cmd) => cb(cmd)),
  onExpand: (cb) => ipcRenderer.on('expand', (_e, v) => cb(v)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),
});

window.addEventListener('DOMContentLoaded', () => {
  const island = document.getElementById('island');
  const pillTime = document.getElementById('pillTime');
  const unit = document.querySelector('#dialSub') || document.querySelector('#cueSub');
  if (!island || !pillTime) return;
  const pushTrayState = () => {
    const [m, s] = pillTime.textContent.trim().split(':').map(Number);
    ipcRenderer.send('set-tray-state', {
      mode: unit ? unit.textContent.trim().toLowerCase() : 'focus',
      remaining: (m || 0) * 60 + (s || 0),
      running: island.classList.contains('running'),
    });
  };
  pushTrayState();
  setInterval(pushTrayState, 1000);
});

contextBridge.exposeInMainWorld('overlay', {
  onVignette: (cb) => ipcRenderer.on('vignette', (_e, on) => cb(on)),
  onCelebrate: (cb) => ipcRenderer.on('celebrate', (_e, opts) => cb(opts)),
});
