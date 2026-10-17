// Revision 15 acceptance tests: the Tracking Number (unique among active chicken orders, free again after Complete / cancel / change,
// locked once saved), the Butcher screen feed, and the screen-only "display" account for the butcher TV.
// Every test builds its own shop (own server, own database), so none can disturb another or touch real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct, createOtherProduct } from '../src/services/catalog.js';

const START = new Date('2026-10-16T02:00:00Z');
let keyN = 0;
const key = () => `r14-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

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
  return { call, async login(username, password) { const r = await call('POST', '/api/login', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r; } };
}

async function makeShop({ idleMinutes = 60 } = {}) {
  const db = openDb(':memory:');
  const clock = { now: START };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r14-inv-'));
  const config = loadConfig({ dbPath: ':memory:', inventoryDir: dir, largeWeightKg: 50, sessionIdleMinutes: idleMinutes });
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  createUser(db, { username: 'cash2', display_name: 'Cashier Two', role: 'cashier', password: 'cashier-pass-2' });
  createUser(db, { username: 'butcher-tv', display_name: 'Butcher TV', role: 'display', password: 'butcher-pass-1' });
  const broiler = createProduct(db, adminUser, { name: 'Broiler', price: '150', category: 'BROILER' }).id;
  const eggs = createOtherProduct(db, adminUser, { name: 'Eggs', kind: 'EGGS', prices: { piece: '10' } });
  const server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier, cashier2, tv] = [client(base), client(base), client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1');
  await cashier.login('cash', 'cashier-pass-1'); await cashier2.login('cash2', 'cashier-pass-2');
  const shop = {
    db, clock, server, base, admin, manager, cashier, cashier2, tv, broiler, eggs,
    close: () => { server.close(); try { db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); },
    async stock(amount = 500) {
      const inv = (await manager.call('GET', '/api/inventory')).data;
      for (const row of [...inv.chicken, ...inv.other]) {
        const r = await manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: amount, reason: 'RECOUNT' });
        assert.ok(r.status < 300, JSON.stringify(r.data));
      }
    },
    order: (who, items, extra = {}) => who.call('POST', '/api/orders', { submission_key: key(), items, other_items: [], ...extra }),
    move: (id, status, who = manager) => who.call('POST', `/api/orders/${id}/fulfillment`, { status }),
  };
  await shop.stock();
  return shop;
}

const chicken = (product, heads = 1, extra = {}) => ({ product_id: product, weight: String(heads * 1.5), heads, feather: 'NOT_POUR', dara: false, cut: 'SLICE', slice_size: 'MEDIUM', ...extra });
const TAKEN = (n) => `Tracking number ${n} is already taken. Please select a different number.`;

test('a typed tracking number is saved on the order and shown in its details, the board and the list', async () => {
  const shop = await makeShop();
  try {
    const r = await shop.order(shop.cashier, [chicken(shop.broiler, 2)], { tracking_number: 5 });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.order.tracking_number, 5);
    const detail = await shop.cashier.call('GET', `/api/orders/${r.data.order.id}`);
    assert.equal(detail.data.order.tracking_number, 5);
    const board = (await shop.cashier.call('GET', '/api/board')).data.orders;
    assert.equal(board.find((o) => o.id === r.data.order.id).tracking_number, 5);
    const listed = (await shop.cashier.call('GET', '/api/orders?view=current')).data.orders;
    assert.equal(listed.find((o) => o.id === r.data.order.id).tracking_number, 5);
    const found = (await shop.cashier.call('GET', '/api/orders?q=%235&view=current')).data.orders;
    assert.deepEqual(found.map((o) => o.id), [r.data.order.id], 'searching #5 finds the order with tracking number 5');
  } finally { shop.close(); }
});

test('a number already used by an Ongoing or Standby order is refused with the exact message; both statuses keep it unavailable', async () => {
  const shop = await makeShop();
  try {
    const first = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 5 });
    assert.equal(first.status, 201);
    const dup = await shop.order(shop.cashier2, [chicken(shop.broiler)], { tracking_number: 5 });
    assert.equal(dup.status, 409);
    assert.equal(dup.data.error, TAKEN(5));
    assert.equal((await shop.move(first.data.order.id, 'STANDBY')).status, 200);
    const stillDup = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 5 });
    assert.equal(stillDup.status, 409, 'Standby still holds the number');
    assert.equal(stillDup.data.error, TAKEN(5));
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1, 'the refused orders were not saved');
  } finally { shop.close(); }
});

test('the number is free again once its order is Complete, canceled, or replaced by a change', async () => {
  const shop = await makeShop();
  try {
    const a = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 1 });
    await shop.move(a.data.order.id, 'COMPLETE');
    assert.equal((await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 1 })).status, 201, 'reused after Complete');

    const b = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 2 });
    const cancel = await shop.cashier.call('POST', `/api/orders/${b.data.order.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND', reason_note: 'test', stock_returnable: true });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
    assert.equal((await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 2 })).status, 201, 'reused after cancel');

    const c = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 3 });
    const changed = await shop.cashier.call('POST', `/api/orders/${c.data.order.id}/change`, {
      submission_key: key(), reason_code: 'CUSTOMER_CHANGED_MIND', reason_note: 'more chicken', items: [chicken(shop.broiler, 2)], other_items: [], tracking_number: 3,
    });
    assert.equal(changed.status, 201, JSON.stringify(changed.data));
    assert.equal(changed.data.order.tracking_number, 3, 'the replacement keeps the same number');
    assert.equal((await shop.order(shop.cashier2, [chicken(shop.broiler)], { tracking_number: 3 })).status, 409, 'and it is held by the replacement');
  } finally { shop.close(); }
});

test('an empty number is filled in with the lowest free one; the next-number route says what Auto would pick; 100 in use is refused', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.cashier.call('GET', '/api/tracking-number/next')).data.tracking_number, 1);
    const a = await shop.order(shop.cashier, [chicken(shop.broiler)]);
    const b = await shop.order(shop.cashier, [chicken(shop.broiler)]);
    assert.deepEqual([a.data.order.tracking_number, b.data.order.tracking_number], [1, 2]);
    await shop.move(a.data.order.id, 'COMPLETE');
    assert.equal((await shop.cashier.call('GET', '/api/tracking-number/next')).data.tracking_number, 1, 'a finished order gives its number back');
    // Fill 1 to 100 directly, then ask for another.
    const ins = shop.db.prepare("UPDATE orders SET tracking_number = ? WHERE id = ?");
    shop.db.prepare("UPDATE orders SET fulfillment_status = 'COMPLETE' WHERE id = ?").run(b.data.order.id);
    for (let n = 1; n <= 100; n += 1) {
      const o = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: n });
      assert.equal(o.status, 201, `number ${n}: ${JSON.stringify(o.data)}`);
    }
    assert.equal((await shop.cashier.call('GET', '/api/tracking-number/next')).data.tracking_number, null);
    const full = await shop.order(shop.cashier, [chicken(shop.broiler)]);
    assert.equal(full.status, 409);
    assert.equal(full.data.code, 'TRACKING_FULL');
    void ins;
  } finally { shop.close(); }
});

test('only whole numbers 1 to 100 are accepted, and only on orders that have chicken', async () => {
  const shop = await makeShop();
  try {
    for (const bad of [0, 101, -3, 2.5, 'abc']) {
      const r = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: bad });
      assert.equal(r.status, 400, `${bad}`);
    }
    const eggsOnly = await shop.cashier.call('POST', '/api/orders', {
      submission_key: key(), items: [], other_items: [{ other_product_id: shop.eggs.id, option_id: shop.eggs.options[0].id, quantity: '2' }], tracking_number: 7,
    });
    assert.equal(eggsOnly.status, 400, 'a number on an order without chicken is refused');
    const noChicken = await shop.cashier.call('POST', '/api/orders', { submission_key: key(), items: [], other_items: [{ other_product_id: shop.eggs.id, option_id: shop.eggs.options[0].id, quantity: '2' }] });
    assert.equal(noChicken.status, 201, JSON.stringify(noChicken.data));
    assert.equal(noChicken.data.order.tracking_number, null, 'no chicken, no tracking number');
    const hash = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: '#12' });
    assert.equal(hash.data.order.tracking_number, 12, 'a leading # is ignored');
  } finally { shop.close(); }
});

test('two cashiers saving at the same moment cannot both get the same number', async () => {
  const shop = await makeShop();
  try {
    const results = await Promise.all([
      shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 9 }),
      shop.order(shop.cashier2, [chicken(shop.broiler)], { tracking_number: 9 }),
      shop.order(shop.manager, [chicken(shop.broiler)], { tracking_number: 9 }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409]);
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE tracking_number = 9').get().n, 1);
  } finally { shop.close(); }
});

test('the database itself refuses a duplicate active number and any edit of a saved number', async () => {
  const shop = await makeShop();
  try {
    const a = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 4 });
    const b = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 6 });
    assert.throws(() => shop.db.prepare('UPDATE orders SET tracking_number = 4 WHERE id = ?').run(b.data.order.id), /cannot be changed/);
    assert.throws(() => shop.db.prepare('UPDATE orders SET tracking_number = NULL WHERE id = ?').run(a.data.order.id), /cannot be changed/);
    // The unique index stands on its own: put the other order's number back in play by completing/reopening directly.
    shop.db.prepare("UPDATE orders SET fulfillment_status = 'COMPLETE' WHERE id = ?").run(a.data.order.id);
    const c = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 4 });
    assert.equal(c.status, 201);
    assert.throws(() => shop.db.prepare("UPDATE orders SET fulfillment_status = 'ONGOING' WHERE id = ?").run(a.data.order.id), /UNIQUE/);
  } finally { shop.close(); }
});

test('moving a Complete order back to Ongoing is refused when its number has been reused', async () => {
  const shop = await makeShop();
  try {
    const a = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 8 });
    await shop.move(a.data.order.id, 'COMPLETE');
    const back = await shop.move(a.data.order.id, 'ONGOING');
    assert.equal(back.status, 200, 'while the number is still free it may move back');
    await shop.move(a.data.order.id, 'COMPLETE');
    const b = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 8 });
    assert.equal(b.status, 201);
    const refused = await shop.move(a.data.order.id, 'STANDBY');
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Tracking number 8 is now used by ORD-/);
  } finally { shop.close(); }
});

test('Butcher screen feed: only Ongoing and Standby chicken orders, oldest first, with preparation and no prices', async () => {
  const shop = await makeShop();
  try {
    const a = await shop.order(shop.cashier, [chicken(shop.broiler, 2)], { tracking_number: 1, customer_number: 'Maria' });
    const b = await shop.order(shop.cashier, [chicken(shop.broiler, 1, { feather: 'POUR', cut: 'NONE', slice_size: null })], { tracking_number: 2 });
    const done = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 3 });
    const canceled = await shop.order(shop.cashier, [chicken(shop.broiler)], { tracking_number: 4 });
    await shop.cashier.call('POST', `/api/orders/${canceled.data.order.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND', reason_note: 'x', stock_returnable: true });
    await shop.move(done.data.order.id, 'COMPLETE');
    await shop.move(b.data.order.id, 'STANDBY');
    await shop.cashier.call('POST', '/api/orders', { submission_key: key(), items: [], other_items: [{ other_product_id: shop.eggs.id, option_id: shop.eggs.options[0].id, quantity: '2' }] });

    const feed = (await shop.tv.login('butcher-tv', 'butcher-pass-1'), (await shop.tv.call('GET', '/api/butcher')));
    assert.equal(feed.status, 200, JSON.stringify(feed.data));
    assert.deepEqual(feed.data.orders.map((o) => [o.tracking_number, o.fulfillment_status]), [[1, 'ONGOING'], [2, 'STANDBY']]);
    const first = feed.data.orders[0];
    assert.equal(first.customer_number, 'Maria');
    assert.equal(first.items[0].heads, 2);
    assert.equal(first.items[0].feather, 'NOT_POUR');
    assert.equal(first.items[0].cut, 'SLICE');
    assert.equal(first.items[0].slice_size, 'MEDIUM');
    const text = JSON.stringify(feed.data);
    assert.ok(!/centavos|price|payment|cashier/i.test(text), 'no money and no cashier names reach the TV');
    assert.equal((await shop.cashier.call('GET', '/api/butcher')).status, 200, 'staff may open it too (to check the screen)');
  } finally { shop.close(); }
});

test('the display account opens the butcher feed and is refused everything else', async () => {
  const shop = await makeShop();
  try {
    await shop.tv.login('butcher-tv', 'butcher-pass-1');
    assert.equal((await shop.tv.call('GET', '/api/me')).data.user.role, 'display');
    assert.equal((await shop.tv.call('GET', '/api/butcher')).status, 200);
    for (const [method, url] of [['GET', '/api/board'], ['GET', '/api/orders'], ['GET', '/api/config'], ['GET', '/api/products'], ['GET', '/api/inventory'], ['GET', '/api/users'], ['GET', '/api/export.csv'], ['GET', '/api/tracking-number/next']]) {
      assert.equal((await shop.tv.call(method, url)).status, 403, `${method} ${url}`);
    }
    assert.equal((await shop.tv.call('POST', '/api/orders', { submission_key: key(), items: [chicken(shop.broiler)], other_items: [] })).status, 403);
    assert.equal((await shop.tv.call('POST', '/api/orders/1/fulfillment', { status: 'COMPLETE' })).status, 403);
    const anon = client(shop.base);
    assert.equal((await anon.call('GET', '/api/butcher')).status, 401, 'signed-out visitors get nothing');
  } finally { shop.close(); }
});

test('the display account never times out from idleness, and keeps its cookie for a year; others still do', async () => {
  const shop = await makeShop({ idleMinutes: 30 });
  try {
    const login = await shop.tv.login('butcher-tv', 'butcher-pass-1');
    const cookie = login.headers.getSetCookie()[0];
    assert.match(cookie, /Max-Age=31536000/);
    const cashLogin = await client(shop.base).login('cash', 'cashier-pass-1');
    assert.match(cashLogin.headers.getSetCookie()[0], /Max-Age=604800/);
    shop.clock.now = new Date(START.getTime() + 5 * 24 * 3600_000);   // five days of nobody touching it
    assert.equal((await shop.tv.call('GET', '/api/butcher')).status, 200, 'the TV is still signed in');
    assert.equal((await shop.cashier.call('GET', '/api/board')).status, 401, 'a cashier idle that long is signed out');
  } finally { shop.close(); }
});

test('the display account is created and edited like any other account, and is not offered in the report staff list', async () => {
  const shop = await makeShop();
  try {
    const made = await shop.admin.call('POST', '/api/users', { username: 'tv2', display_name: 'TV 2', role: 'display', password: 'tv-pass-12345' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(made.data.user.role, 'display');
    const staff = (await shop.manager.call('GET', '/api/staff')).data.staff;
    assert.ok(!staff.some((s) => s.role === 'display'));
    const bad = await shop.admin.call('POST', '/api/users', { username: 'tv3', display_name: 'x', role: 'kiosk', password: 'tv-pass-12345' });
    assert.equal(bad.status, 400);
  } finally { shop.close(); }
});

test('upgrade to version 12: a safety copy first; old orders keep every value and simply have no tracking number; the rules then apply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v12-'));
  const file = path.join(dir, 'pos.db');
  try {
    const first = openDb(file);
    const admin = createUser(first, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
    const p = createProduct(first, admin, { name: 'Broiler', price: '150', category: 'BROILER' });
    first.prepare("INSERT INTO business_days (business_date, status, opened_at) VALUES ('2026-10-16', 'OPEN', '2026-10-16T00:00:00Z')").run();
    first.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key, business_day_id)
                   VALUES ('ORD-OLD-1', '2026-10-16', 'COMPLETED', 100, 100, ?, '2026-10-16T01:00:00Z', 'old-key-0001', 1)`).run(admin.id);
    void p;
    // Pretend this file was made by Revision 13: no tracking column, version 11, the old trigger.
    first.exec('DROP INDEX one_active_tracking_number');
    first.exec('DROP TRIGGER orders_immutable_fields');
    first.exec('ALTER TABLE orders DROP COLUMN tracking_number');
    // ... and a users table that only allows the three old roles, with a sign-in and a deleted account's gap in the ids.
    first.exec('PRAGMA foreign_keys = OFF');
    first.exec(`CREATE TABLE users_old (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('cashier','manager','admin')), active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at TEXT NOT NULL, deleted_at TEXT)`);
    first.exec('INSERT INTO users_old SELECT id, username, display_name, password_hash, role, active, created_at, deleted_at FROM users');
    first.exec('DROP TABLE users');
    first.exec('ALTER TABLE users_old RENAME TO users');
    first.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES ('abc', ?, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z')").run(admin.id);
    first.exec("UPDATE sqlite_sequence SET seq = 7 WHERE name = 'users'");
    first.exec('PRAGMA foreign_keys = ON');
    first.exec('PRAGMA user_version = 11');
    first.close();

    const db = openDb(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
    assert.ok(fs.readdirSync(dir).some((f) => /\.before-v12-.*\.bak$/.test(f)), 'a safety copy was saved');
    const old = db.prepare("SELECT * FROM orders WHERE order_number = 'ORD-OLD-1'").get();
    assert.equal(old.tracking_number, null);
    assert.equal(old.total_centavos, 100);
    // The users table was rebuilt: same people, same ids, every link still valid, and the new role is allowed.
    assert.deepEqual(db.prepare('SELECT id, username, role FROM users').all().map((u) => ({ ...u })), [{ id: admin.id, username: 'owner', role: 'admin' }]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare("SELECT user_id FROM sessions WHERE token_hash = 'abc'").get().user_id, admin.id);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'foreign keys are back on');
    assert.equal(createUser(db, { username: 'butcher-tv', display_name: 'TV', role: 'display', password: 'tv-pass-12345' }).id, 8, 'the id counter carried over');
    assert.throws(() => db.prepare('UPDATE orders SET tracking_number = 3 WHERE id = ?').run(old.id), /cannot be changed/, 'the trigger was replaced');
    const again = openDb(file);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 12, 'a second start changes nothing');
    again.close(); db.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Live chicken is not butchered: an order with only Live chicken has no tracking number and never reaches the Butcher screen; a mixed order is tagged and shows only the prepared chicken', async () => {
  const shop = await makeShop();
  try {
    const liveLine = (heads = 1) => chicken(shop.broiler, heads, { feather: 'LIVE', cut: 'NONE', slice_size: null });
    const liveOnly = await shop.order(shop.cashier, [liveLine(2)]);
    assert.equal(liveOnly.status, 201, JSON.stringify(liveOnly.data));
    assert.equal(liveOnly.data.order.tracking_number, null);
    const typed = await shop.order(shop.cashier, [liveLine()], { tracking_number: 5 });
    assert.equal(typed.status, 400, 'a number on a Live-only order is refused');
    assert.equal((await shop.cashier.call('GET', '/api/tracking-number/next')).data.tracking_number, 1, 'Live orders use up no numbers');

    const mixed = await shop.order(shop.cashier, [liveLine(3), chicken(shop.broiler, 1, { feather: 'POUR', cut: 'NONE', slice_size: null })]);
    assert.equal(mixed.status, 201, JSON.stringify(mixed.data));
    assert.equal(mixed.data.order.tracking_number, 1);

    await shop.tv.login('butcher-tv', 'butcher-pass-1');
    const feed = (await shop.tv.call('GET', '/api/butcher')).data.orders;
    assert.deepEqual(feed.map((o) => o.tracking_number), [1], 'only the mixed order is on the screen');
    assert.equal(feed[0].items.length, 1, 'its Live line is not listed');
    assert.equal(feed[0].items[0].feather, 'POUR');
  } finally { shop.close(); }
});
