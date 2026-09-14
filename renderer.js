const DURATIONS = { focus: 25 * 60, break: 5 * 60 };
const ACCENTS = { focus: '#c9b48a', break: '#7fc06a' };
const LABELS = { focus: 'Focus', break: 'Break' };
const MIN = 60, MAX = 90 * 60;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const island = document.getElementById('island');
const dot = document.getElementById('dot');
const pillName = document.getElementById('pillName');
const pillTime = document.getElementById('pillTime');
const taskEl = document.getElementById('task');
const timeEl = document.getElementById('time');
const playBtn = document.getElementById('play');
const playIcon = document.getElementById('playIcon');
const minorBtn = document.getElementById('minor');
const quitBtn = document.getElementById('quit');
const modes = document.querySelectorAll('.mode');

const PLAY_PATH = 'M8 5.5v13l11-6.5z';
const PAUSE_PATH = 'M7 5h3.2v14H7zM13.8 5H17v14h-3.2z';

let mode = 'focus';
let remaining = DURATIONS.focus;
let running = false;
let expanded = false;
let taskName = '';
let raf = null, lastTick = 0;

function fmtClock(s) {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/* the screen-wide vignette follows focus only — breaks stay bright.
   cached so the per-frame render() doesn't spam IPC */
let vignetteOn = null;
function syncVignette() {
  const on = running && mode === 'focus';
  if (on === vignetteOn) return;
  vignetteOn = on;
  window.notch.setVignette(on);
}

function render() {
  island.style.setProperty('--accent', ACCENTS[mode]);
  island.classList.toggle('running', running);
  dot.classList.toggle('running', running);

  pillTime.textContent = fmtClock(remaining);
  pillName.textContent = taskName || LABELS[mode];

  // big editable numeral shows whole minutes when idle, live clock when running
  if (running) {
    timeEl.firstChild.textContent = fmtClock(remaining);
    timeEl.querySelector('.unit').textContent = LABELS[mode];
    timeEl.style.cursor = 'default';
  } else {
    timeEl.firstChild.textContent = Math.round(DURATIONS[mode] / 60);
    timeEl.querySelector('.unit').textContent = 'min';
    timeEl.style.cursor = 'ns-resize';
  }

  playIcon.querySelector('path').setAttribute('d', running ? PAUSE_PATH : PLAY_PATH);
  modes.forEach((m) => m.classList.toggle('on', m.dataset.mode === mode));
  minorBtn.title = running ? 'Finish now' : 'Reset';
  syncVignette();
}

function setMode(next) {
  if (running) toggleRun();
  mode = next;
  remaining = DURATIONS[mode];
  render();
}

/* ---- completion: reaching zero and finishing early land in the same place ---- */
function completeSession() {
  const finished = mode;
  running = false;
  if (raf) cancelAnimationFrame(raf);

  island.classList.remove('finished');
  void island.offsetWidth;          // restart the flash if two land close together
  island.classList.add('finished');
  setTimeout(() => island.classList.remove('finished'), 2100);

  window.notch.celebrate({ tone: finished === 'focus' ? 'green' : 'gold' });

  mode = finished === 'focus' ? 'break' : 'focus';
  remaining = DURATIONS[mode];
  setExpanded(false);
  render();
}

function tick(now) {
  if (!running) return;
  remaining = Math.max(0, remaining - (now - lastTick) / 1000);
  lastTick = now;
  if (remaining <= 0) {
    completeSession();
    return;
  }
  render();
  raf = requestAnimationFrame(tick);
}

function toggleRun() {
  running = !running;
  if (running) {
    if (remaining <= 0) remaining = DURATIONS[mode];
    lastTick = performance.now();
    raf = requestAnimationFrame(tick);
    // starting a session retreats to the minimal notch — subtle, out of the way
    setExpanded(false);
  } else if (raf) {
    cancelAnimationFrame(raf);
  }
  render();
}

function resetTimer() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  remaining = DURATIONS[mode];
  render();
}

function setExpanded(v) {
  expanded = v;
  island.classList.toggle('expanded', expanded);
}

/* ---------------------------------------------------------------
   click-through hit test.
   The window is a 420x180 transparent box pinned over the menu bar,
   so it stays click-through by default and only becomes solid while
   the cursor is actually on the notch. mousemove still arrives while
   ignoring because main passes { forward: true }.
   --------------------------------------------------------------- */
let ignoring = true;
function setIgnore(v) {
  if (v === ignoring) return;
  ignoring = v;
  window.notch.setIgnoreMouse(v);
}
function overNotch(x, y) {
  const r = island.getBoundingClientRect();
  const pad = 15; // the shoulders
  return x >= r.left - pad && x <= r.right + pad && y >= r.top && y <= r.bottom + 2;
}
function updateIgnore(e) {
  if (grab || document.activeElement === taskEl) { setIgnore(false); return; }
  setIgnore(!overNotch(e.clientX, e.clientY));
}

// collapsed pill: tap to expand, drag to move the window.
// We detect intent ourselves (movement threshold) instead of -webkit-app-region,
// which would swallow the click entirely.
const pill = document.querySelector('.pill');
let grab = null;
pill.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  grab = { x: e.screenX, y: e.screenY, moved: false };
  window.notch.dragStart();
});
window.addEventListener('mousemove', (e) => {
  updateIgnore(e);
  if (!grab) return;
  if (!grab.moved && (Math.abs(e.screenX - grab.x) > 3 || Math.abs(e.screenY - grab.y) > 3)) {
    grab.moved = true;
  }
  if (grab.moved) window.notch.dragMove();
});
window.addEventListener('mouseup', () => {
  if (!grab) return;
  const wasTap = !grab.moved;
  grab = null;
  if (wasTap && !expanded) setExpanded(true);
});
// cursor left the window entirely — hand the menu bar back
document.addEventListener('mouseleave', () => {
  if (!grab && document.activeElement !== taskEl) setIgnore(true);
});

// collapse when clicking empty card space (not on a control or the task field)
document.querySelector('.card').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) setExpanded(false);
});

playBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRun(); });
// same slot: reset while idle, finish-the-session while running
minorBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (running) completeSession(); else resetTimer();
});
quitBtn.addEventListener('click', (e) => { e.stopPropagation(); window.notch.quit(); });

modes.forEach((m) =>
  m.addEventListener('click', (e) => { e.stopPropagation(); setMode(m.dataset.mode); })
);

// scroll over the numeral to adjust the active mode's length (paused only)
timeEl.addEventListener('wheel', (e) => {
  e.preventDefault();
  e.stopPropagation();
  if (running) return;
  const step = (e.shiftKey ? 5 : 1) * 60;
  const dir = e.deltaY < 0 ? 1 : -1;
  DURATIONS[mode] = clamp(DURATIONS[mode] + dir * step, MIN, MAX);
  remaining = DURATIONS[mode];
  render();
}, { passive: false });

// task name
taskEl.addEventListener('input', () => {
  taskName = taskEl.textContent.trim();
  pillName.textContent = taskName || LABELS[mode];
});
taskEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); taskEl.blur(); }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && expanded) setExpanded(false);
});

render();
