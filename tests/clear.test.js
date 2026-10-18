// Tests for `npm run clear-records`: it removes the example orders and price history and nothing else.
// Every test uses its own temporary database. Nothing here can touch your real data file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { authenticate, createSession, createUser } from '../src/services/users.js';
import { createOtherProduct, createProduct, listPriceHistory, updateFee, updateProduct } from '../src/services/catalog.js';
import { cancelOrder, createOrder, moveOrder } from '../src/services/orders.js';
import { clearRecords, countKept, countRecords, countSessions } from '../src/clearRecords.js';
import { saveCashOnHand } from '../src/services/cashbook.js';
import { getInventory, updateRecord, startNewDay } from '../src/services/inventory.js';
import { submitInventory } from '../src/services/inventoryReport.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-10-12T02:00:00Z');

/** Give every product some stock on the open business day (orders are checked against the Daily Inventory). */
function stockUp(db, user, amount = 100) {
  const inv = getInventory(db, user, {}, NOW);
  for (const row of [...inv.chicken, ...inv.other]) updateRecord(db, user, row.id, { rev: row.rev, beginning: amount }, NOW);
}

function makeShop() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-clear-'));
  const file = path.join(dir, 'pos.db');
  const db = openDb(file);
  const admin = createUser(db, { username: 'gabriel', display_name: 'Gabriel', role: 'admin', password: 'gabriel-pass-1' });
  const manager = createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  const cashier = createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  const cull = createProduct(db, admin, { name: 'Cull Chicken', price: '58' }).id;
  createOtherProduct(db, admin, { name: 'Garlic', options: [{ unit: 'kg', sold_by: 'PER_KG', price: '80' }] });
  updateFee(db, admin, 'POUR', { amount: '45', basis: 'per_item' });
  updateProduct(db, admin, cull, { price: '60' });
  const config = loadConfig({ dbPath: file });
  stockUp(db, manager);
  const order = (n, who = cashier) => createOrder(db, who, {
    submission_key: `clear-test-order-${n}-aaaaaaaa`, customer_number: `C-${n}`,
    items: [{ product_id: cull, weight: '1.5', feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null }], payment: { method: 'CASH', received: '500' },
  }, { config, now: NOW }).order;
  const o1 = order(1), o2 = order(2), o3 = order(3);
  moveOrder(db, cashier, o1.id, 'STANDBY', { now: NOW });
  cancelOrder(db, cashier, o3.id, { reason_code: 'WRONG_WEIGHT' }, { now: NOW });
  createSession(db, admin.id, NOW);
  return { dir, file, db, admin, manager, cashier, cull, config, order, orders: [o1, o2, o3] };
}

const rows = (db, sql) => db.prepare(sql).all();
const triggers = (db) => rows(db, "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
const setup = (db) => ({
  users: rows(db, 'SELECT * FROM users ORDER BY id'),
  sessions: rows(db, 'SELECT * FROM sessions ORDER BY token_hash'),
  products: rows(db, 'SELECT * FROM products ORDER BY id'),
  otherProducts: rows(db, 'SELECT * FROM other_products ORDER BY id'),
  options: rows(db, 'SELECT * FROM other_product_options ORDER BY id'),
  fees: rows(db, 'SELECT * FROM service_fees ORDER BY code'),
});
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function runCli(shop, args, port, env = {}) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/clear-records.js', ...args], {
    cwd: root, encoding: 'utf8', timeout: 60_000, input: '',
    env: { ...process.env, DB_PATH: shop.file, PORT: String(port), ...env },
  });
}

test('clearing removes every order, line, payment, history entry and price change, and nothing else', () => {
  const shop = makeShop();
  const before = countRecords(shop.db);
  assert.equal(before.orders, 3);
  assert.ok(before.lines >= 3 && before.payments >= 3 && before.history >= 5 && before.priceChanges >= 2, JSON.stringify(before));
  const kept = setup(shop.db);
  const keptCounts = countKept(shop.db);

  const deleted = clearRecords(shop.db);
  assert.deepEqual(deleted, before);
  assert.deepEqual(countRecords(shop.db), { orders: 0, lines: 0, payments: 0, history: 0, priceChanges: 0, inventoryDays: 0, inventoryRecords: 0 });
  assert.equal(rows(shop.db, 'SELECT COUNT(*) AS n FROM order_counters')[0].n, 0);

  // users (including the admin and their password and session), products, current prices and fees: byte for byte the same
  assert.deepEqual(setup(shop.db), kept);
  assert.deepEqual(countKept(shop.db), keptCounts);
  assert.equal(keptCounts.users, 3);
  assert.ok(authenticate(shop.db, 'gabriel', 'gabriel-pass-1'), 'the admin can still sign in');
  assert.ok(authenticate(shop.db, 'cash', 'cashier-pass-1'));
  assert.equal(rows(shop.db, 'SELECT role, active, deleted_at FROM users WHERE username = \'gabriel\'')[0].role, 'admin');
  assert.equal(rows(shop.db, 'PRAGMA integrity_check')[0].integrity_check, 'ok');
  assert.deepEqual(rows(shop.db, 'PRAGMA foreign_key_check'), []);
  shop.db.close();
});

test('the database protections are back exactly as before, and the app starts numbering again', () => {
  const shop = makeShop();
  const protections = triggers(shop.db);
  assert.ok(protections.length >= 10);
  clearRecords(shop.db);
  assert.deepEqual(triggers(shop.db), protections, 'the same triggers with the same text');

  const next = shop.order(10);
  assert.equal(next.id, 1, 'order ids start again');
  assert.match(next.order_number, /^ORD-20261012-001$/, 'the day counter starts again');
  assert.throws(() => shop.db.exec('DELETE FROM orders'), /cannot be deleted/);
  assert.throws(() => shop.db.exec('DELETE FROM payments'), /cannot be deleted/);
  assert.throws(() => shop.db.exec('DELETE FROM order_events'), /cannot be deleted/);
  assert.throws(() => shop.db.exec('DELETE FROM order_items'), /cannot be deleted/);
  assert.throws(() => shop.db.exec('UPDATE orders SET total_centavos = 1'), /cannot be changed/);
  assert.equal(listPriceHistory(shop.db).length, 0);
  updateProduct(shop.db, shop.admin, shop.cull, { price: '61' }, NOW);
  assert.equal(listPriceHistory(shop.db)[0].id, 1, 'price history numbering starts again');
  shop.db.close();
});

test('keepPriceHistory clears the orders but leaves the price history alone', () => {
  const shop = makeShop();
  const history = rows(shop.db, 'SELECT * FROM price_history ORDER BY id');
  assert.ok(history.length >= 2);
  clearRecords(shop.db, { keepPriceHistory: true });
  assert.equal(countRecords(shop.db).orders, 0);
  assert.deepEqual(rows(shop.db, 'SELECT * FROM price_history ORDER BY id'), history);
  shop.db.close();
});

test('all or nothing: if anything cannot be deleted, nothing is changed and the protections stay', () => {
  const shop = makeShop();
  // Something outside the app points at an order, so the orders cannot be removed.
  shop.db.exec('CREATE TABLE zz_extra_note (order_id INTEGER REFERENCES orders(id))');
  shop.db.prepare('INSERT INTO zz_extra_note VALUES (?)').run(shop.orders[0].id);
  const before = { counts: countRecords(shop.db), triggers: triggers(shop.db), history: rows(shop.db, 'SELECT * FROM price_history ORDER BY id'), events: rows(shop.db, 'SELECT * FROM order_events ORDER BY id') };
  assert.throws(() => clearRecords(shop.db), /FOREIGN KEY|still point|nothing was changed/i);
  assert.deepEqual(countRecords(shop.db), before.counts);
  assert.deepEqual(triggers(shop.db), before.triggers, 'the protections are still there');
  assert.deepEqual(rows(shop.db, 'SELECT * FROM price_history ORDER BY id'), before.history);
  assert.deepEqual(rows(shop.db, 'SELECT * FROM order_events ORDER BY id'), before.events);
  assert.throws(() => shop.db.exec('DELETE FROM orders'), /cannot be deleted/, 'and they still protect the orders');
  shop.db.close();
});

test('Daily Inventory: closed days go with the orders they were made from; the open day and its typed numbers stay; the protections come back', () => {
  const shop = makeShop();
  moveOrder(shop.db, shop.cashier, shop.orders[1].id, 'COMPLETE', { now: NOW });          // nothing Ongoing, so the day can be closed
  const opts = { dir: path.join(shop.dir, 'inventory') };
  submitInventory(shop.db, shop.manager, { business_date: '2026-10-12' }, NOW, opts);     // Revision 11: submitted before it is closed
  const closedBy = startNewDay(shop.db, shop.manager, { business_date: '2026-10-12' }, NOW, opts);
  assert.equal(closedBy.closed.business_date, '2026-10-12');
  const next = new Date('2026-10-13T02:00:00Z');
  const open = getInventory(shop.db, shop.manager, {}, next);
  assert.equal(open.day.business_date, '2026-10-13');
  const carried = open.chicken.find((r) => r.name === 'Cull Chicken');
  assert.equal(carried.beginning, 98000, '100 heads - 2 sold (1.5 kg orders of 1 head each, 1 canceled)');
  const protectionsBefore = triggers(shop.db);
  const counts = countRecords(shop.db);
  assert.deepEqual([counts.inventoryDays, counts.inventoryRecords > 0], [1, true]);

  assert.equal(rows(shop.db, 'SELECT COUNT(*) AS n FROM inventory_submissions')[0].n, 1);
  const deleted = clearRecords(shop.db);
  assert.equal(deleted.inventoryDays, 1);
  assert.deepEqual(countRecords(shop.db).inventoryDays, 0);
  assert.equal(rows(shop.db, 'SELECT COUNT(*) AS n FROM inventory_submissions')[0].n, 0, 'the closed day\'s submitted inventory goes with it');
  assert.equal(rows(shop.db, 'SELECT COUNT(*) AS n FROM business_days')[0].n, 1, 'one business day is left');
  const day = rows(shop.db, 'SELECT * FROM business_days')[0];
  assert.deepEqual([day.business_date, day.status], ['2026-10-13', 'OPEN']);
  const left = rows(shop.db, 'SELECT * FROM inventory_records');
  assert.ok(left.length > 0 && left.every((r) => r.business_day_id === day.id), 'only the open day\'s records are left');
  assert.ok(left.every((r) => r.beginning_carried === 0), 'their Beginning Balances can be typed in again, because the day they came from is gone');
  assert.equal(left.find((r) => r.product_id === shop.cull).beginning_milli, 98000, 'the number itself is unchanged');
  assert.deepEqual(triggers(shop.db), protectionsBefore, 'the same triggers with the same text');
  assert.throws(() => shop.db.exec('DELETE FROM business_days'), /FOREIGN KEY/i, 'the open day cannot be erased while it has records');
  shop.db.exec("UPDATE business_days SET status = 'CLOSED', closed_at = '2026-10-13T10:00:00Z'");
  assert.throws(() => shop.db.exec('DELETE FROM business_days'), /closed business day cannot be deleted/, 'a closed day is protected again');
  assert.deepEqual(rows(shop.db, 'PRAGMA foreign_key_check'), []);
  shop.db.close();
});

test('command: asks before deleting; a wrong answer, a missing confirmation or a running app changes nothing', async () => {
  const shop = makeShop();
  const counts = countRecords(shop.db);
  shop.db.close();
  const port = await freePort();
  assert.ok(shop.file.startsWith(os.tmpdir()), 'the tests only ever use a temporary database');

  // no person to ask (no terminal) and no --confirm
  let r = runCli(shop, [], port);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs a person to confirm/);
  // a wrong word
  r = runCli(shop, ['--confirm', 'clear'], port);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cancelled\. Nothing was deleted\./);
  r = runCli(shop, ['--confirm'], port);
  assert.equal(r.status, 1);
  // the app is running (something is listening on the port)
  const busy = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => busy.once('listening', resolve));
  r = runCli(shop, ['--confirm', 'CLEAR'], busy.address().port);
  busy.close();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Stop it first/);

  const db = new DatabaseSync(shop.file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, counts.orders);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n, counts.priceChanges);
  db.close();
  assert.deepEqual(fs.readdirSync(shop.dir).filter((f) => f.includes('before-clear')), [], 'no deletion, so no safety copy was needed');
});

test('command: with the confirmation it saves a safety copy first, clears the records and keeps the users', async () => {
  const shop = makeShop();
  const counts = countRecords(shop.db);
  const kept = setup(shop.db);
  const protections = triggers(shop.db);
  shop.db.close();
  const port = await freePort();

  const r = runCli(shop, ['--confirm', 'CLEAR'], port);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /PERMANENTLY DELETE/);
  assert.match(r.stdout, /3 user account\(s\)/);
  assert.match(r.stdout, /Done\. Deleted 3 order\(s\)/);

  const copies = fs.readdirSync(shop.dir).filter((f) => /^pos\.db\.before-clear-\d{14}\.bak$/.test(f));
  assert.equal(copies.length, 1, 'one safety copy');
  const copy = new DatabaseSync(path.join(shop.dir, copies[0]), { readOnly: true });
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, counts.orders, 'the copy still has the orders');
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM payments').get().n, counts.payments);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM price_history').get().n, counts.priceChanges);
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM users").get().n, 3);
  copy.close();

  const db = openDb(shop.file);
  assert.deepEqual(countRecords(db), { orders: 0, lines: 0, payments: 0, history: 0, priceChanges: 0, inventoryDays: 0, inventoryRecords: 0 });
  assert.deepEqual(setup(db), kept, 'users, sessions, products, prices and fees are untouched');
  assert.ok(authenticate(db, 'gabriel', 'gabriel-pass-1'), 'gabriel (admin) can still sign in');
  assert.deepEqual(triggers(db), protections, 'the protections against deleting orders are back, unchanged');
  db.close();

  // running it again has nothing to do
  const again = runCli(shop, ['--confirm', 'CLEAR'], port);
  assert.equal(again.status, 0);
  assert.match(again.stderr, /There are no orders, closed inventory days or price history to clear/);
  assert.equal(fs.readdirSync(shop.dir).filter((f) => f.includes('before-clear')).length, 1, 'no second copy for nothing');
});

test('command: --keep-price-history keeps the price history', async () => {
  const shop = makeShop();
  const history = rows(shop.db, 'SELECT * FROM price_history ORDER BY id');
  shop.db.close();
  const r = runCli(shop, ['--confirm', 'CLEAR', '--keep-price-history'], await freePort());
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /price history is kept/);
  const db = new DatabaseSync(shop.file);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM price_history ORDER BY id').all(), history);
  db.close();
});

// ---- Revision 17: cash on hand, and the full reset for going live ------------------------------------------

test('revision 17: cash on hand of a closed day is cleared with it (the clear used to fail on it)', () => {
  const shop = makeShop();
  saveCashOnHand(shop.db, shop.manager, { amount: '1500' }, NOW);
  moveOrder(shop.db, shop.cashier, shop.orders[1].id, 'COMPLETE', { now: NOW });
  const opts = { dir: path.join(shop.dir, 'inventory') };
  submitInventory(shop.db, shop.manager, { business_date: '2026-10-12' }, NOW, opts);
  startNewDay(shop.db, shop.manager, { business_date: '2026-10-12' }, NOW, opts);
  assert.ok(rows(shop.db, 'SELECT * FROM cash_on_hand').length >= 1);
  clearRecords(shop.db);
  assert.equal(rows(shop.db, 'SELECT COUNT(*) AS n FROM cash_on_hand')[0].n, 0, 'the closed day cash on hand is gone');
  assert.deepEqual(rows(shop.db, 'PRAGMA foreign_key_check'), []);
  shop.db.close();
});

test('revision 17: --everything also deletes the open day and every sign-in, keeps the setup, and the app opens a fresh day', () => {
  const shop = makeShop();
  saveCashOnHand(shop.db, shop.manager, { amount: '1500' }, NOW);
  const kept = { ...setup(shop.db), sessions: [] };
  const protections = triggers(shop.db);
  assert.ok(countSessions(shop.db) >= 1);
  assert.equal(rows(shop.db, "SELECT COUNT(*) AS n FROM business_days WHERE status = 'OPEN'")[0].n, 1);
  clearRecords(shop.db, { everything: true });
  for (const t of ['business_days', 'inventory_records', 'inventory_events', 'inventory_submissions', 'inventory_saves', 'cash_counts', 'cash_on_hand', 'expenses', 'ref_stock_entries', 'orders', 'payments', 'sessions', 'price_history']) {
    assert.equal(rows(shop.db, `SELECT COUNT(*) AS n FROM ${t}`)[0].n, 0, `${t} is empty`);
  }
  assert.deepEqual(setup(shop.db), kept, 'users, products, prices and fees are untouched');
  assert.deepEqual(triggers(shop.db), protections);
  assert.deepEqual(rows(shop.db, 'PRAGMA foreign_key_check'), []);
  assert.ok(authenticate(shop.db, 'gabriel', 'gabriel-pass-1'));
  // a fresh day opens by itself, with a stock row for every product, all zero
  const inv = getInventory(shop.db, shop.manager, {}, NOW);
  assert.equal(inv.day.status, 'OPEN');
  assert.ok(inv.chicken.length >= 1 && [...inv.chicken, ...inv.other].every((r) => r.beginning === 0 || r.beginning === '0' || !r.beginning));
  stockUp(shop.db, shop.manager);
  assert.equal(shop.order(20).id, 1);
  shop.db.close();
});
