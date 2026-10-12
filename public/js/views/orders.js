// Order history: find an order by number, see exactly what was saved, and cancel, change or refund it.
import { api, download } from '../api.js';
import { state, saveDraft, newDraft, refreshConfig } from '../state.js';
import { $, esc, label, formatPeso, formatThousandths, fmtDateTime, fmtDate, todayPH, toast, errorBox, openDialog, closeDialog, confirmDialog, orderStatusBadges, uuid } from '../util.js';
import { REASONS, ACTION_LABELS, PAYMENT_METHODS, STATUS_LABELS, FULFILLMENT, FULFILLMENT_LABELS, COUNTS_AS_SALE } from '/shared/constants.js';
import { orderTable } from './slip.js';
import { resetCheckoutUi } from './checkout.js';

const filters = { q: '', from: todayPH(), to: todayPH(), status: '' };
const isManager = () => state.user.role === 'manager' || state.user.role === 'admin';

export async function mountOrders(root) {
  // The words on the Order List come first (Ongoing, Standby, Complete); the sale statuses stay available under their own heading.
  const opt = (value, text) => `<option value="${value}" ${filters.status === value ? 'selected' : ''}>${esc(text)}</option>`;
  const statusOptions = `<option value="">Any status</option>
    <optgroup label="Order List">${FULFILLMENT.map((f) => opt(`pickup:${f}`, FULFILLMENT_LABELS[f])).join('')}</optgroup>
    <optgroup label="Sale">${Object.keys(STATUS_LABELS).map((st) => opt(`sale:${st}`, STATUS_LABELS[st])).join('')}</optgroup>`;
  root.innerHTML = `
    <div class="panel">
      <div class="panel-head"><h1>Orders</h1></div>
      <form id="filters" class="filters">
        <div class="field"><label for="fq">Order number or customer</label><input id="fq" type="text" value="${esc(filters.q)}" placeholder="ORD-20261009-001" autocomplete="off"></div>
        <div class="field"><label for="ffrom">From</label><input id="ffrom" type="date" value="${esc(filters.from)}"></div>
        <div class="field"><label for="fto">To</label><input id="fto" type="date" value="${esc(filters.to)}"></div>
        <div class="field"><label for="fstatus">Status</label><select id="fstatus">${statusOptions}</select></div>
        <button class="btn btn--primary" type="submit">Search</button>
      </form>
      <p class="muted mt-s">Searching by order number looks through all dates.</p>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Daily Sales Report</h2></div>
      <p class="muted">The report from your paper form, filled in with what the app knows: sales by chicken type, heads, kilos, prices, service, eggs, other products and the totals. The parts you count by hand (balances, expenses, cash count) are left empty for you.${isManager() ? '' : ' It shows your own sales.'}</p>
      <div id="dailyError"></div>
      <div class="filters mt-s">
        <div class="field"><label for="dDate">Report date</label><input id="dDate" type="date" value="${esc(todayPH())}"></div>
        ${isManager() ? '<div class="field"><label for="dCashier">Cashier</label><select id="dCashier"><option value="">All cashiers</option></select></div>' : ''}
        <button type="button" class="btn btn--primary" id="dailyXlsx">Download Excel (like the paper form)</button>
        <button type="button" class="btn" id="dailyCsv">Download CSV (one row per sale line)</button>
      </div>
    </div>
    ${isManager() ? `<div class="panel">
      <div class="panel-head"><h2>Spreadsheet export</h2></div>
      <p class="muted">Downloads the orders in the date range above: one row per item, canceled orders in red, with daily, weekly and monthly summaries.</p>
      <div id="exportError"></div>
      <div class="btn-row mt-s">
        <button type="button" class="btn btn--primary" id="exportXlsx">Download Excel (.xlsx)</button>
        <button type="button" class="btn" id="exportCsv">Download CSV</button>
      </div></div>` : ''}
    <div class="panel" id="results" aria-live="polite"></div>`;

  $('#filters').onsubmit = (e) => { e.preventDefault(); readFilters(); load(); };
  const daily = (ext) => async () => {
    $('#dailyError').innerHTML = '';
    const qs = new URLSearchParams({ date: $('#dDate').value || todayPH() });
    if (isManager() && $('#dCashier').value) qs.set('cashier', $('#dCashier').value);
    try { await download(`/api/daily-report.${ext}?${qs}`, `daily-sales-report.${ext}`); toast('Daily report downloaded.', 'ok'); }
    catch (err) { $('#dailyError').innerHTML = errorBox(err); }
  };
  $('#dailyXlsx').onclick = daily('xlsx');
  $('#dailyCsv').onclick = daily('csv');
  if (isManager()) {
    api('GET', '/api/staff').then(({ staff }) => {
      $('#dCashier').insertAdjacentHTML('beforeend', staff.map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join(''));
    }).catch(() => {});
  }
  if (isManager()) {
    const run = (ext) => async () => {
      readFilters();
      $('#exportError').innerHTML = '';
      const qs = new URLSearchParams({ from: filters.from, to: filters.to });
      try { await download(`/api/export.${ext}?${qs}`, `chicken-pos.${ext}`); toast('Export downloaded.', 'ok'); }
      catch (err) { $('#exportError').innerHTML = errorBox(err); }
    };
    $('#exportXlsx').onclick = run('xlsx');
    $('#exportCsv').onclick = run('csv');
  }
  $('#results').onclick = (e) => {
    const row = e.target.closest('[data-open]');
    if (row) openDetail(Number(row.dataset.open));
  };
  await load();
  startAutoRefresh();
}

function readFilters() {
  filters.q = $('#fq').value.trim();
  filters.from = $('#ffrom').value;
  filters.to = $('#fto').value;
  filters.status = $('#fstatus').value;
}

let loadSeq = 0;
let refreshTimer = null;

async function load({ quiet = false } = {}) {
  const box = $('#results');
  if (!box) return; // the details were opened from the Order List, not from this screen
  const seq = ++loadSeq;
  if (!quiet) box.innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Loading orders...</p>';
  const qs = new URLSearchParams();
  if (filters.q) qs.set('q', filters.q);
  else { if (filters.from) qs.set('from', filters.from); if (filters.to) qs.set('to', filters.to); }
  const [kind, code] = filters.status.split(':');
  if (kind === 'pickup') qs.set('pickup', code);
  else if (kind === 'sale') qs.set('status', code);
  try {
    const { orders } = await api('GET', `/api/orders?${qs}`);
    if (seq !== loadSeq || !$('#results')) return; // a newer search started, or the person left this screen
    if (!orders.length) { box.innerHTML = '<div class="empty">No orders match. Change the dates or the search.</div>'; return; }
    box.innerHTML = `<p class="muted">${orders.length} ${orders.length === 1 ? 'order' : 'orders'}${orders.length >= 200 ? ' (showing the latest 200)' : ''}</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>Order number</th><th>Date and time</th><th>Customer</th><th class="num">Items</th><th class="num">Total</th><th>Status</th><th>Cashier</th></tr></thead>
        <tbody>${orders.map((o) => `<tr class="clickable row--${o.status.toLowerCase().replace('partially_refunded', 'refunded')}" data-open="${o.id}" data-order-id="${o.id}">
          <td><button type="button" class="btn btn--plain btn--small" data-open="${o.id}"><strong>${esc(o.order_number)}</strong></button></td>
          <td class="nowrap">${esc(fmtDateTime(o.submitted_at))}</td><td>${esc(o.customer_number === 'WALK-IN' ? 'Walk-in' : o.customer_number)}</td>
          <td class="num">${o.line_count}</td><td class="num">${formatPeso(o.total_centavos)}</td><td data-order-status>${orderStatusBadges(o)}</td><td>${esc(o.cashier_name)}</td></tr>`).join('')}</tbody>
      </table></div>`;
  } catch (err) {
    if (seq !== loadSeq || !$('#results')) return;
    if (!quiet) box.innerHTML = errorBox(err); // a failed background refresh keeps what is on screen
  }
}

/**
 * Statuses are moved on the Order List, possibly on another device. While this screen is open the list quietly asks for
 * the saved statuses again, so what it shows is never older than a few seconds. It stops by itself when the person leaves.
 */
const REFRESH_MS = 20000;
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if (!$('#results') || location.hash !== '#/orders') { clearInterval(refreshTimer); refreshTimer = null; return; }
    if (document.hidden || document.querySelector('dialog[open]')) return;
    load({ quiet: true });
  }, REFRESH_MS);
}

function timeline(order) {
  return `<ol class="timeline">${order.events.map((e) => {
    const cls = { CANCEL: 't-cancel', REFUND: 't-refund', CHANGE: 't-change', MOVE: 't-move' }[e.action_type] ?? '';
    const reason = e.reason_code ? `<div>Reason: ${esc(REASONS[e.reason_code] ?? e.reason_code)}${e.reason_note ? ` &mdash; ${esc(e.reason_note)}` : ''}</div>` : (e.reason_note ? `<div>${esc(e.reason_note)}</div>` : '');
    const extra = [
      e.related_number && e.action_type === 'CHANGE' ? `Replaced by ${esc(e.related_number)}` : '',
      e.refund_centavos ? `Refunded ${formatPeso(e.refund_centavos)}` : '',
      e.stock_returnable === true ? 'Chicken can go back into stock' : e.stock_returnable === false ? 'Chicken cannot go back into stock' : '',
    ].filter(Boolean).map((t) => `<div class="muted">${t}</div>`).join('');
    return `<li class="${cls}"><strong>${esc(ACTION_LABELS[e.action_type])}</strong> by ${esc(e.user_name)} <span class="muted">${esc(fmtDateTime(e.created_at))}</span>${reason}${extra}</li>`;
  }).join('')}</ol>`;
}

function paymentBlock(order) {
  if (!order.payments.length) return '<p class="muted">No payment details were recorded.</p>';
  return order.payments.map((p) => `<dl class="kv">
      <dt>Method</dt><dd>${esc(PAYMENT_METHODS[p.method])}</dd>
      <dt>Amount</dt><dd>${formatPeso(p.amount_centavos)}</dd>
      ${p.paid_at ? `<dt>Paid at</dt><dd>${esc(fmtDateTime(p.paid_at))}</dd>` : ''}
      ${p.account_name ? `<dt>Account name</dt><dd>${esc(p.account_name)}</dd>` : ''}
      ${p.account_number ? `<dt>Account number</dt><dd>${esc(p.account_number)}</dd>` : ''}
      ${p.reference ? `<dt>Reference</dt><dd>${esc(p.reference)}</dd>` : ''}</dl>`).join('');
}

export async function openDetail(id) {
  let order;
  try { ({ order } = await api('GET', `/api/orders/${id}`)); } catch (err) { toast(err.message, 'error'); return; }
  const open = order.status === 'COMPLETED';
  const actions = [{ label: 'Close', value: null }];
  if (open) {
    actions.push({ label: 'Cancel order', kind: 'danger', value: 'cancel' }, { label: 'Change order', value: 'change' });
    if (isManager()) actions.push({ label: 'Refund order', kind: 'danger', value: 'refund' });
  }
  const links = [order.replaces_number ? `Replaces ${esc(order.replaces_number)}` : '', order.replaced_by_number ? `Replaced by ${esc(order.replaced_by_number)}` : ''].filter(Boolean).join(' &middot; ');
  const choice = await openDialog({
    title: order.order_number,
    body: `
      <div class="btn-row"><span data-order-status>${orderStatusBadges(order)}</span> <span class="muted">${links}</span></div>
      <dl class="kv">
        <dt>Date and time</dt><dd>${esc(fmtDateTime(order.submitted_at))}</dd>
        <dt>Customer</dt><dd>${esc(order.customer_number === 'WALK-IN' ? 'Walk-in' : order.customer_number)}</dd>
        <dt>Cashier</dt><dd>${esc(order.cashier_name)}</dd>
        ${COUNTS_AS_SALE.includes(order.status) ? `<dt>Pickup status</dt><dd data-pickup-status>${esc(FULFILLMENT_LABELS[order.fulfillment_status] ?? '')}</dd>` : ''}
        ${order.refund_centavos ? `<dt>Refunded</dt><dd>${formatPeso(order.refund_centavos)}</dd>` : ''}
      </dl>
      <div class="slip">${orderTable(order)}</div>
      <div><h3>Payment details</h3>${paymentBlock(order)}</div>
      <div><h3>History</h3>${timeline(order)}</div>`,
    actions,
  });
  if (choice === 'cancel') await reasonDialog(order, 'cancel');
  if (choice === 'refund') await reasonDialog(order, 'refund');
  if (choice === 'change') await startChange(order);
}

async function reasonDialog(order, kind) {
  const isCancel = kind === 'cancel';
  const options = Object.entries(REASONS).map(([c, t]) => `<option value="${c}">${esc(t)}</option>`).join('');
  const done = await openDialog({
    title: `${isCancel ? 'Cancel' : 'Refund'} ${order.order_number}`,
    body: `
      <p>${isCancel
        ? 'The order stays on record with its status set to Canceled. It is not counted as a sale.'
        : 'This records a full refund in the app. Return the money to the customer yourself. The chicken is not put back into stock automatically.'}</p>
      <div id="reasonError"></div>
      <div class="field"><label for="rCode">Reason</label><select id="rCode"><option value="">Choose a reason</option>${options}</select></div>
      <div class="field"><label for="rNote">Notes <span class="muted" id="rNoteHint">(optional)</span></label><textarea id="rNote"></textarea></div>
      ${isCancel ? '<label class="check"><input type="checkbox" id="rStock"> The chicken can go back into stock (for example it is still alive or untouched)</label>' : ''}`,
    onOpen: (dlg) => {
      $('#rCode', dlg).onchange = (e) => { $('#rNoteHint', dlg).textContent = e.target.value === 'OTHER' ? '(required: explain the reason)' : '(optional)'; };
    },
    actions: [
      { label: 'Go back', value: false },
      {
        label: isCancel ? 'Cancel this order' : 'Refund this order', kind: 'danger',
        onClick: async (dlg) => {
          const body = { reason_code: $('#rCode', dlg).value, reason_note: $('#rNote', dlg).value };
          if (isCancel) body.stock_returnable = $('#rStock', dlg).checked;
          if (!body.reason_code) { $('#reasonError', dlg).innerHTML = errorBox({ message: 'Choose a reason from the list.' }); return false; }
          try { await api('POST', `/api/orders/${order.id}/${kind}`, body); return true; }
          catch (err) { $('#reasonError', dlg).innerHTML = errorBox(err); return false; }
        },
      },
    ],
  });
  if (done === true) { toast(`${order.order_number} ${isCancel ? 'canceled' : 'refunded'}.`, 'ok'); load(); }
}

/** Change = load the order into the checkout screen; submitting there replaces it with a new, linked order. */
async function startChange(order) {
  if (state.draft && (state.draft.items.length || state.draft.otherItems.length)) {
    const ok = await confirmDialog('You have an order in progress on the New order screen. Replace it with the order you want to change?', { confirmLabel: 'Replace it', title: 'Order in progress' });
    if (!ok) return;
  }
  await refreshConfig(api).catch(() => {});
  const draft = newDraft();
  draft.items = order.items.map((i) => ({
    key: uuid(), productId: i.product_id, name: i.product_name, weight: formatThousandths(i.weight_g), heads: String(i.heads ?? 1),
    prep: { feather: i.feather, dara: i.dara, cut: i.cut, sliceSize: i.slice_size }, confirmLarge: true,
  }));
  draft.otherItems = order.other_items.map((i) => ({
    key: uuid(), productId: i.other_product_id, optionId: i.option_id, name: i.product_name, unit: i.unit,
    quantity: i.sold_by === 'PER_KG' ? formatThousandths(i.quantity_milli) : String(i.quantity_milli / 1000),
  }));
  const dsc = order.discount;
  if (dsc && dsc.amount_centavos > 0) {
    const value = dsc.type === 'FIXED' ? `${Math.floor(dsc.value / 100)}.${String(dsc.value % 100).padStart(2, '0')}` : String(dsc.value / 100);
    draft.discount = { type: dsc.type, value, reason: dsc.reason_code, note: dsc.note ?? '' };
  }
  draft.customerNumber = order.customer_number === 'WALK-IN' ? '' : order.customer_number;
  draft.changeOf = { id: order.id, number: order.order_number };
  const pay = order.payments[0];
  if (pay) { draft.payment.method = pay.method; } // account details are not copied; they may be masked for cashiers
  state.draft = draft;
  saveDraft();
  resetCheckoutUi();
  closeDialog();
  location.hash = '#/new';
  toast(`Change the items, then review and submit. ${order.order_number} will be marked Replaced.`);
}
