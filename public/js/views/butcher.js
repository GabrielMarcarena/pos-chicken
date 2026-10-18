// Butcher screen: for the TV in the butcher area. It shows only what the butcher needs, nothing else (no tabs, no prices, no buttons).
//   * ONGOING orders are big and bright on the left: tracking number, customer, and how each chicken is cut. This is the screen's purpose.
//   * STANDBY orders (ready, waiting for the customer) are small and dim on the right, so they never compete with Ongoing.
//   * COMPLETE orders are gone: the server does not send them.
// It asks the server every few seconds. If the server cannot be reached it says so and keeps the last orders on screen.
import { api } from '../api.js';
import { esc, prepChips, formatKg } from '../util.js';

const POLL_MS = 3000;
const NEW_FOR_MS = 60_000;
let timer = null;
let clockTimer = null;
const seen = new Map();   // order id -> when this screen first saw it (so a new order glows for a minute)
let firstLoad = true;
let lastJson = '';
let orders = [];

export async function mountButcher(root) {
  stopButcher();
  document.title = 'Butcher - Chicken POS';
  document.body.classList.add('display-mode', 'display-butcher');
  seen.clear(); firstLoad = true; lastJson = ''; orders = [];
  root.innerHTML = `<div class="bt">
      <header class="bt-head"><h1>BUTCHER</h1><div class="bt-head-r"><span id="btOffline" class="bt-offline" hidden>Not connected &mdash; trying again&hellip;</span><span id="btClock" class="bt-clock"></span></div></header>
      <div class="bt-grid"><section class="bt-ongoing" aria-label="Ongoing orders"><h2 class="bt-h">Ongoing <span id="btOnN" class="bt-n">0</span></h2><div id="btOn" class="bt-cards"></div><div id="btOnEmpty" class="bt-empty">No orders to prepare.</div></section>
        <aside class="bt-standby" aria-label="Ready for pickup"><h2 class="bt-h bt-h--dim">Ready for pickup <span id="btStN" class="bt-n">0</span></h2><ul id="btSt" class="bt-sb"></ul><p id="btStEmpty" class="bt-sbempty">None waiting.</p></aside></div>
    </div>`;
  tickClock();
  clockTimer = setInterval(() => { tickClock(); refreshAges(); }, 1000);
  await load();
  timer = setInterval(load, POLL_MS);
}

export function stopButcher() {
  clearInterval(timer); clearInterval(clockTimer); timer = clockTimer = null;
  document.body.classList.remove('display-mode', 'display-butcher');
}

async function load() {
  if (!document.getElementById('btOn')) { stopButcher(); return; }
  try {
    const data = await api('GET', '/api/butcher');
    setOffline(false);
    const now = Date.now();
    for (const o of data.orders) if (!seen.has(o.id)) seen.set(o.id, firstLoad ? 0 : now);   // 0 = was already there when the screen opened
    const json = JSON.stringify(data.orders);
    if (json !== lastJson) { lastJson = json; orders = data.orders; draw(); }
    firstLoad = false;   // after the first drawing: what is already there when the screen opens simply appears; later arrivals animate
  } catch (err) {
    if (err.status === 401 || err.status === 403) { stopButcher(); return; }   // signed out: the app shows the sign-in screen
    setOffline(true);
  }
}

function setOffline(on) {
  const el = document.getElementById('btOffline');
  if (el) el.hidden = !on;
}

function tickClock() {
  const el = document.getElementById('btClock');
  if (el) el.textContent = new Date().toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Manila' });
}

const minutesAgo = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000));
const ageText = (iso) => { const m = minutesAgo(iso); return m < 1 ? 'just now' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };

function refreshAges() {
  document.querySelectorAll('[data-age]').forEach((el) => { el.textContent = ageText(el.dataset.age); });
  document.querySelectorAll('.bt-card.bt-new').forEach((el) => { if (Date.now() - Number(el.dataset.seen) > NEW_FOR_MS) { el.classList.remove('bt-new'); el.querySelector('.bt-newtag')?.remove(); } });
}

const who = (o) => (o.customer_number && o.customer_number !== 'WALK-IN' ? o.customer_number : 'Walk-in');
const tag = (o) => (o.tracking_number == null ? '—' : o.tracking_number);

function lineHtml(i) {
  const prep = prepChips({ feather: i.feather, dara: i.dara, cut: i.cut, slice_size: i.slice_size });
  const service = prep[0] ?? '';
  const extra = prep.slice(1);
  return `<li class="bt-line"><div class="bt-line-top"><span class="bt-prod">${esc(i.name)}</span>
      <span class="bt-qty">${i.heads > 1 ? `${i.heads} heads &middot; ` : ''}${formatKg(i.weight_g)} kg</span></div>
    <div class="bt-prep"><span class="bt-service">${esc(service)}</span>${extra.map((c) => `<span class="bt-extra">${esc(c)}</span>`).join('')}</div></li>`;
}

function ongoingCard(o) {
  const at = seen.get(o.id) ?? 0;
  const fresh = at && Date.now() - at < NEW_FOR_MS;
  return `<article class="bt-card${fresh ? ' bt-new' : ''}" data-id="${o.id}" data-seen="${at}" aria-label="Tracking number ${esc(tag(o))}, ${esc(who(o))}">
    <div class="bt-tag" aria-hidden="true"><span class="bt-hash">#</span>${esc(tag(o))}</div>
    <div class="bt-main">
      <div class="bt-who"><span class="bt-cust">${esc(who(o))}</span><span class="bt-meta">${esc(o.order_number)} &middot; <span data-age="${esc(o.submitted_at)}">${esc(ageText(o.submitted_at))}</span></span>${fresh ? '<span class="bt-newtag">NEW</span>' : ''}</div>
      <ul class="bt-lines">${o.items.map(lineHtml).join('')}</ul>
    </div></article>`;
}

function standbyRow(o) {
  return `<li class="bt-sbrow" data-id="${o.id}"><span class="bt-sbtag">#${esc(tag(o))}</span><span class="bt-sbwho">${esc(who(o))}</span></li>`;
}

// Changes are shown smoothly, never as a jump:
//   * an order that leaves a list (moved to Standby, or Complete) shrinks and fades away, then the cards below slide up into the gap;
//   * an order that arrives (new, or on its way to Standby) grows and fades in;
//   * a card whose details did not change is left alone, so nothing flickers every 3 seconds.
const LEAVE_MS = 450;
const ENTER_MS = 500;
const html = (markup) => { const t = document.createElement('template'); t.innerHTML = markup.trim(); return t.content.firstElementChild; };
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Slide the remaining items from where they were to where they are now (FLIP), so a gap closes smoothly. */
function flip(container, change) {
  const before = new Map([...container.children].filter((c) => c.dataset.id && !c.classList.contains('bt-leave')).map((c) => [c.dataset.id, c.getBoundingClientRect()]));
  change();
  if (reduceMotion()) return;
  for (const el of container.children) {
    const was = before.get(el.dataset.id);
    if (!was || el.classList.contains('bt-leave')) continue;
    const now = el.getBoundingClientRect();
    const dx = was.left - now.left; const dy = was.top - now.top;
    if (!dx && !dy) continue;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.getBoundingClientRect();   // apply the starting position before the move is switched on
    el.style.transition = 'transform .4s ease';
    el.style.transform = '';
    setTimeout(() => { el.style.transition = ''; }, 450);
  }
}

function sync(container, list, build) {
  const wanted = new Set(list.map((o) => String(o.id)));
  const live = [...container.children].filter((c) => !c.classList.contains('bt-leave'));
  const have = new Map(live.map((c) => [c.dataset.id, c]));
  const leaving = live.filter((c) => !wanted.has(c.dataset.id));
  flip(container, () => {
    for (const el of leaving) {
      el.classList.add('bt-leave');
      setTimeout(() => flip(container, () => el.remove()), LEAVE_MS);
    }
    let prev = null;
    for (const o of list) {
      const hash = JSON.stringify(o);
      let el = have.get(String(o.id));
      if (!el) {
        el = html(build(o));
        el.dataset.h = hash;
        if (!firstLoad) { el.classList.add('bt-enter'); setTimeout(() => el.classList.remove('bt-enter'), ENTER_MS); }
      } else if (el.dataset.h !== hash) {
        const fresh = html(build(o));
        fresh.dataset.h = hash;
        el.replaceWith(fresh); el = fresh;
      }
      const after = prev ? prev.nextElementSibling : container.firstElementChild;
      if (el !== after) container.insertBefore(el, after);
      prev = el;
    }
  });
}

function draw() {
  const on = orders.filter((o) => o.fulfillment_status === 'ONGOING');
  const st = orders.filter((o) => o.fulfillment_status === 'STANDBY');
  document.getElementById('btOnN').textContent = on.length;
  document.getElementById('btStN').textContent = st.length;
  sync(document.getElementById('btOn'), on, ongoingCard);
  sync(document.getElementById('btSt'), st, standbyRow);
  document.getElementById('btOnEmpty').hidden = on.length > 0;
  document.getElementById('btStEmpty').hidden = st.length > 0;
}
