const FOCUS_CUE = 'Clear your mind';
const BREAK_CUE = 'Let it settle';
const HINTS = { focus: 'Empty your inbox', break: 'Breathe out slowly' };
const LIME = '#d3f26a';
const ACCENTS = { focus: '#d3f26a', break: '#7fc06a' };
const LABELS = { focus: 'Focus', break: 'Break' };
const MIN = 60, MAX = 90 * 60;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const island = document.getElementById('island');
const dot = document.getElementById('dot');
const pillName = document.getElementById('pillName');
const pillTime = document.getElementById('pillTime');
const taskEl = document.getElementById('task');
const dialTime = document.getElementById('dialTime');
const dialSub = document.getElementById('dialSub');
const cue = document.getElementById('cue');
const cueSub = document.getElementById('cueSub');
const hintText = document.getElementById('hintText');
const playBtn = document.getElementById('play');
const playLabel = document.getElementById('playLabel');
const playPlus = document.getElementById('playPlus');
const minorBtn = document.getElementById('minor');
const minorReset = document.getElementById('minorReset');
const minorDone = document.getElementById('minorDone');
const quitBtn = document.getElementById('quit');
const gearBtn = document.getElementById('gear');
const prefsEl = document.getElementById('prefs');
const pfill = document.getElementById('pfill');
const pknob = document.getElementById('pknob');
const statL = document.getElementById('statL');
const statR = document.getElementById('statR');
const tickSvg = document.getElementById('tickSvg');
const modes = document.querySelectorAll('.mode');
const timeEl = { querySelector: (s) => document.querySelector('#cueSub') };

const PLAY = '+';
const PAUSE = '❚❚';
let DUR = { focus: 25 * 60, break: 5 * 60 };
let mode = 'focus';
let remaining = DUR.focus;
let total = DUR.focus;
let running = false;
let expanded = false;
let taskName = '';
let stats = { sessions: 0, daySessions: 0, minutes: 0 };
let raf = null, lastTick = 0;

/* ---------- radar tick ring (ref 1) ---------- */
const TICKS = 72;
let tickEls = [];
(function buildTicks() {
  const NS = 'http://www.w3.org/2000/svg';
  const cx = 74, cy = 74, r = 66;
  for (let i = 0; i < TICKS; i++) {
    const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
    const long = i % 6 === 0;
    const r1 = r - (long ? 9 : 5), r2 = r;
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', cx + r1 * Math.cos(a)); l.setAttribute('y1', cy + r1 * Math.sin(a));
    l.setAttribute('x2', cx + r2 * Math.cos(a)); l.setAttribute('y2', cy + r2 * Math.sin(a));
    l.setAttribute('stroke', 'rgba(255,255,255,.55)');
    l.setAttribute('stroke-width', long ? 1.6 : 1);
    l.setAttribute('stroke-linecap', 'round');
    l.dataset.i = i;
    tickSvg.appendChild(l); tickEls.push(l);
  }
  const prog = document.createElementNS(NS, 'circle');
  prog.setAttribute('cx', cx); prog.setAttribute('cy', cy); prog.setAttribute('r', 52);
  prog.setAttribute('fill', 'none'); prog.setAttribute('stroke', LIME);
  prog.setAttribute('stroke-width', 2); prog.setAttribute('stroke-linecap', 'round');
  prog.setAttribute('pathLength', 100); prog.setAttribute('stroke-dasharray', '100');
  prog.setAttribute('stroke-dashoffset', 100);
  prog.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
  prog.style.filter = 'drop-shadow(0 0 5px rgba(211,242,106,.9))';
  prog.id = 'progArc';
  tickSvg.appendChild(prog);
  const halo = document.createElementNS(NS, 'circle');
  halo.setAttribute('cx', cx); halo.setAttribute('cy', cy); halo.setAttribute('r', 40);
  halo.setAttribute('fill', 'rgba(255,255,255,.92)');
  halo.setAttribute('opacity', '.10');
  tickSvg.appendChild(halo);
})();

function fmtClock(s) {
  s = Math.max(0, Math.ceil(s));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let vignetteOn = null;
function syncVignette() {
  const on = running && mode === 'focus';
  if (on === vignetteOn) return;
  vignetteOn = on;
  window.notch.setVignette(on);
}

function progress() { return total > 0 ? clamp(1 - remaining / total, 0, 1) : 0; }

function render() {
  island.style.setProperty('--accent', ACCENTS[mode]);
  island.classList.toggle('running', running);
  dot.classList.toggle('running', running);

  pillTime.textContent = fmtClock(remaining);
  pillName.textContent = taskName || LABELS[mode];
  dialTime.textContent = running ? fmtClock(remaining) : fmtClock(DUR[mode]);
  dialSub.textContent = running ? LABELS[mode] + ' · live' : 'Ready';
  cue.firstChild.textContent = mode === 'focus' ? FOCUS_CUE : BREAK_CUE;
  cueSub.textContent = `${LABELS[mode]} · ${Math.round(DUR[mode] / 60)} min`;
  hintText.textContent = running ? (mode === 'focus' ? 'Stay with it' : 'Let go') : HINTS[mode];
  playLabel.textContent = running ? 'Pause' : 'Start tracking';
  playPlus.textContent = running ? '❚❚' : '+';
  playPlus.style.fontSize = running ? '9px' : '14px';
  minorReset.style.display = running ? 'none' : 'block';
  minorDone.style.display = running ? 'block' : 'none';
  minorBtn.title = running ? 'Finish now' : 'Reset';
  modes.forEach((m) => m.classList.toggle('on', m.dataset.mode === mode));

  const p = progress();
  pfill.style.width = `${p * 100}%`;
  pknob.style.left = `${p * 100}%`;
  const arc = document.getElementById('progArc');
  if (arc) arc.setAttribute('stroke-dashoffset', 100 - p * 100);
  tickEls.forEach((el, i) => {
    const lit = i / TICKS <= p;
    el.setAttribute('stroke', lit ? LIME : 'rgba(255,255,255,.55)');
    el.setAttribute('opacity', lit ? 1 : (running ? .85 : .6));
  });
  statL.textContent = String(stats.daySessions || 0);
  statR.textContent = ((stats.minutes || 0) / 60).toFixed(1);
  renderPrefs();
  syncVignette();
}

function renderPrefs() {
  if (!prefsEl) return;
  prefsEl.innerHTML = '';
  [15, 25, 45].forEach((m) => {
    const b = document.createElement('button');
    b.textContent = `${m}m`;
    if (Math.round(DUR[mode] / 60) === m) b.classList.add('on');
    b.onclick = (e) => { e.stopPropagation(); DUR[mode] = m * 60; if (!running) { remaining = DUR[mode]; total = DUR[mode]; } persistSettings(); render(); };
    prefsEl.appendChild(b);
  });
}

async function persistSettings() {
  try { await window.notch.saveSettings({ focusMin: Math.round(DUR.focus / 60), breakMin: Math.round(DUR.break / 60) }); } catch {}
}

function setMode(next) {
  if (running) toggleRun();
  mode = next; remaining = DUR[mode]; total = DUR[mode];
  render();
}

function completeSession(finishedEarly = false) {
  const finished = mode;
  const mins = Math.round((total - remaining) / 60) || Math.round(total / 60);
  running = false;
  if (raf) cancelAnimationFrame(raf);
  island.classList.remove('finished');
  void island.offsetWidth;
  island.classList.add('finished');
  setTimeout(() => island.classList.remove('finished'), 2100);
  window.notch.celebrate({ tone: finished === 'focus' ? 'green' : 'gold' });
  window.notch.notify({ title: finished === 'focus' ? 'Focus complete' : 'Break over', body: finished === 'focus' ? 'Nice work — take a breather.' : 'Back to it.' });
  try { window.notch.complete({ mode: finished, minutes: finishedEarly ? Math.max(1, mins) : Math.round(total / 60) }); } catch {}
  stats.daySessions = (stats.daySessions || 0) + 1;
  stats.minutes = (stats.minutes || 0) + (finishedEarly ? Math.max(1, mins) : Math.round(total / 60));
  mode = finished === 'focus' ? 'break' : 'focus';
  remaining = DUR[mode]; total = DUR[mode];
  setExpanded(false);
  render();
}

function tick(now) {
  if (!running) return;
  remaining = Math.max(0, remaining - (now - lastTick) / 1000);
  lastTick = now;
  if (remaining <= 0) { completeSession(false); return; }
  render();
  raf = requestAnimationFrame(tick);
}

function toggleRun() {
  running = !running;
  if (running) {
    if (remaining <= 0) { remaining = DUR[mode]; total = DUR[mode]; }
    if (!total || total <= 0) total = DUR[mode];
    lastTick = performance.now();
    raf = requestAnimationFrame(tick);
    setExpanded(false);
  } else if (raf) cancelAnimationFrame(raf);
  render();
}
function resetTimer() { running = false; if (raf) cancelAnimationFrame(raf); remaining = DUR[mode]; total = DUR[mode]; render(); }
function setExpanded(v) { expanded = v; island.classList.toggle('expanded', expanded); }

let ignoring = true;
function setIgnore(v) { if (v === ignoring) return; ignoring = v; window.notch.setIgnoreMouse(v); }
function overNotch(x, y) {
  const r = island.getBoundingClientRect();
  const pad = 15;
  return x >= r.left - pad && x <= r.right + pad && y >= r.top && y <= r.bottom + 2;
}
function updateIgnore(e) {
  if (grab || document.activeElement === taskEl) { setIgnore(false); return; }
  setIgnore(!overNotch(e.clientX, e.clientY));
}

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
  if (!grab.moved && (Math.abs(e.screenX - grab.x) > 3 || Math.abs(e.screenY - grab.y) > 3)) grab.moved = true;
  if (grab.moved) window.notch.dragMove();
});
window.addEventListener('mouseup', () => {
  if (!grab) return;
  const wasTap = !grab.moved;
  grab = null;
  if (wasTap && !expanded) setExpanded(true);
});
document.addEventListener('mouseleave', () => { if (!grab && document.activeElement !== taskEl) setIgnore(true); });
document.getElementById('card').addEventListener('click', (e) => { if (e.target === e.currentTarget) setExpanded(false); });

playBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleRun(); });
minorBtn.addEventListener('click', (e) => { e.stopPropagation(); if (running) completeSession(true); else resetTimer(); });
quitBtn.addEventListener('click', (e) => { e.stopPropagation(); window.notch.quit(); });
gearBtn.addEventListener('click', (e) => { e.stopPropagation(); island.classList.toggle('show-prefs'); });
modes.forEach((m) => m.addEventListener('click', (e) => { e.stopPropagation(); setMode(m.dataset.mode); }));

document.querySelector('.dial').addEventListener('wheel', (e) => {
  e.preventDefault(); e.stopPropagation();
  if (running) return;
  const step = (e.shiftKey ? 5 : 1) * 60;
  const dir = e.deltaY < 0 ? 1 : -1;
  DUR[mode] = clamp(DUR[mode] + dir * step, MIN, MAX);
  remaining = DUR[mode]; total = DUR[mode];
  persistSettings(); render();
}, { passive: false });

taskEl.addEventListener('input', () => { taskName = taskEl.textContent.trim(); pillName.textContent = taskName || LABELS[mode]; });
taskEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); taskEl.blur(); } });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && expanded) setExpanded(false);
  if (e.code === 'Space' && document.activeElement !== taskEl) { e.preventDefault(); toggleRun(); }
});

window.notch.onCmd((cmd) => {
  if (cmd === 'toggle' || cmd === 'pause') { if (cmd === 'pause' && !running) return; toggleRun(); }
  else if (cmd === 'reset') resetTimer();
  else if (cmd === 'finish') { if (running) completeSession(true); }
  else if (cmd === 'start-focus') { if (mode !== 'focus') setMode('focus'); if (!running) toggleRun(); else setExpanded(false); }
  else if (cmd === 'start-break') { if (mode !== 'break') setMode('break'); if (!running) toggleRun(); else setExpanded(false); }
});
window.notch.onExpand((v) => setExpanded(!!v));
window.notch.onSettings((s) => {
  if (s.focusMin) DUR.focus = s.focusMin * 60;
  if (s.breakMin) DUR.break = s.breakMin * 60;
  if (!running) { remaining = DUR[mode]; total = DUR[mode]; }
  render();
});

(async function boot() {
  try {
    const s = await window.notch.loadSettings();
    if (s.focusMin) DUR.focus = s.focusMin * 60;
    if (s.breakMin) DUR.break = s.breakMin * 60;
    if (s.stats) stats = s.stats;
    if (!s.onboarded) setExpanded(true);
  } catch {}
  remaining = DUR[mode]; total = DUR[mode];
  render();
})();
