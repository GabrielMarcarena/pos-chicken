// Orders: pricing on the server, submit, cancel, change (void and replace) and refund.
//
// Rules this file protects:
//   * The server recalculates every price from the database. Prices sent by the browser are never trusted.
//   * A submitted order is never edited or deleted. Cancel, change and refund add audit events and move the
//     order to a new status; the original lines stay exactly as they were.
//   * Order numbers come from an atomic per-day counter, so two cashiers can never get the same number and
//     a canceled order keeps its number forever.
//   * A repeated submission with the same submission_key returns the first order instead of creating another.
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { parseWeightToGrams, parsePesosToCentavos, parseQuantityToMilli, parseWholeQuantityToMilli, parsePercentToBp, parseHeads } from '../../shared/money.js';
import { validatePrep } from '../../shared/rules.js';
import { chickenLine, otherLine, grandTotal, discountAmount } from '../../shared/pricing.js';
import { REASONS, PAYMENT_METHODS, DISCOUNT_REASONS } from '../../shared/constants.js';
import { getFeeConfig, productCode } from './catalog.js';
import { ROLE_RANK } from './users.js';
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
    customer_number: o.customer_number,
    status: o.status,
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
      fees: JSON.parse(i.fee_detail), service_fee_centavos: i.service_fee_centavos, line_total_centavos: i.line_total_centavos,
    })),
    other_items: o.other_items.map((i) => ({
      line_no: i.line_no, other_product_id: i.other_product_id, option_id: i.option_id, sold_by: i.sold_by, product_name: i.product_name, unit: i.unit,
      unit_price_centavos: i.unit_price_centavos, quantity_milli: i.quantity_milli, line_total_centavos: i.line_total_centavos,
    })),
    payments: o.payments.map((p) => ({
      method: p.method, amount_centavos: p.amount_centavos, paid_at: p.paid_at, reference: p.reference,
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

export function listOrders(db, { q = '', from, to, status, limit = 200 } = {}) {
  const where = [];
  const params = [];
  const text = clean(q, 60);
  if (text) { where.push('(o.order_number LIKE ? OR o.customer_number LIKE ?)'); params.push(`%${text}%`, `%${text}%`); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from ?? '')) { where.push('o.business_date >= ?'); params.push(from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) { where.push('o.business_date <= ?'); params.push(to); }
  if (status) { where.push('o.status = ?'); params.push(status); }
  const rows = db.prepare(`
    SELECT o.id, o.order_number, o.business_date, o.customer_number, o.status, o.total_centavos, o.refund_centavos, o.submitted_at,
           u.display_name AS cashier_name, rb.order_number AS replaced_by_number,
           (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) + (SELECT COUNT(*) FROM order_other_items x WHERE x.order_id = o.id) AS line_count
    FROM orders o JOIN users u ON u.id = o.cashier_id LEFT JOIN orders rb ON rb.id = o.replaced_by_order_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY o.id DESC LIMIT ?`).all(...params, Math.min(Number(limit) || 200, 500));
  return rows;
}

// ---- Validating and pricing a new order ---------------------------------------------------------

function buildPayment(p, total, errors) {
  if (!p || !p.method || p.method === 'NONE') return null;
  if (!PAYMENT_METHODS[p.method]) { errors.push('Choose a payment method from the list.'); return null; }
  const amount = p.amount === undefined || p.amount === '' ? total : parsePesosToCentavos(p.amount);
  if (amount === null || amount <= 0) { errors.push('Payment amount must be above ₱0.00.'); return null; }
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
  return { method: p.method, amount, paidAt, accountName, accountNumber, reference };
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
  if (items.length + others.length === 0) throw new HttpError(400, 'Add at least one item before submitting.', 'EMPTY_ORDER');
  if (items.length + others.length > 100) throw new HttpError(400, 'An order can have at most 100 items.', 'VALIDATION');

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
    if (it.dara !== undefined && typeof it.dara !== 'boolean') errors.push(`${tag}: Dara must be on or off.`);
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
    if (quantityMilli === null || !option.active || !option.product_active) return null;
    return { option, quantityMilli, calc: otherLine({ unitPriceCentavos: option.price_centavos, quantityMilli }) };
  });

  if (needsLargeConfirm && !errors.length) {
    throw new HttpError(400, `A weight is above ${config.largeWeightKg} kg. Please confirm it is correct.`, 'WEIGHT_CONFIRM');
  }
  const totalOk = errors.length === 0;
  const subtotal = totalOk ? grandTotal([...lines.map((l) => l.calc.lineTotal), ...otherLines.map((l) => l.calc.lineTotal)]) : 0;
  const discount = totalOk ? buildDiscount(payload.discount, subtotal, errors) : null;
  const total = discount ? subtotal - discount.amount : 0;
  const payment = buildPayment(payload.payment, total, errors);

  const customer = clean(payload.customer_number, 40) || 'WALK-IN';
  if (!SAFE_TEXT.test(customer)) errors.push('Customer number contains characters that are not allowed.');

  if (errors.length) throw new HttpError(400, 'Please fix the order and try again.', 'VALIDATION', errors);

  if (payload.expected_total_centavos !== undefined && payload.expected_total_centavos !== total) {
    throw new HttpError(409, 'A price changed while this order was open. The total has been refreshed. Please review it again.', 'PRICE_CHANGED');
  }
  return { customer, lines, otherLines, payment, subtotal, discount, total };
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
  });
}

function addEvent(db, e) {
  db.prepare(`INSERT INTO order_events (order_id, action_type, reason_code, reason_note, user_id, created_at, refund_centavos, stock_returnable, related_order_id, snapshot_before, snapshot_after)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    e.orderId, e.action, e.reasonCode ?? null, e.reasonNote ?? null, e.userId, e.now.toISOString(),
    e.refund ?? null, e.stockReturnable ?? null, e.relatedId ?? null, e.before ?? null, e.after ?? null);
}

/** Insert an order and everything under it. Must be called inside tx(). */
function insertOrder(db, user, draft, { key, now, replacesId = null, reasonNote = null }) {
  const date = toBusinessDate(now);
  const seq = db.prepare(`INSERT INTO order_counters (business_date, last_seq) VALUES (?, 1)
                          ON CONFLICT(business_date) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq`).get(date).last_seq;
  const orderNumber = `ORD-${date.replaceAll('-', '')}-${String(seq).padStart(3, '0')}`;

  const d = draft.discount;
  const { lastInsertRowid } = db.prepare(`INSERT INTO orders (order_number, business_date, customer_number, status, subtotal_centavos, discount_type, discount_value,
                                          discount_centavos, discount_reason, discount_note, total_centavos, cashier_id, submitted_at, submission_key, replaces_order_id)
                                          VALUES (?,?,?,'COMPLETED',?,?,?,?,?,?,?,?,?,?,?)`)
    .run(orderNumber, date, draft.customer, draft.subtotal, d.type, d.value, d.amount, d.reason, d.note, draft.total, user.id, now.toISOString(), key, replacesId);
  const orderId = Number(lastInsertRowid);

  let lineNo = 0;
  const insertItem = db.prepare(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos,
                                 feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const l of draft.lines) {
    insertItem.run(orderId, ++lineNo, l.product.id, l.product.name, l.product.price_per_kg_centavos, l.weightG, l.heads, l.calc.weightAmount,
      l.prep.feather, l.prep.dara ? 1 : 0, l.prep.cut, l.prep.sliceSize, JSON.stringify(l.calc.fees), l.calc.serviceFee, l.calc.lineTotal);
  }
  const insertOther = db.prepare(`INSERT INTO order_other_items (order_id, line_no, other_product_id, option_id, product_name, unit, sold_by, unit_price_centavos, quantity_milli, line_total_centavos)
                                  VALUES (?,?,?,?,?,?,?,?,?,?)`);
  for (const l of draft.otherLines) {
    insertOther.run(orderId, ++lineNo, l.option.product_id, l.option.id, l.option.product_name, l.option.unit, l.option.sold_by, l.option.price_centavos, l.quantityMilli, l.calc.lineTotal);
  }
  if (draft.payment) {
    const p = draft.payment;
    db.prepare(`INSERT INTO payments (order_id, method, amount_centavos, paid_at, account_name, account_number, reference, recorded_by, recorded_at)
                VALUES (?,?,?,?,?,?,?,?,?)`).run(orderId, p.method, p.amount, p.paidAt, p.accountName, p.accountNumber, p.reference, user.id, now.toISOString());
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
    const id = insertOrder(db, user, draft, { key, now });
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
    const newId = insertOrder(db, user, draft, { key, now, replacesId: id, reasonNote: `Replaces ${original.order_number}` });
    db.prepare("UPDATE orders SET status = 'REPLACED', replaced_by_order_id = ? WHERE id = ?").run(newId, id);
    addEvent(db, {
      orderId: id, action: 'CHANGE', reasonCode: reason.code, reasonNote: reason.note, userId: user.id, now,
      relatedId: newId, before, after: snapshot(db, newId),
    });
    return { order: getOrder(db, newId, user), duplicate: false };
  });
}
