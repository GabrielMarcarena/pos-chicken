// Clear the shop's records (orders, price history and closed inventory days) while keeping the setup (users, products, current prices, fees)
// and the OPEN business day with the stock numbers typed on it (Revision 9).
//
// The database refuses to delete submitted orders, lines, payments and audit events, on purpose, so the app itself can
// never lose a sale. This module is the one deliberate exception, used only by `npm run clear-records` (never by a web
// screen). To stay safe it:
//   * does everything in ONE transaction: either all of it happens or none of it,
//   * takes the protections (triggers) out, deletes, and puts back the very same protection text it took out,
//   * checks before it commits that the protections are identical to before, and that nothing is left dangling.
// If anything is wrong the transaction is rolled back and the database is exactly as it was.

import { tx } from './db.js';

// Children first, so no row is ever deleted while another row still points at it.
const ORDER_TABLES = ['order_events', 'payments', 'order_ref_items', 'order_other_items', 'order_items', 'orders'];
// Revision 9: the closed days of the Daily Inventory are history made from the same orders, so they go with them. They are protected by
// triggers too. The OPEN day stays: it holds the Beginning Balances the shop typed in, which are stock, not examples.
// Revision 11: the submitted inventories ("Submit Inventory Today") of the closed days go with them (their files on disk are left alone).
// The open day keeps its submissions; its numbers change when its orders go, so it has to be submitted again before it can be closed.
// Revision 12: the ref stock entries, cash counts and expenses of the closed days go with them too; the open day keeps its own.
// Revision 13: and the saved inventory ("Save", and the final save made at midnight) of the closed days.
const DAY_TABLES = ['ref_stock_entries', 'cash_counts', 'expenses', 'inventory_saves'];
const INVENTORY_TABLES = [...DAY_TABLES, 'inventory_submissions', 'inventory_events', 'inventory_records', 'business_days'];
const PROTECTED_TABLES = [...ORDER_TABLES, ...INVENTORY_TABLES];
const closedRecords = "SELECT r.id FROM inventory_records r JOIN business_days d ON d.id = r.business_day_id WHERE d.status = 'CLOSED'";

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/** What would be deleted. */
export function countRecords(db) {
  return {
    orders: count(db, 'orders'),
    lines: count(db, 'order_items') + count(db, 'order_other_items') + count(db, 'order_ref_items'),
    payments: count(db, 'payments'),
    history: count(db, 'order_events'),
    priceChanges: count(db, 'price_history'),
    inventoryDays: db.prepare("SELECT COUNT(*) AS n FROM business_days WHERE status = 'CLOSED'").get().n,
    inventoryRecords: db.prepare(`SELECT COUNT(*) AS n FROM (${closedRecords})`).get().n,
  };
}

/** What stays. */
export function countKept(db) {
  return {
    users: db.prepare('SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL').get().n,
    chickenProducts: count(db, 'products'),
    otherProducts: count(db, 'other_products'),
    serviceFees: count(db, 'service_fees'),
    openDays: db.prepare("SELECT COUNT(*) AS n FROM business_days WHERE status = 'OPEN'").get().n,
  };
}

const protections = (db) => db.prepare(
  `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${PROTECTED_TABLES.map(() => '?').join(',')}) ORDER BY name`,
).all(...PROTECTED_TABLES).map((t) => ({ name: t.name, table: t.tbl_name, sql: t.sql }));

/**
 * Delete every order (with its lines, payments and history), restart the order numbers, and, unless told to keep it,
 * the price history. Returns what was deleted. Throws (and changes nothing) if anything does not check out.
 */
export function clearRecords(db, { keepPriceHistory = false } = {}) {
  const deleted = countRecords(db);
  tx(db, () => {
    const before = protections(db);
    for (const t of before) db.exec(`DROP TRIGGER "${t.name.replaceAll('"', '""')}"`);

    for (const table of ORDER_TABLES) db.exec(`DELETE FROM ${table}`);
    db.exec('DELETE FROM order_counters');
    // Closed inventory days (and their audit rows) go; the open day stays and its Beginning Balances become typed-in numbers again,
    // because the day they were carried from is gone.
    for (const table of DAY_TABLES) db.exec(`DELETE FROM ${table} WHERE business_day_id IN (SELECT id FROM business_days WHERE status = 'CLOSED')`);
    db.exec("DELETE FROM inventory_submissions WHERE business_day_id IN (SELECT id FROM business_days WHERE status = 'CLOSED')");
    db.exec(`DELETE FROM inventory_events WHERE record_id IN (${closedRecords})`);
    db.exec(`DELETE FROM inventory_records WHERE id IN (${closedRecords})`);
    db.exec("DELETE FROM business_days WHERE status = 'CLOSED'");
    db.exec('UPDATE inventory_records SET beginning_carried = 0');
    const cleared = [...ORDER_TABLES];
    if (!keepPriceHistory) { db.exec('DELETE FROM price_history'); cleared.push('price_history'); }
    // Numbering (ids) starts again from 1 for the tables that were emptied.
    db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${cleared.map(() => '?').join(',')})`).run(...cleared);

    for (const t of before) db.exec(t.sql);

    // Proof, before anything is saved.
    const after = protections(db);
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('The database protections could not be put back exactly as they were, so nothing was changed.');
    const dangling = db.prepare('PRAGMA foreign_key_check').all();
    if (dangling.length) throw new Error('Some records still point at deleted orders, so nothing was changed.');
    const left = countRecords(db);
    if (left.orders || left.lines || left.payments || left.history || left.inventoryDays || left.inventoryRecords || (!keepPriceHistory && left.priceChanges)) {
      throw new Error('Some records were not removed, so nothing was changed.');
    }
  });
  return deleted;
}
