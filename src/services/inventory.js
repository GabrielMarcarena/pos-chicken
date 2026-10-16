// Daily Inventory: business days, the stock figures for each product, the stock check for new orders, and closing a day.
//
// ONE source of truth for stock. The New order screen, the Daily Inventory screen, the order check on the server and the exports all
// read the figures from here, and every figure comes from the same arithmetic (shared/inventory.js):
//
//   Total = Beginning + Additional      Left = Total - Sold      New Total = Left - Reject - Dead - Pull Out   (chicken)
//                                                                New Total = Left                              (other products)
//
// "Sold" is never typed in. It is counted from the saved orders of the business day, so a sale can only be counted once:
//   * a new order counts as sold the moment it is saved, whether it is Ongoing, Standby or Complete (the pickup column never changes stock)
//   * a canceled or replaced order is not counted, so its stock is free again. When a canceled chicken cannot go back (the cashier did not
//     tick "can go back into stock"), its heads are added to Reject on the same record, so the New Total does not rise
//   * a refund is money only: the order stays sold and nothing goes back into stock
//   * when a day is closed, its Sold figures are frozen. Orders of a closed day are never recounted into any other day
//
// All figures are thousandths (77 heads = 77000). Chicken is counted in heads; other products in the unit they are sold by.
//
// The Beginning Balance of a new day is carried over from the previous day's New Total, but a manager or the admin can correct it
// (for example after a recount). Changing a Beginning Balance that already has a number needs a reason, and the reason is saved with
// who changed it and when. Every other number needs no reason.
//
// Revision 11:
//   * Katay is a chicken inventory loss, like Reject, Dead and Pull Out (New Total = Left - Reject - Katay - Dead - Pull Out).
//   * Other products are counted in pieces (or packs, sacks, cartons, trays). "kg" has no stock row of its own: a per-kg sale says how
//     many pieces were weighed, and those pieces come off the product's "piece" row. Per-kg lines saved before Revision 11 have no
//     piece count; they still count against the old kg row, which is shown only while it holds a number.
//   * Closing a day takes two steps: "Submit Inventory Today" saves the day's inventory file (on this computer and as a download) and
//     remembers every number in it; "Closed Inventory Today and Reset the Day" closes the day only while those numbers are unchanged.
//
// Revision 12:
//   * "Closed Inventory Today and Reset the Day" submits and closes in ONE step (closeAndSubmit in inventoryReport.js); the separate
//     Submit Inventory Today button still works on its own.
//   * Katay and Dead are linked to the ref stock (refStock.js): storing a Katay or Dead chicken in the ref from the New order screen adds
//     it to the chicken's Katay or Dead here too, and Katay or Dead typed here goes into the ref when the person says so.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { ROLE_RANK } from './users.js';
import { COUNTS_AS_SALE, INVENTORY_REASONS, REF_KINDS, REF_LABELS, REF_FIELD, unitRank } from '../../shared/constants.js';
import { parseCountToMilli, parseHeads, parseWeightToGrams, formatKg } from '../../shared/money.js';
import { refBalance, refByProduct, refKey, refHeldBy, refFromRecord, addRefEntry, refSummary } from './refStock.js';
import { computeRow, checkRow, insufficientStockMessage, isEmptyRow, LOSS_FIELDS, LOSS_LABELS, formatQty } from '../../shared/inventory.js';
import { toBusinessDate, toPhtDateTime } from '../time.js';

/** Who may type stock numbers and start a new business day. Everyone signed in may look. */
export const INVENTORY_EDIT_ROLE = 'manager';

const MARKS = COUNTS_AS_SALE.map(() => '?').join(',');
const FIELD_COLUMN = { beginning: 'beginning_milli', additional: 'additional_milli', reject: 'reject_milli', katay: 'katay_milli', dead: 'dead_milli', pull_out: 'pull_out_milli' };
const FIELD_LABEL = { beginning: 'Beginning Balance', additional: 'Additional', ...LOSS_LABELS };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const canEdit = (user) => ROLE_RANK[user.role] >= ROLE_RANK[INVENTORY_EDIT_ROLE];

// ---- Business days ------------------------------------------------------------------------------

export const openDay = (db) => db.prepare("SELECT * FROM business_days WHERE status = 'OPEN'").get() ?? null;

/** The date label for the next business day: today, or the day after the latest day when that one is already today or later. */
function nextDate(db, now) {
  const today = toBusinessDate(now);
  const last = db.prepare('SELECT MAX(business_date) AS d FROM business_days').get().d;
  return last && last >= today ? addDays(last, 1) : today;
}

/**
 * The open business day. If there is none yet (a new install, or the first start after the upgrade) one is opened. Revision 13: an open
 * day whose date has passed (the clock went past midnight) is saved and closed first, and today is opened. Call inside tx().
 */
export function ensureOpenDay(db, now, userId = null) {
  const day = openDay(db);
  if (day && day.business_date < toBusinessDate(now)) {
    autoClose(db, day, now);
    return openDay(db);
  }
  if (day) return day;
  db.prepare("INSERT INTO business_days (business_date, status, opened_at, opened_by) VALUES (?, 'OPEN', ?, ?)").run(nextDate(db, now), now.toISOString(), userId);
  return openDay(db);
}

function shapeDay(db, day, now) {
  if (!day) return null;
  const closedBy = day.closed_by ? db.prepare('SELECT display_name FROM users WHERE id = ?').get(day.closed_by)?.display_name ?? null : null;
  return {
    id: day.id, business_date: day.business_date, status: day.status, opened_at: day.opened_at, closed_at: day.closed_at, closed_by_name: closedBy,
    // An open day older than today: the shop has not started a new business day yet.
    stale: day.status === 'OPEN' && day.business_date < toBusinessDate(now),
  };
}

// ---- Records ------------------------------------------------------------------------------------

const COL = { CHICKEN: 'product_id', OTHER: 'option_id' };
const parts = (r) => ({
  beginning: r.beginning_milli, additional: r.additional_milli, reject: r.reject_milli, katay: r.katay_milli ?? 0, dead: r.dead_milli, pull_out: r.pull_out_milli,
});

/** The "piece" selling option of an other product: where pieces sold by the kilo are counted. Null if the product has none. */
export function pieceOptionOf(db, otherProductId) {
  return db.prepare("SELECT id FROM other_product_options WHERE product_id = ? AND unit = 'piece'").get(otherProductId)?.id ?? null;
}

// The stock row a saved other-product line counts against, in SQL (x = order_other_items): a per-kg line with a piece count counts
// against the product's piece row, everything else against its own selling option.
const STOCK_OPTION_SQL = `CASE WHEN x.sold_by = 'PER_KG' AND x.pieces IS NOT NULL
  THEN (SELECT po.id FROM other_product_options po WHERE po.product_id = x.other_product_id AND po.unit = 'piece') ELSE x.option_id END`;
const STOCK_QTY_SQL = "CASE WHEN x.sold_by = 'PER_KG' AND x.pieces IS NOT NULL THEN x.pieces * 1000 ELSE x.quantity_milli END";

/** The New Total a record ended the day with (its Sold figure is frozen once the day is closed). */
const closingTotal = (r) => computeRow(r.kind, parts(r), r.sold_milli ?? 0).new_total;

/**
 * The record of one product (kind CHICKEN, itemId = products.id) or selling option (kind OTHER, itemId = other_product_options.id)
 * for a day, created if it is missing. A new record starts from the New Total of the item's most recent earlier record (carried
 * forward). An item with no earlier record starts at 0 and its Beginning Balance can be typed in once. Call inside tx().
 */
export function ensureRecord(db, day, kind, itemId, now) {
  const col = COL[kind];
  const found = db.prepare(`SELECT * FROM inventory_records WHERE business_day_id = ? AND ${col} = ?`).get(day.id, itemId);
  if (found) return found;
  const prev = db.prepare(`SELECT * FROM inventory_records WHERE ${col} = ? AND business_day_id <> ? ORDER BY business_day_id DESC LIMIT 1`).get(itemId, day.id);
  const beginning = prev ? Math.max(closingTotal(prev), 0) : 0;
  db.prepare(`INSERT INTO inventory_records (business_day_id, kind, ${col}, beginning_milli, beginning_carried, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(day.id, kind, itemId, beginning, prev ? 1 : 0, now.toISOString());
  return db.prepare(`SELECT * FROM inventory_records WHERE business_day_id = ? AND ${col} = ?`).get(day.id, itemId);
}

/**
 * Make sure every active chicken product and every counted selling option of an active other product has a record on this day. An option
 * does not need a price to have stock: counting the stock comes before pricing it. "kg" is not counted (pieces are). Call inside tx().
 */
function materialize(db, day, now) {
  for (const p of db.prepare('SELECT id FROM products WHERE active = 1').all()) ensureRecord(db, day, 'CHICKEN', p.id, now);
  for (const o of db.prepare("SELECT o.id FROM other_product_options o JOIN other_products p ON p.id = o.product_id WHERE p.active = 1 AND o.sold_by <> 'PER_KG'").all()) {
    ensureRecord(db, day, 'OTHER', o.id, now);
  }
}

function missingRecords(db, day) {
  const chicken = db.prepare(`SELECT COUNT(*) AS n FROM products p WHERE p.active = 1
                              AND NOT EXISTS (SELECT 1 FROM inventory_records r WHERE r.business_day_id = ? AND r.product_id = p.id)`).get(day.id).n;
  const other = db.prepare(`SELECT COUNT(*) AS n FROM other_product_options o JOIN other_products p ON p.id = o.product_id WHERE p.active = 1 AND o.sold_by <> 'PER_KG'
                            AND NOT EXISTS (SELECT 1 FROM inventory_records r WHERE r.business_day_id = ? AND r.option_id = o.id)`).get(day.id).n;
  return chicken + other;
}

/** The open day with a record for every active item (opening the day first if needed). Writes only when something is missing. */
export function prepareOpenDay(db, now, user = null) {
  const day = openDay(db);
  if (day && day.business_date >= toBusinessDate(now) && missingRecords(db, day) === 0) return day;
  return tx(db, () => {
    const d = ensureOpenDay(db, now, user?.id ?? null);
    materialize(db, d, now);
    return d;
  });
}

// ---- Sold (counted from the orders, never typed) --------------------------------------------------

/** Heads sold per chicken product and units sold per counted selling option on a day, as thousandths (pieces sold by the kilo included). */
export function soldMaps(db, dayId) {
  const chicken = new Map();
  const other = new Map();
  for (const r of db.prepare(`SELECT i.product_id AS id, SUM(i.heads) AS n FROM order_items i JOIN orders o ON o.id = i.order_id
                              WHERE o.business_day_id = ? AND o.status IN (${MARKS}) GROUP BY i.product_id`).all(dayId, ...COUNTS_AS_SALE)) chicken.set(r.id, r.n * 1000);
  for (const r of db.prepare(`SELECT ${STOCK_OPTION_SQL} AS id, SUM(${STOCK_QTY_SQL}) AS n FROM order_other_items x JOIN orders o ON o.id = x.order_id
                              WHERE o.business_day_id = ? AND o.status IN (${MARKS}) GROUP BY 1`).all(dayId, ...COUNTS_AS_SALE)) {
    if (r.id !== null) other.set(r.id, (other.get(r.id) ?? 0) + r.n);
  }
  return { chicken, other };
}

const soldOf = (rec, maps) => (rec.sold_milli !== null ? rec.sold_milli : (rec.kind === 'CHICKEN' ? maps.chicken.get(rec.product_id) : maps.other.get(rec.option_id)) ?? 0);

/** The names and units for every record of a day, with the calculated columns. */
function rowsFor(db, day) {
  const maps = soldMaps(db, day.id);
  const rows = db.prepare(`
    SELECT r.*, p.name AS chicken_name, p.active AS chicken_active, op.name AS other_name, op.active AS other_active, o.unit AS unit, o.sold_by AS sold_by
    FROM inventory_records r
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN other_product_options o ON o.id = r.option_id
    LEFT JOIN other_products op ON op.id = o.product_id
    WHERE r.business_day_id = ?`).all(day.id);
  // The most recent earlier record of the same item: its Beginning Balance and the date of its business day (the italic note).
  const previous = {
    CHICKEN: db.prepare(`SELECT r.beginning_milli AS beginning, d.business_date AS date FROM inventory_records r JOIN business_days d ON d.id = r.business_day_id
                         WHERE r.product_id = ? AND r.business_day_id < ? ORDER BY r.business_day_id DESC LIMIT 1`),
    OTHER: db.prepare(`SELECT r.beginning_milli AS beginning, d.business_date AS date FROM inventory_records r JOIN business_days d ON d.id = r.business_day_id
                       WHERE r.option_id = ? AND r.business_day_id < ? ORDER BY r.business_day_id DESC LIMIT 1`),
  };
  // The latest correction of the Beginning Balance (a change with a reason), so the screen can show that it was edited and why.
  const lastEdit = db.prepare(`SELECT e.reason_code, e.reason_note, e.old_milli, e.created_at, u.display_name AS by_name
                               FROM inventory_events e JOIN users u ON u.id = e.user_id
                               WHERE e.record_id = ? AND e.field = 'beginning' AND e.reason_code IS NOT NULL ORDER BY e.id DESC LIMIT 1`);
  const shaped = rows.flatMap((r) => {
    const calc = computeRow(r.kind, parts(r), soldOf(r, maps));
    // A product that has been switched off is not listed, unless it still has stock or sales on this day (so nothing is ever hidden that has a number).
    // The same goes for an old "kg" row (Revision 11 counts pieces instead): it is listed only while it still holds a number.
    const switchedOff = r.kind === 'CHICKEN' ? r.chicken_active === 0 : (r.other_active === 0 || r.sold_by === 'PER_KG');
    const hasNumbers = r.beginning_milli > 0 || r.additional_milli > 0 || calc.sold > 0 || r.reject_milli > 0 || (r.katay_milli ?? 0) > 0 || r.dead_milli > 0 || r.pull_out_milli > 0;
    if (switchedOff && !hasNumbers) return [];
    const chicken = r.kind === 'CHICKEN';
    const prev = previous[r.kind].get(chicken ? r.product_id : r.option_id, day.id);
    const edit = lastEdit.get(r.id);
    const row = {
      id: r.id, kind: r.kind, item_id: chicken ? r.product_id : r.option_id,
      name: chicken ? r.chicken_name : `${r.other_name} - ${r.unit}`, product_name: chicken ? r.chicken_name : r.other_name,
      unit: chicken ? 'heads' : r.unit, sold_by: chicken ? null : r.sold_by,
      beginning: r.beginning_milli, additional: r.additional_milli, total: calc.total, sold: calc.sold, left: calc.left,
      reject: chicken ? r.reject_milli : null, katay: chicken ? (r.katay_milli ?? 0) : null, dead: chicken ? r.dead_milli : null,
      pull_out: chicken ? r.pull_out_milli : null, new_total: calc.new_total,
      // The Beginning Balance can be corrected by a manager or admin on the open day (the screen asks for a reason when one is needed).
      beginning_editable: day.status === 'OPEN',
      beginning_needs_reason: r.beginning_carried === 1 || r.beginning_milli > 0,
      beginning_carried: r.beginning_carried === 1,
      prev_beginning: prev ? prev.beginning : null, prev_date: prev ? prev.date : null,
      beginning_edit: edit ? {
        reason_code: edit.reason_code, reason: INVENTORY_REASONS[edit.reason_code] ?? edit.reason_code, note: edit.reason_note, was: edit.old_milli, by: edit.by_name, at: edit.created_at,
      } : null,
      rev: r.rev,
    };
    row.empty = isEmptyRow(row);
    return [row];
  });
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  // Other products: by product name, then in the order piece, pack, sack, kg (eggs: piece, carton, tray).
  const byProduct = (a, b) => a.product_name.localeCompare(b.product_name, undefined, { sensitivity: 'base' }) || unitRank(a.unit) - unitRank(b.unit) || byName(a, b);
  return { chicken: shaped.filter((r) => r.kind === 'CHICKEN').sort(byName), other: shaped.filter((r) => r.kind === 'OTHER').sort(byProduct) };
}

// ---- Reading --------------------------------------------------------------------------------------

export function listDays(db, limit = 400) {
  return db.prepare('SELECT id, business_date, status FROM business_days ORDER BY business_date DESC LIMIT ?').all(limit);
}

/** The Daily Inventory screen: one business day (the open one unless a date is given). */
export function getInventory(db, viewer, { date } = {}, now = new Date()) {
  const open = prepareOpenDay(db, now, viewer);
  let day = open;
  if (date && date !== open.business_date) {
    day = db.prepare('SELECT * FROM business_days WHERE business_date = ?').get(String(date));
    if (!day) throw new HttpError(404, 'There is no business day for that date.', 'NOT_FOUND');
  }
  const rows = rowsFor(db, day);
  return {
    day: shapeDay(db, day, now), open_day: shapeDay(db, open, now), days: listDays(db),
    chicken: rows.chicken, other: rows.other,
    can_edit: canEdit(viewer) && day.status === 'OPEN', can_close: canEdit(viewer) && day.status === 'OPEN',
    // Revision 13: the day's one saved row ("Save"), or null.
    saved: saveStatus(db, day),
    // Submit Inventory Today: the latest submission of this day, and whether its numbers are still the day's numbers.
    submission: submissionStatus(db, day),
  };
}

/**
 * What the New order screen needs: how many heads / units can still be sold on the open business day (the New Total, never below 0).
 * Same numbers as the Daily Inventory screen, because they come from the same rows.
 */
export function stockSummary(db, now = new Date()) {
  const day = prepareOpenDay(db, now);
  const rows = rowsFor(db, day);
  const chicken_heads = {};
  const other_milli = {};
  for (const r of rows.chicken) chicken_heads[r.item_id] = Math.max(r.new_total, 0) / 1000;
  for (const r of rows.other) other_milli[r.item_id] = Math.max(r.new_total, 0);
  // A per-kg option has no stock of its own: its pieces come off the product's piece row. other_stock_of tells the screen which one.
  const other_stock_of = {};
  for (const o of db.prepare(`SELECT k.id AS kg, (SELECT p.id FROM other_product_options p WHERE p.product_id = k.product_id AND p.unit = 'piece') AS piece
                              FROM other_product_options k WHERE k.sold_by = 'PER_KG'`).all()) {
    if (o.piece) other_stock_of[o.kg] = o.piece;
  }
  // Revision 12: heads of Katay and Dead chicken in the ref (not tied to a business day).
  return { business_day_id: day.id, business_date: day.business_date, stale: day.business_date < toBusinessDate(now), chicken_heads, other_milli, other_stock_of, ref_heads: refBalance(db),
    // Revision 13: the same heads per chicken product, so the cashier picks which one is sold
    ref_by_product: refByProduct(db) };
}

// ---- The stock check for a new order --------------------------------------------------------------

/**
 * Quantities an order asks for: Map(productId -> heads) and Map(stock optionId -> thousandths), with the names for the message.
 * A per-kg line asks for its pieces from the product's piece row (l.stockOptionId, set by buildDraft).
 */
export function demandOf(draft) {
  const chicken = new Map();
  const other = new Map();
  for (const l of draft.lines) {
    const e = chicken.get(l.product.id) ?? { name: l.product.name, heads: 0 };
    e.heads += l.heads;
    chicken.set(l.product.id, e);
  }
  for (const l of draft.otherLines) {
    const byPiece = l.pieces !== null && l.pieces !== undefined;
    const id = byPiece ? l.stockOptionId : l.option.id;
    const e = other.get(id) ?? { name: l.option.product_name, unit: byPiece ? 'piece' : l.option.unit, milli: 0 };
    e.milli += byPiece ? l.pieces * 1000 : l.quantityMilli;
    other.set(id, e);
  }
  // Revision 12: Katay and Dead chicken sold from the ref, in heads. Revision 13: per kind and chicken product (key "KATAY:3").
  const ref = new Map();
  for (const l of draft.refLines ?? []) {
    const k = refKey(l.kind, l.productId);
    const e = ref.get(k) ?? { kind: l.kind, productId: l.productId, product: l.productName, heads: 0 };
    e.heads += l.heads;
    ref.set(k, e);
  }
  return { chicken, other, ref };
}

/** What an existing order is holding: used when it is being replaced, so its own stock counts as free for the replacement. */
export function heldBy(db, orderId) {
  const chicken = new Map();
  const other = new Map();
  for (const r of db.prepare('SELECT product_id AS id, SUM(heads) AS n FROM order_items WHERE order_id = ? GROUP BY product_id').all(orderId)) chicken.set(r.id, r.n * 1000);
  for (const r of db.prepare(`SELECT ${STOCK_OPTION_SQL} AS id, SUM(${STOCK_QTY_SQL}) AS n FROM order_other_items x WHERE x.order_id = ? GROUP BY 1`).all(orderId)) {
    if (r.id !== null) other.set(r.id, (other.get(r.id) ?? 0) + r.n);
  }
  return { chicken, other, ref: refHeldBy(db, orderId) };
}

/**
 * Refuse an order that asks for more than is available. Must run inside the same transaction that saves the order, so two cashiers
 * can never both be given the last chicken. `released` is what an order being replaced already holds.
 */
export function assertStock(db, day, demand, now, released = { chicken: new Map(), other: new Map() }) {
  const sold = soldMaps(db, day.id);
  const problems = [];
  // The ref is not tied to a business day: an order being replaced always gives its ref heads back (released.ref).
  if (demand.ref?.size) {
    const inRef = refByProduct(db);
    for (const [k, want] of demand.ref) {
      // An order sold before Revision 13 being replaced: its heads (no product) are free for any chicken of the same kind.
      const available = (inRef[want.kind][want.productId] ?? 0) + (released.ref?.get(k) ?? 0) + (released.ref?.get(refKey(want.kind, null)) ?? 0);
      if (want.heads > available) problems.push(`Insufficient stock. Only ${available} ${available === 1 ? 'head' : 'heads'} of ${REF_LABELS[want.kind]} (${want.product}) ${available === 1 ? 'is' : 'are'} in the ref.`);
    }
  }
  for (const [id, want] of demand.chicken) {
    const rec = ensureRecord(db, day, 'CHICKEN', id, now);
    const available = computeRow('CHICKEN', parts(rec), (sold.chicken.get(id) ?? 0) - (released.chicken.get(id) ?? 0)).new_total;
    if (want.heads * 1000 > available) problems.push(insufficientStockMessage('CHICKEN', want.name, 'heads', available));
  }
  for (const [id, want] of demand.other) {
    const rec = ensureRecord(db, day, 'OTHER', id, now);
    const available = computeRow('OTHER', parts(rec), (sold.other.get(id) ?? 0) - (released.other.get(id) ?? 0)).new_total;
    if (want.milli > available) problems.push(insufficientStockMessage('OTHER', want.name, want.unit, available));
  }
  if (problems.length === 1) throw new HttpError(409, problems[0], 'INSUFFICIENT_STOCK');
  if (problems.length > 1) throw new HttpError(409, 'There is not enough stock for some items.', 'INSUFFICIENT_STOCK', problems);
}

/**
 * A chicken order is canceled and the cashier said the chicken cannot go back into stock (it was burned or dressed). The heads stop
 * counting as Sold, so they are added to Reject on the same record and the New Total does not rise. Only for an order of the
 * open business day: a closed day is never changed. Other products always go back into stock. Call inside tx(), after the status change.
 */
export function rejectCanceledChicken(db, user, order, now) {
  const day = openDay(db);
  if (!day || order.business_day_id !== day.id) return;
  for (const r of db.prepare('SELECT product_id AS id, SUM(heads) AS n FROM order_items WHERE order_id = ? GROUP BY product_id').all(order.id)) {
    const rec = ensureRecord(db, day, 'CHICKEN', r.id, now);
    const next = rec.reject_milli + r.n * 1000;
    db.prepare('UPDATE inventory_records SET reject_milli = ?, rev = rev + 1, updated_at = ? WHERE id = ?').run(next, now.toISOString(), rec.id);
    db.prepare('INSERT INTO inventory_events (record_id, field, old_milli, new_milli, user_id, created_at, note) VALUES (?,?,?,?,?,?,?)')
      .run(rec.id, 'reject', rec.reject_milli, next, user.id, now.toISOString(), `Canceled ${order.order_number}: the chicken cannot go back into stock`);
  }
}

// ---- Typing numbers in ----------------------------------------------------------------------------

const cleanNote = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);

/**
 * Change the numbers on one record of the open day. body: { rev, beginning?, additional?, reject?, katay?, dead?, pull_out?, reason?, reason_note? }
 * in whole heads / units. Sold is not accepted: it is counted from the orders.
 *
 * The Beginning Balance can be corrected, also when it was carried over from the previous day. Changing a Beginning Balance that
 * already has a number (typed earlier, or carried over, even if that was 0) needs a reason: body.reason is one of INVENTORY_REASONS, and
 * "Other" also needs reason_note. Typing the very first Beginning Balance of a product that has never had one needs no reason. The reason,
 * the old and new number, who and when are saved in the inventory history, which cannot be edited or deleted.
 */
export function updateRecord(db, user, id, body, now = new Date()) {
  if (!canEdit(user)) throw new HttpError(403, 'Only a manager or the admin can change inventory numbers.', 'FORBIDDEN');
  return tx(db, () => {
    const rec = db.prepare('SELECT * FROM inventory_records WHERE id = ?').get(id);
    if (!rec) throw new HttpError(404, 'Inventory record not found.', 'NOT_FOUND');
    const day = db.prepare('SELECT * FROM business_days WHERE id = ?').get(rec.business_day_id);
    if (day.status !== 'OPEN') throw new HttpError(409, `Business day ${day.business_date} is closed. A closed day is history and cannot be changed.`, 'DAY_CLOSED');
    if (!Number.isInteger(body?.rev) || body.rev !== rec.rev) {
      throw new HttpError(409, 'Someone else changed this row while you were looking at it. The latest numbers are shown. Please check them and try again.', 'CONFLICT');
    }
    const fields = Object.keys(FIELD_COLUMN).filter((f) => body[f] !== undefined);
    if (!fields.length) throw new HttpError(400, 'There is nothing to change.', 'VALIDATION');

    const info = rec.kind === 'CHICKEN'
      ? { name: db.prepare('SELECT name FROM products WHERE id = ?').get(rec.product_id).name, unit: 'heads', whole: true }
      : (() => {
        const o = db.prepare('SELECT o.unit, o.sold_by, p.name FROM other_product_options o JOIN other_products p ON p.id = o.product_id WHERE o.id = ?').get(rec.option_id);
        return { name: `${o.name} - ${o.unit}`, unit: o.unit, whole: o.sold_by === 'FIXED' };
      })();
    const before = parts(rec);
    const next = { ...before };
    const errors = [];
    for (const f of fields) {
      if (LOSS_FIELDS.includes(f) && rec.kind !== 'CHICKEN') { errors.push('Other products do not have Reject, Katay, Dead or Pull Out.'); continue; }
      const value = parseCountToMilli(body[f], { whole: info.whole });
      if (value === null) errors.push(`${FIELD_LABEL[f]}: enter ${info.whole ? 'a whole number' : 'a number with up to 3 decimals'}, zero or more.`);
      else next[f] = value;
    }
    if (errors.length) throw new HttpError(400, 'Please fix the numbers and try again.', 'VALIDATION', errors);

    // A correction of the Beginning Balance must say why.
    let reason = null;
    if (next.beginning !== before.beginning && (rec.beginning_carried === 1 || before.beginning > 0)) {
      const code = String(body.reason ?? '');
      if (!INVENTORY_REASONS[code]) throw new HttpError(400, 'Say why the Beginning Balance is being changed. Choose a reason.', 'REASON_REQUIRED');
      const note = cleanNote(body.reason_note);
      if (code === 'OTHER' && note.length < 3) throw new HttpError(400, 'Please explain the reason in the note.', 'REASON_REQUIRED');
      reason = { code, note: note || null };
    }

    const soldNow = soldOf({ ...rec, sold_milli: null }, soldMaps(db, day.id));
    const problems = checkRow(rec.kind, next, soldNow, info.unit);
    if (problems.length) throw new HttpError(400, problems[0], 'INVENTORY_RULE', problems.length > 1 ? problems : undefined);

    // Revision 12: Katay or Dead typed higher goes into the ref when the person says so (to_ref: true). Typed lower, the heads that came
    // into the ref from this row go back out (never more than came in, and never more than is still in the ref).
    if (body.to_ref !== undefined && typeof body.to_ref !== 'boolean') throw new HttpError(400, 'Say whether the chicken went into the ref (yes or no).', 'VALIDATION');
    const refMoves = [];
    if (rec.kind === 'CHICKEN') {
      for (const kind of REF_KINDS) {
        const f = REF_FIELD[kind];
        if (!fields.includes(f) || next[f] === before[f]) continue;
        const diff = (next[f] - before[f]) / 1000;
        if (diff > 0 && body.to_ref === true) refMoves.push({ kind, field: f, heads: diff, source: 'INVENTORY' });
        if (diff < 0) {
          const out = Math.min(-diff, refFromRecord(db, rec.id, kind));
          if (out > 0) {
            const inRef = refByProduct(db)[kind][rec.product_id] ?? 0;   // Revision 13: this chicken's part of the ref
            if (out > inRef) {
              throw new HttpError(409, `${out} ${out === 1 ? 'head' : 'heads'} of this ${FIELD_LABEL[f]} ${out === 1 ? 'was' : 'were'} put in the ref, but only ${inRef} ${REF_LABELS[kind]} ${inRef === 1 ? 'is' : 'are'} still in the ref (the rest were sold). ${FIELD_LABEL[f]} cannot go that low.`, 'REF_SOLD');
            }
            refMoves.push({ kind, field: f, heads: -out, source: 'CORRECTION' });
          }
        }
      }
    }

    const changed = fields.filter((f) => next[f] !== before[f]);
    const eventOf = {};
    if (changed.length) {
      const set = changed.map((f) => `${FIELD_COLUMN[f]} = ?`).join(', ');
      db.prepare(`UPDATE inventory_records SET ${set}, rev = rev + 1, updated_at = ? WHERE id = ?`).run(...changed.map((f) => next[f]), now.toISOString(), id);
      const log = db.prepare('INSERT INTO inventory_events (record_id, field, old_milli, new_milli, user_id, created_at, note, reason_code, reason_note) VALUES (?,?,?,?,?,?,?,?,?)');
      for (const f of changed) {
        const why = f === 'beginning' ? reason : null;
        const move = refMoves.find((m) => m.field === f);
        const refNote = move ? (move.heads > 0 ? ` (into the ref: ${move.heads})` : ` (out of the ref: ${-move.heads})`) : '';
        eventOf[f] = Number(log.run(id, f, before[f], next[f], user.id, now.toISOString(), `${info.name}: ${FIELD_LABEL[f]} ${formatQty(before[f])} to ${formatQty(next[f])}${refNote}`, why?.code ?? null, why?.note ?? null).lastInsertRowid);
      }
    }
    for (const m of refMoves) {
      addRefEntry(db, {
        kind: m.kind, heads: m.heads, source: m.source, productId: rec.product_id, recordId: rec.id, eventId: eventOf[m.field], dayId: day.id, userId: user.id, now,
        note: m.source === 'CORRECTION' ? `${info.name}: ${FIELD_LABEL[m.field]} lowered on the Daily Inventory` : `${info.name}: ${FIELD_LABEL[m.field]} typed on the Daily Inventory`,
      });
    }
    const rows = rowsFor(db, day);
    return {
      row: [...rows.chicken, ...rows.other].find((r) => r.id === id), changed: changed.length > 0,
      ref_moves: refMoves.map((m) => ({ kind: m.kind, heads: m.heads })), ref_heads: refMoves.length ? refBalance(db) : undefined,
    };
  });
}

/**
 * Store a Katay or Dead chicken in the ref (Revision 12, the Advanced button of the New order screen). body: { kind: KATAY | DEAD,
 * product_id (the chicken it is), heads, weight (kg, all the heads together), note? }. In ONE transaction:
 *   * the heads are added to that chicken's Katay or Dead on the open business day (the Daily Inventory), with the same rule as typing it
 *     there: Reject + Katay + Dead + Pull Out may not be more than what is Left
 *   * the heads (and their weight) go into the ref
 * Anyone signed in may do it (the cashier is the one at the ref); who did it and when is kept in both histories.
 */
export function storeInRef(db, user, body, now = new Date()) {
  const kind = String(body?.kind ?? '');
  const errors = [];
  if (!REF_KINDS.includes(kind)) errors.push('Choose Katay or Dead.');
  const heads = parseHeads(body?.heads);
  if (heads === null) errors.push('The number of heads must be a whole number from 1 to 999.');
  const weightG = parseWeightToGrams(body?.weight);
  if (weightG === null) errors.push('Enter the weight in kg: above 0, with up to 3 decimals.');
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(body?.product_id));
  if (!product) errors.push('Choose which chicken it is.');
  if (errors.length) throw new HttpError(400, errors[0], 'VALIDATION', errors.length > 1 ? errors : undefined);
  const note = cleanNote(body?.note);
  prepareOpenDay(db, now, user);
  return tx(db, () => {
    const day = openDay(db);
    const rec = ensureRecord(db, day, 'CHICKEN', product.id, now);
    const field = REF_FIELD[kind];
    const before = parts(rec);
    const next = { ...before, [field]: before[field] + heads * 1000 };
    const soldNow = soldOf({ ...rec, sold_milli: null }, soldMaps(db, day.id));
    const problems = checkRow('CHICKEN', next, soldNow, 'heads');
    if (problems.length) {
      const left = Math.max(computeRow('CHICKEN', before, soldNow).new_total, 0) / 1000;
      throw new HttpError(409, `${product.name}: only ${left} ${left === 1 ? 'head is' : 'heads are'} left on today's Daily Inventory, so ${heads} cannot be counted as ${FIELD_LABEL[field]}. Check the number, or ask a manager to fix the Daily Inventory first.`, 'INVENTORY_RULE', problems);
    }
    db.prepare(`UPDATE inventory_records SET ${FIELD_COLUMN[field]} = ?, rev = rev + 1, updated_at = ? WHERE id = ?`).run(next[field], now.toISOString(), rec.id);
    const eventId = Number(db.prepare('INSERT INTO inventory_events (record_id, field, old_milli, new_milli, user_id, created_at, note) VALUES (?,?,?,?,?,?,?)')
      .run(rec.id, field, before[field], next[field], user.id, now.toISOString(), `${product.name}: ${FIELD_LABEL[field]} ${formatQty(before[field])} to ${formatQty(next[field])} (stored in the ref from New order, ${formatKg(weightG)} kg)`).lastInsertRowid);
    addRefEntry(db, { kind, heads, weightG, source: 'ADVANCED', productId: product.id, recordId: rec.id, eventId, dayId: day.id, userId: user.id, now, note: note || null });
    return {
      stored: { kind, name: REF_LABELS[kind], heads, weight_g: weightG, product: product.name },
      inventory: { product: product.name, field: FIELD_LABEL[field], was: before[field] / 1000, now: next[field] / 1000, business_date: day.business_date },
      ref: refSummary(db),
    };
  });
}

// ---- Submit Inventory Today: what was submitted, and is it still current? ------------------------------

/** Where the submitted inventory files are kept: config.inventoryDir, else backups/inventory (a temporary folder for a test database). */
export function inventoryDir(config = {}) {
  if (config.inventoryDir) return path.resolve(config.inventoryDir);
  if (!config.dbPath || config.dbPath === ':memory:') return path.join(os.tmpdir(), `chicken-pos-inventory-${process.pid}`);
  return path.resolve('backups', 'inventory');
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** Every number of a day (every row, zero rows included), as one hash. Two different sets of numbers never give the same fingerprint. */
export function dayFingerprint(db, day) {
  const rows = rowsFor(db, day);
  const all = [...rows.chicken, ...rows.other].map((r) => [r.kind, r.item_id, r.beginning, r.additional, r.sold, r.reject, r.katay, r.dead, r.pull_out]);
  all.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  return sha256(JSON.stringify(all));
}

const latestSubmission = (db, dayId) => db.prepare(`SELECT s.*, u.display_name AS by_name FROM inventory_submissions s JOIN users u ON u.id = s.submitted_by
                                                    WHERE s.business_day_id = ? ORDER BY s.id DESC LIMIT 1`).get(dayId) ?? null;

/** Is the saved file still there, byte for byte as it was submitted? */
export function submissionFileOk(submission, dir) {
  try { return sha256(fs.readFileSync(path.join(dir, submission.file_name))) === submission.file_sha256; } catch { return false; }
}

function submissionStatus(db, day) {
  const s = latestSubmission(db, day.id);
  if (!s) return { latest: null, current: false };
  return {
    latest: { id: s.id, file_name: s.file_name, submitted_at: s.submitted_at, by: s.by_name },
    // While the day is open, the numbers may have changed since (a new sale, a typed correction). A closed day cannot change.
    current: day.status === 'CLOSED' || s.fingerprint === dayFingerprint(db, day),
  };
}

// ---- Closing the day ("Closed Inventory Today and Reset the Day") ------------------------------------------

/**
 * Why the day can or cannot be closed right now, and what the shop should know before it is. Read-only.
 * submitting: the closing also submits the inventory in the same step (Revision 12), so "submit first / submit again" does not apply.
 */
function inspect(db, day, now = new Date(), { dir = null, submitting = false } = {}) {
  const sale = `status IN (${MARKS})`;
  const ongoing = db.prepare(`SELECT order_number FROM orders WHERE fulfillment_status = 'ONGOING' AND ${sale} ORDER BY id`).all(...COUNTS_AS_SALE).map((o) => o.order_number);
  const standby = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE fulfillment_status = 'STANDBY' AND ${sale}`).get(...COUNTS_AS_SALE).n;
  const complete = db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE fulfillment_status = 'COMPLETE' AND business_day_id = ? AND ${sale}`).get(day.id, ...COUNTS_AS_SALE).n;
  const rows = rowsFor(db, day);
  const negative = [...rows.chicken, ...rows.other].filter((r) => r.new_total < 0).map((r) => r.name);
  const blockers = [];
  const notices = [];
  if (ongoing.length) {
    blockers.push({
      code: 'ONGOING_ORDERS', count: ongoing.length, orders: ongoing.slice(0, 10),
      message: `${ongoing.length} order${ongoing.length === 1 ? ' is' : 's are'} still Ongoing (being prepared): ${ongoing.slice(0, 10).join(', ')}${ongoing.length > 10 ? ' and more' : ''}. `
        + 'An order that is still being prepared can still be canceled or changed, which would change today\'s sold numbers after the day is closed. Move each one to Standby or Complete on the Order List (or cancel it), then try again.',
    });
  }
  if (negative.length) {
    blockers.push({
      code: 'NEGATIVE_BALANCE', items: negative,
      message: `The New Total is below zero for ${negative.join(', ')}. Sold is more than Beginning Balance plus Additional, so the count is wrong. Fix the numbers on the Daily Inventory screen, then try again.`,
    });
  }
  // The business date may never run ahead of the real date: a day can be closed on its own date or later, not before.
  const today = toBusinessDate(now);
  if (day.business_date > today) {
    blockers.push({
      code: 'NOT_STARTED',
      message: `Business day ${day.business_date} has not started yet (today is ${today}). It can be closed on ${day.business_date} or later. This stops the business date from running ahead of the real date when the day is closed twice.`,
    });
  }
  // The day's inventory must have been submitted, and the submitted file must still hold the day's numbers.
  const s = submitting ? null : latestSubmission(db, day.id);
  if (submitting) {
    // nothing to check: the inventory is submitted with the numbers it has at the moment of closing
  } else if (!s) {
    blockers.push({ code: 'SUBMIT_FIRST', message: 'Press "Submit Inventory Today" first. It saves today\'s inventory file on this computer and downloads a copy; then the day can be closed.' });
  } else if (s.fingerprint !== dayFingerprint(db, day)) {
    blockers.push({
      code: 'SUBMIT_AGAIN',
      message: `The inventory changed after it was submitted at ${toPhtDateTime(s.submitted_at).slice(11)} (an order, a cancellation or a typed number). Press "Submit Inventory Today" again so the saved file holds the final numbers.`,
    });
  } else if (dir && !submissionFileOk(s, dir)) {
    blockers.push({ code: 'SUBMISSION_FILE', message: `The submitted inventory file (${s.file_name}) is missing or was changed on this computer. Press "Submit Inventory Today" again.` });
  }
  if (standby) {
    notices.push({
      code: 'STANDBY_ORDERS', count: standby,
      message: `${standby} order${standby === 1 ? ' is' : 's are'} on Standby (ready for pickup). ${standby === 1 ? 'It was' : 'They were'} counted as sold on this business day and `
        + `${standby === 1 ? 'stays' : 'stay'} on the Order List, so ${standby === 1 ? 'it carries' : 'they carry'} over safely. If one is canceled later, add its chicken back with Additional on the day it comes back.`,
    });
  }
  if (complete) {
    notices.push({
      code: 'COMPLETE_ORDERS', count: complete,
      message: `${complete} Complete order${complete === 1 ? '' : 's'} will leave the Order List and the Orders tab's list of today's orders. ${complete === 1 ? 'It stays' : 'They stay'} saved: choose "All saved orders" on the Orders tab, or any report, to see ${complete === 1 ? 'it' : 'them'}. Nothing is deleted.`,
    });
  }
  // Revision 12: a reminder only. The cash breakdown is typed in New order > Advanced and goes on the Daily Report.
  if (!db.prepare('SELECT 1 FROM cash_counts WHERE business_day_id = ? LIMIT 1').get(day.id)) {
    notices.push({ code: 'NO_CASH_COUNT', message: 'No cash breakdown was saved for this business day. If you want it on the Daily Report, count the cash first in New order > Advanced > Cash breakdown. Once the day is closed it can no longer be added.' });
  }
  return { blockers, notices };
}

export function closeCheck(db, user, now = new Date(), opts = {}) {
  const day = prepareOpenDay(db, now, user);
  const { blockers, notices } = inspect(db, day, now, opts);
  return { business_date: day.business_date, can_close: blockers.length === 0, blockers, notices };
}

/**
 * The closing itself, for a day that has passed every check. Call inside tx(), with the open day.
 *   1. the day's Sold figures are frozen into its records and the day is closed (a closed day is never changed again)
 *   2. the next day is opened (today's date, or the day after when the closed day is already today)
 *   3. every record is carried forward: the next Beginning Balance = this day's New Total; Additional, Reject, Katay, Dead and Pull Out start at 0
 */
export function closeOpenDay(db, user, day, notices, now) {
  const maps = soldMaps(db, day.id);
  const records = db.prepare('SELECT * FROM inventory_records WHERE business_day_id = ?').all(day.id);
  for (const r of records) {
    db.prepare('UPDATE inventory_records SET sold_milli = ?, rev = rev + 1, updated_at = ? WHERE id = ?').run(soldOf({ ...r, sold_milli: null }, maps), now.toISOString(), r.id);
  }
  db.prepare("UPDATE business_days SET status = 'CLOSED', closed_at = ?, closed_by = ? WHERE id = ?").run(now.toISOString(), user?.id ?? null, day.id);

  const fresh = ensureOpenDay(db, now, user?.id ?? null);
  for (const r of records) ensureRecord(db, fresh, r.kind, r.kind === 'CHICKEN' ? r.product_id : r.option_id, now);
  materialize(db, fresh, now);
  const standby = notices.find((n) => n.code === 'STANDBY_ORDERS');
  const complete = notices.find((n) => n.code === 'COMPLETE_ORDERS');
  return {
    closed: shapeDay(db, db.prepare('SELECT * FROM business_days WHERE id = ?').get(day.id), now), opened: shapeDay(db, fresh, now),
    standby_orders: standby?.count ?? 0, complete_orders_cleared: complete?.count ?? 0, records_carried: records.length,
  };
}

// ---- Save, and the automatic close at midnight (Revision 13) ---------------------------------------------------------

/** The numbers of one row as kept in a save. */
const saveRow = (r) => ({
  kind: r.kind, item_id: r.item_id, name: r.name, unit: r.unit, beginning: r.beginning, additional: r.additional, total: r.total, sold: r.sold, left: r.left,
  ...(r.kind === 'CHICKEN' ? { reject: r.reject, katay: r.katay, dead: r.dead, pull_out: r.pull_out } : {}), new_total: r.new_total,
});

/** Write the day's one save row (a new one, or replacing the earlier save of the same day). Call inside tx(), on the open day. */
function writeSave(db, day, userId, how, now) {
  const rows = rowsFor(db, day);
  const snapshot = { chicken: rows.chicken.map(saveRow), other: rows.other.map(saveRow), edits: beginningEdits(db, day.id) };
  db.prepare(`INSERT INTO inventory_saves (business_day_id, saved_at, saved_by, how, fingerprint, snapshot) VALUES (?,?,?,?,?,?)
              ON CONFLICT(business_day_id) DO UPDATE SET saved_at = excluded.saved_at, saved_by = excluded.saved_by, how = excluded.how,
                fingerprint = excluded.fingerprint, snapshot = excluded.snapshot`)
    .run(day.id, now.toISOString(), userId, how, dayFingerprint(db, day), JSON.stringify(snapshot));
}

/** The save of a day for the screen: when, by whom, and whether the numbers changed since. Null when the day was never saved. */
export function saveStatus(db, day) {
  const s = db.prepare('SELECT s.*, u.display_name AS by_name FROM inventory_saves s LEFT JOIN users u ON u.id = s.saved_by WHERE s.business_day_id = ?').get(day.id);
  if (!s) return null;
  return {
    saved_at: s.saved_at, by: s.by_name ?? null, how: s.how,
    current: day.status === 'CLOSED' || s.fingerprint === dayFingerprint(db, day),
  };
}

/** The "Save" button: keep the open day's numbers in the database, one row per day (saving again replaces it). Manager and admin. */
export function saveDay(db, user, now = new Date()) {
  if (!canEdit(user)) throw new HttpError(403, 'Only a manager or the admin can save the inventory.', 'FORBIDDEN');
  prepareOpenDay(db, now, user);
  return tx(db, () => {
    const day = ensureOpenDay(db, now, user.id);
    materialize(db, day, now);
    writeSave(db, day, user.id, 'MANUAL', now);
    return { business_date: day.business_date, saved: saveStatus(db, day) };
  });
}

/** The saved numbers of one business day (the open day's latest save, or a closed day's final save). */
export function savedDay(db, date) {
  const day = db.prepare('SELECT * FROM business_days WHERE business_date = ?').get(String(date ?? ''));
  if (!day) throw new HttpError(404, 'There is no business day for that date.', 'NOT_FOUND');
  const s = db.prepare('SELECT s.*, u.display_name AS by_name FROM inventory_saves s LEFT JOIN users u ON u.id = s.saved_by WHERE s.business_day_id = ?').get(day.id);
  if (!s) throw new HttpError(404, `Business day ${day.business_date} was never saved.`, 'NOT_FOUND');
  return { business_date: day.business_date, status: day.status, saved_at: s.saved_at, by: s.by_name ?? null, how: s.how, ...JSON.parse(s.snapshot) };
}

/**
 * The midnight close. The open day's date has passed, so it is saved one last time (how AUTO_CLOSE) and closed, and today is opened with
 * every New Total carried forward as the Beginning Balance. Nothing can stop it: an Ongoing order stays on the Order List (like a Standby
 * one) and a New Total below zero starts the next day at 0. If the app was off for some days, it closes the old day once and opens today.
 * Call inside tx().
 */
function autoClose(db, day, now) {
  materialize(db, day, now);
  writeSave(db, day, null, 'AUTO_CLOSE', now);
  return closeOpenDay(db, null, day, [], now);
}

/** Close the open day if midnight has passed. Safe to call any time (the server calls it every minute). Returns the closed date or null. */
export function autoCloseIfDue(db, now = new Date()) {
  const day = openDay(db);
  if (!day || day.business_date >= toBusinessDate(now)) return null;
  tx(db, () => ensureOpenDay(db, now));
  return day.business_date;
}

/**
 * The open day that is about to be closed: the one the person is looking at (body.business_date), with every record in place and every
 * check passed. Call inside tx(). Throws (changing nothing) when the date is wrong or something blocks the closing.
 */
export function dayToClose(db, user, body, now, opts = {}) {
  const day = ensureOpenDay(db, now, user.id);
  const wanted = String(body?.business_date ?? '');
  if (wanted !== day.business_date) {
    const closed = db.prepare("SELECT * FROM business_days WHERE business_date = ? AND status = 'CLOSED'").get(wanted);
    if (closed) throw new HttpError(409, `Business day ${wanted} was already closed. Nothing was changed.`, 'ALREADY_CLOSED');
    throw new HttpError(400, 'Say which business day is being closed.', 'VALIDATION');
  }
  materialize(db, day, now);
  const { blockers, notices } = inspect(db, day, now, opts);
  if (blockers.length) throw new HttpError(409, blockers[0].message, blockers[0].code, blockers.map((b) => b.message));
  return { day, notices };
}

/**
 * Close the open business day and open the next one, in ONE transaction: all of it happens or none of it does.
 *   0. the day must be submitted ("Submit Inventory Today") with the numbers it has now, and its saved file must still be intact
 *   1. the day's Sold figures are frozen into its records and the day is closed (a closed day is never changed again)
 *   2. the next day is opened (today's date, or the day after when the closed day is already today)
 *   3. every record is carried forward: the next Beginning Balance = this day's New Total; Additional, Reject, Katay, Dead and Pull Out start at 0
 * body.business_date must be the day the person is looking at, so a second click (or a second person) cannot close the new day by accident.
 * Nothing is deleted: Complete orders only stop being shown on the Order List and the Orders tab's list of today's orders.
 */
export function startNewDay(db, user, body, now = new Date(), opts = {}) {
  if (!canEdit(user)) throw new HttpError(403, 'Only a manager or the admin can close the inventory and start a new business day.', 'FORBIDDEN');
  return tx(db, () => {
    const { day, notices } = dayToClose(db, user, body, now, opts);
    return closeOpenDay(db, user, day, notices, now);
  });
}

// ---- For the report -------------------------------------------------------------------------------

/** Every Beginning Balance correction made on a day (the ones with a reason), oldest first. For the exports. */
export function beginningEdits(db, dayId) {
  return db.prepare(`
    SELECT e.old_milli, e.new_milli, e.reason_code, e.reason_note, e.created_at, u.display_name AS by_name,
           r.kind, p.name AS chicken_name, op.name AS other_name, o.unit AS unit
    FROM inventory_events e
    JOIN inventory_records r ON r.id = e.record_id
    JOIN users u ON u.id = e.user_id
    LEFT JOIN products p ON p.id = r.product_id
    LEFT JOIN other_product_options o ON o.id = r.option_id
    LEFT JOIN other_products op ON op.id = o.product_id
    WHERE r.business_day_id = ? AND e.field = 'beginning' AND e.reason_code IS NOT NULL
    ORDER BY e.id`).all(dayId).map((e) => ({
    name: e.kind === 'CHICKEN' ? e.chicken_name : `${e.other_name} - ${e.unit}`, was: e.old_milli, now: e.new_milli,
    reason: INVENTORY_REASONS[e.reason_code] ?? e.reason_code, note: e.reason_note ?? '', by: e.by_name, at: e.created_at,
  }));
}

/** One business day with all of its rows (zero rows included; the caller decides what to leave out), by date. Used by the reports. */
export function dayWithRows(db, date, now = new Date()) {
  prepareOpenDay(db, now);
  const day = db.prepare('SELECT * FROM business_days WHERE business_date = ?').get(String(date));
  if (!day) throw new HttpError(404, 'There is no business day for that date.', 'NOT_FOUND');
  return { day: shapeDay(db, day, now), raw: day, ...rowsFor(db, day), edits: beginningEdits(db, day.id) };
}

/** Record a submission. Called by the Submit Inventory Today service inside its transaction, after the file is saved and checked. */
export function insertSubmission(db, { day, user, fileName, fileSha, fingerprint, snapshot, now }) {
  const id = Number(db.prepare(`INSERT INTO inventory_submissions (business_day_id, submitted_at, submitted_by, file_name, file_sha256, fingerprint, snapshot)
                                VALUES (?,?,?,?,?,?,?)`).run(day.id, now.toISOString(), user.id, fileName, fileSha, fingerprint, JSON.stringify(snapshot)).lastInsertRowid);
  return db.prepare('SELECT * FROM inventory_submissions WHERE id = ?').get(id);
}

export { canEdit as canEditInventory, rowsFor as inventoryRows, sha256, shapeDay };
