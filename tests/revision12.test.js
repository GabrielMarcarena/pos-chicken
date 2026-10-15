// Revision 12 acceptance tests: the ref stock (Katay / Dead kept in the ref, stored from New order > Advanced or typed on the Daily Inventory),
// the cash breakdown and expenses (and what the Daily Report makes of them), Close the day and reset in one step, the closed-day Export,
// the Sales List (Excel) with fitted columns, assorted eggs, clear-records, and the upgrade to version 10.
// Every test builds its own shop (own server, own database, own inventory folder), so none can disturb another or touch real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct, createOtherProduct, seedStarterCatalog, seedRevision11Products, listProducts, listOtherProducts } from '../src/services/catalog.js';
import { gatherDaily, buildModel } from '../src/services/dailyReport.js';
import { eggSizeOf } from '../shared/constants.js';
import { CSV_HEADERS } from '../src/services/export.js';
import { clearRecords, countRecords } from '../src/clearRecords.js';

const START = new Date('2026-10-15T02:00:00Z');   // 10:00 on Thursday 15 Oct 2026 in the Philippines
let keyN = 0;
const key = () => `r12-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

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

/** A shop as it would be after the first start of Revision 12: starter products, Brown Cull Chicken, Ducks and Catfish, with SAMPLE prices. */
async function makeShop() {
  const db = openDb(':memory:');
  const clock = { now: START };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r12-inv-'));
  const config = loadConfig({ dbPath: ':memory:', inventoryDir: dir, largeWeightKg: 50, sessionIdleMinutes: 60 * 24 * 365 });
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  const whole = createProduct(db, adminUser, { name: 'Whole Chicken', price: '120' }).id;
  seedRevision11Products(db, START);
  const server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier] = [client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1'); await cashier.login('cash', 'cashier-pass-1');
  const brown = listProducts(db, { includeInactive: true }).find((p) => p.name === 'Brown Cull Chicken');
  const other = (name) => listOtherProducts(db, { includeInactive: true }).find((p) => p.name === name);
  const shop = {
    db, clock, dir, server, base, admin, manager, cashier, whole, brown: brown.id,
    close: () => { server.close(); try { db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); },
    other, option: (name, unit) => { const p = other(name); return { product: p.id, id: p.options.find((o) => o.unit === unit).id }; },
    inventory: async (who = manager, query = '') => (await who.call('GET', `/api/inventory${query}`)).data,
    async row(name, query = '') { const inv = await shop.inventory(manager, query); return [...inv.chicken, ...inv.other].find((r) => r.name === name); },
    async set(name, fields, who = manager) {
      const row = await shop.row(name);
      assert.ok(row, `no inventory row called ${name}`);
      return who.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, ...fields });
    },
    order: (who, items = [], others = [], extra = {}) => who.call('POST', '/api/orders', { submission_key: key(), items, other_items: others, ...extra }),
    move: (id, status, who = manager) => who.call('POST', `/api/orders/${id}/fulfillment`, { status }),
    submit: (date, who = manager) => who.call('POST', '/api/inventory/submit', { business_date: date }),
    close2: (date, who = manager) => who.call('POST', '/api/inventory/close-day', { business_date: date }),
    check: async (who = manager) => (await who.call('GET', '/api/inventory/close-check')).data,
  };
  // SAMPLE prices (test data only): Brown Cull ₱56/kg; Ducks ₱320/kg or ₱900 a piece; Catfish ₱160/kg.
  assert.equal((await admin.call('PATCH', `/api/products/${brown.id}`, { price: '56', active: true })).status, 200);
  for (const [name, unit, price] of [['Ducks', 'kg', '320'], ['Ducks', 'piece', '900'], ['Catfish', 'kg', '160']]) {
    assert.equal((await admin.call('PATCH', `/api/other-product-options/${shop.option(name, unit).id}`, { price })).status, 200);
  }
  return shop;
}

const live = (product, heads = 1, extra = {}) => ({ product_id: product, weight: String(heads * 1.5), heads, feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null, ...extra });
const byKg = (opt, kg, pieces) => ({ other_product_id: opt.product, option_id: opt.id, quantity: String(kg), ...(pieces === undefined ? {} : { pieces }) });
const fixed = (opt, n) => ({ other_product_id: opt.product, option_id: opt.id, quantity: String(n) });

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
const sheetNames = (files) => [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
const sheet = (files, name) => files[`xl/worksheets/sheet${sheetNames(files).indexOf(name) + 1}.xml`];
/** The text and numbers of each row of a sheet, in order: [['Whole Chicken', 10, 5, ...], ...] */
const sheetRows = (xml) => [...xml.matchAll(/<row r="\d+"[^>]*>(.*?)<\/row>/g)].map((m) => [...m[1].matchAll(/<c r="[A-Z]+\d+"[^>]*?(?:\/>|>(.*?)<\/c>)/g)]
  .map((c) => { const inner = c[1] ?? ''; const t = /<t[^>]*>(.*?)<\/t>/.exec(inner); if (t) return t[1].replace(/&amp;/g, '&'); const v = /<v>(.*?)<\/v>/.exec(inner); return v ? Number(v[1]) : null; })
  .filter((v) => v !== null));


const ref = (kind, heads, kg, price) => ({ kind, heads, weight: String(kg), price_per_kg: String(price) });
const store = (shop, who, kind, heads, kg, product = shop.whole) => who.call('POST', '/api/ref/store', { kind, product_id: product, heads, weight: String(kg) });
const refHeads = async (shop, kind) => (await shop.cashier.call('GET', '/api/advanced')).data.ref.kinds.find((k) => k.kind === kind).heads;
const money = async (shop, who = shop.cashier) => (await who.call('GET', '/api/advanced')).data.money;
const reportFiles = async (shop, query = '') => readZip((await shop.manager.call('GET', `/api/daily-report.xlsx?date=2026-10-15${query}`)).data);

// ---- 1. Storing in the ref (New order > Advanced) ------------------------------------------------------------------------

test('Store in the ref: a cashier puts Katay or Dead in the ref; the chicken\'s Katay / Dead on the Daily Inventory goes up by the same heads', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    const r = await store(shop, shop.cashier, 'KATAY', 2, 3.2);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await store(shop, shop.cashier, 'DEAD', 1, 1.4)).status, 201);
    assert.equal(await refHeads(shop, 'KATAY'), 2);
    assert.equal(await refHeads(shop, 'DEAD'), 1);
    const row = await shop.row('Whole Chicken');
    assert.deepEqual([row.katay, row.dead, row.new_total], [2000, 1000, 7000], 'Katay and Dead are inventory losses: 10 - 2 - 1 = 7');
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM inventory_events WHERE field IN ('katay','dead')").get().n, 2, 'the Daily Inventory history has both');
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM ref_stock_entries').get().n, 2);
    // the same rule as typing it on the inventory: Reject + Katay + Dead + Pull Out may not be more than what is Left
    const tooMany = await store(shop, shop.cashier, 'KATAY', 9, 9);
    assert.equal(tooMany.status, 409, JSON.stringify(tooMany.data));
    assert.equal(await refHeads(shop, 'KATAY'), 2, 'a refused store changes nothing in the ref');
    assert.equal((await shop.row('Whole Chicken')).katay, 2000, 'and nothing on the inventory');
    // bad input and signed-out
    for (const bad of [{ kind: 'REJECT', heads: 1, weight: '1' }, { kind: 'KATAY', heads: 0, weight: '1' }, { kind: 'KATAY', heads: 1.5, weight: '1' },
      { kind: 'KATAY', heads: 1, weight: '0' }, { kind: 'KATAY', heads: 1, weight: 'abc' }, { kind: 'KATAY', heads: 1, weight: '1', product_id: 99999 }]) {
      const res = await shop.cashier.call('POST', '/api/ref/store', { product_id: shop.whole, ...bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
    assert.equal((await client(shop.base).call('POST', '/api/ref/store', { kind: 'KATAY', product_id: shop.whole, heads: 1, weight: '1' })).status, 401);
    assert.throws(() => shop.db.prepare('UPDATE ref_stock_entries SET heads = 99').run(), /cannot be changed/);
    assert.throws(() => shop.db.prepare('DELETE FROM ref_stock_entries').run(), /cannot be deleted/);
  } finally { shop.close(); }
});

test('Selling from the ref: by the kilo at the typed price, no service fee, no discount; short stock is refused; cancel gives the heads back; a refund does not', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    assert.equal((await store(shop, shop.cashier, 'KATAY', 3, 4.5)).status, 201);
    const sold = await shop.order(shop.cashier, [], [], { ref_items: [ref('KATAY', 2, 2.5, 100)] });
    assert.equal(sold.status, 201, JSON.stringify(sold.data));
    assert.equal(sold.data.order.total_centavos, 25000, '2.5 kg x ₱100 = ₱250.00, nothing added');
    assert.equal(sold.data.order.discount.amount_centavos, 0, 'the cashier adds any discount, never the system');
    assert.equal(await refHeads(shop, 'KATAY'), 1);
    const row = await shop.row('Whole Chicken');
    assert.deepEqual([row.sold, row.katay], [0, 3000], 'the Daily Inventory Sold is not touched: the heads already left as Katay');
    // only 1 head left in the ref
    const short = await shop.order(shop.cashier, [], [], { ref_items: [ref('KATAY', 2, 2, 100)] });
    assert.equal(short.status, 409, JSON.stringify(short.data));
    assert.match(JSON.stringify(short.data), /Insufficient stock/);
    assert.equal(await refHeads(shop, 'KATAY'), 1);
    // Dead is a separate pile
    assert.equal((await shop.order(shop.cashier, [], [], { ref_items: [ref('DEAD', 1, 1, 90)] })).status, 409);
    // bad prices and weights
    for (const bad of [ref('KATAY', 1, 1, 0), ref('KATAY', 1, 0, 100), ref('KATAY', 0, 1, 100), ref('KATAY', 1, 1, 'abc'), ref('ALIVE', 1, 1, 100)]) {
      assert.equal((await shop.order(shop.cashier, [], [], { ref_items: [bad] })).status, 400, JSON.stringify(bad));
    }
    // a canceled order gives its heads back
    const cancel = await shop.cashier.call('POST', `/api/orders/${sold.data.order.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
    assert.equal(await refHeads(shop, 'KATAY'), 3);
    // a refunded order does not
    const second = await shop.order(shop.cashier, [], [], { ref_items: [ref('KATAY', 2, 2.5, 100)] });
    assert.equal(second.status, 201);
    assert.equal(await refHeads(shop, 'KATAY'), 1);
    const refund = await shop.manager.call('POST', `/api/orders/${second.data.order.id}/refund`, { reason_code: 'WRONG_PRODUCT' });
    assert.equal(refund.status, 200, JSON.stringify(refund.data));
    assert.equal(await refHeads(shop, 'KATAY'), 1, 'a refund does not put the heads back in the ref');
    // the slip and the order list show the ref line
    const full = (await shop.cashier.call('GET', `/api/orders/${second.data.order.id}`)).data.order;
    assert.equal(full.ref_items.length, 1);
    assert.equal(full.ref_items[0].heads, 2);
  } finally { shop.close(); }
});

test('Changing an order that holds ref heads releases them for the new order', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    assert.equal((await store(shop, shop.cashier, 'DEAD', 2, 2.8)).status, 201);
    const first = await shop.order(shop.cashier, [], [], { ref_items: [ref('DEAD', 2, 2.8, 80)] });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    assert.equal(await refHeads(shop, 'DEAD'), 0);
    const changed = await shop.cashier.call('POST', `/api/orders/${first.data.order.id}/change`, {
      reason_code: 'WRONG_WEIGHT', submission_key: key(), items: [], other_items: [], ref_items: [ref('DEAD', 2, 2.6, 80)],
    });
    assert.equal(changed.status, 201, JSON.stringify(changed.data));
    assert.equal(await refHeads(shop, 'DEAD'), 0, 'the new order holds the same 2 heads; they were not counted twice');
  } finally { shop.close(); }
});

// ---- 2. Typing Katay / Dead on the Daily Inventory ---------------------------------------------------------------------------

test('Daily Inventory: Katay typed higher goes into the ref only when the person says so; typed lower takes back only what came from that row', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    const yes = await shop.set('Whole Chicken', { katay: 3, to_ref: true });
    assert.equal(yes.status, 200, JSON.stringify(yes.data));
    assert.equal(await refHeads(shop, 'KATAY'), 3);
    const no = await shop.set('Whole Chicken', { katay: 5, to_ref: false });
    assert.equal(no.status, 200);
    assert.equal(await refHeads(shop, 'KATAY'), 3, 'No: the Daily Inventory goes up, the ref does not');
    assert.equal((await shop.set('Whole Chicken', { dead: 1 })).status, 200);
    assert.equal(await refHeads(shop, 'DEAD'), 0, 'no answer means not from the ref');
    assert.equal((await shop.set('Whole Chicken', { katay: 4 })).status, 200);
    assert.equal(await refHeads(shop, 'KATAY'), 2, 'lowered by 1: one head comes back out of the ref');
    assert.equal((await shop.set('Whole Chicken', { katay: 0 })).status, 200);
    assert.equal(await refHeads(shop, 'KATAY'), 0, 'lowered by 4 but only the 3 that came in (2 left) can leave the ref');
    assert.equal((await shop.set('Whole Chicken', { katay: 1, to_ref: 'yes' })).status, 400, 'the answer is yes or no');
    const corrections = shop.db.prepare("SELECT heads FROM ref_stock_entries WHERE source = 'CORRECTION' ORDER BY id").all().map((e) => e.heads);
    assert.deepEqual(corrections, [-1, -2]);
  } finally { shop.close(); }
});

test('Daily Inventory: heads that were already sold from the ref cannot be taken back out (REF_SOLD)', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    assert.equal((await shop.set('Whole Chicken', { dead: 3, to_ref: true })).status, 200);
    assert.equal((await shop.order(shop.cashier, [], [], { ref_items: [ref('DEAD', 2, 3, 70)] })).status, 201);
    const row = await shop.row('Whole Chicken');
    const res = await shop.manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, dead: 0 });
    assert.equal(res.status, 409, JSON.stringify(res.data));
    assert.equal(res.data.code, 'REF_SOLD');
    assert.equal((await shop.row('Whole Chicken')).dead, 3000, 'nothing changed');
    assert.equal(await refHeads(shop, 'DEAD'), 1);
    assert.equal((await shop.set('Whole Chicken', { dead: 2 })).status, 200, 'taking back the 1 head still in the ref is fine');
  } finally { shop.close(); }
});

// ---- 3. Close the day and reset, in one step; Export of a closed day -------------------------------------------------------------

test('Close the day and reset: submits and closes in one step; a failure leaves no file and the day open; an Ongoing order still blocks it', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    const o = (await shop.order(shop.cashier, [live(shop.whole, 2)])).data.order;
    // Ongoing blocks
    const blocked = await shop.manager.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15', submit: true });
    assert.equal(blocked.status, 409, JSON.stringify(blocked.data));
    assert.equal(shop.db.prepare("SELECT status FROM business_days WHERE business_date = '2026-10-15'").get().status, 'OPEN');
    assert.deepEqual(fs.readdirSync(shop.dir), [], 'a blocked close leaves no file');
    await shop.move(o.id, 'COMPLETE');
    // a broken count fails the whole thing: no file, day still open
    shop.db.prepare('UPDATE inventory_records SET beginning_milli = 0 WHERE product_id = ?').run(shop.whole);
    const broken = await shop.manager.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15', submit: true });
    assert.equal(broken.status, 409, JSON.stringify(broken.data));
    assert.deepEqual(fs.readdirSync(shop.dir), []);
    assert.equal(shop.db.prepare("SELECT status FROM business_days WHERE business_date = '2026-10-15'").get().status, 'OPEN');
    shop.db.prepare('UPDATE inventory_records SET beginning_milli = 10000 WHERE product_id = ?').run(shop.whole);
    // cashiers cannot
    assert.equal((await shop.cashier.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15', submit: true })).status, 403);
    // a reminder, not a block, when no cash was counted
    const check = (await shop.manager.call('GET', '/api/inventory/close-check?submit=1')).data;
    assert.ok(JSON.stringify(check).includes('NO_CASH_COUNT'), JSON.stringify(check));
    const done = await shop.manager.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15', submit: true });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(shop.db.prepare("SELECT status FROM business_days WHERE business_date = '2026-10-15'").get().status, 'CLOSED');
    assert.equal(fs.readdirSync(shop.dir).filter((f) => f.endsWith('.xlsx')).length, 1, 'the submitted file is saved');
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM inventory_submissions').get().n, 1);
    // closing again is refused (the day is closed)
    assert.notEqual((await shop.manager.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15', submit: true })).status, 200);
  } finally { shop.close(); }
});

// ---- 4. Cash breakdown --------------------------------------------------------------------------------------------------

test('Cash breakdown: every bill and coin, validated; the latest count of the day wins; the earlier ones stay; it is append-only', async () => {
  const shop = await makeShop();
  try {
    const first = await shop.cashier.call('POST', '/api/cash-count', { counts: { 1000: '2', 500: '1', 200: '', 100: '3', 50: '4', 20: '5', 10: '6', 5: '7', 1: '8', '0.25': '9' } });
    assert.equal(first.status, 201, JSON.stringify(first.data));
    // 2000 + 500 + 300 + 200 + 100 + 60 + 35 + 8 + 2.25 = 3205.25
    assert.equal(first.data.cash_count.total_centavos, 320525);
    const second = await shop.cashier.call('POST', '/api/cash-count', { counts: { 1000: '1' } });
    assert.equal(second.data.cash_count.total_centavos, 100000);
    assert.equal((await money(shop)).cash_count.total_centavos, 100000, 'the latest count is the count of the day');
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM cash_counts').get().n, 2, 'the earlier count stays in the history');
    for (const bad of [{ 500: 'x' }, { 500: '-1' }, { 500: '1.5' }, { 500: '100000' }, { 2000: '1' }]) {
      assert.equal((await shop.cashier.call('POST', '/api/cash-count', { counts: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await shop.cashier.call('POST', '/api/cash-count', {})).status, 400);
    assert.equal((await client(shop.base).call('POST', '/api/cash-count', { counts: {} })).status, 401);
    assert.throws(() => shop.db.prepare('UPDATE cash_counts SET total_centavos = 1').run(), /cannot be changed/);
    assert.throws(() => shop.db.prepare('DELETE FROM cash_counts').run(), /cannot be deleted/);
  } finally { shop.close(); }
});

// ---- 5. Expenses ----------------------------------------------------------------------------------------------------------

test('Expenses: Coke 75 + Bread 35 + Meal 200 = 310; a mistake is removed (kept, marked); a cashier removes only their own; a closed day is locked', async () => {
  const shop = await makeShop();
  try {
    const add = await shop.cashier.call('POST', '/api/expenses', { items: [{ item: 'Coke', amount: '75' }, { item: 'Bread', amount: '35' }, { item: 'Meal', amount: '200' }] });
    assert.equal(add.status, 201, JSON.stringify(add.data));
    assert.equal(add.data.expenses_total_centavos, 31000);
    // one wrong line saves nothing
    const bad = await shop.cashier.call('POST', '/api/expenses', { items: [{ item: 'Ice', amount: '20' }, { item: '', amount: '5' }] });
    assert.equal(bad.status, 400);
    for (const item of [{ item: 'Ice', amount: '0' }, { item: 'Ice', amount: 'abc' }, { item: 'Ice', amount: '-5' }, { item: 'Ice', amount: '99999999' }]) {
      assert.equal((await shop.cashier.call('POST', '/api/expenses', { items: [item] })).status, 400, JSON.stringify(item));
    }
    assert.equal((await shop.cashier.call('POST', '/api/expenses', { items: [] })).status, 400);
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM expenses').get().n, 3, 'nothing from the refused requests was saved');
    const mgr = await shop.manager.call('POST', '/api/expenses', { items: [{ item: 'Gas', amount: '500' }] });
    assert.equal(mgr.data.expenses_total_centavos, 81000);
    const [coke, , , gas] = mgr.data.expenses;
    assert.equal((await shop.cashier.call('POST', `/api/expenses/${gas.id}/remove`, {})).status, 403, 'a cashier cannot remove what a manager typed');
    const rm = await shop.cashier.call('POST', `/api/expenses/${coke.id}/remove`, { note: 'typed twice' });
    assert.equal(rm.status, 200, JSON.stringify(rm.data));
    assert.equal(rm.data.expenses_total_centavos, 73500);
    const removed = rm.data.expenses.find((e) => e.id === coke.id);
    assert.deepEqual([removed.removed, removed.remove_note, removed.removed_by], [true, 'typed twice', 'Cashier']);
    assert.equal((await shop.cashier.call('POST', `/api/expenses/${coke.id}/remove`, {})).status, 409, 'removed once only');
    assert.equal((await shop.manager.call('POST', `/api/expenses/${gas.id}/remove`, {})).status, 200, 'a manager removes any');
    assert.equal((await shop.cashier.call('POST', '/api/expenses/99999/remove', {})).status, 404);
    assert.throws(() => shop.db.prepare('DELETE FROM expenses').run(), /cannot be deleted/);
    assert.throws(() => shop.db.prepare("UPDATE expenses SET amount_centavos = 1 WHERE removed_at IS NULL").run());
    // close the day: its expenses and counts are history
    assert.equal((await shop.set('Whole Chicken', { beginning: 1 })).status, 200);
    assert.equal((await shop.manager.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15', submit: true })).status, 200);
    assert.throws(() => shop.db.prepare("UPDATE expenses SET removed_at = '2026-10-16T00:00:00Z' WHERE removed_at IS NULL").run());
    const closedDayId = shop.db.prepare("SELECT id FROM business_days WHERE business_date = '2026-10-15'").get().id;
    assert.throws(() => shop.db.prepare("INSERT INTO expenses (business_day_id, item, amount_centavos, created_by, created_at) VALUES (?, 'Late', 100, 1, '2026-10-16T00:00:00Z')").run(closedDayId));
    assert.throws(() => shop.db.prepare("INSERT INTO cash_counts (business_day_id, counts, total_centavos, counted_by, counted_at) VALUES (?, '{}', 0, 1, '2026-10-16T00:00:00Z')").run(closedDayId));
  } finally { shop.close(); }
});

// ---- 6. Daily Sales Report ---------------------------------------------------------------------------------------------------------

test('Daily Report: Katay/Dead (REF) block, expense rows, LESS EXPENSES, the cash breakdown, EXPECTED CASH and EXCESS/LOSS', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 20 })).status, 200);
    // A: ₱180 in cash (1.5 kg x ₱120). B: ₱180 by GCash. C: Katay 1.2 kg x ₱150 = ₱180, no payment recorded (counts as cash).
    const a = await shop.order(shop.cashier, [live(shop.whole, 1)], [], { payment: { method: 'CASH', received: '200' } });
    const b = await shop.order(shop.cashier, [live(shop.whole, 1)], [], { payment: { method: 'GCASH', amount: '180', paid_at: '2026-10-15T10:15', account_name: 'Juan', account_number: '09171234567', reference: 'REF 1' } });
    assert.equal(a.status, 201, JSON.stringify(a.data)); assert.equal(b.status, 201, JSON.stringify(b.data));
    assert.equal((await store(shop, shop.cashier, 'KATAY', 2, 2.4)).status, 201);
    const c = await shop.order(shop.cashier, [], [], { ref_items: [ref('KATAY', 1, 1.2, 150)] });
    assert.equal(c.status, 201, JSON.stringify(c.data));
    assert.equal((await shop.cashier.call('POST', '/api/expenses', { items: [{ item: 'Coke', amount: '75' }, { item: 'Bread', amount: '35' }] })).status, 201);
    assert.equal((await shop.manager.call('POST', '/api/expenses', { items: [{ item: 'Gas', amount: '90' }] })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/cash-count', { counts: { 1000: '1' } })).status, 201);
    // expected = 180 + 180 - (75 + 35 + 90) = 160 ; counted 1000 ; excess 840
    const m = await money(shop);
    assert.deepEqual([m.cash_sales_centavos, m.non_cash_centavos, m.expenses_total_centavos, m.expected_cash_centavos, m.excess_loss_centavos], [36000, 18000, 20000, 16000, 84000]);

    const files = await reportFiles(shop);
    const form = files['xl/worksheets/sheet1.xml'];
    for (const text of ['KATAY / DEAD (REF)', 'EXPENSES', 'Coke', 'Bread', 'Gas', 'LESS EXPENSES', 'CASH BREAKDOWN', 'OVERALL TOTAL', 'LESS NON-CASH PAYMENTS', 'EXPECTED CASH', 'EXCESS/LOSS']) {
      assert.ok(form.includes(text), text);
    }
    assert.match(form, /<f>[^<]*<\/f><v>840<\/v>/, 'EXCESS/LOSS is a formula worth 840');
    assert.match(form, /<f>[^<]*<\/f><v>160<\/v>/, 'EXPECTED CASH is a formula worth 160');
    assert.match(form, /<f>SUM\([A-Z]+\d+:[A-Z]+\d+\)<\/f><v>200<\/v>/, 'the expenses add up with a formula');
    // one cashier's report shows only what that cashier typed
    const cashId = shop.db.prepare("SELECT id FROM users WHERE username = 'cash'").get().id;
    const mgrId = shop.db.prepare("SELECT id FROM users WHERE username = 'mgr'").get().id;
    const forCash = (await reportFiles(shop, `&cashier=${cashId}`))['xl/worksheets/sheet1.xml'];
    assert.ok(forCash.includes('Coke') && !forCash.includes('Gas'));
    const forMgr = (await reportFiles(shop, `&cashier=${mgrId}`))['xl/worksheets/sheet1.xml'];
    assert.ok(forMgr.includes('Gas') && !forMgr.includes('Coke'));
    assert.ok(!forMgr.includes('KATAY / DEAD (REF)'), 'the manager sold no ref chicken');
    // before any count the EXCESS/LOSS stays empty
    const empty = await makeShop();
    try {
      assert.equal((await money(empty)).excess_loss_centavos, null);
    } finally { empty.close(); }
  } finally { shop.close(); }
});

// ---- 7. Sales List (Excel) and the CSV --------------------------------------------------------------------------------------------

test('Download Sales List (Excel): the CSV\'s 18 columns, sold orders only, columns wide enough for their headers', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 20 })).status, 200);
    const kept = (await shop.order(shop.cashier, [live(shop.whole, 1)], [], { customer_number: 'Aling Rosa' })).data.order;
    const gone = (await shop.order(shop.cashier, [live(shop.whole, 1)])).data.order;
    assert.equal((await shop.cashier.call('POST', `/api/orders/${gone.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' })).status, 200);
    assert.equal((await store(shop, shop.cashier, 'DEAD', 1, 1.1)).status, 201);
    assert.equal((await shop.order(shop.cashier, [], [], { ref_items: [ref('DEAD', 1, 1.1, 60)] })).status, 201);
    const res = await shop.manager.call('GET', '/api/export-sales.xlsx');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /chicken-pos-sales-list_.*\.xlsx/);
    const files = readZip(res.data);
    assert.deepEqual(sheetNames(files), ['Sales List']);
    const xml = sheet(files, 'Sales List');
    const rows = sheetRows(xml);
    assert.equal(rows[0].length, 18);
    assert.deepEqual(rows[0], CSV_HEADERS);
    assert.ok(rows.some((r) => r.includes('Aling Rosa')));
    assert.ok(rows.some((r) => r.includes(kept.order_number)) && !rows.some((r) => r.includes(gone.order_number)), 'the canceled order is not listed');
    assert.ok(rows.some((r) => r.includes('Ref Chicken') || r.some((c) => /Dead Chicken/.test(String(c)))), 'the ref line is listed');
    const widths = [...xml.matchAll(/<col min="\d+" max="\d+" width="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.equal(widths.length, 18);
    widths.forEach((w, i) => assert.ok(w >= rows[0][i].length, `column ${i + 1} (${rows[0][i]}) is ${w} wide, header has ${rows[0][i].length}`));
    assert.match(xml, /<pane [^>]*state="frozen"/, 'the header row stays in view');
    assert.match(xml, /<autoFilter /);
    assert.equal((await shop.cashier.call('GET', '/api/export-sales.xlsx')).status, 403);
    // the plain CSV is still there, and the main Excel export has fitted columns too
    assert.equal((await shop.manager.call('GET', '/api/export.csv')).status, 200);
    const main = readZip((await shop.manager.call('GET', '/api/export.xlsx')).data);
    assert.ok(sheetNames(main).every((n) => /<cols>/.test(sheet(main, n))), 'every sheet of the main export has column widths');
  } finally { shop.close(); }
});

// ---- 8. Assorted eggs ----------------------------------------------------------------------------------------------------------------

test('Assorted eggs: an Eggs product, an "assorted" name, or an egg name without a size lands on the Asst. row', () => {
  assert.equal(eggSizeOf('Eggs Assorted'), 'Asst.');
  assert.equal(eggSizeOf('Itlog'), 'Asst.');
  assert.equal(eggSizeOf('Eggs'), 'Asst.');
  assert.equal(eggSizeOf('Eggs (Asst.)'), 'Asst.');
  assert.equal(eggSizeOf('Egg Medium'), 'Med.');
  assert.equal(eggSizeOf('Large Eggs'), 'Lar.');
  assert.equal(eggSizeOf('Whole Chicken'), null);
});

test('Assorted eggs: selling "Eggs Assorted" and an Eggs-type product called "Itlog" puts both on the Asst. row of the Daily Report', async () => {
  const shop = await makeShop();
  try {
    for (const name of ['Eggs Assorted', 'Itlog']) {
      const created = await shop.admin.call('POST', '/api/other-products', { name, kind: 'EGGS', prices: { piece: '9', tray: '250' } });
      assert.equal(created.status, 201, JSON.stringify(created.data));
    }
    for (const name of ['Eggs Assorted', 'Itlog']) {
      const opt = shop.option(name, 'piece');
      const row = await shop.row(`${name} - piece`);
      assert.ok(row, `${name} - piece is on the Daily Inventory`);
      assert.equal((await shop.set(`${name} - piece`, { beginning: 100 })).status, 200);
      assert.equal((await shop.order(shop.cashier, [], [fixed(opt, 10)])).status, 201);
    }
    const model = buildModel(gatherDaily(shop.db, { date: '2026-10-15' }));
    const asst = model.eggRows.find((r) => r.size === 'Asst.');
    assert.equal(asst.sold, '20 piece');
    assert.equal(asst.amount, 18000);
    for (const size of ['Sm.', 'Med.', 'Lar.', 'XL']) assert.equal(model.eggRows.find((r) => r.size === size).amount, 0);
  } finally { shop.close(); }
});

// ---- 9. Clear records, upgrade --------------------------------------------------------------------------------------------------------

test('clear-records also clears the ref entries, cash counts and expenses of closed days, and keeps the users', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    assert.equal((await store(shop, shop.cashier, 'KATAY', 1, 1.5)).status, 201);
    assert.equal((await shop.order(shop.cashier, [], [], { ref_items: [ref('KATAY', 1, 1.5, 100)] })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/cash-count', { counts: { 500: '1' } })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/expenses', { items: [{ item: 'Ice', amount: '20' }] })).status, 201);
    for (const o of shop.db.prepare("SELECT id FROM orders WHERE fulfillment_status = 'ONGOING'").all()) await shop.move(o.id, 'COMPLETE');
    assert.equal((await shop.manager.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15', submit: true })).status, 200);
    const users = shop.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const counts = countRecords(shop.db);
    assert.ok(JSON.stringify(counts).length > 2);
    clearRecords(shop.db, { now: new Date('2026-10-16T02:00:00Z') });
    for (const t of ['ref_stock_entries', 'order_ref_items', 'cash_counts', 'expenses', 'orders']) {
      assert.equal(shop.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, `${t} is empty`);
    }
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, users);
  } finally { shop.close(); }
});

test('upgrade to version 10: a safety copy is made first, the data is unchanged, the new tables exist and are protected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v10-'));
  const file = path.join(dir, 'pos.db');
  const first = openDb(file);
  const admin = createUser(first, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createProduct(first, admin, { name: 'Whole Chicken', price: '120' });
  // turn it back into a version 9 database: no ref, cash or expense tables
  for (const t of ['ref_stock_entries', 'order_ref_items', 'cash_counts', 'expenses']) first.exec(`DROP TABLE ${t}`);
  first.exec('PRAGMA user_version = 9');
  const before = JSON.stringify(first.prepare('SELECT * FROM products ORDER BY id').all());
  first.close();
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 10);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all()), before, 'the data is unchanged');
  for (const t of ['ref_stock_entries', 'order_ref_items', 'cash_counts', 'expenses']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0);
  assert.ok(fs.readdirSync(dir).some((f) => /\.before-v10-.*\.bak$/.test(f)), 'a safety copy was made first');
  db.close();
  assert.equal(openDb(file).prepare('PRAGMA user_version').get().user_version, 10, 'a second start changes nothing');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).length, 1, 'and makes no second copy');
  fs.rmSync(dir, { recursive: true, force: true });
});
