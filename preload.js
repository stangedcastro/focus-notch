const { contextBridge, ipcRenderer } = require('electron');

// the notch window
contextBridge.exposeInMainWorld('notch', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', ignore),
  setTrayState: (state) => ipcRenderer.send('set-tray-state', state),
  quit: () => ipcRenderer.send('quit-app'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  setVignette: (on) => ipcRenderer.send('overlay-vignette', on),
  celebrate: (opts) => ipcRenderer.send('overlay-celebrate', opts),
});

// The renderer already keeps these values in the visible UI. Relay them at a
// one-second cadence so the tray never receives animation-frame traffic.
window.addEventListener('DOMContentLoaded', () => {
  const island = document.getElementById('island');
  const pillTime = document.getElementById('pillTime');
  const unit = document.querySelector('#time .unit');
  if (!island || !pillTime) return;

  const pushTrayState = () => {
    const [minutes, seconds] = pillTime.textContent.trim().split(':').map(Number);
    // send over ipcRenderer directly — contextBridge exposes `notch` to the MAIN
    // world, so it does not exist on `window` here inside the isolated preload.
    ipcRenderer.send('set-tray-state', {
      mode: unit ? unit.textContent.trim().toLowerCase() : 'focus',
      remaining: minutes * 60 + seconds,
      running: island.classList.contains('running'),
    });
  };

  pushTrayState();
  setInterval(pushTrayState, 1000);
});

// the ambient overlay window
contextBridge.exposeInMainWorld('overlay', {
  onVignette: (cb) => ipcRenderer.on('vignette', (_e, on) => cb(on)),
  onCelebrate: (cb) => ipcRenderer.on('celebrate', (_e, opts) => cb(opts)),
});
