// Two small touches for staff computers with a mouse (Revision 16):
//   * admin only: a tiny burst of red feathers wherever the admin clicks;
//   * after a minute with no mouse, key or touch, one chicken (drawn after the owner's "Pitik" animation) wanders around the screen. It pecks
//     the screen, pecking the ground only throws up a little feed and dust. Now and then it turns to you, leans in and taps the glass, and each tap leaves a small
//     crack that fades in about 10 seconds. Sometimes it also stops, stares out at you and blinks,
//     and its eye follows the resting mouse pointer. It runs off as soon as the mouse moves or a key is pressed, taking its cracks with it.
// Everything lives in a layer that ignores the mouse (pointer-events: none), so it can never block a click. Not shown on the sign-in page,
// the Butcher screen, the Customer screen or on touch screens. When the computer is set to reduce motion: no feathers, and the chicken
// just stands there (it still blinks and its eye still follows the pointer).
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

// ---- Feathers on click (admin only) ---------------------------------------------------------------------------------------

const featherSvg = (color) => `<svg width="20" height="20" viewBox="0 0 24 24"><path d="M3 21C3 9 11 3 22 3C22 13 16 21 3 21Z" fill="${color}" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/><path d="M3 21L15 9" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/></svg>`;

function featherBurst(x, y) {
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
    f.innerHTML = featherSvg(COLORS.admin);
    host.append(f);
    setTimeout(() => f.remove(), 900);
  }
}

function onClick(e) {
  if (e.detail === 0 || !allowed() || reduceMotion() || state.user.role !== 'admin') return;   // detail 0 = pressed with the keyboard
  featherBurst(e.clientX, e.clientY);
}

// ---- The chicken ("Pitik") ----------------------------------------------------------------------------------------------------
// The shapes and colours are the owner's Pitik drawing. Every moving part turns around its own pivot, the way the Pitik animation does:
//   transform = translate(pivot) rotate(angle) translate(-anchor)
// The body turns at its base, the neck at the shoulder (and carries the head), the tail feathers and the wing at their roots.

const P = {
  foot: 'M0,21.02C-2.535,21.02,-4.591,18.965,-4.591,16.43L-4.591,-16.43C-4.591,-18.965,-2.535,-21.02,0,-21.02C2.535,-21.02,4.591,-18.965,4.591,-16.43L4.591,16.43C4.591,18.965,2.535,21.02,0,21.02Z',
  leg: 'M0,18.775C-6.878,18.775,-12.625,13.54,-13.265,6.692L-15.646,-18.775L15.646,-18.775L13.265,6.692C12.625,13.54,6.878,18.775,0,18.775Z',
  tail3: 'M19.574,30.781C12.574,35.232,3.291,33.167,-1.16,26.167L-24.189,-10.047C-28.64,-17.047,-26.574,-26.33,-19.574,-30.781C-12.574,-35.232,-3.291,-33.167,1.16,-26.167L24.189,10.047C28.64,17.047,26.574,26.33,19.574,30.781Z',
  tail2: 'M27.034,11.132C23.875,18.803,15.097,22.461,7.426,19.302L-18.864,8.476C-26.535,5.317,-30.193,-3.461,-27.034,-11.132C-23.875,-18.803,-15.097,-22.461,-7.426,-19.302L18.864,-8.476C26.535,-5.317,30.193,3.461,27.034,11.132Z',
  tail1: 'M20.38,-3.43C21.757,4.75,16.241,12.498,8.061,13.875L-3.075,15.749C-11.255,17.126,-19.003,11.61,-20.38,3.43C-21.757,-4.75,-16.241,-12.498,-8.061,-13.875L3.075,-15.749C11.255,-17.126,19.003,-11.61,20.38,-3.43Z',
  body: 'M-82.722,-14.956L32.193,-64.648C64.555,-78.642,100.852,-55.131,101.065,-19.873C101.261,12.699,87.873,48.135,35.739,64.133C-8.807,77.803,-54.605,58.663,-86.769,38.7C-107.577,25.785,-105.201,-5.236,-82.722,-14.956Z',
  neck: 'M-16.188,-112.249L-41.897,85.336C-46.244,103.918,-37.144,123.034,-19.979,131.376C6.248,144.122,36.769,125.02,36.769,95.86L42.975,-105.422C42.975,-122.327,29.003,-135.888,12.105,-135.384C-1.48,-134.978,-13.092,-125.483,-16.188,-112.249Z',
  wing: 'M39.145,14.683C38.808,13.828,37.838,13.409,36.985,13.745L8.282,25.051C6.807,25.629,5.194,25.602,3.741,24.971C2.286,24.338,1.166,23.177,0.585,21.704C-0.613,18.66,0.888,15.208,3.932,14.009L3.968,13.994L18.566,7.843C19.413,7.486,19.811,6.509,19.454,5.662C19.096,4.814,18.12,4.415,17.273,4.775L2.711,10.911L-11.154,16.371C-12.627,16.953,-14.239,16.923,-15.694,16.29C-17.148,15.659,-18.268,14.499,-18.849,13.025C-20.048,9.981,-18.552,6.53,-15.513,5.328L8.855,-3.936C9.715,-4.263,10.146,-5.225,9.819,-6.085C9.493,-6.944,8.534,-7.377,7.671,-7.05L-16.726,2.226L-27.818,6.595C-29.292,7.174,-30.905,7.146,-32.362,6.512C-33.811,5.885,-34.93,4.727,-35.513,3.248C-36.094,1.775,-36.066,0.163,-35.433,-1.291C-34.801,-2.746,-33.64,-3.866,-32.167,-4.447L21.495,-25.583C22.35,-25.92,22.771,-26.887,22.434,-27.742C22.097,-28.596,21.131,-29.018,20.274,-28.681L-33.388,-7.545C-35.689,-6.639,-37.5,-4.889,-38.487,-2.619C-39.474,-0.349,-39.519,2.169,-38.612,4.469C-37.702,6.778,-35.952,8.589,-33.687,9.567C-32.501,10.083,-31.248,10.343,-29.993,10.343C-28.846,10.343,-27.697,10.127,-26.598,9.693L-22.114,7.927C-22.777,9.918,-22.775,12.143,-21.947,14.245C-21.04,16.547,-19.291,18.359,-17.022,19.344C-15.836,19.86,-14.583,20.119,-13.328,20.119C-12.181,20.119,-11.032,19.904,-9.933,19.47L-2.679,16.612C-3.342,18.602,-3.34,20.825,-2.513,22.925C-1.607,25.225,0.142,27.036,2.413,28.025C3.598,28.54,4.851,28.798,6.106,28.798C7.253,28.798,8.402,28.582,9.501,28.149L38.206,16.843C39.061,16.506,39.482,15.538,39.145,14.683Z',
  lid: 'M22.459,0C22.473,21.424,12.411,30.128,0.007,30.128C-12.397,30.128,-23.232,21.731,-22.459,0C-22.018,-12.396,-12.404,-22.459,0,-22.459C12.404,-22.459,22.451,-12.404,22.459,0Z',
  combUp: 'M18.555,9.762C18.555,9.762,1.567,-21.608,-15.156,-4.959C-31.879,11.69,18.555,9.762,18.555,9.762Z',
  combUp2: 'M16.038,20.84C16.038,20.84,22.785,-24.826,-7.45,-20.559C-37.685,-16.292,16.038,20.84,16.038,20.84Z',
  wattle1: 'M-6.698,-22.22C-7.463,-23.189,-8.987,-22.955,-9.429,-21.802C-12.975,-12.555,-23.051,19.026,3.126,22.583C30.064,26.243,0.879,-12.617,-6.698,-22.22Z',
  wattle2: 'M4.054,-23.268C3.643,-24.432,2.124,-24.702,1.334,-23.754C-5.006,-16.146,-24.735,10.494,-1.106,22.308C23.21,34.466,8.127,-11.734,4.054,-23.268Z',
  bill: 'M-9.01,-8.762L8.655,0.873C12.364,2.896,10.959,8.528,6.735,8.573L-10.798,8.762Z',
};

// Each turning part: its pivot (where it sits on its parent) and anchor (the point of its own drawing that sits there).
const RIG = {
  legL: { p: [-18.727, -0.526], a: [-18.727, -0.526] }, legR: { p: [11.314, -0.526], a: [11.314, -0.526] },   // the legs turn at the hip (their drawing is already in place)
  body: { p: [-4.119, 0.479], a: [0, 49.75] },
  tail3: { p: [-69.218, -6.491], a: [26.536, 33.129] }, tail2: { p: [-74.647, -2.296], a: [28.169, 20.437] }, tail1: { p: [-80.264, -3.653], a: [20.591, 0] },
  wing: { p: [-16.003, -23.005], a: [39.261, -28.798] },
  neck: { p: [48.783, -25.752], a: [-1, 99] },
  combUp: { p: [24.574, -128.891], a: [18.555, 9.831] }, combUp2: { p: [36.745, -120.053], a: [16.68, 20.84] },
  wattle1: { p: [32.147, -98.031], a: [-14.317, -22.825] }, wattle2: { p: [34.053, -97.629], a: [0, -24.329] },
  bill: { p: [14.941, -93.108], a: [-32.683, -3.521] },
};
const EYE = [9.471, -109.671];   // centre of the near eye, in neck coordinates
const PUPIL_REST = [16.979, -2.33];   // where the Pitik pupil rests: looking ahead
const g = (part, inner, cls = '') => `<g data-part="${part}"${cls ? ` class="${cls}"` : ''}>${inner}</g>`;
const path = (d, fill) => `<path d="${d}" fill="${fill}"/>`;

const HEN_SVG = `<svg class="pitik" viewBox="-220 -340 480 430" width="160" height="143" aria-hidden="true">
  ${g('legR', `<path d="${P.foot}" fill="#333333" transform="translate(12.95,51.5)"/>${path(P.leg, '#fae3c0').replace('<path', '<path transform="translate(11.314,18.249)"')}`)}
  ${g('body', `
    ${g('tail3', path(P.tail3, '#fff0d9'))}${g('tail2', path(P.tail2, '#fff0d9'))}${g('tail1', path(P.tail1, '#fff0d9'))}
    ${path(P.body, '#fff0d9')}
    ${g('neck', `
      <circle cx="29.193" cy="-102.072" r="22.459" fill="#ffffff"/>
      ${g('combUp2', path(P.combUp2, '#ea0018'))}${g('combUp', path(P.combUp, '#ea0018'))}${g('wattle1', path(P.wattle1, '#cc0522'))}
      ${path(P.neck, '#fff0d9')}
      <g data-part="eye" transform="translate(${EYE[0]},${EYE[1]})">${path(P.lid, '#fae3c0')}
        <g data-part="eyeball"><circle r="22.459" fill="#ffffff"/><circle data-part="pupil" r="7.5" cx="${PUPIL_REST[0]}" cy="${PUPIL_REST[1]}" fill="#333333"/></g></g>
      ${g('bill', path(P.bill, '#ffcf00'))}${g('wattle2', path(P.wattle2, '#ea0018'))}`)}
    ${g('wing', path(P.wing, '#fae3c0'))}`)}
  ${g('legL', `<path d="${P.foot}" fill="#333333" transform="translate(-18.05,51.5)"/>${path(P.leg, '#fff0d9').replace('<path', '<path transform="translate(-18.727,18.249)"')}`)}
</svg>`;

// Small hairline cracks, as if the chicken pecked the glass.
const crackSvg = () => {
  const arms = 5 + Math.floor(Math.random() * 3);
  let lines = '';
  for (let i = 0; i < arms; i += 1) {
    const a = (i / arms) * Math.PI * 2 + Math.random() * 0.6;
    let x = 0; let y = 0; let d = 'M0,0';
    const segs = 2 + Math.floor(Math.random() * 2);
    for (let s = 0; s < segs; s += 1) {
      const len = 6 + Math.random() * 9;
      const turn = a + (Math.random() - 0.5) * 0.9;
      x += Math.cos(turn) * len; y += Math.sin(turn) * len;
      d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    }
    lines += `<path d="${d}"/>`;
  }
  return `<svg viewBox="-30 -30 60 60" width="58" height="58"><g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <g stroke="rgba(255,255,255,.9)" stroke-width="3">${lines}</g><g stroke="#2a3833" stroke-width="1.5">${lines}</g>
    <circle r="2.6" fill="#2a3833"/></g></svg>`;
};

const MAX_CRACKS = 30;
let hen = null;       // the chicken while it is on screen
let idleTimer = null;
const pointer = { x: window.innerWidth / 2, y: window.innerHeight / 2 };   // where the mouse last was (the eye looks there)

const view = () => ({ w: window.innerWidth, h: window.innerHeight });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const lerp = (a, b, t) => a + (b - a) * t;

/** Write every part's transform from the current angles. */
function pose(h) {
  for (const [name, r] of Object.entries(RIG)) {
    const el = h.parts[name];
    if (!el) continue;
    const ang = h.ang[name] ?? 0;
    el.setAttribute('transform', `translate(${r.p[0]},${r.p[1]}) rotate(${ang.toFixed(2)}) translate(${-r.a[0]},${-r.a[1]})`);
  }
  h.parts.eyeball.setAttribute('transform', `scale(1,${h.lid.toFixed(3)})`);
}

/** Turn parts to new angles over ms. Resolves early (and harmlessly) if the chicken has gone. */
function tween(h, targets, ms) {
  const from = {}; for (const k of Object.keys(targets)) from[k] = k === 'lid' ? h.lid : (h.ang[k] ?? 0);
  return new Promise((resolve) => {
    const t0 = performance.now();
    const step = (now) => {
      if (hen !== h) { resolve(); return; }
      const t = Math.min(1, (now - t0) / ms);
      const e = ease(t);
      for (const [k, v] of Object.entries(targets)) { if (k === 'lid') h.lid = lerp(from[k], v, e); else h.ang[k] = lerp(from[k], v, e); }
      if (t < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Every frame: legs step while walking, and the pupil looks at the mouse pointer (or straight out while staring). */
function frame(h) {
  if (hen !== h && !h.leaving) return;
  const t = performance.now() / 1000;
  if (h.walking) {
    const swing = Math.sin(t * Math.PI * 2 / 0.36) * 22;
    h.ang.legL = swing; h.ang.legR = -swing;
    h.ang.tail1 = Math.sin(t * 9) * 4; h.ang.combUp = Math.sin(t * 11) * 6; h.ang.combUp2 = Math.sin(t * 11 + 1) * 5;
  } else if (!h.pecking && !h.staring) {
    for (const k of ['legL', 'legR', 'tail1', 'combUp', 'combUp2']) h.ang[k] = lerp(h.ang[k] ?? 0, 0, 0.2);   // settle back to standing
  }
  // the eye: towards the pointer, worked out in the eye's own coordinates so it is right however the head is turned
  let want = PUPIL_REST;
  if (h.staring) want = [0, 0];
  else {
    try {
      const m = h.parts.eye.getScreenCTM()?.inverse();
      if (m) {
        const local = new DOMPoint(pointer.x, pointer.y).matrixTransform(m);
        const len = Math.hypot(local.x, local.y) || 1;
        const r = Math.min(13, len);
        want = [(local.x / len) * r, (local.y / len) * r];
      }
    } catch { /* keep looking ahead */ }
  }
  h.pupil[0] = lerp(h.pupil[0], want[0], 0.25); h.pupil[1] = lerp(h.pupil[1], want[1], 0.25);
  h.parts.pupil.setAttribute('cx', h.pupil[0].toFixed(2)); h.parts.pupil.setAttribute('cy', h.pupil[1].toFixed(2));
  pose(h);
  requestAnimationFrame(() => frame(h));
}

function place(h, x, y, ms = 0, how = 'linear') {
  h.el.style.transition = ms ? `transform ${ms}ms ${how}` : 'none';
  h.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  h.x = x; h.y = y;
}
const face = (h, right) => { h.right = right; h.flip.style.transform = right ? 'scaleX(1)' : 'scaleX(-1)'; };

/** Bits of feed (and a small puff of dust) where the beak meets the ground. No crack: the ground is not glass. */
function feedAtBeak(h) {
  const r = h.parts.bill.getBoundingClientRect();
  const x = h.right ? r.right - 3 : r.left + 3;
  const y = r.bottom - 2;
  const dust = document.createElement('span');
  dust.className = 'dust';
  dust.style.left = `${x}px`; dust.style.top = `${y}px`;
  getLayer().append(dust);
  setTimeout(() => dust.remove(), 650);
  for (let i = 0; i < 3; i += 1) {
    const f = document.createElement('span');
    f.className = 'feed';
    f.style.left = `${x}px`; f.style.top = `${y}px`;
    f.style.setProperty('--dx', `${(h.right ? 1 : -1) * (6 + Math.random() * 26) * (Math.random() < 0.3 ? -1 : 1)}px`);
    f.style.setProperty('--dy', `${-(14 + Math.random() * 22)}px`);
    f.style.setProperty('--rot', `${Math.round(Math.random() * 180)}deg`);
    getLayer().append(f);
    setTimeout(() => f.remove(), 700);
  }
}

/** A tap on the glass: a small crack where the beak hits the screen. It fades in about 10 seconds. */
function crackOnGlass(h) {
  const r = h.parts.bill.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const c = document.createElement('div');
  c.className = 'crack';
  c.style.left = `${x}px`; c.style.top = `${y}px`;
  c.style.transform = `translate(-50%,-50%) rotate(${Math.round(Math.random() * 360)}deg) scale(${(0.7 + Math.random() * 0.6).toFixed(2)})`;
  c.innerHTML = crackSvg();
  getLayer().append(c);
  h.cracks.push(c);
  setTimeout(() => { c.remove(); h.cracks = h.cracks.filter((k) => k !== c); }, 10_500);
  while (h.cracks.length > MAX_CRACKS) h.cracks.shift().remove();
}

/** Tip forward and peck 2 to 4 times (the Pitik peck: body 25°, neck snapping between 52.7° and 83.7°). */
async function peck(h) {
  h.pecking = true;
  await tween(h, { body: 25, neck: 52.7, tail1: -75, tail2: -75, tail3: -75, bill: -17.1, legL: 0, legR: 0 }, 260);
  const times = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < times && hen === h; i += 1) {
    await tween(h, { neck: 83.7, wing: 8, combUp: -11, combUp2: -12 }, 95);
    if (hen !== h) break;
    feedAtBeak(h);
    await tween(h, { neck: 52.7, wing: -8, combUp: -20, combUp2: -11, tail1: -93, tail2: -93, tail3: -93 }, 110);
    await tween(h, { tail1: -75, tail2: -75, tail3: -75 }, 90);
  }
  await tween(h, { body: 0, neck: 0, tail1: 0, tail2: 0, tail3: 0, bill: 0, wing: 0, combUp: 0, combUp2: 0 }, 320);
  h.pecking = false;
}

/** Turn to you, lean in as if close to the glass, and tap it 1 to 3 times. Each tap cracks the screen at the beak. */
async function tapGlass(h) {
  h.el.classList.add('looking', 'close');
  h.staring = true;
  await tween(h, { body: -4, neck: -8, combUp: 6, combUp2: 4 }, 260);
  await sleep(450); if (hen !== h) return;
  const taps = 1 + Math.floor(Math.random() * 3);
  for (let i = 0; i < taps && hen === h; i += 1) {
    await tween(h, { neck: 18, body: 2 }, 90);
    if (hen !== h) return;
    crackOnGlass(h);
    await tween(h, { neck: -8, body: -4 }, 130);
    await sleep(220 + Math.random() * 260);
  }
  if (hen !== h) return;
  await sleep(300);
  h.el.classList.remove('close');
  await tween(h, { body: 0, neck: 0, combUp: 0, combUp2: 0 }, 260);
  h.staring = false;
  h.el.classList.remove('looking');
}

async function blink(h) {
  h.el.classList.add('blink');
  await tween(h, { lid: 0.08 }, 70);
  await tween(h, { lid: 1 }, 110);
  h.el.classList.remove('blink');
}

/** Stop, straighten up with the head turned to you, stare and blink. */
async function stare(h) {
  h.el.classList.add('looking');
  h.staring = true;
  await tween(h, { body: -4, neck: -8, combUp: 6, combUp2: 4 }, 260);
  await sleep(350); if (hen !== h) return;
  await blink(h);
  await sleep(700); if (hen !== h) return;
  await blink(h);
  await sleep(500);
  await tween(h, { body: 0, neck: 0, combUp: 0, combUp2: 0 }, 260);
  h.staring = false;
  h.el.classList.remove('looking');
}

async function walkTo(h, tx, ty) {
  const ms = Math.max(900, (Math.hypot(tx - h.x, ty - h.y) / 70) * 1000);   // about 70 pixels a second
  face(h, tx >= h.x);
  h.walking = true; h.el.classList.add('walking');
  place(h, tx, ty, ms);
  await sleep(ms);
  h.walking = false; h.el.classList.remove('walking');
}

async function life(h) {
  const { w, h: vh } = view();
  const fromLeft = Math.random() < 0.5;
  place(h, fromLeft ? -170 : w + 20, vh * (0.45 + Math.random() * 0.35));
  face(h, fromLeft);
  h.el.getBoundingClientRect();
  while (hen === h) {
    if (!allowed()) { removeHen(); return; }
    const size = view();
    await walkTo(h, 10 + Math.random() * Math.max(40, size.w - 180), size.h * 0.22 + Math.random() * Math.max(40, size.h * 0.62 - 110));
    if (hen !== h) return;
    if (Math.random() < (window.__posGlassChance ?? 0.3)) await tapGlass(h); else await peck(h);   // a test can force it with window.__posGlassChance
    if (hen !== h) return;
    if (Math.random() < (window.__posStareChance ?? 0.4)) { await stare(h); if (hen !== h) return; }   // a test can force it with window.__posStareChance
    await sleep(300 + Math.random() * 900);
  }
}

/** Calm mode: it stands still, blinks now and then, and its eye still follows the pointer. */
async function standStill(h) {
  const { w, h: vh } = view();
  place(h, 40 + Math.random() * (w - 230), vh - 150);
  face(h, Math.random() < 0.5);
  while (hen === h) { await sleep(2500 + Math.random() * 2500); if (hen !== h) return; await blink(h); }
}

function spawnHen() {
  if (hen || !allowed() || document.querySelector('dialog[open]') || document.hidden) return;
  const el = document.createElement('div');
  el.className = 'hen';
  el.innerHTML = `<div class="hen-flip"><div class="hen-body">${HEN_SVG}</div></div>`;
  getLayer().append(el);
  const parts = {};
  for (const p of el.querySelectorAll('[data-part]')) parts[p.dataset.part] = p;
  const h = { el, flip: el.querySelector('.hen-flip'), parts, ang: {}, lid: 1, pupil: [...PUPIL_REST], x: 0, y: 0, right: true, cracks: [], walking: false, pecking: false, staring: false, leaving: false };
  hen = h;
  pose(h);
  requestAnimationFrame(() => frame(h));
  if (reduceMotion()) standStill(h); else life(h);
}

function removeHen() {
  if (!hen) return;
  const h = hen;
  hen = null;
  h.cracks.forEach((c) => c.remove());
  h.el.remove();
}

/** Someone is back: the chicken hurries off the nearest side (glancing at the pointer), and its cracks disappear with it. */
function sendHenAway() {
  if (!hen) return;
  const h = hen;
  hen = null;
  h.cracks.forEach((c) => c.remove()); h.cracks = [];
  if (reduceMotion()) { h.el.remove(); return; }
  h.leaving = true; h.walking = true; h.pecking = false; h.staring = false;
  h.el.classList.add('walking'); h.el.classList.remove('looking');
  h.ang.body = 0; h.ang.neck = -6;
  const { w } = view();
  const left = h.x + 75 < w / 2;
  face(h, !left);
  place(h, left ? -200 : w + 60, h.y, 450, 'ease-in');
  requestAnimationFrame(() => frame(h));
  setTimeout(() => { h.leaving = false; h.el.remove(); }, 480);
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
  if (e && 'clientX' in e && e.type !== 'keydown') { pointer.x = e.clientX; pointer.y = e.clientY; }
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
