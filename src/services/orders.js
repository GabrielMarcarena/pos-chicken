// Orders: pricing on the server, submit, cancel, change (void and replace) and refund.
//
// Rules this file protects:
//   * The server recalculates every price from the database. Prices sent by the browser are never trusted.
//   * A submitted order is never edited or deleted. Cancel, change and refund add audit events and move the
//     order to a new status; the original lines stay exactly as they were.
//   * Order numbers come from an atomic per-day counter, so two cashiers can never get the same number and
//     a canceled order keeps its number forever.
//   * A repeated submission with the same submission_key returns the first order instead of creating another.
//   * Stock is checked in the same transaction that saves the order (see inventory.js), so two cashiers can never be sold the same last chicken.
//     Every order belongs to the business day that is open when it is saved.
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { parseWeightToGrams, parsePesosToCentavos, parseQuantityToMilli, parseWholeQuantityToMilli, parsePercentToBp, parseHeads, formatPeso } from '../../shared/money.js';
import { validatePrep, serviceOf } from '../../shared/rules.js';
import { chickenLine, otherLine, refLine, grandTotal, discountAmount } from '../../shared/pricing.js';
import { REASONS, PAYMENT_METHODS, DISCOUNT_REASONS, FULFILLMENT, FULFILLMENT_LABELS, COUNTS_AS_SALE, REF_KINDS, REF_LABELS } from '../../shared/constants.js';
import { getFeeConfig, productCode } from './catalog.js';
import { ROLE_RANK } from './users.js';
import { ensureOpenDay, assertStock, demandOf, heldBy, rejectCanceledChicken, pieceOptionOf } from './inventory.js';
import { toBusinessDate, phtLocalToIso } from '../time.js';

const clean = (value, max) => String(value ?? '').trim().slice(0, max);
const SAFE_TEXT = /^[\p{L}\p{N} .,'#()+\-/_]*$/u;

// ---- Reading ------------------------------------------------------------------------------------

export function loadOrder(db, id) {
  const o = db.prepare(`
    SELECT o.*, u.display_name AS cashier_name, rb.order_number AS replaced_by_number, rp.order_number AS replaces_number
    FROM orders o
    JOIN users u ON u.id = o.cashier_id
    LEFT JOIN orders rb ON rb.id = o.replaced_by_order_id
    LEFT JOIN orders rp ON rp.id = o.replaces_order_id
    WHERE o.id = ?`).get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no').all(id);
  o.other_items = db.prepare('SELECT * FROM order_other_items WHERE order_id = ? ORDER BY line_no').all(id);
  o.ref_items = db.prepare('SELECT * FROM order_ref_items WHERE order_id = ? ORDER BY line_no').all(id);   // Revision 12: Katay / Dead from the ref
  o.payments = db.prepare('SELECT p.*, u.display_name AS recorded_by_name FROM payments p JOIN users u ON u.id = p.recorded_by WHERE p.order_id = ? ORDER BY p.id').all(id);
  o.events = db.prepare(`
    SELECT e.*, u.display_name AS user_name, r.order_number AS related_number
    FROM order_events e JOIN users u ON u.id = e.user_id LEFT JOIN orders r ON r.id = e.related_order_id
    WHERE e.order_id = ? ORDER BY e.id`).all(id);
  return o;
}

const maskNumber = (n) => (n && n.length > 4 ? `${'•'.repeat(n.length - 4)}${n.slice(-4)}` : n ? '••••' : null);
const maskName = (n) => (n ? n.split(/\s+/).map((w) => `${w[0]}•••`).join(' ') : null);

/** Shape an order for the API. Cashiers see payment account details masked. */
export function presentOrder(o, viewer) {
  const full = ROLE_RANK[viewer.role] >= ROLE_RANK.manager;
  return {
    id: o.id,
    order_number: o.order_number,
    business_date: o.business_date,
    business_day_id: o.business_day_id,   // which Daily Inventory day counted this sale
    customer_number: o.customer_number,
    status: o.status,
    fulfillment_status: o.fulfillment_status,
    subtotal_centavos: o.subtotal_centavos,
    discount: { type: o.discount_type, value: o.discount_value, amount_centavos: o.discount_centavos, reason_code: o.discount_reason, note: o.discount_note },
    total_centavos: o.total_centavos,
    refund_centavos: o.refund_centavos,
    cashier_name: o.cashier_name,
    submitted_at: o.submitted_at,
    replaced_by_number: o.replaced_by_number,
    replaces_number: o.replaces_number,
    items: o.items.map((i) => ({
      line_no: i.line_no, product_id: i.product_id, product_code: productCode(i.product_id), product_name: i.product_name,
      price_per_kg_centavos: i.price_per_kg_centavos, heads: i.heads, weight_g: i.weight_g, weight_amount_centavos: i.weight_amount_centavos,
      feather: i.feather_prep, dara: !!i.dara, cut: i.cut_method, slice_size: i.slice_size,
      service: serviceOf({ feather: i.feather_prep, cut: i.cut_method }),   // LIVE, POUR, NOT_POUR, POUR_SLICE, NOT_POUR_SLICE, POUR_DUKOT or NOT_POUR_DUKOT: the seven services, named the way the cashier picked them
      fees: JSON.parse(i.fee_detail), service_fee_centavos: i.service_fee_centavos, line_total_centavos: i.line_total_centavos,
    })),
    other_items: o.other_items.map((i) => ({
      line_no: i.line_no, other_product_id: i.other_product_id, option_id: i.option_id, sold_by: i.sold_by, product_name: i.product_name, unit: i.unit,
      unit_price_centavos: i.unit_price_centavos, quantity_milli: i.quantity_milli, line_total_centavos: i.line_total_centavos,
      pieces: i.pieces ?? null,   // per-kg lines: how many pieces were weighed (the stock is counted in pieces)
    })),
    // Revision 12: Katay and Dead chicken sold from the ref (price per kg typed by the cashier, no service fee).
    ref_items: (o.ref_items ?? []).map((i) => ({
      line_no: i.line_no, kind: i.ref_kind, product_name: i.product_name, heads: i.heads, weight_g: i.weight_g,
      price_per_kg_centavos: i.price_per_kg_centavos, line_total_centavos: i.line_total_centavos,
    })),
    payments: o.payments.map((p) => ({
      method: p.method, amount_centavos: p.amount_centavos, received_centavos: p.received_centavos, change_centavos: p.change_centavos,
      paid_at: p.paid_at, reference: p.reference,
      account_name: full ? p.account_name : maskName(p.account_name),
      account_number: full ? p.account_number : maskNumber(p.account_number),
      recorded_by_name: p.recorded_by_name, recorded_at: p.recorded_at,
    })),
    events: o.events.map((e) => ({
      action_type: e.action_type, reason_code: e.reason_code, reason_note: e.reason_note, user_name: e.user_name,
      created_at: e.created_at, refund_centavos: e.refund_centavos, stock_returnable: e.stock_returnable === null ? null : !!e.stock_returnable,
      related_number: e.related_number,
    })),
  };
}

export function getOrder(db, id, viewer) {
  const o = loadOrder(db, id);
  if (!o) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
  return presentOrder(o, viewer);
}

/**
 * The Orders tab. view = 'current' (Revision 11, the tab's default): the orders of the open business day, plus orders of earlier days
 * that are still Ongoing or Standby. Once a day is closed its Complete orders are no longer listed here (they are not deleted: view
 * 'all' with dates, a search by order number, and every report still show them). view = 'all' (or none): every saved order, by the
 * business date of the day it was sold on.
 */
export function listOrders(db, { q = '', from, to, status, pickup, view = 'all', limit = 200 } = {}) {
  const where = [];
  const params = [];
  const text = clean(q, 60);
  if (text) { where.push('(o.order_number LIKE ? OR o.customer_number LIKE ?)'); params.push(`%${text}%`, `%${text}%`); }
  if (!text && view === 'current') {
    const open = db.prepare("SELECT id FROM business_days WHERE status = 'OPEN'").get();
    where.push(`(o.business_day_id = ? OR (o.fulfillment_status IN ('ONGOING','STANDBY') AND o.status IN (${COUNTS_AS_SALE.map(() => '?').join(', ')})))`);
    params.push(open?.id ?? -1, ...COUNTS_AS_SALE);
  } else if (view !== 'current') {
    // The business date of the day the order was sold on (the order's own calendar date for orders saved before business days existed).
    if (/^\d{4}-\d{2}-\d{2}$/.test(from ?? '')) { where.push('COALESCE(d.business_date, o.business_date) >= ?'); params.push(from); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) { where.push('COALESCE(d.business_date, o.business_date) <= ?'); params.push(to); }
  }
  if (status) { where.push('o.status = ?'); params.push(status); }
  if (pickup) {
    // Same meaning as the Order List board: only orders that are on the list have an Ongoing / Standby / Complete status.
    if (!FULFILLMENT.includes(pickup)) throw new HttpError(400, 'Choose Ongoing, Standby or Complete.', 'VALIDATION');
    where.push(`o.fulfillment_status = ? AND o.status IN (${COUNTS_AS_SALE.map(() => '?').join(', ')})`);
    params.push(pickup, ...COUNTS_AS_SALE);
  }
  const rows = db.prepare(`
    SELECT o.id, o.order_number, o.business_date, o.customer_number, o.status, o.fulfillment_status, o.total_centavos, o.refund_centavos, o.submitted_at,
           u.display_name AS cashier_name, rb.order_number AS replaced_by_number, d.business_date AS day_date,
           (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) + (SELECT COUNT(*) FROM order_other_items x WHERE x.order_id = o.id)
             + (SELECT COUNT(*) FROM order_ref_items r WHERE r.order_id = o.id) AS line_count
    FROM orders o JOIN users u ON u.id = o.cashier_id LEFT JOIN orders rb ON rb.id = o.replaced_by_order_id
    LEFT JOIN business_days d ON d.id = o.business_day_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY o.id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 200, 500));
  return rows;
}

/**
 * The Order List (Kanban board). Ongoing and Standby show every order that is still on its way to the customer, however old.
 * Complete shows only the orders of the OPEN business day: when the day is closed (Submit Closing Inventory / Reset Daily Records),
 * its Complete orders leave the board, and a Standby order from an earlier day leaves the board as soon as it is claimed (Complete).
 * Nothing is deleted: every order stays in the Orders tab, the reports and the Daily Inventory counts.
 * Canceled and replaced orders are not on the board: they were never going to be picked up. Refunded orders stay,
 * marked, so nobody hands out a refunded order by mistake.
 */
export function listBoard(db) {
  const open = db.prepare("SELECT id, business_date FROM business_days WHERE status = 'OPEN'").get() ?? null;
  const rows = db.prepare(`
    SELECT o.id, o.order_number, o.business_date, o.customer_number, o.status, o.fulfillment_status, o.bookmarked,
           o.subtotal_centavos, o.discount_centavos, o.discount_reason, o.total_centavos, o.refund_centavos,
           o.submitted_at, u.display_name AS cashier_name, o.business_day_id, d.business_date AS day_date
    FROM orders o JOIN users u ON u.id = o.cashier_id LEFT JOIN business_days d ON d.id = o.business_day_id
    WHERE o.status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')
      AND (o.fulfillment_status <> 'COMPLETE' OR (? IS NOT NULL AND o.business_day_id = ?))
    ORDER BY o.id DESC LIMIT 1000`).all(open?.id ?? null, open?.id ?? null);
  const chicken = db.prepare('SELECT product_name, heads, weight_g, feather_prep, dara, cut_method, slice_size FROM order_items WHERE order_id = ? ORDER BY line_no');
  const other = db.prepare('SELECT product_name, unit, sold_by, quantity_milli, pieces FROM order_other_items WHERE order_id = ? ORDER BY line_no');
  const ref = db.prepare('SELECT ref_kind, product_name, heads, weight_g FROM order_ref_items WHERE order_id = ? ORDER BY line_no');
  // What the expanded card shows about payment. Account names and numbers are left out; the Details screen has them (masked for cashiers).
  const paid = db.prepare('SELECT method, amount_centavos, paid_at, reference FROM payments WHERE order_id = ? ORDER BY id');
  const cards = rows.map(({ business_day_id: dayId, day_date: dayDate, ...o }) => ({
    ...o,
    bookmarked: !!o.bookmarked,
    // An order sold on an earlier business day (it was on Standby when that day was closed). It leaves the board once it is Complete.
    from_earlier_day: open ? dayId !== open.id : true, day_date: dayDate ?? o.business_date,
    payments: paid.all(o.id),
    items: chicken.all(o.id).map((i) => ({ kind: 'chicken', name: i.product_name, heads: i.heads, weight_g: i.weight_g, feather: i.feather_prep, dara: !!i.dara, cut: i.cut_method, slice_size: i.slice_size })),
    other_items: other.all(o.id).map((i) => ({ kind: 'other', name: i.product_name, unit: i.unit, sold_by: i.sold_by, quantity_milli: i.quantity_milli, pieces: i.pieces ?? null })),
    ref_items: ref.all(o.id).map((i) => ({ kind: 'ref', ref_kind: i.ref_kind, name: i.product_name, heads: i.heads, weight_g: i.weight_g })),
  }));
  return { columns: FULFILLMENT, open_day: open?.business_date ?? null, orders: cards };
}

/**
 * Move an order to Ongoing, Standby or Complete. Only the pickup status changes: the sale, its lines, prices and payment
 * are untouched. Every real move is written to the audit trail ("Ongoing → Standby", who, when). Moving to the column the
 * order is already in does nothing, so a double drop never writes twice or duplicates a card.
 */
export function moveOrder(db, user, id, status, { now = new Date() } = {}) {
  if (!FULFILLMENT.includes(status)) throw new HttpError(400, 'Choose Ongoing, Standby or Complete.', 'VALIDATION');
  return tx(db, () => {
    const order = db.prepare('SELECT id, order_number, status, fulfillment_status FROM orders WHERE id = ?').get(id);
    if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
    if (order.status === 'CANCELED' || order.status === 'REPLACED') {
      throw new HttpError(409, `${order.order_number} is ${order.status.toLowerCase()} and is not on the Order List.`, 'BAD_STATUS');
    }
    const changed = order.fulfillment_status !== status;
    if (changed) {
      db.prepare('UPDATE orders SET fulfillment_status = ? WHERE id = ?').run(status, id);
      addEvent(db, {
        orderId: id, action: 'MOVE', reasonNote: `${FULFILLMENT_LABELS[order.fulfillment_status]} → ${FULFILLMENT_LABELS[status]}`, userId: user.id, now,
      });
    }
    return { order: getOrder(db, id, user), changed };
  });
}

/**
 * Bookmark (or un-bookmark) an order on the Order List. The caller says which state it wants, so a repeated or double request
 * ends in the same place instead of flipping back. Only the orders.bookmarked flag changes: the status, the pickup status, the
 * lines and the payment are untouched, and the flag belongs to the order id, so it stays with the card when the card moves.
 */
export function setBookmark(db, id, bookmarked) {
  if (typeof bookmarked !== 'boolean') throw new HttpError(400, 'Say whether the order should be bookmarked (true or false).', 'VALIDATION');
  return tx(db, () => {
    const order = db.prepare('SELECT id, order_number, status, bookmarked FROM orders WHERE id = ?').get(id);
    if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
    if (order.status === 'CANCELED' || order.status === 'REPLACED') {
      throw new HttpError(409, `${order.order_number} is ${order.status.toLowerCase()} and is not on the Order List.`, 'BAD_STATUS');
    }
    const changed = !!order.bookmarked !== bookmarked;
    if (changed) db.prepare('UPDATE orders SET bookmarked = ? WHERE id = ?').run(bookmarked ? 1 : 0, id);
    return { id, order_number: order.order_number, bookmarked, changed };
  });
}

// ---- Validating and pricing a new order ---------------------------------------------------------

/**
 * The payment typed on the review screen. Rules (the server enforces them; the screen only helps):
 *   * the amount paid must match the order total: less is "Insufficient payment", more is refused too, so what is saved always matches the order
 *   * cash may also carry the money received; then change = money received - amount paid, and the money received may not be less than the amount paid
 *   * money received and change belong to cash only
 */
function buildPayment(p, total, errors) {
  if (!p || !p.method || p.method === 'NONE') return null;
  if (!PAYMENT_METHODS[p.method]) { errors.push('Choose a payment method from the list.'); return null; }
  const amount = p.amount === undefined || p.amount === '' ? total : parsePesosToCentavos(p.amount);
  if (amount === null || amount <= 0) { errors.push('Payment amount must be above ₱0.00.'); return null; }
  if (amount < total) {
    errors.push(`Insufficient payment. The amount paid (${formatPeso(amount)}) is less than the order total (${formatPeso(total)}). The order cannot be saved as fully paid.`);
    return null;
  }
  if (amount > total) {
    errors.push(`The amount paid (${formatPeso(amount)}) is more than the order total (${formatPeso(total)}). Amount paid must match the order total${p.method === 'CASH' ? '; put the cash handed over in Money received and the app works out the change' : ''}.`);
    return null;
  }
  let received = null;
  let change = null;
  const hasReceived = p.received !== undefined && p.received !== null && String(p.received).trim() !== '';
  if (hasReceived && p.method !== 'CASH') {
    errors.push('Money received and change are only for cash payments.');
  } else if (hasReceived) {
    received = parsePesosToCentavos(p.received);
    if (received === null || received <= 0) { errors.push('Money received must be an amount above ₱0.00.'); received = null; }
    else if (received < amount) { errors.push(`Insufficient payment. The money received (${formatPeso(received)}) is less than the amount paid (${formatPeso(amount)}).`); received = null; }
    else change = received - amount;
  }
  let paidAt = null;
  if (p.paid_at) {
    paidAt = phtLocalToIso(p.paid_at);
    if (!paidAt) errors.push('Payment date and time are not valid.');
  }
  const card = p.method !== 'CASH';
  const accountName = card ? clean(p.account_name, 100) || null : null;
  const accountNumber = card ? clean(p.account_number, 40) || null : null;
  const reference = card ? clean(p.reference, 60) || null : null;
  for (const value of [accountName, accountNumber, reference]) {
    if (value && !SAFE_TEXT.test(value)) errors.push('Payment details contain characters that are not allowed.');
  }
  return { method: p.method, amount, received, change, paidAt, accountName, accountNumber, reference };
}

/**
 * Optional discount on the whole order (fixed amount in pesos, or a percentage). A reason is always recorded.
 * It must be more than 0 and less than the subtotal, so an order is never free.
 */
function buildDiscount(d, subtotal, errors) {
  if (!d || !d.type || d.type === 'NONE') return { type: 'NONE', value: 0, amount: 0, reason: null, note: null };
  if (d.type !== 'FIXED' && d.type !== 'PERCENT') { errors.push('Choose a fixed or a percentage discount.'); return null; }
  const value = d.type === 'FIXED' ? parsePesosToCentavos(d.value) : parsePercentToBp(d.value);
  if (value === null || value <= 0) {
    errors.push(d.type === 'FIXED' ? 'The discount amount must be above ₱0.00.' : 'The discount percentage must be above 0% and at most 100%.');
    return null;
  }
  if (!DISCOUNT_REASONS[d.reason_code]) { errors.push('Choose a reason for the discount.'); return null; }
  const note = clean(d.note, 200);
  if (d.reason_code === 'OTHER' && note.length < 3) { errors.push('Explain the discount in the notes box.'); return null; }
  const amount = discountAmount(subtotal, d.type, value);
  if (amount <= 0 || amount >= subtotal) { errors.push('The discount must be more than ₱0.00 and less than the order subtotal.'); return null; }
  return { type: d.type, value, amount, reason: d.reason_code, note: note || null };
}

/** Validate the payload and price it from the database. Throws 400 with a list of plain-language problems. */
export function buildDraft(db, payload, config) {
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'The order could not be read.', 'VALIDATION');
  const items = Array.isArray(payload.items) ? payload.items : [];
  const others = Array.isArray(payload.other_items) ? payload.other_items : [];
  const refs = Array.isArray(payload.ref_items) ? payload.ref_items : [];
  if (items.length + others.length + refs.length === 0) throw new HttpError(400, 'Add at least one item before submitting.', 'EMPTY_ORDER');
  if (items.length + others.length + refs.length > 100) throw new HttpError(400, 'An order can have at most 100 items.', 'VALIDATION');

  const errors = [];
  const fees = getFeeConfig(db);
  const largeG = config.largeWeightKg * 1000;
  let needsLargeConfirm = false;

  const lines = items.map((it, i) => {
    const tag = `Chicken item ${i + 1}`;
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(it?.product_id));
    if (!product) { errors.push(`${tag}: product not found.`); return null; }
    if (!product.active) errors.push(`${tag}: ${product.name} is not active.`);
    const weightG = parseWeightToGrams(it.weight);
    if (weightG === null) errors.push(`${tag}: enter a weight above 0 kg with at most 3 decimals.`);
    // Heads = how many chickens were weighed together. Optional for older callers (counts as 1).
    const heads = it.heads === undefined ? 1 : parseHeads(it.heads);
    if (heads === null) errors.push(`${tag}: the number of heads must be a whole number from 1 to 999.`);
    if (it.dara !== undefined && typeof it.dara !== 'boolean') errors.push(`${tag}: With Blood must be on or off.`);
    const prep = { feather: it.feather ?? null, dara: it.dara === true, cut: it.cut ?? 'NONE', sliceSize: it.slice_size ?? null };
    for (const message of validatePrep(prep)) errors.push(`${tag}: ${message}`);
    if (weightG !== null && weightG > largeG && it.confirm_large !== true) needsLargeConfirm = true;
    if (weightG === null || heads === null || !product.active) return null;
    return { product, weightG, heads, prep, calc: chickenLine({ pricePerKgCentavos: product.price_per_kg_centavos, weightG, heads, prep, fees }) };
  });

  const otherLines = others.map((it, i) => {
    const tag = `Other product ${i + 1}`;
    const option = db.prepare(`SELECT o.*, p.name AS product_name, p.active AS product_active FROM other_product_options o
                               JOIN other_products p ON p.id = o.product_id WHERE o.id = ?`).get(Number(it?.option_id));
    if (!option || option.product_id !== Number(it?.other_product_id)) { errors.push(`${tag}: product not found.`); return null; }
    if (!option.active || !option.product_active) errors.push(`${tag}: ${option.product_name} (${option.unit}) is not available.`);
    // Per kg items take a weight with decimals; pieces, dozens, packs and batches are whole numbers.
    const perKg = option.sold_by === 'PER_KG';
    const quantityMilli = perKg ? parseQuantityToMilli(it.quantity) : parseWholeQuantityToMilli(it.quantity);
    if (quantityMilli === null) errors.push(perKg ? `${tag}: enter a weight above 0 kg with at most 3 decimals.` : `${tag}: enter a whole number of ${option.unit}.`);
    // Revision 11: a per-kg line also says how many pieces were weighed (1 when not given); the stock is counted in pieces, on the product's piece row.
    let pieces = null;
    let stockOptionId = null;
    if (perKg) {
      pieces = it.pieces === undefined || it.pieces === null || it.pieces === '' ? 1 : parseHeads(it.pieces);
      if (pieces === null) errors.push(`${tag}: the number of pieces must be a whole number from 1 to 999.`);
      stockOptionId = pieceOptionOf(db, option.product_id);
      if (stockOptionId === null) errors.push(`${tag}: ${option.product_name} has no "piece" unit to count its stock in. Ask a manager to add it in Products.`);
    } else if (it.pieces !== undefined && it.pieces !== null && it.pieces !== '') {
      errors.push(`${tag}: the number of pieces is only asked for things sold by the kilo.`);
    }
    if (quantityMilli === null || !option.active || !option.product_active || (perKg && (pieces === null || stockOptionId === null))) return null;
    return { option, quantityMilli, pieces, stockOptionId, calc: otherLine({ unitPriceCentavos: option.price_centavos, quantityMilli }) };
  });

  // Revision 12: Katay or Dead chicken from the ref. The cashier types the price per kg; there is no service fee and no discount of its
  // own (a discount is added on the review screen like for any order). Price = price per kg x weight, rounded like a chicken line.
  const refLines = refs.map((it, i) => {
    const tag = `Ref item ${i + 1}`;
    const kind = String(it?.kind ?? '');
    if (!REF_KINDS.includes(kind)) { errors.push(`${tag}: choose Katay or Dead.`); return null; }
    const heads = parseHeads(it.heads);
    if (heads === null) errors.push(`${tag}: the number of heads must be a whole number from 1 to 999.`);
    const weightG = parseWeightToGrams(it.weight);
    if (weightG === null) errors.push(`${tag}: enter a weight above 0 kg with at most 3 decimals.`);
    const price = parsePesosToCentavos(it.price_per_kg);
    if (price === null || price <= 0) errors.push(`${tag}: enter the price per kg (above ₱0.00).`);
    if (heads === null || weightG === null || price === null || price <= 0) return null;
    return { kind, name: REF_LABELS[kind], heads, weightG, price, calc: refLine({ pricePerKgCentavos: price, weightG }) };
  });

  if (needsLargeConfirm && !errors.length) {
    throw new HttpError(400, `A weight is above ${config.largeWeightKg} kg. Please confirm it is correct.`, 'WEIGHT_CONFIRM');
  }
  const totalOk = errors.length === 0;
  const subtotal = totalOk ? grandTotal([...lines.map((l) => l.calc.lineTotal), ...otherLines.map((l) => l.calc.lineTotal), ...refLines.map((l) => l.calc.lineTotal)]) : 0;
  const discount = totalOk ? buildDiscount(payload.discount, subtotal, errors) : null;
  const total = discount ? subtotal - discount.amount : 0;
  const payment = buildPayment(payload.payment, total, errors);

  const customer = clean(payload.customer_number, 40) || 'WALK-IN';
  if (!SAFE_TEXT.test(customer)) errors.push('Customer number contains characters that are not allowed.');

  if (errors.length) throw new HttpError(400, 'Please fix the order and try again.', 'VALIDATION', errors);

  if (payload.expected_total_centavos !== undefined && payload.expected_total_centavos !== total) {
    throw new HttpError(409, 'A price changed while this order was open. The total has been refreshed. Please review it again.', 'PRICE_CHANGED');
  }
  return { customer, lines, otherLines, refLines, payment, subtotal, discount, total };
}

function submissionKey(value) {
  const key = String(value ?? '');
  if (!/^[A-Za-z0-9-]{8,80}$/.test(key)) throw new HttpError(400, 'Missing submission key.', 'VALIDATION');
  return key;
}

// ---- Writing ------------------------------------------------------------------------------------

function snapshot(db, id) {
  const o = loadOrder(db, id);
  return JSON.stringify({
    order_number: o.order_number, status: o.status, subtotal_centavos: o.subtotal_centavos, discount_type: o.discount_type,
    discount_centavos: o.discount_centavos, discount_reason: o.discount_reason, total_centavos: o.total_centavos, refund_centavos: o.refund_centavos,
    items: o.items.map(({ id: _i, order_id: _o, ...rest }) => rest),
    other_items: o.other_items.map(({ id: _i, order_id: _o, ...rest }) => rest),
    ref_items: o.ref_items.map(({ id: _i, order_id: _o, ...rest }) => rest),
  });
}

function addEvent(db, e) {
  db.prepare(`INSERT INTO order_events (order_id, action_type, reason_code, reason_note, user_id, created_at, refund_centavos, stock_returnable, related_order_id, snapshot_before, snapshot_after)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.orderId, e.action, e.reasonCode ?? null, e.reasonNote ?? null, e.userId, e.now.toISOString(),
    e.refund ?? null, e.stockReturnable ?? null, e.relatedId ?? null, e.before ?? null, e.after ?? null);
}

/** Insert an order and everything under it. Must be called inside tx(). */
function insertOrder(db, user, draft, { key, now, dayId, replacesId = null, reasonNote = null }) {
  const date = toBusinessDate(now);
  const seq = db.prepare(`INSERT INTO order_counters (business_date, last_seq) VALUES (?, 1)
                          ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq`).get(date).last_seq;
  const orderNumber = `ORD-${date.replaceAll('-', '')}-${String(seq).padStart(3, '0')}`;

  const d = draft.discount;
  const { lastInsertRowid } = db.prepare(`INSERT INTO orders (order_number, business_date, customer_number, status, subtotal_centavos, discount_type, discount_value,
                                          discount_centavos, discount_reason, discount_note, total_centavos, cashier_id, submitted_at, submission_key, replaces_order_id, business_day_id)
                                          VALUES (?,?,?,'COMPLETED',?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orderNumber, date, draft.customer, draft.subtotal, d.type, d.value, d.amount, d.reason, d.note, draft.total, user.id, now.toISOString(), key, replacesId, dayId);
  const orderId = Number(lastInsertRowid);

  let lineNo = 0;
  const insertItem = db.prepare(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos,
                                 feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of draft.lines) {
    insertItem.run(orderId, ++lineNo, l.product.id, l.product.name, l.product.price_per_kg_centavos, l.weightG, l.heads, l.calc.weightAmount,
      l.prep.feather, l.prep.dara ? 1 : 0, l.prep.cut, l.prep.sliceSize, JSON.stringify(l.calc.fees), l.calc.serviceFee, l.calc.lineTotal);
  }
  const insertOther = db.prepare(`INSERT INTO order_other_items (order_id, line_no, other_product_id, option_id, product_name, unit, sold_by, unit_price_centavos, quantity_milli, line_total_centavos, pieces)
                                  VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of draft.otherLines) {
    insertOther.run(orderId, ++lineNo, l.option.product_id, l.option.id, l.option.product_name, l.option.unit, l.option.sold_by, l.option.price_centavos, l.quantityMilli, l.calc.lineTotal, l.pieces);
  }
  const insertRef = db.prepare(`INSERT INTO order_ref_items (order_id, line_no, ref_kind, product_name, heads, weight_g, price_per_kg_centavos, line_total_centavos)
                                VALUES (?,?,?,?,?,?,?,?)`);
  for (const l of draft.refLines ?? []) insertRef.run(orderId, ++lineNo, l.kind, l.name, l.heads, l.weightG, l.price, l.calc.lineTotal);
  if (draft.payment) {
    const p = draft.payment;
    db.prepare(`INSERT INTO payments (order_id, method, amount_centavos, received_centavos, change_centavos, paid_at, account_name, account_number, reference, recorded_by, recorded_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(orderId, p.method, p.amount, p.received, p.change, p.paidAt, p.accountName, p.accountNumber, p.reference, user.id, now.toISOString());
  }
  addEvent(db, { orderId, action: 'SUBMIT', reasonNote, userId: user.id, now, relatedId: replacesId, after: snapshot(db, orderId) });
  return orderId;
}

export function createOrder(db, user, payload, { config, now = new Date() }) {
  const key = submissionKey(payload?.submission_key);
  const existing = db.prepare('SELECT id FROM orders WHERE submission_key = ?').get(key);
  if (existing) return { order: getOrder(db, existing.id, user), duplicate: true };
  const draft = buildDraft(db, payload, config);
  return tx(db, () => {
    const again = db.prepare('SELECT id FROM orders WHERE submission_key = ?').get(key);
    if (again) return { order: getOrder(db, again.id, user), duplicate: true };
    // Stock is checked here, inside the transaction that saves the order, against the open business day.
    const day = ensureOpenDay(db, now, user.id);
    assertStock(db, day, demandOf(draft), now);
    const id = insertOrder(db, user, draft, { key, now, dayId: day.id });
    return { order: getOrder(db, id, user), duplicate: false };
  });
}

function checkReason(body) {
  const code = body?.reason_code;
  if (!REASONS[code]) throw new HttpError(400, 'Choose a reason from the list.', 'VALIDATION');
  const note = clean(body.reason_note, 1000);
  if (code === 'OTHER' && note.length < 3) throw new HttpError(400, 'Explain the reason in the notes box.', 'VALIDATION');
  return { code, note: note || null };
}

function requireStatus(order, allowed, verb) {
  if (!order) throw new HttpError(404, 'Order not found.', 'NOT_FOUND');
  if (!allowed.includes(order.status)) {
    throw new HttpError(409, `${order.order_number} is ${order.status.toLowerCase().replace('_', ' ')} and cannot be ${verb}.`, 'BAD_STATUS');
  }
}

export function cancelOrder(db, user, id, body, { now = new Date() } = {}) {
  const reason = checkReason(body);
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    requireStatus(order, ['COMPLETED'], 'canceled');
    const before = snapshot(db, id);
    db.prepare("UPDATE orders SET status = 'CANCELED' WHERE id = ?").run(id);
    addEvent(db, {
      orderId: id, action: 'CANCEL', reasonCode: reason.code, reasonNote: reason.note, userId: user.id, now,
      stockReturnable: body.stock_returnable === undefined ? null : body.stock_returnable ? 1 : 0, before, after: snapshot(db, id),
    });
    // A canceled order is no longer counted as sold, so its stock is free again. If the chicken cannot go back (burned or dressed),
    // it is recorded as Reject so the New Total does not rise.
    if (body.stock_returnable === false) rejectCanceledChicken(db, user, order, now);
    return getOrder(db, id, user);
  });
}

/** Full refund. The money part only: stock is never returned automatically. */
export function refundOrder(db, user, id, body, { now = new Date() } = {}) {
  const reason = checkReason(body);
  return tx(db, () => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    requireStatus(order, ['COMPLETED'], 'refunded');
    const before = snapshot(db, id);
    db.prepare("UPDATE orders SET status = 'REFUNDED', refund_centavos = total_centavos WHERE id = ?").run(id);
    addEvent(db, {
      orderId: id, action: 'REFUND', reasonCode: reason.code, reasonNote: reason.note, userId: user.id, now,
      refund: order.total_centavos, before, after: snapshot(db, id),
    });
    return getOrder(db, id, user);
  });
}

/** Change = void and replace: the original is marked REPLACED and a new linked order is created. */
export function changeOrder(db, user, id, payload, { config, now = new Date() }) {
  const reason = checkReason(payload);
  const key = submissionKey(payload?.submission_key);
  const existing = db.prepare('SELECT id FROM orders WHERE submission_key = ?').get(key);
  if (existing) return { order: getOrder(db, existing.id, user), duplicate: true };
  const draft = buildDraft(db, payload, config);
  return tx(db, () => {
    const original = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    requireStatus(original, ['COMPLETED'], 'changed');
    const before = snapshot(db, id);
    // The order being replaced stops counting as sold, so its own stock is free for the replacement.
    const day = ensureOpenDay(db, now, user.id);
    // The ref is not tied to a business day, so the original's Katay / Dead heads are always free for the replacement.
    const held = heldBy(db, id);
    const none = { chicken: new Map(), other: new Map(), ref: held.ref };
    assertStock(db, day, demandOf(draft), now, original.business_day_id === day.id ? held : none);
    const newId = insertOrder(db, user, draft, { key, now, dayId: day.id, replacesId: id, reasonNote: `Replaces ${original.order_number}` });
    db.prepare("UPDATE orders SET status = 'REPLACED', replaced_by_order_id = ? WHERE id = ?").run(newId, id);
    addEvent(db, {
      orderId: id, action: 'CHANGE', reasonCode: reason.code, reasonNote: reason.note, userId: user.id, now,
      relatedId: newId, before, after: snapshot(db, newId),
    });
    return { order: getOrder(db, newId, user), duplicate: false };
  });
}
