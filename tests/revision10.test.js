// Revision 10 acceptance tests: editable Beginning Balance with a reason, closing from the Inventory page and the Order List,
// the previous-day note, the new unit structure for other products, hidden zero rows, the Whole Inventory export,
// and the upgrade from version 7 (rehearsed on a copy, with a forced failure to prove nothing is half-changed).
// Every test builds its own shop (own server, own database), so no test can disturb another and none can touch real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct, createOtherProduct, seedStarterCatalog } from '../src/services/catalog.js';
import { INVENTORY_REASONS, UNITS } from '../shared/constants.js';
import { formatDateMDY, previousBeginningText, isEmptyRow } from '../shared/inventory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START = new Date('2026-10-12T02:00:00Z');   // 10:00 on Monday 12 Oct 2026 in the Philippines
let keyN = 0;
const key = () => `r10-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

function client(base) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'pos', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return { call, async login(username, password) { const r = await call('POST', '/api/login', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); } };
}

async function makeShop() {
  const db = openDb(':memory:');
  const clock = { now: START };
  const config = loadConfig({ dbPath: ':memory:', largeWeightKg: 50, sessionIdleMinutes: 60 * 24 * 365 });
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  const whole = createProduct(db, adminUser, { name: 'Whole Chicken', price: '120' }).id;
  const cull = createProduct(db, adminUser, { name: 'Cull Chicken', price: '58' }).id;
  const eggs = createOtherProduct(db, adminUser, { name: 'Eggs (Small)', kind: 'EGGS', prices: { piece: '10', tray: '300' } });
  const etag = createOtherProduct(db, adminUser, { name: 'Etag (Sun-Dried)', kind: 'OTHER', prices: { kg: '450' } });
  const server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier] = [client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1'); await cashier.login('cash', 'cashier-pass-1');
  const shop = {
    db, clock, server, admin, manager, cashier, adminUser, whole, cull,
    eggs, etag, optionOf: (product, unit) => ({ id: product.options.find((o) => o.unit === unit).id, product: product.id }),
    close: () => { server.close(); try { db.close(); } catch { /* already closed */ } },
    inventory: async (who = manager, query = '') => (await who.call('GET', `/api/inventory${query}`)).data,
    async row(name, query = '', who = manager) { const inv = await shop.inventory(who, query); return [...inv.chicken, ...inv.other].find((r) => r.name === name); },
    async set(name, fields, who = manager) {
      const row = await shop.row(name);
      assert.ok(row, `no inventory row called ${name}`);
      return who.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, ...fields });
    },
    order: (who, items = [], other = [], extra = {}) => who.call('POST', '/api/orders', { submission_key: key(), items, other_items: other, ...extra }),
    // Revision 11: a day is closed in two steps, "Submit Inventory Today" and then "Closed Inventory Today and Reset the Day".
    // Revision 13: a day left open past midnight closes by itself, so a hand close is made on the day's own evening (22:00 PH time).
    closeDay: async (date, who = manager) => {
      const now = clock.now;
      if (now.toISOString().slice(0, 10) > date) clock.now = new Date(`${date}T14:00:00Z`);
      try {
        await who.call('POST', '/api/inventory/submit', { business_date: date });
        return await who.call('POST', '/api/inventory/close-day', { business_date: date });
      } finally { clock.now = now; }
    },
    board: async (who = cashier) => (await who.call('GET', '/api/board')).data,
    move: (who, id, status) => who.call('POST', `/api/orders/${id}/fulfillment`, { status }),
  };
  manager.shop = shop;
  return shop;
}
const live = (product, heads = 1) => ({ product_id: product, weight: String(heads), heads, feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null });
const readZip = (buf) => {
  const files = {};
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const csize = buf.readUInt32LE(p + 20); const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32); const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26); const lelen = buf.readUInt16LE(off + 28);
    const start = off + 30 + lnlen + lelen;
    files[name] = inflateRawSync(buf.subarray(start, start + csize)).toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return files;
};
const sheetNames = (files) => [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);

/** A shop with day 1 (2026-10-12) closed and day 2 (2026-10-13) open: Whole Chicken 100 -> sold 23 -> carried 77. */
async function secondDay(shop) {
  assert.equal((await shop.set('Whole Chicken', { beginning: 100 })).status, 200);
  assert.equal((await shop.set('Etag (Sun-Dried) - piece', { beginning: 12 })).status, 200);   // Revision 11: counted in pieces, also when sold by the kilo
  assert.equal((await shop.order(shop.cashier, [live(shop.whole, 23)])).status, 201);
  const open = await shop.cashier.call('GET', '/api/orders');
  for (const o of open.data.orders) await shop.move(shop.manager, o.id, 'COMPLETE');
  const closed = await shop.closeDay('2026-10-12');                      // Revision 13: closed by hand the same evening
  assert.equal(closed.status, 200, JSON.stringify(closed.data));
  shop.clock.now = new Date('2026-10-13T01:00:00Z');
  return closed.data;
}

// ---- Change 2: the Beginning Balance can be corrected, with a reason ----------------------------------------------------

test('Change 2: a carried Beginning Balance can be corrected by a manager or admin, but only with a reason, and the reason is saved', async () => {
  const shop = await makeShop();
  try {
    await secondDay(shop);
    const row = await shop.row('Whole Chicken');
    assert.deepEqual([row.beginning / 1000, row.beginning_carried, row.beginning_editable, row.beginning_needs_reason], [77, true, true, true]);

    // no reason, an unknown reason, and "Other" without an explanation are all refused, and nothing changes
    for (const body of [{ beginning: 70 }, { beginning: 70, reason: 'BECAUSE' }, { beginning: 70, reason: 'OTHER' }, { beginning: 70, reason: 'OTHER', reason_note: 'x' }]) {
      const r = await shop.manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, ...body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.data.code, 'REASON_REQUIRED');
    }
    assert.equal((await shop.row('Whole Chicken')).beginning, 77000);
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM inventory_events WHERE reason_code IS NOT NULL").get().n, 0);

    // with a reason it is saved; the old and new numbers, the reason, who and when are in the history
    const ok = await shop.manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: 70, reason: 'INCORRECT_INVENTORY', reason_note: 'Counted 70 on the shelf' });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.row.beginning, 70000);
    assert.equal(ok.data.row.new_total, 70000);
    assert.deepEqual([ok.data.row.beginning_edit.reason_code, ok.data.row.beginning_edit.reason, ok.data.row.beginning_edit.note, ok.data.row.beginning_edit.by],
      ['INCORRECT_INVENTORY', 'Incorrect inventory', 'Counted 70 on the shelf', 'Manager']);
    const event = shop.db.prepare("SELECT * FROM inventory_events WHERE reason_code IS NOT NULL").get();
    assert.deepEqual([event.record_id, event.field, event.old_milli, event.new_milli, event.reason_code, event.reason_note, event.user_id !== null], [row.id, 'beginning', 77000, 70000, 'INCORRECT_INVENTORY', 'Counted 70 on the shelf', true]);
    assert.ok(event.created_at);
    // the history cannot be edited or deleted
    assert.throws(() => shop.db.prepare('UPDATE inventory_events SET reason_code = NULL').run(), /cannot be changed/);
    assert.throws(() => shop.db.prepare('DELETE FROM inventory_events').run(), /cannot be deleted/);

    // the admin may do it too; "Other" works with an explanation; every reason on the list is accepted
    for (const [i, code] of Object.keys(INVENTORY_REASONS).entries()) {
      const fresh = await shop.row('Whole Chicken');
      const r = await shop.admin.call('PATCH', `/api/inventory/records/${fresh.id}`, { rev: fresh.rev, beginning: 60 - i, reason: code, reason_note: code === 'OTHER' ? 'Two boxes moved to the other shop' : '' });
      assert.equal(r.status, 200, `${code}: ${JSON.stringify(r.data)}`);
    }
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM inventory_events WHERE reason_code IS NOT NULL").get().n, 1 + Object.keys(INVENTORY_REASONS).length);
  } finally { shop.close(); }
});

test('Change 2: cashiers cannot edit, a changed number needs a reason only for the Beginning Balance, and the usual stock rules still apply', async () => {
  const shop = await makeShop();
  try {
    await secondDay(shop);
    const row = await shop.row('Whole Chicken');
    const asCashier = await shop.cashier.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: 70, reason: 'RECOUNT' });
    assert.equal(asCashier.status, 403);
    assert.equal((await shop.row('Whole Chicken')).beginning, 77000);

    // Additional needs no reason
    assert.equal((await shop.set('Whole Chicken', { additional: 5 })).status, 200);
    // typing the same Beginning Balance again changes nothing and needs no reason
    const same = await shop.set('Whole Chicken', { beginning: 77 });
    assert.equal(same.status, 200);
    assert.equal(same.data.changed, false);
    // a Beginning Balance that would leave a negative New Total is refused even with a reason
    assert.equal((await shop.order(shop.manager, [live(shop.whole, 10)])).status, 201);
    const tooLow = await shop.set('Whole Chicken', { beginning: 3, reason: 'TYPING_MISTAKE' });
    assert.equal(tooLow.status, 400);
    assert.equal(tooLow.data.code, 'INVENTORY_RULE');
    assert.equal((await shop.row('Whole Chicken')).beginning, 77000);
    // a long note is cut to 200 characters and control characters are removed
    const noted = await shop.set('Whole Chicken', { beginning: 76, reason: 'OTHER', reason_note: `Line one\nLine\ttwo ${'x'.repeat(400)}` });
    assert.equal(noted.status, 200);
    const saved = shop.db.prepare("SELECT reason_note FROM inventory_events WHERE reason_code = 'OTHER'").get().reason_note;
    assert.ok(saved.length === 200 && !/[\n\t]/.test(saved), 'the note is one clean line of at most 200 characters');
    // a closed day can never be corrected
    const day1 = await shop.row('Whole Chicken', '?date=2026-10-12');
    const closed = await shop.manager.call('PATCH', `/api/inventory/records/${day1.id}`, { rev: day1.rev, beginning: 1, reason: 'RECOUNT' });
    assert.equal(closed.status, 409);
    assert.equal(closed.data.code, 'DAY_CLOSED');
  } finally { shop.close(); }
});

test('Change 2: the very first Beginning Balance of a product needs no reason; changing it afterwards does', async () => {
  const shop = await makeShop();
  try {
    const row = await shop.row('Whole Chicken');
    assert.deepEqual([row.beginning, row.beginning_needs_reason, row.beginning_carried], [0, false, false]);
    const first = await shop.set('Whole Chicken', { beginning: 100 });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.row.beginning_edit, null, 'setting the first number is not a correction');
    assert.equal(first.data.row.beginning_needs_reason, true);
    const again = await shop.set('Whole Chicken', { beginning: 90 });
    assert.equal(again.status, 400);
    assert.equal(again.data.code, 'REASON_REQUIRED');
    assert.equal((await shop.set('Whole Chicken', { beginning: 90, reason: 'RECOUNT' })).status, 200);
  } finally { shop.close(); }
});

// ---- Change 3: the previous day's Beginning Balance next to the Beginning Balance ----------------------------------------------

test('Change 3: the italic note is the previous business day\'s Beginning Balance and its date (month/day/year)', async () => {
  const shop = await makeShop();
  try {
    const day1 = await shop.row('Whole Chicken');
    assert.deepEqual([day1.prev_beginning, day1.prev_date], [null, null], 'the first day has no previous day');
    await secondDay(shop);
    const row = await shop.row('Whole Chicken');
    assert.deepEqual([row.beginning / 1000, row.prev_beginning / 1000, row.prev_date], [77, 100, '2026-10-12']);
    assert.equal(previousBeginningText({ prev_beginning: row.prev_beginning, prev_date: row.prev_date }), '(100 10/12/2026)');
    const piece = await shop.row('Etag (Sun-Dried) - piece');
    assert.equal(previousBeginningText(piece), '(12 10/12/2026)', 'other products have the note too (counted in pieces since Revision 11)');
    assert.equal(previousBeginningText({ prev_beginning: 12500, prev_date: '2026-10-12' }), '(12.5 10/12/2026)', 'an old kg figure keeps its decimals');
    assert.equal(previousBeginningText({ prev_beginning: null, prev_date: null }), '');
    assert.equal(formatDateMDY('2026-01-05'), '01/05/2026');
    // a day later the note moves on: the Beginning Balance of the day before (77) and its date
    assert.equal((await shop.order(shop.cashier, [live(shop.whole, 7)])).status, 201);
    const o = (await shop.cashier.call('GET', '/api/orders')).data.orders[0];
    await shop.move(shop.manager, o.id, 'COMPLETE');
    shop.clock.now = new Date('2026-10-14T01:00:00Z');
    assert.equal((await shop.closeDay('2026-10-13')).status, 200);
    const third = await shop.row('Whole Chicken');
    assert.deepEqual([third.beginning / 1000, third.prev_beginning / 1000, third.prev_date], [70, 77, '2026-10-13']);
    // a correction changes the number but the note keeps pointing at the day before
    const fixed = await shop.set('Whole Chicken', { beginning: 69, reason: 'RECOUNT' });
    assert.deepEqual([fixed.data.row.beginning / 1000, fixed.data.row.prev_beginning / 1000], [69, 77]);
    // an old day shows its own note
    const old = await shop.row('Whole Chicken', '?date=2026-10-13');
    assert.deepEqual([old.beginning / 1000, old.prev_beginning / 1000, old.prev_date], [77, 100, '2026-10-12']);
  } finally { shop.close(); }
});

// ---- Change 3: closing from the Inventory page and the Order List ----------------------------------------------------

test('Change 3: closing clears the Complete orders from the Order List; Standby stays; a claimed Standby order from a closed day leaves; nothing is deleted', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 100 })).status, 200);
    const place = async (heads, extra = {}) => (await shop.order(shop.cashier, [live(shop.whole, heads)], [], extra)).data.order;
    const ongoing = await place(1);
    const standbyA = await place(2, { customer_number: 'Pick-up A' });
    const standbyB = await place(3, { customer_number: 'Pick-up B' });
    const done = await place(4);
    await shop.move(shop.manager, standbyA.id, 'STANDBY'); await shop.move(shop.manager, standbyB.id, 'STANDBY'); await shop.move(shop.manager, done.id, 'COMPLETE');

    // the close check says what will happen
    const check = (await shop.manager.call('GET', '/api/inventory/close-check')).data;
    assert.equal(check.can_close, false, 'an Ongoing order still blocks the closing');
    // (Revision 12 adds a reminder when no cash breakdown was saved; it is only a reminder and never blocks.)
    assert.deepEqual(check.notices.filter((n) => n.code !== 'NO_CASH_COUNT').map((n) => [n.code, n.count]).sort(), [['COMPLETE_ORDERS', 1], ['STANDBY_ORDERS', 2]]);
    assert.match(check.notices.find((n) => n.code === 'COMPLETE_ORDERS').message, /leave the Order List.*Nothing is deleted/s);
    assert.equal((await shop.closeDay('2026-10-12')).status, 409);
    let board = await shop.board();
    assert.equal(board.orders.length, 4, 'a refused closing changes nothing on the Order List');

    await shop.move(shop.manager, ongoing.id, 'STANDBY');
    shop.clock.now = new Date('2026-10-13T01:00:00Z');
    const ordersBefore = JSON.stringify(shop.db.prepare('SELECT id, order_number, status, total_centavos, business_day_id FROM orders ORDER BY id').all());
    const paymentsBefore = shop.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
    const closed = await shop.closeDay('2026-10-12');
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.deepEqual([closed.data.standby_orders, closed.data.complete_orders_cleared], [3, 1]);

    // Complete is empty; the three Standby orders are still there, marked as sold on an earlier day
    board = await shop.board();
    assert.deepEqual(board.orders.map((o) => o.order_number).sort(), [ongoing, standbyA, standbyB].map((o) => o.order_number).sort());
    assert.ok(board.orders.every((o) => o.fulfillment_status === 'STANDBY' && o.from_earlier_day === true && o.day_date === '2026-10-12'));
    assert.equal(board.open_day, '2026-10-13');
    // nothing was deleted: the claimed order is still in the Orders tab with all its data
    assert.equal(JSON.stringify(shop.db.prepare('SELECT id, order_number, status, total_centavos, business_day_id FROM orders ORDER BY id').all()), ordersBefore);
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, paymentsBefore);
    const all = (await shop.cashier.call('GET', '/api/orders')).data.orders;
    assert.equal(all.length, 4);
    assert.equal(all.find((o) => o.id === done.id).fulfillment_status, 'COMPLETE');
    // the Standby orders still count in the closed day's inventory and are not counted again on the new day
    assert.equal((await shop.row('Whole Chicken', '?date=2026-10-12')).sold, 10000);
    assert.equal((await shop.row('Whole Chicken')).sold, 0);
    assert.equal((await shop.row('Whole Chicken')).beginning, 90000);

    // the customer comes for order A: it is marked Complete and leaves the Order List (it stays in Orders and in the reports)
    const claimed = await shop.move(shop.cashier, standbyA.id, 'COMPLETE');
    assert.equal(claimed.status, 200);
    board = await shop.board();
    assert.deepEqual(board.orders.map((o) => o.id).sort(), [ongoing.id, standbyB.id].sort());
    assert.equal((await shop.cashier.call('GET', `/api/orders/${standbyA.id}`)).data.order.fulfillment_status, 'COMPLETE');
    assert.equal((await shop.row('Whole Chicken', '?date=2026-10-12')).sold, 10000, 'claiming does not touch the stock figures of the closed day');
    // moving it back is still possible by id (nothing is locked), and it returns to the board as Standby
    assert.equal((await shop.move(shop.manager, standbyA.id, 'STANDBY')).status, 200);
    assert.ok((await shop.board()).orders.some((o) => o.id === standbyA.id));
    assert.equal((await shop.move(shop.manager, standbyA.id, 'COMPLETE')).status, 200);

    // an order sold TODAY and marked Complete stays on the board until its own day is closed
    const today = await place(5);
    await shop.move(shop.manager, today.id, 'COMPLETE');
    board = await shop.board();
    const card = board.orders.find((o) => o.id === today.id);
    assert.deepEqual([card.fulfillment_status, card.from_earlier_day], ['COMPLETE', false]);
    await shop.move(shop.manager, ongoing.id, 'COMPLETE'); await shop.move(shop.manager, standbyB.id, 'COMPLETE');
    assert.deepEqual((await shop.board()).orders.map((o) => o.id), [today.id], 'the other two left because their day is closed');
    shop.clock.now = new Date('2026-10-14T01:00:00Z');
    assert.equal((await shop.closeDay('2026-10-13')).status, 200);
    assert.deepEqual((await shop.board()).orders, [], 'closing the second day clears its Complete order too');
    assert.equal((await shop.cashier.call('GET', '/api/orders')).data.orders.length, 5, 'and still nothing is deleted');
  } finally { shop.close(); }
});

test('Change 3: canceled orders are not on the Order List, refunded Standby orders stay until claimed, and the screen and the server agree', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 50 })).status, 200);
    const a = (await shop.order(shop.cashier, [live(shop.whole, 1)])).data.order;
    const b = (await shop.order(shop.cashier, [live(shop.whole, 1)], [], { payment: { method: 'CASH' } })).data.order;
    await shop.move(shop.manager, b.id, 'STANDBY');
    assert.equal((await shop.manager.call('POST', `/api/orders/${b.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 200);
    assert.equal((await shop.cashier.call('POST', `/api/orders/${a.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' })).status, 200);
    shop.clock.now = new Date('2026-10-13T01:00:00Z');
    assert.equal((await shop.closeDay('2026-10-12')).status, 200);
    const board = await shop.board();
    assert.deepEqual(board.orders.map((o) => [o.id, o.status, o.from_earlier_day]), [[b.id, 'REFUNDED', true]]);
  } finally { shop.close(); }
});

// ---- Change 4: other products -----------------------------------------------------------------------------------------

test('Change 4: every other product has all of its counted units on the Daily Inventory from the moment it is created', async () => {
  const shop = await makeShop();
  try {
    const inv = await shop.inventory();
    const unitsOf = (product) => inv.other.filter((r) => r.product_name === product).map((r) => r.unit);
    assert.deepEqual(unitsOf('Eggs (Small)'), UNITS.EGGS, 'eggs: piece, carton, tray');
    // Revision 11: kg has no stock row of its own (something sold by the kilo is counted in pieces)
    assert.deepEqual(unitsOf('Etag (Sun-Dried)'), UNITS.OTHER.filter((u) => u !== 'kg'), 'everything else: piece, pack, sack');
    assert.ok(!inv.other.some((r) => r.name === 'Etag (Sun-Dried) - kg'), 'no kg row');

    // a product created now shows up straight away, in the same order, even though it has no price yet
    const added = await shop.manager.call('POST', '/api/other-products', { name: 'Laya', kind: 'OTHER' });
    assert.equal(added.status, 201);
    const after = await shop.inventory();
    assert.deepEqual(after.other.filter((r) => r.product_name === 'Laya').map((r) => r.name), ['Laya - piece', 'Laya - pack', 'Laya - sack']);
    assert.ok(after.other.filter((r) => r.product_name === 'Laya').every((r) => r.empty && r.beginning === 0));
    // the stock can be counted before the admin has set a price
    assert.equal((await shop.set('Laya - sack', { beginning: 8 })).status, 200);
    assert.equal((await shop.row('Laya - sack')).empty, false);
    // ...but it still cannot be sold until it has a price
    const laya = added.data.other_product;
    const sack = laya.options.find((o) => o.unit === 'sack');
    const refused = await shop.order(shop.cashier, [], [{ other_product_id: laya.id, option_id: sack.id, quantity: '1' }]);
    assert.equal(refused.status, 400);
    const cfg = (await shop.cashier.call('GET', '/api/config')).data;
    assert.ok(!cfg.other_products.some((p) => p.name === 'Laya'), 'unpriced products stay off the cashier screen');
    // an order is checked against the stock of its own unit
    const priced = await shop.admin.call('PATCH', `/api/other-product-options/${sack.id}`, { price: '700' });
    assert.equal(priced.status, 200);
    const tooMany = await shop.order(shop.cashier, [], [{ other_product_id: laya.id, option_id: sack.id, quantity: '9' }]);
    assert.equal(tooMany.status, 409);
    assert.match(tooMany.data.error, /Only 8 sacks of Laya are available/);
    assert.equal((await shop.order(shop.cashier, [], [{ other_product_id: laya.id, option_id: sack.id, quantity: '8' }])).status, 201);

    // a switched-off product has no rows; switching it on brings them back with their numbers
    const etagId = shop.etag.id;
    assert.equal((await shop.manager.call('PATCH', `/api/other-products/${etagId}`, { active: false })).status, 200);
    assert.equal((await shop.inventory()).other.some((r) => r.product_name === 'Etag (Sun-Dried)'), false);
    assert.equal((await shop.manager.call('PATCH', `/api/other-products/${etagId}`, { active: true })).status, 200);
    assert.equal((await shop.inventory()).other.filter((r) => r.product_name === 'Etag (Sun-Dried)').length, 3);
  } finally { shop.close(); }
});

test('Change 4: rows with nothing in them are marked empty (other products only); a product that sold out is not empty', async () => {
  const shop = await makeShop();
  try {
    const inv = await shop.inventory();
    assert.ok(inv.chicken.every((r) => r.empty === false), 'chicken rows are always shown');
    assert.ok(inv.other.every((r) => r.empty === true), 'a new shop has no stock in any other product');
    assert.equal(isEmptyRow({ kind: 'CHICKEN', beginning: 0, additional: 0, sold: 0 }), false);
    assert.equal((await shop.set('Etag (Sun-Dried) - piece', { beginning: 2 })).status, 200);
    const etagKg = shop.optionOf(shop.etag, 'kg');
    assert.equal((await shop.order(shop.cashier, [], [{ other_product_id: etagKg.product, option_id: etagKg.id, quantity: '2.5', pieces: 2 }])).status, 201);
    const sold = await shop.row('Etag (Sun-Dried) - piece');
    assert.deepEqual([sold.new_total, sold.sold, sold.empty], [0, 2000, false], 'sold out today (2 pieces weighing 2.5 kg): still listed, with what happened');
    // nothing but Additional is a row with stock
    assert.equal((await shop.set('Eggs (Small) - tray', { additional: 4 })).status, 200);
    assert.equal((await shop.row('Eggs (Small) - tray')).empty, false);
    assert.equal((await shop.row('Eggs (Small) - carton')).empty, true);
    // the next morning: a product that finished at 0 and had no Beginning Balance today is empty again, one with stock is not
    shop.clock.now = new Date('2026-10-13T01:00:00Z');
    const orders = (await shop.cashier.call('GET', '/api/orders')).data.orders;
    for (const o of orders) await shop.move(shop.manager, o.id, 'COMPLETE');
    assert.equal((await shop.closeDay('2026-10-12')).status, 200);
    assert.equal((await shop.row('Etag (Sun-Dried) - piece')).empty, true);
    assert.equal((await shop.row('Eggs (Small) - tray')).empty, false);
  } finally { shop.close(); }
});

// Revision 11 replaced the Daily Report and Whole Inventory exports of the Inventory page with "Submit Inventory Today" and
// "Export Inventory History"; the Beginning Balance corrections and their reasons are kept in both.
test('Change 4 (as of Revision 11): the inventory files list every Beginning Balance correction with its reason; exporting changes nothing', async () => {
  const shop = await makeShop();
  try {
    await secondDay(shop);
    assert.equal((await shop.set('Whole Chicken', { beginning: 70, reason: 'INCORRECT_INVENTORY', reason_note: 'Counted again' })).status, 200);
    const snapshot = () => JSON.stringify({
      records: shop.db.prepare('SELECT * FROM inventory_records ORDER BY id').all(), events: shop.db.prepare('SELECT * FROM inventory_events ORDER BY id').all(),
      orders: shop.db.prepare('SELECT * FROM orders ORDER BY id').all(), days: shop.db.prepare('SELECT * FROM business_days ORDER BY id').all(),
    });
    const submitted = await shop.manager.call('POST', '/api/inventory/submit', { business_date: '2026-10-13' });
    assert.equal(submitted.status, 201, JSON.stringify(submitted.data));
    const file = readZip((await shop.manager.call('GET', `/api/inventory/submissions/${submitted.data.submission.id}/file`)).data);
    // Revision 13: the corrections are notes under the tables of the one sheet (no separate sheet any more)
    assert.ok(file['xl/worksheets/sheet1.xml'].includes('Counted again'), 'the submitted file has the corrections');
    assert.deepEqual(sheetNames(file), ['Inventory Today']);
    // Revision 12: once the day is closed (submitted and closed in one step), its Export file lists them too, and exporting changes nothing.
    const closed = await shop.manager.call('POST', '/api/inventory/close-day', { business_date: '2026-10-13', submit: true });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    const before = snapshot();
    const exported = readZip((await shop.manager.call('GET', '/api/inventory/day.xlsx?date=2026-10-13')).data);
    assert.equal(snapshot(), before, 'exporting a closed day changes no stock, order, day or history row');
    const edits = exported['xl/worksheets/sheet1.xml'];
    assert.ok(edits.includes('Incorrect inventory') && edits.includes('Counted again') && edits.includes('Whole Chicken'), 'the corrections sheet lists the reason');
  } finally { shop.close(); }
});

// ---- Small changes ----------------------------------------------------------------------------------------------------

test('Small changes: Service fees list only Pour and Dress, and With Blood / Dukot cannot be given a fee', async () => {
  const shop = await makeShop();
  try {
    const fees = (await shop.admin.call('GET', '/api/service-fees')).data.fees;
    assert.deepEqual(Object.keys(fees).sort(), ['NOT_POUR', 'POUR']);
    assert.deepEqual(Object.keys((await shop.cashier.call('GET', '/api/config')).data.fees).sort(), ['NOT_POUR', 'POUR']);
    for (const code of ['DARA', 'DUKOT']) assert.equal((await shop.admin.call('PUT', `/api/service-fees/${code}`, { amount: '10', basis: 'per_head' })).status, 404, code);
    assert.equal((await shop.admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_head' })).status, 200);
  } finally { shop.close(); }
});

test('Small changes: starter data uses the new units and marks the egg products as eggs', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a','A','x','admin','2026-01-01')").run();
  assert.equal(seedStarterCatalog(db), true);
  const units = (name) => db.prepare('SELECT o.unit FROM other_product_options o JOIN other_products p ON p.id = o.product_id WHERE p.name = ? ORDER BY o.id').all(name).map((r) => r.unit);
  assert.deepEqual(units('Eggs (Large)'), UNITS.EGGS);
  assert.deepEqual(units('Etag (Sun-Dried)'), UNITS.OTHER);
  assert.deepEqual(db.prepare("SELECT name FROM other_products WHERE kind = 'EGGS' ORDER BY name").all().map((r) => r.name), ['Eggs (Large)', 'Eggs (Medium)', 'Eggs (Small)']);
  db.close();
});

// ---- The upgrade from version 7 ---------------------------------------------------------------------------------------

/** A version 7 database (the exact layout of revision 9) holding orders, payments, stock and an old-style catalog. */
function makeVersion7Database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v7-'));
  const file = path.join(dir, 'pos.db');
  const seed = new DatabaseSync(file);
  seed.exec(fs.readFileSync(path.join(HERE, 'fixtures', 'schema-v7.sql'), 'utf8'));
  seed.exec('PRAGMA user_version = 7');
  const now = '2026-10-09T02:00:00.000Z';
  seed.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('owner','Owner','x','admin',?)").run(now);
  seed.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('Cull Chicken', 5800, 1, ?, ?)").run(now, now);
  const order = (n, day) => seed.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key, business_day_id)
    VALUES (?, ?, 'COMPLETED', 29880, 29880, 1, ?, ?, ?)`).run(`ORD-2026100${n}-001`, `2026-10-0${n}`, now, `k${n}`, day);
  seed.prepare("INSERT INTO business_days (business_date, status, opened_at) VALUES ('2026-10-08','OPEN',?)").run(now);
  order(8, 1);
  seed.prepare("UPDATE business_days SET status = 'CLOSED', closed_at = ? WHERE id = 1").run(now);          // day 1 is closed, as the shop would have done
  seed.prepare("INSERT INTO business_days (business_date, status, opened_at) VALUES ('2026-10-09','OPEN',?)").run(now);
  order(9, 2);
  const line = (orderId, n, feather, dara, cut, size, fee) => seed.prepare(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos,
    feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos) VALUES (?, ?, 1, 'Cull Chicken', 5800, 3600, 3, 20880, ?, ?, ?, ?, '[{"code":"DARA"}]', ?, ?)`)
    .run(orderId, n, feather, dara, cut, size, fee, 20880 + fee);
  line(1, 1, 'POUR', 1, 'SLICE', 'MEDIUM', 9000); line(1, 2, 'NOT_POUR', 0, 'DUKOT', null, 7500); line(1, 3, 'LIVE', 0, 'NONE', null, 0); line(2, 1, 'POUR', 0, 'DUKOT', null, 4500);
  seed.prepare("INSERT INTO payments (order_id, method, amount_centavos, recorded_by, recorded_at, received_centavos, change_centavos) VALUES (1,'CASH',29880,1,?,30000,120)").run(now);
  seed.prepare("INSERT INTO inventory_records (business_day_id, kind, product_id, beginning_milli, updated_at) VALUES (2,'CHICKEN',1,50000,?)").run(now);
  seed.prepare("INSERT INTO inventory_events (record_id, field, old_milli, new_milli, user_id, created_at, note) VALUES (1,'beginning',0,50000,1,?,'Cull Chicken: Beginning Balance 0 to 50')").run(now);
  seed.prepare("INSERT INTO service_fees (code, amount_centavos, basis, updated_at) VALUES ('POUR',4500,'per_head',?),('NOT_POUR',2500,'per_head',?),('DARA',0,'per_head',?),('DUKOT',0,'per_head',?)").run(now, now, now, now);
  seed.prepare("INSERT INTO other_products (name, active, created_at, updated_at) VALUES ('Eggs (Small)',1,?,?),('Eggplant',1,?,?),('Etag (Sun-Dried)',1,?,?)").run(now, now, now, now, now, now);
  seed.prepare("INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at) VALUES (1,'dozen','FIXED',9000,1,?,?),(1,'Piece','FIXED',800,1,?,?),(3,'kg','PER_KG',45000,1,?,?)").run(now, now, now, now, now, now);
  seed.close();
  return { dir, file };
}

test('upgrade 7 -> 8: every order, payment, stock figure and price is kept exactly; the catalog gains the standard units; a safety copy is saved', () => {
  const { dir, file } = makeVersion7Database();
  const seed = new DatabaseSync(file);
  const tables = ['users', 'products', 'service_fees', 'order_items', 'order_other_items', 'orders', 'payments', 'order_events', 'business_days', 'inventory_records', 'inventory_events', 'price_history', 'other_product_options'];
  const dump = (d) => JSON.stringify(Object.fromEntries(tables.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map(({ tracking_number: _t, ...row }) => row)])));   // orders.tracking_number is new in version 12 (empty for old orders)
  const before = dump(seed);
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);   // 7 -> 8 -> 9 (Revision 11) in one start
  // inventory_events gained two columns (empty for old rows); other_product_options is compared apart because new rows were added.
  // Version 9 added products.category and inventory_records.katay_milli; every other value is unchanged.
  const after = JSON.parse(dump(db));
  const was = JSON.parse(before);
  for (const t of tables.filter((x) => !['inventory_events', 'other_product_options', 'products', 'inventory_records'].includes(x))) assert.deepEqual(after[t], was[t], `${t} is byte-for-byte the same`);
  assert.deepEqual(after.inventory_events.map(({ reason_code: a, reason_note: b, ...rest }) => [a, b, rest]), was.inventory_events.map((e) => [null, null, e]));
  assert.deepEqual(after.products.map(({ category, ...rest }) => [category, rest]), was.products.map((p) => ['CULL', p]), 'Cull Chicken is filled in as CULL');
  assert.deepEqual(after.inventory_records.map(({ katay_milli: k, ...rest }) => [k, rest]), was.inventory_records.map((r) => [0, r]), 'Katay starts at 0');
  for (const o of was.other_product_options) assert.deepEqual(after.other_product_options.find((x) => x.id === o.id), o, 'existing options keep their unit, price and switch');

  // the catalog: eggs found by name, standard units added without touching the old ones, new ones switched off at ₱0
  const kinds = Object.fromEntries(db.prepare('SELECT name, kind FROM other_products').all().map((r) => [r.name, r.kind]));
  assert.deepEqual(kinds, { 'Eggs (Small)': 'EGGS', Eggplant: 'OTHER', 'Etag (Sun-Dried)': 'OTHER' });
  const unitsOf = (name) => db.prepare('SELECT o.unit, o.price_centavos, o.active FROM other_product_options o JOIN other_products p ON p.id = o.product_id WHERE p.name = ? ORDER BY o.id').all(name).map((r) => [r.unit, r.price_centavos, r.active]);
  assert.deepEqual(unitsOf('Eggs (Small)'), [['dozen', 9000, 1], ['Piece', 800, 1], ['carton', 0, 0], ['tray', 0, 0]], 'the old dozen and the capital-P Piece stay; carton and tray are added');
  assert.deepEqual(unitsOf('Etag (Sun-Dried)'), [['kg', 45000, 1], ['piece', 0, 0], ['pack', 0, 0], ['sack', 0, 0]]);
  assert.deepEqual(unitsOf('Eggplant').map(([u]) => u), ['piece', 'pack', 'sack', 'kg']);

  // plain Pour / Dress are now allowed, and the protections on saved lines are back
  const add = (feather, cut, size, n) => db.prepare(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, service_fee_centavos, line_total_centavos)
    VALUES (2, ?, 1, 'Cull Chicken', 5800, 3600, 20880, ?, 0, ?, ?, 0, 20880)`).run(n, feather, cut, size);
  add('POUR', 'NONE', null, 10); add('NOT_POUR', 'NONE', null, 11);
  assert.throws(() => add('LIVE', 'DUKOT', null, 12), /CHECK/);
  assert.throws(() => add('POUR', 'NONE', 'SMALL', 13), /CHECK/);
  assert.throws(() => db.prepare('UPDATE order_items SET weight_g = 1').run(), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM order_items').run(), /cannot be deleted/);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // the safety copy is the untouched version 7 file
  const copies = fs.readdirSync(dir).filter((f) => /\.before-v8-.*\.bak$/.test(f));
  assert.equal(copies.length, 1);
  const copy = new DatabaseSync(path.join(dir, copies[0]), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 7);
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('other_products') WHERE name = 'kind'").get().n, 0);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM order_items').get().n, 4);
  copy.close();
  db.close();

  // a second start changes nothing and makes no second copy
  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM other_product_options').get().n, after.other_product_options.length);
  assert.equal(fs.readdirSync(dir).filter((f) => /\.bak$/.test(f)).length, 1);
  again.close();
});

test('upgrade 7 -> 8: if a step fails, nothing is half-changed - the file stays at version 7 with every row, and the next start can try again', () => {
  const { dir, file } = makeVersion7Database();
  const blocker = new DatabaseSync(file);
  blocker.exec('CREATE TABLE order_items_new (x INTEGER)');          // makes the table rebuild fail part-way through the upgrade
  const dump = (d) => JSON.stringify(['orders', 'order_items', 'other_products', 'other_product_options', 'inventory_events'].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
  const before = dump(blocker);
  blocker.close();
  assert.throws(() => openDb(file), /order_items_new/);
  const check = new DatabaseSync(file);
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 7, 'still version 7');
  assert.equal(dump(check), before, 'every row is exactly as it was');
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('other_products') WHERE name = 'kind'").get().n, 0, 'no half-added column');
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('order_items_no_update','order_items_no_delete')").get().n, 2, 'the protections on saved lines are still there');
  check.exec('DROP TABLE order_items_new');
  check.close();
  assert.ok(fs.readdirSync(dir).some((f) => /\.before-v8-.*\.bak$/.test(f)), 'the safety copy was made before the first step');
  const fixed = openDb(file);                                          // the next start completes the upgrade
  assert.equal(fixed.prepare('PRAGMA user_version').get().user_version, 12);
  assert.equal(fixed.prepare('SELECT COUNT(*) AS n FROM order_items').get().n, 4);
  fixed.close();
});

test('a new database and an upgraded one end with the same table layout', () => {
  const { file } = makeVersion7Database();
  const upgraded = openDb(file);
  const fresh = openDb(':memory:');
  const layout = (d) => Object.fromEntries(['order_items', 'other_products', 'inventory_events', 'products', 'order_other_items', 'inventory_records', 'inventory_submissions', 'product_images'].map((t) => [t, d.prepare(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info('${t}')`).all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`)]));
  const a = layout(upgraded); const b = layout(fresh);
  for (const t of Object.keys(b)) assert.deepEqual([...a[t]].sort(), [...b[t]].sort(), t);
  const triggers = (d) => d.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(triggers(upgraded), triggers(fresh));
  upgraded.close(); fresh.close();
});
