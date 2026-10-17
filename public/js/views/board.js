// Order List: a Kanban board of every open order, in three columns: Ongoing -> Standby -> Complete.
//
//   * Drag a card to another column, or right-click it (or press its Move button) to change its pickup status.
//   * Every move is saved on the server first-hand; the board always loads the latest saved statuses when it opens.
//   * Complete means the customer has actually received the order, so it asks for a confirmation.
//   * Only the pickup status changes. The sale (items, prices, payment, Completed / Refunded ...) is never touched.
//   * Cards are compact. Click a card (or its arrow) to show everything about the order, click again to fold it.
//   * The star bookmarks an order so it is easy to find again. The bookmark is saved on the order itself.
//   * Sorting and the "Bookmarked only" filter only change what is shown, never the orders.
import { api } from '../api.js';
import { $, $$, esc, formatPeso, formatKg, toast, errorBox, confirmDialog, prepChips, otherQtyText } from '../util.js';
import { FULFILLMENT, FULFILLMENT_LABELS, FULFILLMENT_HINTS, PAYMENT_METHODS, DISCOUNT_REASONS } from '/shared/constants.js';
import { SORTS, DEFAULT_SORT, sortOrders, customerName, timeOf } from '/shared/boardSort.js';
import { formatDateMDY } from '/shared/inventory.js';
import { openDetail } from './orders.js';

const ICONS = { ONGOING: '⏳', STANDBY: '🛍️', COMPLETE: '✅' };
const MENU_TEXT = { ONGOING: 'Move to Ongoing', STANDBY: 'Move to Standby', COMPLETE: 'Mark as Complete' };
const REFRESH_MS = 20_000;
const SORT_KEY = 'pos.orderList.sort';
const ZOOM_KEY = 'pos.orderList.zoomedOut';

// The sort choice is a harmless convenience, so it is remembered in this browser. If the browser will not store it, it is
// simply remembered until the page is closed.
function savedSort() {
  try { const v = localStorage.getItem(SORT_KEY); return SORTS.some(([k]) => k === v) ? v : DEFAULT_SORT; } catch { return DEFAULT_SORT; }
}
function rememberSort(value) { try { localStorage.setItem(SORT_KEY, value); } catch { /* not stored; fine */ } }

// Zoom out shows the board smaller so more orders fit on the screen without scrolling. It changes only how big things are drawn, never
// an order. Like the sort, it is a harmless convenience: remembered in this browser if the browser allows it.
function savedZoom() { try { return localStorage.getItem(ZOOM_KEY) === '1'; } catch { return false; } }
function rememberZoom(on) { try { localStorage.setItem(ZOOM_KEY, on ? '1' : '0'); } catch { /* not stored; fine */ } }

const view = {
  root: null,
  orders: [],            // the cards on the board, one entry per order id
  zoomedOut: savedZoom(), // true = the board is drawn smaller (Zoom out); false = normal size
  sort: savedSort(),     // one of SORTS; applied inside every column
  filter: 'all',         // 'all' or 'bookmarked'; deliberately not remembered across a reload, so orders never seem to go missing
  expanded: new Set(),   // order ids whose card is open (cards start folded)
  saving: new Set(),     // order ids with a move in flight
  marking: new Set(),    // order ids with a bookmark change in flight
  rev: 0,                // bumped by every move or bookmark, so a slow refresh that started before it cannot undo it
  dragId: null,
  timer: null,
  loadedAt: null,
  failedRefresh: false,
};

const byId = (id) => view.orders.find((o) => o.id === id);
const customerText = (o) => customerName(o) || 'Walk-in';

export async function mountBoard(root) {
  closeMenu();
  stopPolling();
  view.root = root;
  view.dragId = null;
  view.saving.clear();
  view.marking.clear();
  view.expanded.clear();   // every visit starts with folded cards
  const sorts = SORTS.map(([v, t]) => `<option value="${v}" ${view.sort === v ? 'selected' : ''}>${esc(t)}</option>`).join('');
  root.innerHTML = `
    <div class="panel board-panel">
      <div class="panel-head">
        <h1>Order List</h1>
        <div class="board-tools">
          <div class="field board-sort"><label for="boardSort">Sort by</label><select id="boardSort">${sorts}</select></div>
          <div class="field board-show"><span class="label" id="showLabel">Show</span>
            <div class="seg" role="group" aria-labelledby="showLabel">
              <button type="button" class="seg-btn" data-filter="all" aria-pressed="${view.filter === 'all'}">All orders</button>
              <button type="button" class="seg-btn" data-filter="bookmarked" aria-pressed="${view.filter === 'bookmarked'}"><span aria-hidden="true">★</span> Bookmarked <span class="seg-count" id="markCount">0</span></button>
            </div>
          </div>
          <button type="button" class="btn btn--small" id="boardZoom" aria-pressed="${view.zoomedOut}" title="Show the board smaller so more orders fit on the screen">${view.zoomedOut ? 'Normal size' : 'Zoom out'}</button>
          <button type="button" class="btn btn--small" id="boardRefresh">Refresh</button>
          <a class="btn btn--small" id="boardButcher" href="/#/butcher" target="_blank" rel="noopener" title="Opens the screen the butcher TV shows, in a new tab">Butcher view</a>
        </div>
      </div>
      <p class="muted">Tap a card to open or fold it. Drag a card to another column, or right-click it (on a phone or tablet, tap <strong>Move</strong>) to change its status.
        Tap the star to bookmark an order. Mark an order <strong>Complete</strong> only when the customer has received it.
        Complete orders leave this list when the day is closed; Standby orders stay until they are claimed.</p>
      <div id="boardNote" aria-live="polite"></div>
      <div id="boardFilterNote" aria-live="polite"></div>
    </div>
    <div id="boardBody" class="board-wrap${view.zoomedOut ? ' board-wrap--zoomed' : ''}"><p class="muted"><span class="spinner" aria-hidden="true"></span> Loading the Order List...</p></div>
    <p class="sr" id="boardLive" role="status" aria-live="polite"></p>`;

  $('#boardZoom').onclick = toggleZoom;
  $('#boardSort').onchange = (e) => { view.sort = e.target.value; rememberSort(view.sort); render(); announce(`Sorted by ${SORTS.find(([k]) => k === view.sort)?.[1] ?? ''}.`); };
  $('#boardRefresh').onclick = () => load({ showSpinner: true });
  root.onclick = onClick;
  root.oncontextmenu = onContextMenu;
  root.onkeydown = onKeyDown;
  root.ondragstart = onDragStart;
  root.ondragover = onDragOver;
  root.ondragleave = onDragLeave;
  root.ondrop = onDrop;
  root.ondragend = onDragEnd;
  await load({ showSpinner: false });
  startPolling();
}

function toggleZoom() {
  view.zoomedOut = !view.zoomedOut;
  rememberZoom(view.zoomedOut);
  $('#boardBody')?.classList.toggle('board-wrap--zoomed', view.zoomedOut);
  const btn = $('#boardZoom');
  if (btn) { btn.textContent = view.zoomedOut ? 'Normal size' : 'Zoom out'; btn.setAttribute('aria-pressed', String(view.zoomedOut)); }
  announce(view.zoomedOut ? 'Order List zoomed out.' : 'Order List at normal size.');
}

// ---- Loading the saved statuses ------------------------------------------------------------------

async function load({ showSpinner = false } = {}) {
  if (!view.root?.isConnected) return;
  const rev = view.rev;
  try {
    const board = await api('GET', '/api/board');
    // Ignore an answer that arrives after the person moved on, after a card was moved, or while a card is being dragged or saved.
    if (!view.root?.isConnected) return;
    if (view.dragId || view.saving.size || view.marking.size || rev !== view.rev) return;
    // One entry per order id: a card can never appear twice, whatever status it has.
    const seen = new Map();
    for (const o of board.orders) seen.set(o.id, o);
    view.orders = [...seen.values()];
    for (const id of [...view.expanded]) if (!seen.has(id)) view.expanded.delete(id);   // an order that left the board has nothing to keep open
    view.loadedAt = new Date();
    view.failedRefresh = false;
    $('#boardNote').innerHTML = '';
    render();
  } catch (err) {
    if (!view.root?.isConnected) return;
    if (showSpinner || !view.orders.length) $('#boardBody').innerHTML = errorBox(err);
    else if (!view.failedRefresh) { view.failedRefresh = true; $('#boardNote').innerHTML = '<p class="cfg-hint">Could not refresh the Order List. Showing the last saved view. It will try again.</p>'; }
  }
}

function startPolling() {
  stopPolling();
  view.timer = setInterval(() => {
    // Stop when the person has left this screen; skip while the tab is in the background or a menu is open.
    if (!view.root?.isConnected || location.hash !== '#/board') return stopPolling();
    if (document.hidden || document.querySelector('.kmenu')) return undefined;
    return load();
  }, REFRESH_MS);
}
function stopPolling() { if (view.timer) clearInterval(view.timer); view.timer = null; }

// ---- Drawing the board ----------------------------------------------------------------------------

const when = (iso, options) => (timeOf(iso) === null ? 'Date unknown' : new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', ...options }));
const shortWhen = (iso) => when(iso, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fullWhen = (iso) => when(iso, { dateStyle: 'medium', timeStyle: 'short' });

/** Every line of the order as plain text: { name, qty, chips }. The compact card shows the first; the open card shows all. */
function lineList(o) {
  return [
    ...o.items.map((i) => ({
      name: i.name,
      qty: `${i.heads > 1 ? `${i.heads} heads · ` : ''}${formatKg(i.weight_g)} kg`,
      chips: prepChips({ feather: i.feather, dara: i.dara, cut: i.cut, slice_size: i.slice_size }),
    })),
    ...o.other_items.map((i) => ({
      name: i.name,
      qty: otherQtyText(i),
      chips: [],
    })),
    // Revision 12: Katay / Dead chicken from the ref
    ...(o.ref_items ?? []).map((i) => ({
      name: i.name,
      qty: `${i.heads > 1 ? `${i.heads} heads · ` : ''}${formatKg(i.weight_g)} kg`,
      chips: ['From the ref'],
    })),
  ];
}

function summaryHtml(lines) {
  if (!lines.length) return '<p class="kcard-sum muted">No items</p>';
  const all = lines.map((l) => `${l.name} ${l.qty}`);
  const more = lines.length > 1 ? `<span class="kcard-sum-more">+ ${lines.length - 1} more</span>` : '';
  return `<p class="kcard-sum" title="${esc(all.join(', '))}"><span class="kcard-sum-main">${esc(all[0])}</span>${more}</p>`;
}

function paymentHtml(o) {
  if (!o.payments?.length) return 'Not recorded';
  return o.payments.map((p) => `<span class="kpay">${esc(PAYMENT_METHODS[p.method] ?? p.method)} ${formatPeso(p.amount_centavos)}${p.reference ? ` · Ref ${esc(p.reference)}` : ''}</span>`).join('');
}

/** Everything about the order that the compact card leaves out. */
function detailHtml(o, lines) {
  const items = lines.map((l) => `<li><span class="kline-main">${esc(l.name)}</span>
      <span class="kline-qty">${esc(l.qty)}</span>
      ${l.chips.length ? `<span class="chips">${l.chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</span>` : ''}</li>`).join('');
  const facts = [['Customer', esc(customerText(o))], ['Ordered', esc(fullWhen(o.submitted_at))]];
  if (o.discount_centavos > 0) {
    facts.push(['Subtotal', formatPeso(o.subtotal_centavos)]);
    facts.push(['Discount', `−${formatPeso(o.discount_centavos)}${o.discount_reason ? ` (${esc(DISCOUNT_REASONS[o.discount_reason] ?? o.discount_reason)})` : ''}`]);
  }
  facts.push(['Total', `<strong>${formatPeso(o.total_centavos)}</strong>`], ['Payment', paymentHtml(o)]);
  if (o.refund_centavos > 0) facts.push(['Refunded', formatPeso(o.refund_centavos)]);
  facts.push(['Cashier', esc(o.cashier_name)]);
  return `<div class="kcard-detail" id="kd-${o.id}">
    <ul class="kcard-lines">${items}</ul>
    <dl class="kcard-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="kcard-actions">
      <button type="button" class="btn btn--small btn--plain" data-open="${o.id}">Details</button>
      <button type="button" class="btn btn--small btn--plain" data-toggle="${o.id}">Show less</button>
    </div>
  </div>`;
}

function cardHtml(o) {
  const refunded = o.status === 'REFUNDED' || o.status === 'PARTIALLY_REFUNDED';
  const busy = view.saving.has(o.id);
  const open = view.expanded.has(o.id);
  const lines = lineList(o);
  const no = esc(o.order_number);
  return `<article class="kcard${refunded ? ' kcard--refunded' : ''}${busy ? ' kcard--saving' : ''}${open ? ' kcard--open' : ''}${o.bookmarked ? ' kcard--bookmarked' : ''}" data-card="${o.id}" data-status="${o.fulfillment_status}"
      draggable="${busy ? 'false' : 'true'}" tabindex="0" aria-busy="${busy}"
      aria-label="${no}, ${o.tracking_number != null ? `tracking number ${o.tracking_number}, ` : ''}${esc(customerText(o))}, ${esc(FULFILLMENT_LABELS[o.fulfillment_status])}, ${formatPeso(o.total_centavos)}${o.bookmarked ? ', bookmarked' : ''}. Press Enter to ${open ? 'fold' : 'open'} it, the Menu key to move it.">
    <div class="kcard-top">
      <button type="button" class="kcard-toggle" data-toggle="${o.id}" aria-expanded="${open}"${open ? ` aria-controls="kd-${o.id}"` : ''} aria-label="Details of ${no}">
        <span class="kcard-chev" aria-hidden="true">▸</span><span class="kcard-no">${no}</span>
      </button>
      ${o.tracking_number != null ? `<span class="kcard-track" title="Tracking number" aria-label="Tracking number ${o.tracking_number}">#${o.tracking_number}</span>` : ''}
      <button type="button" class="kcard-mark${o.bookmarked ? ' is-on' : ''}" data-bookmark="${o.id}" aria-pressed="${o.bookmarked}" aria-label="Bookmark ${no}"
        title="${o.bookmarked ? 'Remove bookmark' : 'Bookmark this order'}"><span aria-hidden="true">${o.bookmarked ? '★' : '☆'}</span></button>
    </div>
    <div class="kcard-row">
      <span class="kcard-cust" title="${esc(customerText(o))}">${esc(customerText(o))}</span>
      <strong class="kcard-total">${formatPeso(o.total_centavos)}</strong>
    </div>
    ${summaryHtml(lines)}
    <div class="kcard-meta">
      <span class="kcard-info">
        <span class="badge badge--${o.fulfillment_status.toLowerCase()}" data-stage="${o.fulfillment_status}">${esc(FULFILLMENT_LABELS[o.fulfillment_status])}</span>
        ${refunded ? '<span class="badge badge--refunded">Refunded</span>' : ''}
        <span class="kcard-date muted">${esc(shortWhen(o.submitted_at))}</span>
        ${o.from_earlier_day && o.day_date ? `<span class="kcard-earlier" data-earlier title="Sold on an earlier business day and still waiting to be claimed">Sold ${esc(formatDateMDY(o.day_date))}</span>` : ''}
      </span>
      <button type="button" class="btn btn--small kcard-move" data-move-menu="${o.id}" aria-haspopup="menu">Move &#9662;</button>
    </div>
    ${open ? detailHtml(o, lines) : ''}
  </article>`;
}

/** The cards of one column, after the Bookmarked filter and the chosen sort. Nothing here changes an order. */
const shownIn = (status) => sortOrders(view.orders.filter((o) => o.fulfillment_status === status && (view.filter === 'all' || o.bookmarked)), view.sort);

function syncControls(shown) {
  const marked = view.orders.filter((o) => o.bookmarked).length;
  const count = $('#markCount');
  if (count) count.textContent = String(marked);
  $$('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === view.filter)));
  const note = $('#boardFilterNote');
  if (note) {
    note.innerHTML = view.filter === 'bookmarked'
      ? `<p class="board-filter-note">Showing bookmarked orders only: ${shown} of ${view.orders.length} orders on the board. <button type="button" class="btn btn--small btn--plain" data-filter="all">Show all orders</button></p>`
      : '';
  }
}

function render() {
  const body = $('#boardBody');
  if (!body) return;
  // Keep each column's scroll position and the focused control when the board is redrawn.
  const scroll = Object.fromEntries($$('.kcol-body', body).map((c) => [c.dataset.drop, c.scrollTop]));
  const active = document.activeElement;
  const cardId = body.contains(active) ? active.closest?.('[data-card]')?.dataset.card : null;
  const refocus = !cardId ? null
    : active.matches('[data-toggle]') ? `[data-toggle="${cardId}"]`
      : active.matches('[data-bookmark]') ? `[data-bookmark="${cardId}"]`
        : active.matches('[data-move-menu]') ? `[data-move-menu="${cardId}"]` : `[data-card="${cardId}"]`;
  const boardScroll = $('.kboard', body)?.scrollLeft ?? 0;
  let shown = 0;
  body.innerHTML = `<div class="kboard${view.dragId ? ' kboard--dragging' : ''}" role="group" aria-label="Order List board">${FULFILLMENT.map((status) => {
    const cards = shownIn(status);
    shown += cards.length;
    const emptyText = view.filter === 'bookmarked' ? `No bookmarked ${FULFILLMENT_LABELS[status].toLowerCase()} orders` : `No ${FULFILLMENT_LABELS[status].toLowerCase()} orders`;
    return `<section class="kcol kcol--${status.toLowerCase()}${view.dragId && byId(view.dragId)?.fulfillment_status === status ? ' kcol--source' : ''}" data-col="${status}" aria-labelledby="kh-${status}">
      <header class="kcol-head">
        <div class="kcol-title"><span class="kcol-icon" aria-hidden="true">${ICONS[status]}</span><h2 id="kh-${status}">${esc(FULFILLMENT_LABELS[status])}</h2><span class="kcount" aria-label="${cards.length} orders">${cards.length}</span></div>
        <p class="kcol-hint">${esc(FULFILLMENT_HINTS[status])}</p>
      </header>
      <p class="kcol-drop" aria-hidden="true">Drop here to move to ${esc(FULFILLMENT_LABELS[status])}</p>
      <div class="kcol-body" data-drop="${status}">${cards.length ? cards.map(cardHtml).join('') : `<p class="kcol-empty">${esc(emptyText)}</p>`}</div>
    </section>`;
  }).join('')}</div>
  <p class="muted board-stamp">${view.loadedAt ? `Updated ${esc(view.loadedAt.toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' }))}` : ''}</p>`;
  $$('.kcol-body', body).forEach((c) => { c.scrollTop = scroll[c.dataset.drop] ?? 0; });
  const board = $('.kboard', body);
  if (board) board.scrollLeft = boardScroll;
  syncControls(shown);
  if (refocus) ($(refocus, body) ?? $('.seg-btn[aria-pressed="true"]'))?.focus({ preventScroll: true });
}

const announce = (text) => { const live = $('#boardLive'); if (live) live.textContent = text; };

// ---- Moving an order ------------------------------------------------------------------------------

/** Ask first when the target is Complete, then save. Returns true when the card is now in the new column. */
async function requestMove(id, status) {
  const order = byId(id);
  if (!order || order.fulfillment_status === status || view.saving.has(id)) return false;
  if (status === 'COMPLETE') {
    const ok = await confirmDialog(
      'Mark this order Complete only if the customer has already received it. Has the customer picked up the order?',
      { title: `Mark ${order.order_number} as Complete?`, confirmLabel: 'Yes, the customer has it', cancelLabel: 'Not yet' },
    );
    if (!ok) { render(); return false; }
  }
  return saveMove(id, status);
}

async function saveMove(id, status) {
  const order = byId(id);
  if (!order) return false;
  const previous = order.fulfillment_status;
  order.fulfillment_status = status; // show it in the new column at once; it is rolled back if the server says no
  view.saving.add(id);
  view.rev += 1;
  render();
  try {
    await api('POST', `/api/orders/${id}/fulfillment`, { status });
    view.saving.delete(id);
    view.rev += 1;
    // A Standby order from an earlier business day leaves the list as soon as it is claimed. It stays saved in Orders and the reports.
    const leaves = status === 'COMPLETE' && order.from_earlier_day;
    if (leaves) { view.orders = view.orders.filter((o) => o.id !== id); view.expanded.delete(id); }
    render();
    const text = leaves ? `${order.order_number} is Complete and has left the Order List. It is still saved in Orders.` : `${order.order_number} moved to ${FULFILLMENT_LABELS[status]}.`;
    announce(text);
    toast(text, 'ok');
    return true;
  } catch (err) {
    view.saving.delete(id);
    view.rev += 1;
    order.fulfillment_status = previous;
    render();
    toast(err.message, 'error');
    if (err.status === 409 || err.status === 404) load(); // the order is no longer on the board (for example it was canceled)
    return false;
  }
}

// ---- Opening and folding a card, bookmarks, the filter -----------------------------------------------

/** Open or fold one card. This only redraws that card; it never touches the order or its status. */
function toggleCard(id) {
  const order = byId(id);
  if (!order) return;
  if (view.expanded.has(id)) view.expanded.delete(id); else view.expanded.add(id);
  const old = $(`[data-card="${id}"]`, view.root);
  if (!old) return render();
  const active = document.activeElement;
  const hadFocus = old.contains(active);
  const onCard = active === old;
  const template = document.createElement('template');
  template.innerHTML = cardHtml(order).trim();
  const fresh = template.content.firstElementChild;
  old.replaceWith(fresh);
  if (hadFocus) (onCard ? fresh : $('[data-toggle]', fresh))?.focus({ preventScroll: true });
  return undefined;
}

/** Switch the star on or off. The browser says which state it wants, so a double click cannot flip it twice on the server. */
async function toggleBookmark(id) {
  const order = byId(id);
  if (!order || view.marking.has(id)) return;
  const next = !order.bookmarked;
  order.bookmarked = next;              // show it at once; it is put back if the server says no
  view.marking.add(id);
  view.rev += 1;
  render();
  try {
    await api('PUT', `/api/orders/${id}/bookmark`, { bookmarked: next });
    view.marking.delete(id);
    view.rev += 1;
    render();
    announce(`${order.order_number} ${next ? 'bookmarked' : 'bookmark removed'}.`);
  } catch (err) {
    view.marking.delete(id);
    view.rev += 1;
    order.bookmarked = !next;
    render();
    toast(err.message, 'error');
    if (err.status === 409 || err.status === 404) load(); // the order is no longer on the board (for example it was canceled)
  }
}

function setFilter(value) {
  view.filter = value === 'bookmarked' ? 'bookmarked' : 'all';
  render();
  announce(view.filter === 'bookmarked' ? 'Showing bookmarked orders only.' : 'Showing all orders.');
}

// ---- Drag and drop --------------------------------------------------------------------------------

function onDragStart(e) {
  const card = e.target.closest?.('[data-card]');
  if (!card) return;
  const id = Number(card.dataset.card);
  if (view.saving.has(id)) { e.preventDefault(); return; }
  closeMenu();
  view.dragId = id;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', String(id));
  // Style after the browser has taken its drag picture, so the picture is not faded.
  setTimeout(() => {
    if (view.dragId !== id) return;
    $('.kboard')?.classList.add('kboard--dragging');
    card.classList.add('kcard--dragging');
    $(`.kcol[data-col="${byId(id)?.fulfillment_status}"]`)?.classList.add('kcol--source');
  }, 0);
}

function columnOf(e) { return e.target.closest?.('[data-col]') ?? null; }

function onDragOver(e) {
  if (view.dragId === null) return;
  const col = columnOf(e);
  if (!col) return;
  const order = byId(view.dragId);
  const here = col.dataset.col === order?.fulfillment_status;
  if (here) { e.dataTransfer.dropEffect = 'none'; return; } // dropping where it already is does nothing
  e.preventDefault(); // this column accepts the card
  e.dataTransfer.dropEffect = 'move';
  $$('.kcol--over').forEach((c) => { if (c !== col) c.classList.remove('kcol--over'); });
  col.classList.add('kcol--over');
}

function onDragLeave(e) {
  const col = columnOf(e);
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('kcol--over');
}

async function onDrop(e) {
  const col = columnOf(e);
  if (view.dragId === null || !col) return;
  e.preventDefault();
  const id = view.dragId;
  endDrag();
  await requestMove(id, col.dataset.col);
}

function onDragEnd() { endDrag(); }

function endDrag() {
  view.dragId = null;
  $$('.kcol--over, .kcol--source').forEach((c) => c.classList.remove('kcol--over', 'kcol--source'));
  $('.kboard')?.classList.remove('kboard--dragging');
  $$('.kcard--dragging').forEach((c) => c.classList.remove('kcard--dragging'));
}

// ---- Right-click menu -----------------------------------------------------------------------------

let menuOpenedAt = 0;

function closeMenu() {
  document.querySelector('.kmenu')?.remove();
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('scroll', onScrollWhileOpen, true);
}

// Scrolling moves the card away from the menu, so the menu closes. A scroll that was already under way as the
// menu opened (the browser bringing the card into view) must not close it again.
function onScrollWhileOpen() { if (performance.now() - menuOpenedAt > 400) closeMenu(); }

function onOutsidePointer(e) { if (!e.target.closest?.('.kmenu')) closeMenu(); }

function openMenu(id, x, y, returnFocus) {
  const order = byId(id);
  if (!order) return;
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'kmenu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `Move ${order.order_number}`);
  menu.innerHTML = `
    <p class="kmenu-title">${esc(order.order_number)}</p>
    ${FULFILLMENT.map((s) => `<button type="button" role="menuitem" class="kmenu-item kmenu-item--${s.toLowerCase()}" data-menu-move="${s}" ${s === order.fulfillment_status ? 'disabled aria-current="true"' : ''}>
        <span aria-hidden="true">${ICONS[s]}</span> ${esc(MENU_TEXT[s])}${s === order.fulfillment_status ? ' <span class="muted">(current)</span>' : ''}</button>`).join('')}
    <hr>
    <button type="button" role="menuitem" class="kmenu-item" data-menu-bookmark="1"><span aria-hidden="true">${order.bookmarked ? '★' : '☆'}</span> ${order.bookmarked ? 'Remove bookmark' : 'Bookmark this order'}</button>
    <button type="button" role="menuitem" class="kmenu-item" data-menu-details="1">View order details</button>`;
  menu.dataset.id = String(id);
  menu._returnFocus = returnFocus;
  document.body.append(menu);
  // Keep the menu on screen.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
  menu.onclick = async (e) => {
    const move = e.target.closest('[data-menu-move]');
    const details = e.target.closest('[data-menu-details]');
    const mark = e.target.closest('[data-menu-bookmark]');
    if (!move && !details && !mark) return;
    closeMenu();
    if (move) await requestMove(id, move.dataset.menuMove);
    else if (mark) toggleBookmark(id);
    else showDetails(id);
  };
  menu.onkeydown = (e) => {
    const items = $$('.kmenu-item:not(:disabled)', menu);
    const at = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); const back = menu._returnFocus; closeMenu(); back?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Tab') { e.preventDefault(); closeMenu(); menu._returnFocus?.focus(); }
  };
  document.addEventListener('pointerdown', onOutsidePointer, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  menuOpenedAt = performance.now();
  window.addEventListener('scroll', onScrollWhileOpen, true);
  $('.kmenu-item:not(:disabled)', menu)?.focus({ preventScroll: true });
}

function onContextMenu(e) {
  const card = e.target.closest?.('[data-card]');
  if (!card) return;
  e.preventDefault();
  const rect = card.getBoundingClientRect();
  // A keyboard-triggered menu has no pointer position; open it beside the card instead.
  const fromKeyboard = e.clientX === 0 && e.clientY === 0;
  openMenu(Number(card.dataset.card), fromKeyboard ? rect.left + 24 : e.clientX, fromKeyboard ? rect.top + 24 : e.clientY, card);
}

// ---- Clicks and keys ------------------------------------------------------------------------------

async function showDetails(id) {
  await openDetail(id);
  // The order may have been canceled, refunded or changed while the details were open.
  if (view.root?.isConnected && location.hash === '#/board') load();
}

function onClick(e) {
  const filter = e.target.closest('[data-filter]');
  if (filter) return setFilter(filter.dataset.filter);
  // Each button does its own job and stops here, so pressing it can never also open or fold the card.
  const star = e.target.closest('[data-bookmark]');
  if (star) return toggleBookmark(Number(star.dataset.bookmark));
  const moveBtn = e.target.closest('[data-move-menu]');
  if (moveBtn) {
    const rect = moveBtn.getBoundingClientRect();
    return openMenu(Number(moveBtn.dataset.moveMenu), rect.left, rect.bottom + 4, moveBtn);
  }
  const open = e.target.closest('[data-open]');
  if (open) return showDetails(Number(open.dataset.open));
  const toggle = e.target.closest('[data-toggle]');
  if (toggle) return toggleCard(Number(toggle.dataset.toggle));
  if (e.target.closest('.kcard-detail')) return undefined; // reading an open card never folds it by accident
  const card = e.target.closest('[data-card]');
  if (card) return toggleCard(Number(card.dataset.card));
  return undefined;
}

function onKeyDown(e) {
  const card = e.target.closest?.('[data-card]');
  if (!card || e.target !== card) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCard(Number(card.dataset.card)); }
  // Moving a focused card with the keyboard: Alt + Left / Right arrow
  else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const order = byId(Number(card.dataset.card));
    const next = FULFILLMENT[FULFILLMENT.indexOf(order.fulfillment_status) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) requestMove(order.id, next);
  }
}
