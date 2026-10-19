// Revision 16 acceptance tests: the Assistant Cashier (Order List and Butcher view only, no prices), Cash on hand in the cash breakdown
// and the Daily Report, and the upgrade to version 13. Every test builds its own shop (own server, own database), so none can disturb
// another or touch real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct } from '../src/services/catalog.js';

const START = new Date('2026-10-16T02:00:00Z');
let keyN = 0;
const key = () => `r16-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

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

async function makeShop() {
  const db = openDb(':memory:');
  const clock = { now: START };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r16-inv-'));
  const config = loadConfig({ dbPath: ':memory:', inventoryDir: dir, largeWeightKg: 50, sessionIdleMinutes: 60 });
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  createUser(db, { username: 'asst', display_name: 'Assistant', role: 'assistant', password: 'assist-pass-1' });
  createUser(db, { username: 'butcher-tv', display_name: 'Butcher TV', role: 'display', password: 'butcher-pass-1' });
  const broiler = createProduct(db, adminUser, { name: 'Broiler', price: '150', category: 'BROILER' }).id;
  const server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier, assistant, tv] = [client(base), client(base), client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1'); await cashier.login('cash', 'cashier-pass-1');
  await assistant.login('asst', 'assist-pass-1'); await tv.login('butcher-tv', 'butcher-pass-1');
  const shop = {
    db, clock, server, base, admin, manager, cashier, assistant, tv, broiler,
    close: () => { server.close(); try { db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); },
    async stock(amount = 500) {
      const inv = (await manager.call('GET', '/api/inventory')).data;
      for (const row of [...inv.chicken, ...inv.other]) {
        const r = await manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: amount, reason: 'RECOUNT' });
        assert.ok(r.status < 300, JSON.stringify(r.data));
      }
    },
    order: (who, items, extra = {}) => who.call('POST', '/api/orders', { submission_key: key(), items, other_items: [], ...extra }),
  };
  await shop.stock();
  return shop;
}

const chicken = (product, heads = 1, extra = {}) => ({ product_id: product, weight: String(heads * 1.5), heads, feather: 'NOT_POUR', dara: false, cut: 'SLICE', slice_size: 'MEDIUM', ...extra });
const cashPay = (amount, received) => ({ payment: { method: 'CASH', amount, received } });

function readZip(buf) {
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
}

// ---- ADD 1: the Assistant Cashier ---------------------------------------------------------------------------------------------

test('the Assistant Cashier sees the Order List without any price, payment or cashier name, and can move and bookmark cards', async () => {
  const shop = await makeShop();
  try {
    const made = await shop.order(shop.cashier, [chicken(shop.broiler, 2)], { tracking_number: 3, customer_number: 'Maria', ...cashPay('450.00', '500') });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const id = made.data.order.id;

    const board = await shop.assistant.call('GET', '/api/board');
    assert.equal(board.status, 200);
    const card = board.data.orders.find((o) => o.id === id);
    assert.equal(card.tracking_number, 3);
    assert.equal(card.customer_number, 'Maria');
    assert.equal(card.items[0].heads, 2);
    assert.equal(card.items[0].feather, 'NOT_POUR');
    const keysOf = (v) => (Array.isArray(v) ? v.flatMap(keysOf) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keysOf(x)]) : []);
    const keys = keysOf(board.data);
    assert.deepEqual(keys.filter((k) => /centavos|price|cashier_name|discount|refund|fees?$/i.test(k)), [], 'no money field reaches the Assistant');
    assert.deepEqual(card.payments, [], 'no payment either');
    // the same board for the cashier still has the money
    assert.ok((await shop.cashier.call('GET', '/api/board')).data.orders.find((o) => o.id === id).total_centavos > 0);

    const moved = await shop.assistant.call('POST', `/api/orders/${id}/fulfillment`, { status: 'STANDBY' });
    assert.equal(moved.status, 200);
    assert.ok(!/_centavos/.test(JSON.stringify(moved.data)), 'the reply to a move carries no money either');
    assert.equal(shop.db.prepare('SELECT fulfillment_status FROM orders WHERE id = ?').get(id).fulfillment_status, 'STANDBY');
    assert.equal((await shop.assistant.call('PUT', `/api/orders/${id}/bookmark`, { bookmarked: true })).status, 200);
    assert.equal((await shop.assistant.call('GET', '/api/butcher')).status, 200, 'the Butcher view works too');
    assert.equal((await shop.assistant.call('GET', '/api/me')).data.user.role, 'assistant');
  } finally { shop.close(); }
});

test('the Assistant Cashier is refused everything else: orders, prices, details, cancel, refund, inventory, products, users, exports, reports', async () => {
  const shop = await makeShop();
  try {
    const made = await shop.order(shop.cashier, [chicken(shop.broiler)]);
    const id = made.data.order.id;
    for (const [method, url] of [['GET', '/api/config'], ['GET', '/api/orders'], ['GET', `/api/orders/${id}`], ['GET', '/api/inventory'], ['GET', '/api/advanced'],
      ['GET', '/api/products'], ['GET', '/api/users'], ['GET', '/api/export.csv'], ['GET', '/api/daily-report.xlsx'], ['GET', '/api/tracking-number/next'], ['GET', '/api/price-history']]) {
      assert.equal((await shop.assistant.call(method, url)).status, 403, `${method} ${url}`);
    }
    for (const [url, body] of [['/api/orders', { submission_key: key(), items: [chicken(shop.broiler)], other_items: [] }], [`/api/orders/${id}/cancel`, { reason_code: 'OTHER', reason_note: 'x' }],
      [`/api/orders/${id}/refund`, { reason_code: 'OTHER', reason_note: 'x' }], [`/api/orders/${id}/change`, {}], ['/api/cash-on-hand', { amount: '100' }], ['/api/cash-count', { counts: {} }],
      ['/api/expenses', { items: [{ item: 'x', amount: '1' }] }], ['/api/inventory/save', {}], ['/api/users', { username: 'x', role: 'admin', password: 'password-1' }]]) {
      assert.equal((await shop.assistant.call('POST', url, body)).status, 403, `POST ${url}`);
    }
    assert.equal(shop.db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'COMPLETED', 'nothing was canceled or refunded');
    // the Butcher TV account still cannot use the Order List
    assert.equal((await shop.tv.call('GET', '/api/board')).status, 403);
    assert.equal((await shop.tv.call('GET', '/api/butcher')).status, 200);
  } finally { shop.close(); }
});

test('the admin creates and edits an Assistant Cashier; other roles stay as they were; the report staff list leaves assistants out', async () => {
  const shop = await makeShop();
  try {
    const made = await shop.admin.call('POST', '/api/users', { username: 'asst2', display_name: 'Assistant Two', role: 'assistant', password: 'assist-pass-22' });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    assert.equal(made.data.user.role, 'assistant');
    assert.equal((await shop.admin.call('PATCH', `/api/users/${made.data.user.id}`, { role: 'cashier' })).data.user.role, 'cashier');
    assert.equal((await shop.admin.call('POST', '/api/users', { username: 'bad1', display_name: 'x', role: 'boss', password: 'assist-pass-22' })).status, 400);
    const staff = (await shop.manager.call('GET', '/api/staff')).data.staff;
    assert.ok(!staff.some((s) => s.role === 'assistant' || s.role === 'display'));
    assert.ok(staff.some((s) => s.role === 'cashier'));
  } finally { shop.close(); }
});

// ---- Change 4: Cash on hand -------------------------------------------------------------------------------------------------------

test('cash on hand: set once a day, the latest value counts, expected cash = cash on hand + cash sales - expenses, cash sales stay separate', async () => {
  const shop = await makeShop();
  try {
    const none = (await shop.cashier.call('GET', '/api/advanced')).data.money;
    assert.equal(none.cash_on_hand, null);
    assert.equal(none.cash_on_hand_centavos, 0);

    assert.equal((await shop.order(shop.cashier, [chicken(shop.broiler, 2)], { tracking_number: 1, ...cashPay('450.00', '500') })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/expenses', { items: [{ item: 'Coke', amount: '75' }] })).status, 201);
    const first = await shop.cashier.call('POST', '/api/cash-on-hand', { amount: '1500' });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(first.data.cash_on_hand_centavos, 150000);
    assert.equal(first.data.cash_on_hand.by, 'Cashier');
    assert.equal(first.data.cash_sales_centavos, 45000, 'cash sales today is its own number');
    assert.equal(first.data.expected_cash_centavos, 150000 + 45000 - 7500);

    const second = await shop.manager.call('POST', '/api/cash-on-hand', { amount: '2000.50' });
    assert.equal(second.data.cash_on_hand_centavos, 200050, 'the latest amount counts');
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM cash_on_hand').get().n, 2, 'both are kept in the history');
    assert.equal(second.data.expected_cash_centavos, 200050 + 45000 - 7500);
    assert.equal((await shop.cashier.call('POST', '/api/cash-count', { counts: { 1000: '2', 500: '1' } })).data.excess_loss_centavos, 250000 - (200050 + 45000 - 7500));
    assert.equal((await shop.cashier.call('POST', '/api/cash-on-hand', { amount: '0' })).data.cash_on_hand_centavos, 0, '0 is allowed');
  } finally { shop.close(); }
});

test('cash on hand: bad amounts are refused, saved amounts cannot be edited or deleted, and only the open day can be set', async () => {
  const shop = await makeShop();
  try {
    for (const bad of ['', 'abc', '-5', '12.345', '99999999999']) {
      assert.equal((await shop.cashier.call('POST', '/api/cash-on-hand', { amount: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await shop.cashier.call('POST', '/api/cash-on-hand', {})).status, 400);
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM cash_on_hand').get().n, 0);
    assert.equal((await shop.cashier.call('POST', '/api/cash-on-hand', { amount: '100' })).status, 201);
    assert.throws(() => shop.db.prepare('UPDATE cash_on_hand SET amount_centavos = 1').run(), /cannot be changed/);
    assert.throws(() => shop.db.prepare('DELETE FROM cash_on_hand').run(), /cannot be deleted/);
    const day = shop.db.prepare("SELECT id FROM business_days WHERE status = 'OPEN'").get().id;
    shop.db.prepare("UPDATE business_days SET status = 'CLOSED', closed_at = '2026-10-16T10:00:00Z' WHERE id = ?").run(day);
    assert.throws(() => shop.db.prepare("INSERT INTO cash_on_hand (business_day_id, amount_centavos, set_by, set_at) VALUES (?, 5, 1, 'x')").run(day), /open business day/);
  } finally { shop.close(); }
});

test('Daily Report: PLUS CASH ON HAND sits above EXPECTED CASH and is part of it (a formula and a value); EXCESS/LOSS follows', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.order(shop.cashier, [chicken(shop.broiler, 2)], { tracking_number: 1, ...cashPay('450.00', '500') })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/cash-on-hand', { amount: '1000' })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/cash-count', { counts: { 1000: '1', 100: '4', 50: '1' } })).status, 201);   // 1,450
    const xml = readZip((await shop.manager.call('GET', '/api/daily-report.xlsx?date=2026-10-16')).data)['xl/worksheets/sheet1.xml'];
    const colNum = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    const cells = [...xml.replace(/<c [^>]*\/>/g, '').matchAll(/<c r="([A-Z]+)(\d+)"[^>]*>(.*?)<\/c>/g)].map((m) => ({ col: colNum(m[1]), row: Number(m[2]), xml: m[3] }));
    const textAt = (word) => cells.find((c) => c.xml.includes(`>${word}</t>`));
    const onHand = textAt('PLUS CASH ON HAND'); const expected = textAt('EXPECTED CASH'); const noncash = textAt('LESS NON-CASH PAYMENTS'); const excess = textAt('EXCESS/LOSS');
    assert.ok(onHand && expected && noncash && excess, 'all four rows exist');
    assert.deepEqual([noncash.row, onHand.row, expected.row, excess.row], [noncash.row, noncash.row + 1, noncash.row + 2, noncash.row + 3], 'in order, one under the other');
    const valueOf = (word) => { const label = textAt(word); const next = cells.filter((c) => c.row === label.row && c.col > label.col && /<v>/.test(c.xml)); return Number(/<v>([^<]*)<\/v>/.exec(next.at(-1).xml)[1]); };
    assert.equal(valueOf('PLUS CASH ON HAND'), 1000);
    assert.equal(valueOf('EXPECTED CASH'), 450 + 1000, 'net sales 450 + cash on hand 1000');
    assert.equal(valueOf('EXCESS/LOSS'), 0, '1,450 counted = 1,450 expected');
    assert.match(xml, /<f>[A-Z]+\d+-[A-Z]+\d+\+[A-Z]+\d+<\/f>/, 'EXPECTED CASH is a formula that adds the cash on hand');
    assert.equal(xml.trim().endsWith('</worksheet>'), true);
  } finally { shop.close(); }
});

// ---- The upgrade to version 13 -----------------------------------------------------------------------------------------------------

test('upgrade to version 13: a safety copy first; every account, id and link is kept (Butcher TV included); the Assistant role and cash on hand then work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v13-'));
  const file = path.join(dir, 'pos.db');
  try {
    const first = openDb(file);
    const admin = createUser(first, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
    const tv = createUser(first, { username: 'butcher-tv', display_name: 'TV', role: 'display', password: 'butcher-pass-1' });
    first.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES ('tok', ?, '2026-10-16T00:00:00Z', '2026-10-16T00:00:00Z')").run(tv.id);
    // Pretend this file was made by Revision 15: version 12, a users rule without 'assistant', no cash_on_hand table.
    first.exec('PRAGMA foreign_keys = OFF');
    first.exec(`CREATE TABLE users_old (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('cashier','manager','admin','display')), active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)), created_at TEXT NOT NULL, deleted_at TEXT)`);
    first.exec('INSERT INTO users_old SELECT id, username, display_name, password_hash, role, active, created_at, deleted_at FROM users');
    first.exec('DROP TABLE users');
    first.exec('ALTER TABLE users_old RENAME TO users');
    first.exec('DROP TABLE cash_on_hand');
    first.exec('PRAGMA foreign_keys = ON');
    first.exec('PRAGMA user_version = 12');
    first.close();

    const db = openDb(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    assert.ok(fs.readdirSync(dir).some((f) => /\.before-v13-.*\.bak$/.test(f)), 'a safety copy was saved');
    assert.deepEqual(db.prepare('SELECT id, username, role FROM users ORDER BY id').all().map((u) => ({ ...u })),
      [{ id: admin.id, username: 'owner', role: 'admin' }, { id: tv.id, username: 'butcher-tv', role: 'display' }]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.equal(db.prepare("SELECT user_id FROM sessions WHERE token_hash = 'tok'").get().user_id, tv.id);
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(createUser(db, { username: 'asst', display_name: 'A', role: 'assistant', password: 'assist-pass-1' }).role, 'assistant');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'cash_on_hand'").get().n, 1);
    db.close();
    const again = openDb(file);
    assert.equal(again.prepare('PRAGMA user_version').get().user_version, 14, 'a second start changes nothing');
    again.close();
    void DatabaseSync;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
