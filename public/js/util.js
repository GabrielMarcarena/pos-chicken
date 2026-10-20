// Small helpers shared by every screen.
import { LABELS, COUNTS_AS_SALE, FULFILLMENT, FULFILLMENT_LABELS } from '/shared/constants.js';
import { serviceLabel } from '/shared/rules.js';
export { formatPeso, formatKg, formatThousandths } from '/shared/money.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape text before putting it in HTML. Everything typed by a person goes through this. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const label = (code) => LABELS[code] ?? code;

const PH = { timeZone: 'Asia/Manila' };
export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-PH', { ...PH, dateStyle: 'medium', timeStyle: 'short' }) : '');
export const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00+08:00`).toLocaleDateString('en-PH', { ...PH, dateStyle: 'medium' }) : '');
export const todayPH = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

/** Random id that also works over plain http on a shop network (crypto.randomUUID needs https). */
export function uuid() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function toast(message, kind = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast${kind === 'error' ? ' toast--error' : kind === 'ok' ? ' toast--ok' : ''}`;
  el.textContent = message;
  box.append(el);
  setTimeout(() => el.remove(), kind === 'error' ? 7000 : 3500);
}

export function errorBox(err) {
  const details = err.details?.length ? `<ul>${err.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '';
  return `<div class="error-box" role="alert"><strong>${esc(err.message)}</strong>${details}</div>`;
}

/**
 * Open the shared dialog. actions: [{ label, kind, value, onClick(dialog) }].
 * onClick may return false to keep the dialog open (for example after showing an error).
 * Resolves with the chosen action's value, or null when closed with Esc or the close button.
 */
export function openDialog({ title, body, actions = [], onOpen }) {
  const dlg = $('#dialog');
  dlg.innerHTML = `
    <div class="dlg-head"><h2>${esc(title)}</h2><button type="button" class="btn btn--plain btn--small" data-dlg-close aria-label="Close">Close</button></div>
    <div class="dlg-body">${body}</div>
    <div class="dlg-foot">${actions.map((a, i) => `<button type="button" class="btn ${a.kind ? 'btn--' + a.kind : ''}" data-dlg-action="${i}">${esc(a.label)}</button>`).join('')}</div>`;
  return new Promise((resolve) => {
    // Resolve only after the browser has fired the dialog's "close" event. Resolving earlier lets the next dialog
    // open while that event is still on its way, and the stale event would then close the new dialog's promise.
    const finish = (value) => {
      dlg.onclose = () => resolve(value);
      if (dlg.open) dlg.close(); else resolve(value);
    };
    dlg.onclose = () => resolve(null); // Esc key
    dlg.onclick = async (e) => {
      if (e.target.closest('[data-dlg-close]')) return finish(null);
      const btn = e.target.closest('[data-dlg-action]');
      if (!btn) return undefined;
      const action = actions[Number(btn.dataset.dlgAction)];
      if (!action.onClick) return finish(action.value ?? true);
      btn.disabled = true;
      try {
        const result = await action.onClick(dlg);
        if (result !== false) finish(result ?? action.value ?? true);
      } finally { btn.disabled = false; }
      return undefined;
    };
    // Revision 13 (keyboard): Enter in a box presses the main button; a question with a main (not a danger) button starts on it, so Enter
    // confirms. A danger question (cancel an order ...) starts on the first button, so a stray Enter never does the dangerous thing.
    const mainIndex = actions.findIndex((a) => a.kind === 'primary');
    dlg.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.isComposing || mainIndex < 0) return;
      const t = e.target;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT') return;
      const btn = dlg.querySelector(`[data-dlg-action="${mainIndex}"]`);
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    };
    dlg.showModal();
    const start = mainIndex >= 0 ? dlg.querySelector(`[data-dlg-action="${mainIndex}"]`) : dlg.querySelector('[data-dlg-action="0"]');
    (dlg.querySelector('.dlg-body input:not([type="hidden"]), .dlg-body select, .dlg-body textarea') ?? start)?.focus();
    onOpen?.(dlg);
  });
}

export const closeDialog = () => { const dlg = $('#dialog'); dlg.onclose = null; if (dlg.open) dlg.close(); };

export async function confirmDialog(message, { confirmLabel = 'Yes, continue', cancelLabel = 'Go back', danger = false, title = 'Please confirm' } = {}) {
  const result = await openDialog({
    title, body: `<p>${esc(message)}</p>`,
    actions: [{ label: cancelLabel, value: false }, { label: confirmLabel, kind: danger ? 'danger' : 'primary', value: true }],
  });
  return result === true;
}

export function statusBadge(status) {
  const text = { COMPLETED: 'Completed', CANCELED: 'Canceled', REFUNDED: 'Refunded', PARTIALLY_REFUNDED: 'Partially refunded', REPLACED: 'Replaced' }[status] ?? status;
  return `<span class="badge badge--${status.toLowerCase()}">${esc(text)}</span>`;
}

/**
 * The status an order shows on the Orders screen. It is the same saved value the Order List board uses (orders.fulfillment_status),
 * so the two screens can never disagree. An order that is on the Order List shows its column: Ongoing, Standby or Complete.
 * A refunded order is still on the list, so it also carries its Refunded badge. A canceled or replaced order is not on the
 * Order List (it was never going to be picked up), so it shows Canceled or Replaced instead.
 */
export function orderStatusBadges(o) {
  const onList = COUNTS_AS_SALE.includes(o.status) && FULFILLMENT.includes(o.fulfillment_status);
  if (!onList) return statusBadge(o.status);
  const stage = `<span class="badge badge--${o.fulfillment_status.toLowerCase()}" data-stage="${o.fulfillment_status}">${esc(FULFILLMENT_LABELS[o.fulfillment_status])}</span>`;
  return o.status === 'COMPLETED' ? stage : `${stage} ${statusBadge(o.status)}`;
}

/** Plain text list of the preparation chosen on a chicken line: the service (Live, Pour, Dress, Po-ur & Slice, Dress & Slice, Pour & Dukot, Dress & Dukot), With Blood, then the slice size. */
export function prepChips(prep) {
  const chips = [];
  const service = prep.service_label || serviceLabel({ feather: prep.feather, cut: prep.cut });   // the name saved on the line (or chosen now) wins; older lines are worked out from feather + cut
  if (service) chips.push(service);
  if (prep.dara) chips.push(label('DARA'));
  if (prep.cut === 'SLICE') chips.push(label(prep.sliceSize ?? prep.slice_size));
  return chips;
}

/** A small picture for a product card, picked from the product name so new products get a sensible one (used when no photo is uploaded). */
const ICONS = [[/egg/i, '🥚'], [/etag/i, '🥓'], [/garlic/i, '🧄'], [/onion/i, '🧅'], [/laya|ginger|turmeric|spice/i, '🌿'],
  [/rice/i, '🍚'], [/sayote|chayote|vegetable|veggie/i, '🥒'], [/duck|itik|pato/i, '🦆'], [/catfish|hito|fish|tilapia|bangus/i, '🐟'],
  [/chicken|broiler|cull|manok|native/i, '🐔']];
export const iconFor = (name) => ICONS.find(([re]) => re.test(name))?.[1] ?? '🛒';

/**
 * The picture of a product card (Revision 11): the uploaded photo when there is one, otherwise the icon. If the photo cannot be loaded,
 * the icon takes its place (see watchImages). kind is 'chicken' or 'other'.
 */
export function productPicture(kind, product) {
  const icon = `<span class="ico-fallback" aria-hidden="true">${iconFor(product.name)}</span>`;
  if (!product.image_version) return icon;
  return `<img class="pic" src="/api/product-images/${kind}/${product.id}?v=${encodeURIComponent(product.image_version)}" alt="" loading="lazy" decoding="async">${icon}`;
}

/** A photo that fails to load is hidden, and the icon next to it shows instead. One listener per element (inline handlers are not allowed). */
const watched = new WeakSet();
export function watchImages(root) {
  if (watched.has(root)) return;
  watched.add(root);
  root.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement && e.target.classList.contains('pic')) e.target.closest('.ico')?.classList.add('ico--broken');
  }, true);
}

/** "2 pcs · 1.5 kg" for a line sold by the kilo with its pieces, "1.5 kg" for an older one, "3 piece" for a fixed unit. */
export function otherQtyText(line) {
  if (line.sold_by !== 'PER_KG') return `${line.quantity_milli / 1000} ${line.unit}`;
  const kg = `${formatThousandthsLocal(line.quantity_milli)} kg`;
  return line.pieces ? `${line.pieces} pc${line.pieces === 1 ? '' : 's'} · ${kg}` : kg;
}
const formatThousandthsLocal = (n) => { let s = (n / 1000).toFixed(3).replace(/0+$/, ''); if (s.endsWith('.')) s += '0'; return s; };

/**
 * A short explanation folded away. Each page keeps one short line; the full explanation opens with "How it works" when someone wants it
 * (Revision 16). html is trusted markup written in this app, never text typed by a person.
 */
export function howItWorks(html, title = 'How it works') {
  return `<details class="how"><summary>${title}</summary><div class="how-body">${html}</div></details>`;
}

// ---- One "Edit" button that opens a small menu (Revision 22) ------------------------------------------------------------
/**
 * items: [{ label, attr, value, danger }]. Each item keeps its own data-attribute, so a screen's click handler works as if the
 * button sat on the row. Falsy items are skipped.
 */
export function rowMenu(items, label = 'Edit') {
  const list = items.filter(Boolean);
  return `<div class="row-menu"><button type="button" class="btn btn--small" data-menu aria-haspopup="menu" aria-expanded="false">${esc(label)} <span aria-hidden="true">▾</span></button>
    <div class="row-menu-list" role="menu" hidden>${list.map((i) => `<button type="button" role="menuitem" class="${i.danger ? 'is-danger' : ''}" ${i.attr}="${esc(i.value ?? '')}">${esc(i.label)}</button>`).join('')}</div></div>`;
}

function closeMenus(except) {
  for (const list of document.querySelectorAll('.row-menu-list:not([hidden])')) {
    if (list === except) continue;
    list.hidden = true;
    list.closest('.row-menu')?.querySelector('[data-menu]')?.setAttribute('aria-expanded', 'false');
  }
}

/** Opens and closes every row menu. Called once at start. */
export function installRowMenus() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) { closeMenus(); return; }
    const list = btn.parentElement.querySelector('.row-menu-list');
    const open = list.hidden;
    closeMenus(open ? list : null);
    list.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    list.classList.remove('up');
    if (open) {
      if (list.getBoundingClientRect().bottom > window.innerHeight - 8) list.classList.add('up');
      list.querySelector('button')?.focus();
    }
    e.stopPropagation();
  }, true);
  document.addEventListener('keydown', (e) => {
    const list = document.querySelector('.row-menu-list:not([hidden])');
    if (!list) return;
    if (e.key === 'Escape') { const b = list.parentElement.querySelector('[data-menu]'); closeMenus(); b.focus(); e.stopPropagation(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll('button')];
    const i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    e.preventDefault();
  }, true);
  // picking an item closes the menu (the screen's own handler still runs)
  document.addEventListener('click', (e) => { if (e.target.closest('.row-menu-list button')) setTimeout(() => closeMenus(), 0); });
}

// ---- Phones: a table row becomes a small card (Revision 22) --------------------------------------------------------------
// Every plain "data" table gets a data-label on each cell (its column heading). The stylesheet shows the label inside the card below 640px.
const CARD_SKIP = '.inv, .cash-table, .adv-table, .report-table, .opts-table';
function labelTables(root) {
  for (const t of root.querySelectorAll('table.data')) {
    if (t.matches(CARD_SKIP) || t.dataset.labelled === String(t.rows.length)) continue;
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent.trim());
    if (!heads.length || [...t.querySelectorAll('thead th')].some((th) => th.colSpan > 1)) continue;
    t.classList.add('data--cards');
    for (const tr of t.tBodies[0]?.rows ?? []) [...tr.cells].forEach((td, i) => { if (heads[i] && !td.dataset.label) td.dataset.label = heads[i]; });
    t.dataset.labelled = String(t.rows.length);
  }
}
export function installTableCards() {
  const main = document.querySelector('#main');
  if (!main) return;
  let queued = false;
  new MutationObserver(() => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; labelTables(main); }); }).observe(main, { childList: true, subtree: true });
  labelTables(main);
}
