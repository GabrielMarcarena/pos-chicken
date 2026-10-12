// Small helpers shared by every screen.
import { LABELS, COUNTS_AS_SALE, FULFILLMENT, FULFILLMENT_LABELS } from '/shared/constants.js';
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
    dlg.showModal();
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

/** Plain text list of the preparation chosen on a chicken line: service, Dara, then the slice size or Dukot. */
export function prepChips(prep) {
  const chips = [];
  if (prep.feather) chips.push(label(prep.feather));
  if (prep.dara) chips.push('Dara');
  if (prep.cut === 'SLICE') chips.push(label(prep.sliceSize ?? prep.slice_size));
  if (prep.cut === 'DUKOT') chips.push('Dukot');
  return chips;
}

/** A small picture for a product card, picked from the product name so new products get a sensible one. */
const ICONS = [[/egg/i, '🥚'], [/etag/i, '🥓'], [/garlic/i, '🧄'], [/onion/i, '🧅'], [/laya|ginger|turmeric|spice/i, '🌿'],
  [/rice/i, '🍚'], [/sayote|chayote|vegetable|veggie/i, '🥒'], [/chicken|broiler|cull|manok|native/i, '🐔']];
export const iconFor = (name) => ICONS.find(([re]) => re.test(name))?.[1] ?? '🛒';
