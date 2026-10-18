// Two small touches for staff computers with a mouse (Revision 16):
//   * a tiny burst of feathers, in the colour of your role, wherever you click;
//   * after a minute with no mouse, key or touch, one chicken wanders around the screen. It runs off as soon as you move the mouse.
// Both live in a layer that ignores the mouse (pointer-events: none), so they can never block a click. They are not shown on the sign-in
// page, the Butcher screen or the Customer screen, on touch screens, or (the chicken stands still, no feathers) when the computer is set to
// reduce motion.
import { state } from './state.js';

const COLORS = { admin: '#ff2d2d', manager: '#ffd60a', cashier: '#22c55e', assistant: '#3b82f6' };   // the same colours as the pointer (app.css)
const idleMs = () => Number(window.__posIdleMs) || 60_000;   // a test can shorten it with window.__posIdleMs

const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const hasMouse = () => window.matchMedia?.('(pointer: fine)').matches ?? false;
/** Only on a signed-in staff screen, on a computer with a mouse. */
const allowed = () => Boolean(state.user && COLORS[state.user.role]) && !document.body.classList.contains('display-mode') && hasMouse();

let layer = null;
function getLayer() {
  if (layer?.isConnected) return layer;
  layer = document.createElement('div');
  layer.id = 'fun-layer';
  layer.setAttribute('aria-hidden', 'true');
  document.body.append(layer);
  return layer;
}

// ---- Feathers on click ----------------------------------------------------------------------------------------------------

const featherSvg = (color) => `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M3 21C3 9 11 3 22 3C22 13 16 21 3 21Z" fill="${color}" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/><path d="M3 21L15 9" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function featherBurst(x, y) {
  const color = COLORS[state.user.role];
  const host = getLayer();
  const count = 6;
  for (let i = 0; i < count; i += 1) {
    const f = document.createElement('span');
    f.className = 'feather';
    const angle = (-160 + (140 / (count - 1)) * i + (Math.random() * 16 - 8)) * (Math.PI / 180);   // fans out upwards
    const dist = 26 + Math.random() * 30;
    f.style.left = `${x}px`; f.style.top = `${y}px`;
    f.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    f.style.setProperty('--dy', `${Math.sin(angle) * dist}px`);
    f.style.setProperty('--rot', `${Math.round(Math.random() * 360 - 180)}deg`);
    f.innerHTML = featherSvg(color);
    host.append(f);
    setTimeout(() => f.remove(), 900);
  }
}

function onClick(e) {
  if (e.detail === 0 || !allowed() || reduceMotion()) return;   // detail 0 = pressed with the keyboard, not a mouse click
  featherBurst(e.clientX, e.clientY);
}

// ---- The wandering chicken --------------------------------------------------------------------------------------------------

const HEN = `<svg viewBox="0 0 70 66" width="64" height="60" aria-hidden="true">
  <path d="M12 30 Q1 19 11 12 Q9 23 19 27Z" fill="#e9e2cf" stroke="#cfc6ae" stroke-width="1.3"/>
  <g class="hen-leg hen-leg-a"><path d="M27 48v11m-4 0h8" stroke="#f59e0b" stroke-width="2.6" stroke-linecap="round" fill="none"/></g>
  <g class="hen-leg hen-leg-b"><path d="M37 48v11m-4 0h8" stroke="#f59e0b" stroke-width="2.6" stroke-linecap="round" fill="none"/></g>
  <ellipse cx="31" cy="36" rx="21" ry="15" fill="#fbf7ec" stroke="#cfc6ae" stroke-width="1.5"/>
  <path d="M20 35Q31 26 42 37Q31 47 20 35Z" fill="#efe7d2" stroke="#cfc6ae" stroke-width="1.2"/>
  <g class="hen-head"><circle cx="50" cy="22" r="9.5" fill="#fbf7ec" stroke="#cfc6ae" stroke-width="1.5"/>
  <path d="M45 14q2-8 5-2q2-7 5 0q-1 3-2 4z" fill="#e0342b"/>
  <path d="M58 22l8 2.2l-8 3.4z" fill="#f59e0b"/>
  <ellipse cx="56" cy="30" rx="2.2" ry="3.2" fill="#e0342b"/>
  <circle cx="52" cy="21" r="1.7" fill="#1d2a26"/></g>
</svg>`;

let hen = null;       // { el, flip, x, y, timers: [] } while the chicken is on screen
let idleTimer = null;

const view = () => ({ w: window.innerWidth, h: window.innerHeight });
const later = (fn, ms) => { const t = setTimeout(fn, ms); hen?.timers.push(t); return t; };
const place = (x, y, ms = 0, ease = 'linear') => {
  hen.el.style.transition = ms ? `transform ${ms}ms ${ease}` : 'none';
  hen.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  hen.x = x; hen.y = y;
};

function spawnHen() {
  if (hen || !allowed() || document.querySelector('dialog[open]') || document.hidden) return;
  const { w, h } = view();
  const el = document.createElement('div');
  el.className = 'hen';
  el.innerHTML = `<div class="hen-flip"><div class="hen-body">${HEN}</div></div>`;
  getLayer().append(el);
  hen = { el, flip: el.querySelector('.hen-flip'), x: 0, y: 0, timers: [] };
  if (reduceMotion()) {   // calm mode: the chicken just stands there
    place(40 + Math.random() * (w - 160), h - 100);
    return;
  }
  const fromLeft = Math.random() < 0.5;
  place(fromLeft ? -90 : w + 30, h * (0.45 + Math.random() * 0.4));
  hen.el.getBoundingClientRect();   // apply the starting spot before the first walk
  wander();
}

function wander() {
  if (!hen) return;
  if (!allowed()) { removeHen(); return; }
  const { w, h } = view();
  const tx = 20 + Math.random() * Math.max(40, w - 120);
  const ty = h * 0.25 + Math.random() * Math.max(40, h * 0.65 - 60);
  const dx = tx - hen.x; const dy = ty - hen.y;
  const ms = Math.max(900, (Math.hypot(dx, dy) / 70) * 1000);   // about 70 pixels a second
  hen.flip.style.transform = dx >= 0 ? 'scaleX(1)' : 'scaleX(-1)';   // the drawing faces right
  hen.el.classList.add('walking'); hen.el.classList.remove('pecking');
  place(tx, ty, ms);
  later(() => {
    if (!hen) return;
    hen.el.classList.remove('walking');
    const peck = Math.random() < 0.7;
    hen.el.classList.toggle('pecking', peck);
    later(wander, 1200 + Math.random() * 2200);
  }, ms);
}

function removeHen() {
  if (!hen) return;
  hen.timers.forEach(clearTimeout);
  hen.el.remove();
  hen = null;
}

/** Someone is back: the chicken hurries to the nearest side of the screen and is gone. */
function sendHenAway() {
  if (!hen) return;
  const gone = hen;
  gone.timers.forEach(clearTimeout); gone.timers = [];
  if (reduceMotion()) { removeHen(); return; }
  const { w } = view();
  const left = gone.x < w / 2;
  gone.el.classList.add('walking'); gone.el.classList.remove('pecking');
  gone.flip.style.transform = left ? 'scaleX(-1)' : 'scaleX(1)';
  place(left ? -110 : w + 50, gone.y, 450, 'ease-in');
  setTimeout(() => { if (hen === gone) removeHen(); else gone.el.remove(); }, 480);
}

function armIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (document.hidden) { armIdleTimer(); return; }   // nobody is looking: wait
    spawnHen();
    if (!hen) armIdleTimer();   // not allowed on this screen (or a question box is open): look again later
  }, idleMs());
}

function onActivity(e) {
  if (e?.type === 'mousemove' && e.movementX === 0 && e.movementY === 0) return;   // the browser's own "fake" moves are not the person
  if (hen) sendHenAway();
  armIdleTimer();
}

export function installFun() {
  document.addEventListener('click', onClick, true);
  for (const type of ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(type, onActivity, { passive: true, capture: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onActivity(); });
  armIdleTimer();
}
