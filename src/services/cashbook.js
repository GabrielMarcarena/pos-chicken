// Cash breakdown and expenses (Revision 12, New order > Advanced). Both belong to a business day and both go on the Daily Report.
//
//   Cash breakdown  how many of each bill and coin are in the drawer (₱1,000 down to 25 centavos). Saving again adds a new count; the
//                   latest one is the count of the day. The Daily Report shows it under CASH BREAKDOWN and works out EXCESS/LOSS:
//                     expected cash = what was paid in cash (or with no payment recorded) on the day's sold orders, minus refunds,
//                                     minus the day's expenses
//                     excess / loss = cash counted - expected cash
//   Expenses        what was paid out of the drawer during the day (Coke 75, Bread 35, Meal 200). A mistake is removed, not deleted:
//                   it stays in the history with who removed it, and it no longer counts.
//
// Only the OPEN business day can be counted or given expenses; a closed day is history (the database refuses it too).
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { ROLE_RANK } from './users.js';
import { prepareOpenDay } from './inventory.js';
import { parsePesosToCentavos } from '../../shared/money.js';
import { CASH_DENOMINATIONS, MAX_CASH_PIECES, COUNTS_AS_SALE, cashCountTotal } from '../../shared/constants.js';

const MARKS = COUNTS_AS_SALE.map(() => '?').join(',');
const MAX_EXPENSE_CENTAVOS = 100_000_000;   // ₱1,000,000 for one line: anything bigger is a typing mistake
const cleanText = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const dayById = (db, id) => db.prepare('SELECT * FROM business_days WHERE id = ?').get(id);
function dayByDate(db, date) {
  const day = db.prepare('SELECT * FROM business_days WHERE business_date = ?').get(String(date));
  if (!day) throw new HttpError(404, 'There is no business day for that date.', 'NOT_FOUND');
  return day;
}

// ---- Expected cash (for EXCESS/LOSS) -----------------------------------------------------------------------------------

/**
 * Money the drawer should hold for a business day, before expenses: the sold orders paid in cash or with no payment recorded, after
 * discount, minus their refunds. GCash, Maya, bank and other payments never reach the drawer. cashierId limits it to one cashier's orders.
 */
export function cashSales(db, dayId, cashierId = null) {
  const rows = db.prepare(`SELECT o.total_centavos AS total, o.refund_centavos AS refund,
                                  (SELECT p.method FROM payments p WHERE p.order_id = o.id ORDER BY p.id LIMIT 1) AS method
                           FROM orders o WHERE o.business_day_id = ? AND o.status IN (${MARKS}) ${cashierId ? 'AND o.cashier_id = ?' : ''}`)
    .all(dayId, ...COUNTS_AS_SALE, ...(cashierId ? [cashierId] : []));
  let cash = 0;
  let nonCash = 0;
  for (const r of rows) {
    if (!r.method || r.method === 'CASH') cash += r.total - r.refund; else nonCash += r.total - r.refund;
  }
  return { cash, non_cash: nonCash };
}

// ---- Expenses ------------------------------------------------------------------------------------------------------

const shapeExpense = (e) => ({
  id: e.id, item: e.item, amount_centavos: e.amount_centavos, by: e.by_name, created_at: e.created_at,
  removed: e.removed_at !== null, removed_at: e.removed_at, removed_by: e.removed_by_name ?? null, remove_note: e.remove_note ?? '',
});

/** The expenses of a business day, oldest first (removed ones included, marked). cashierId limits them to what one person typed. */
export function expensesOf(db, dayId, { cashierId = null, includeRemoved = true } = {}) {
  return db.prepare(`SELECT e.*, u.display_name AS by_name, r.display_name AS removed_by_name FROM expenses e
                     JOIN users u ON u.id = e.created_by LEFT JOIN users r ON r.id = e.removed_by
                     WHERE e.business_day_id = ? ${cashierId ? 'AND e.created_by = ?' : ''} ${includeRemoved ? '' : 'AND e.removed_at IS NULL'}
                     ORDER BY e.id`).all(dayId, ...(cashierId ? [cashierId] : [])).map(shapeExpense);
}

const expenseTotal = (list) => list.filter((e) => !e.removed).reduce((s, e) => s + e.amount_centavos, 0);

/**
 * Add one or more expenses to the open business day. body: { items: [{ item: 'Coke', amount: '75' }, ...] }. Every line must have a name
 * and an amount above ₱0; if one line is wrong, nothing is saved and the problems are listed.
 */
export function addExpenses(db, user, body, now = new Date()) {
  const items = Array.isArray(body?.items) ? body.items : [];
  if (!items.length) throw new HttpError(400, 'Type at least one expense: what it was for and how much.', 'VALIDATION');
  if (items.length > 50) throw new HttpError(400, 'Save at most 50 expenses at a time.', 'VALIDATION');
  const errors = [];
  const clean = items.map((it, i) => {
    const item = cleanText(it?.item, 80);
    const amount = parsePesosToCentavos(it?.amount);
    if (!item) errors.push(`Line ${i + 1}: say what the expense was for (for example Coke).`);
    if (amount === null || amount <= 0) errors.push(`Line ${i + 1}: enter an amount above ₱0.00 (for example 75).`);
    else if (amount > MAX_EXPENSE_CENTAVOS) errors.push(`Line ${i + 1}: that amount is too large for one expense. Check the number.`);
    return { item, amount };
  });
  if (errors.length) throw new HttpError(400, 'Please fix the expenses and try again.', 'VALIDATION', errors);
  prepareOpenDay(db, now, user);
  return tx(db, () => {
    const day = db.prepare("SELECT * FROM business_days WHERE status = 'OPEN'").get();
    const insert = db.prepare('INSERT INTO expenses (business_day_id, item, amount_centavos, created_by, created_at) VALUES (?,?,?,?,?)');
    for (const e of clean) insert.run(day.id, e.item, e.amount, user.id, now.toISOString());
    return dayMoney(db, user, {}, now, day);
  });
}

/**
 * Remove an expense typed by mistake (open business day only). A cashier can remove only what they typed; a manager or the admin any.
 * The expense stays in the history, marked removed, with who removed it and the note.
 */
export function removeExpense(db, user, id, body, now = new Date()) {
  return tx(db, () => {
    const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
    if (!e) throw new HttpError(404, 'That expense does not exist.', 'NOT_FOUND');
    const day = dayById(db, e.business_day_id);
    if (day.status !== 'OPEN') throw new HttpError(409, `Business day ${day.business_date} is closed. Its expenses are history and cannot be changed.`, 'DAY_CLOSED');
    if (e.removed_at) throw new HttpError(409, 'That expense was already removed.', 'ALREADY_REMOVED');
    if (e.created_by !== user.id && ROLE_RANK[user.role] < ROLE_RANK.manager) throw new HttpError(403, 'A cashier can only remove an expense they typed. Ask a manager.', 'FORBIDDEN');
    db.prepare('UPDATE expenses SET removed_at = ?, removed_by = ?, remove_note = ? WHERE id = ?').run(now.toISOString(), user.id, cleanText(body?.note, 200) || null, id);
    return dayMoney(db, user, {}, now, day);
  });
}

// ---- Cash breakdown ------------------------------------------------------------------------------------------------

/** The latest saved count of a day: { counts, total_centavos, by, counted_at }, or null. cashierId limits it to one person's counts. */
export function latestCashCount(db, dayId, cashierId = null) {
  const c = db.prepare(`SELECT c.*, u.display_name AS by_name FROM cash_counts c JOIN users u ON u.id = c.counted_by
                        WHERE c.business_day_id = ? ${cashierId ? 'AND c.counted_by = ?' : ''} ORDER BY c.id DESC LIMIT 1`).get(dayId, ...(cashierId ? [cashierId] : []));
  return c ? { id: c.id, counts: JSON.parse(c.counts), total_centavos: c.total_centavos, by: c.by_name, counted_at: c.counted_at } : null;
}

/** Save a cash count for the open business day. body: { counts: { '1000': '3', '500': '2', ..., '0.25': '8' } } (pieces; blank = 0). */
export function saveCashCount(db, user, body, now = new Date()) {
  const given = body?.counts && typeof body.counts === 'object' ? body.counts : null;
  if (!given) throw new HttpError(400, 'Type how many of each bill and coin there are.', 'VALIDATION');
  const errors = [];
  const counts = {};
  for (const d of CASH_DENOMINATIONS) {
    const raw = given[d.key];
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    if (text === '') { counts[d.key] = 0; continue; }
    if (!/^\d{1,5}$/.test(text) || Number(text) > MAX_CASH_PIECES) { errors.push(`${d.label}: enter how many pieces, a whole number from 0 to ${MAX_CASH_PIECES}.`); continue; }
    counts[d.key] = Number(text);
  }
  const unknown = Object.keys(given).filter((k) => !CASH_DENOMINATIONS.some((d) => d.key === k));
  if (unknown.length) errors.push(`Unknown bill or coin: ${unknown.join(', ')}.`);
  if (errors.length) throw new HttpError(400, 'Please fix the cash count and try again.', 'VALIDATION', errors);
  prepareOpenDay(db, now, user);
  return tx(db, () => {
    const day = db.prepare("SELECT * FROM business_days WHERE status = 'OPEN'").get();
    db.prepare('INSERT INTO cash_counts (business_day_id, counts, total_centavos, counted_by, counted_at) VALUES (?,?,?,?,?)')
      .run(day.id, JSON.stringify(counts), cashCountTotal(counts), user.id, now.toISOString());
    return dayMoney(db, user, {}, now, day);
  });
}

// ---- What the Advanced screen shows -----------------------------------------------------------------------------------

/**
 * The cash count, the expenses and the expected cash of a business day (the open one unless a date is given), the way the Daily Report
 * will show them for everyone's sales.
 */
export function dayMoney(db, viewer, { date } = {}, now = new Date(), knownDay = null) {
  const day = knownDay ?? (date ? dayByDate(db, date) : prepareOpenDay(db, now, viewer));
  const expenses = expensesOf(db, day.id);
  const expensesTotal = expenseTotal(expenses);
  const sales = cashSales(db, day.id);
  const count = latestCashCount(db, day.id);
  const expected = sales.cash - expensesTotal;
  return {
    business_date: day.business_date, status: day.status, can_edit: day.status === 'OPEN',
    denominations: CASH_DENOMINATIONS,
    cash_count: count,
    expenses, expenses_total_centavos: expensesTotal,
    cash_sales_centavos: sales.cash, non_cash_centavos: sales.non_cash,
    expected_cash_centavos: expected,
    excess_loss_centavos: count ? count.total_centavos - expected : null,
  };
}
