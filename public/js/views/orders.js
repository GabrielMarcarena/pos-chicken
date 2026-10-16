// Order history: find an order by number, see exactly what was saved, and cancel, change or refund it.
import { api, download } from '../api.js';
import { state, saveDraft, newDraft, refreshConfig, stockOptionOf, findProduct } from '../state.js';
import { $, esc, label, formatPeso, formatThousandths, fmtDateTime, fmtDate, todayPH, toast, errorBox, openDialog, closeDialog, confirmDialog, orderStatusBadges, uuid } from '../util.js';
import { REASONS, ACTION_LABELS, PAYMENT_METHODS, STATUS_LABELS, FULFILLMENT, FULFILLMENT_LABELS, COUNTS_AS_SALE } from '/shared/constants.js';
import { orderTable } from './slip.js';
import { resetCheckoutUi } from './checkout.js';

// view 'current' (the default): the open business day's orders plus earlier orders still Ongoing or Standby. Once a day is closed, its
// Complete orders leave this list (Revision 11); 'all' finds every saved order by date. A search by order number always looks everywhere.
const filters = { q: '', from: todayPH(), to: todayPH(), status: '', view: 'current' };
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
        <div class="field"><label for="fview">Show</label><select id="fview">
          <option value="current" ${filters.view === 'current' ? 'selected' : ''}>Today's orders (open business day)</option>
          <option value="all" ${filters.view === 'all' ? 'selected' : ''}>All saved orders, by date</option></select></div>
        <div class="field"><label for="fq">Order number or customer</label><input id="fq" type="text" value="${esc(filters.q)}" placeholder="ORD-20261009-001" autocomplete="off"></div>
        <div class="field" data-dates ${filters.view === 'current' ? 'hidden' : ''}><label for="ffrom">From</label><input id="ffrom" type="date" value="${esc(filters.from)}"></div>
        <div class="field" data-dates ${filters.view === 'current' ? 'hidden' : ''}><label for="fto">To</label><input id="fto" type="date" value="${esc(filters.to)}"></div>
        <div class="field"><label for="fstatus">Status</label><select id="fstatus">${statusOptions}</select></div>
        <button class="btn btn--primary" type="submit">Search</button>
      </form>
      <p class="muted mt-s" id="viewHint">${viewHint()}</p>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Daily Sales Report</h2></div>
      <p class="muted">The report from your paper form, filled in with what the app knows: sales by chicken type (and Katay / Dead from the ref), heads, kilos, prices, service, eggs, other products, the list of discounts, the expenses and the cash breakdown typed in New order &gt; Advanced, and the totals. The chicken and egg balances are left empty for you to count by hand. The date is the business day the orders were sold on.${isManager() ? '' : ' It shows your own sales.'}</p>
      <div id="dailyError"></div>
      <div class="filters mt-s">
        <div class="field"><label for="dDate">Report date</label><input id="dDate" type="date" value="${esc(todayPH())}"></div>
        ${isManager() ? '<div class="field"><label for="dCashier">Cashier</label><select id="dCashier"><option value="">All cashiers</option></select></div>' : ''}
        <button type="button" class="btn btn--primary" id="dailyXlsx">Download Daily Report</button>
      </div>
    </div>
    ${isManager() ? `<div class="panel">
      <div class="panel-head"><h2>Spreadsheet export</h2></div>
      <p class="muted">Downloads the orders sold on the business days from <strong>From</strong> to <strong>To</strong> above (choose "All saved orders, by date" to set them).
        <strong>Excel</strong> has every detail of every order (canceled orders in red, with daily, weekly and monthly summaries).
        <strong>Sales List</strong> has only the important report columns of the orders that were sold, one row per item, as an Excel file whose
        columns are wide enough to read. <strong>CSV</strong> is the same list as plain text for other programs; a CSV file cannot remember column
        widths, so Excel opens it with narrow columns.</p>
      <div id="exportError"></div>
      <div class="btn-row mt-s">
        <button type="button" class="btn btn--primary" id="exportXlsx">Download Excel (.xlsx)</button>
        <button type="button" class="btn" id="exportSales">Download Sales List (Excel)</button>
        <button type="button" class="btn btn--plain btn--small" id="exportCsv">Plain CSV</button>
      </div></div>` : ''}
    <div class="panel" id="results" aria-live="polite"></div>`;

  $('#filters').onsubmit = (e) => { e.preventDefault(); readFilters(); load(); };
  $('#fview').onchange = () => {
    readFilters();
    root.querySelectorAll('[data-dates]').forEach((el) => { el.hidden = filters.view === 'current'; });
    $('#viewHint').textContent = viewHint();
    load();
  };
  // The report date starts on the open business day, which can be later than today's date if a day was closed early.
  let openDay = null;
  api('GET', '/api/board').then((b) => { openDay = b.open_day; if (openDay) $('#dDate').value = openDay; }).catch(() => {});
  $('#dailyXlsx').onclick = async () => {
    $('#dailyError').innerHTML = '';
    const qs = new URLSearchParams({ date: $('#dDate').value || todayPH() });
    if (isManager() && $('#dCashier').value) qs.set('cashier', $('#dCashier').value);
    try {
      let count = null;
      await download(`/api/daily-report.xlsx?${qs}`, 'daily-sales-report.xlsx', (res) => { const h = res.headers.get('X-Order-Count'); count = h === null ? null : Number(h); });
      if (count === 0) {
        const open = openDay ? ` The open business day is ${openDay}; try that date.` : '';
        $('#dailyError').innerHTML = `<div class="error-box" role="alert"><strong>No sales on ${esc(qs.get('date'))}, so the downloaded report is empty. Reports follow the business day the order was sold on, not the calendar date.${esc(open)}</strong></div>`;
      } else toast('Daily report downloaded.', 'ok');
    }
    catch (err) { $('#dailyError').innerHTML = errorBox(err); }
  };
  if (isManager()) {
    api('GET', '/api/staff').then(({ staff }) => {
      $('#dCashier').insertAdjacentHTML('beforeend', staff.map((u) => `<option value="${u.id}">${esc(u.display_name)}</option>`).join(''));
    }).catch(() => {});
  }
  if (isManager()) {
    const run = (path, fallback) => async () => {
      readFilters();
      $('#exportError').innerHTML = '';
      const qs = new URLSearchParams({ from: filters.from, to: filters.to });
      try { await download(`${path}?${qs}`, fallback); toast('Export downloaded.', 'ok'); }
      catch (err) { $('#exportError').innerHTML = errorBox(err); }
    };
    $('#exportXlsx').onclick = run('/api/export.xlsx', 'chicken-pos.xlsx');
    $('#exportSales').onclick = run('/api/export-sales.xlsx', 'chicken-pos-sales-list.xlsx');
    $('#exportCsv').onclick = run('/api/export.csv', 'chicken-pos.csv');
  }
  $('#results').onclick = (e) => {
    const row = e.target.closest('[data-open]');
    if (row) openDetail(Number(row.dataset.open));
  };
  await load();
  startAutoRefresh();
}

function readFilters() {
  filters.view = $('#fview').value;
  filters.q = $('#fq').value.trim();
  filters.from = $('#ffrom').value;
  filters.to = $('#fto').value;
  filters.status = $('#fstatus').value;
}

function viewHint() {
  return filters.view === 'current'
    ? 'Today\'s orders, plus earlier orders that are still Ongoing or Standby. When the day is closed, its Complete orders leave this list; they stay saved (choose "All saved orders, by date" to see them). Searching by order number looks through every date.'
    : 'Every saved order sold on the business days from From to To. Searching by order number looks through every date.';
}

let loadSeq = 0;
let refreshTimer = null;

async function load({ quiet = false } = {}) {
  const box = $('#results');
  if (!box) return; // the details were opened from the Order List, not from this screen
  const seq = ++loadSeq;
  if (!quiet) box.innerHTML = '<p class="muted"><span class="spinner" aria-hidden="true"></span> Loading orders...</p>';
  const qs = new URLSearchParams({ view: filters.view });
  if (filters.q) qs.set('q', filters.q);
  else if (filters.view !== 'current') { if (filters.from) qs.set('from', filters.from); if (filters.to) qs.set('to', filters.to); }
  const [kind, code] = filters.status.split(':');
  if (kind === 'pickup') qs.set('pickup', code);
  else if (kind === 'sale') qs.set('status', code);
  try {
    const { orders } = await api('GET', `/api/orders?${qs}`);
    if (seq !== loadSeq || !$('#results')) return; // a newer search started, or the person left this screen
    if (!orders.length) {
      box.innerHTML = filters.view === 'current' && !filters.q
        ? '<div class="empty">No orders on the open business day yet. Orders of closed days are under "All saved orders, by date".</div>'
        : '<div class="empty">No orders match. Change the dates or the search.</div>';
      return;
    }
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
      <dt>Amount Paid</dt><dd>${formatPeso(p.amount_centavos)}</dd>
      ${p.received_centavos ? `<dt>Money Received</dt><dd>${formatPeso(p.received_centavos)}</dd><dt>Change</dt><dd>${formatPeso(p.change_centavos ?? 0)}</dd>` : ''}
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
        ? 'The order stays on record with its status set to Canceled. It is not counted as a sale. Its chicken and other products are counted as sold no longer, and Katay or Dead chicken from the ref goes back into the ref. If the chicken cannot go back (it was already burned or dressed), leave the box below unticked and the heads are recorded as Reject in today\'s Daily Inventory.'
        : 'This records a full refund in the app. Return the money to the customer yourself. The order stays counted as sold in the Daily Inventory and nothing is put back into stock.'}</p>
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
  if (state.draft && (state.draft.items.length || state.draft.otherItems.length || state.draft.refItems?.length)) {
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
    ...(i.sold_by === 'PER_KG' ? { pieces: String(i.pieces ?? 1) } : {}),
  }));
  // Revision 12: Katay / Dead chicken from the ref keep their heads, kilos and the price per kg that was typed.
  // Revision 13: and the chicken they came from (an order sold before Revision 13 has none: the cashier picks it again).
  draft.refItems = (order.ref_items ?? []).map((i) => ({
    key: uuid(), kind: i.kind, name: i.product_name, productId: i.product_id ?? null, productName: i.product_id ? findProduct(i.product_id)?.name ?? i.product_name.split(' - ').slice(1).join(' - ') : '',
    heads: String(i.heads), weight: formatThousandths(i.weight_g),
    price: `${Math.floor(i.price_per_kg_centavos / 100)}.${String(i.price_per_kg_centavos % 100).padStart(2, '0')}`,
  }));
  const dsc = order.discount;
  if (dsc && dsc.amount_centavos > 0) {
    const value = dsc.type === 'FIXED' ? `${Math.floor(dsc.value / 100)}.${String(dsc.value % 100).padStart(2, '0')}` : String(dsc.value / 100);
    draft.discount = { type: dsc.type, value, reason: dsc.reason_code, note: dsc.note ?? '' };
  }
  draft.customerNumber = order.customer_number === 'WALK-IN' ? '' : order.customer_number;
  // What this order holds in stock right now: it is replaced by the new order, so its own stock counts as free for the replacement.
  const held = { chicken: {}, other: {}, ref: {} };
  for (const i of order.ref_items ?? []) held.ref[`${i.kind}:${i.product_id ?? null}`] = (held.ref[`${i.kind}:${i.product_id ?? null}`] ?? 0) + i.heads;
  for (const i of order.items) held.chicken[i.product_id] = (held.chicken[i.product_id] ?? 0) + i.heads;
  for (const i of order.other_items) {
    // the stock row it was counted on: a by-the-kilo line with pieces counted on the product's piece row
    const row = i.sold_by === 'PER_KG' && i.pieces ? stockOptionOf(i.option_id) : i.option_id;
    held.other[row] = (held.other[row] ?? 0) + (i.sold_by === 'PER_KG' && i.pieces ? i.pieces * 1000 : i.quantity_milli);
  }
  draft.changeOf = { id: order.id, number: order.order_number, held, dayId: order.business_day_id };
  const pay = order.payments[0];
  if (pay) { draft.payment.method = pay.method; } // account details are not copied; they may be masked for cashiers
  state.draft = draft;
  saveDraft();
  resetCheckoutUi();
  closeDialog();
  location.hash = '#/new';
  toast(`Change the items, then review and submit. ${order.order_number} will be marked Replaced.`);
}
