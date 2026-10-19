// Revision 11 acceptance tests: Brown Cull Chicken, Ducks and Catfish; other products counted in pieces (also when sold by the kilo);
// the new discount reasons (Wholesale, Dead, Katay) kept apart from the inventory losses (Katay, Dead); Submit Inventory Today and
// Closed Inventory Today and Reset the Day; Export Inventory History; the Daily Report's discount list; one business date everywhere;
// product pictures; and the upgrade to version 9.
// Every test builds its own shop (own server, own database, own inventory folder), so no test can disturb another and none can touch real data.
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
import { createProduct, createOtherProduct, seedStarterCatalog, seedRevision11Products, listProducts, listOtherProducts } from '../src/services/catalog.js';
import { gatherDaily, buildModel } from '../src/services/dailyReport.js';
import { gatherExport } from '../src/services/export.js';
import { computeRow, CHICKEN_COLUMNS } from '../shared/inventory.js';
import { DISCOUNT_REASONS, discountReasonLabel } from '../shared/constants.js';
import { ZERO_NOTE } from '../src/services/inventoryReport.js';
import { getInventory } from '../src/services/inventory.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START = new Date('2026-10-15T02:00:00Z');   // 10:00 on Thursday 15 Oct 2026 in the Philippines
let keyN = 0;
const key = () => `r11-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

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

/** A shop as it would be after the first start of Revision 11: starter products, Brown Cull Chicken, Ducks and Catfish, with SAMPLE prices. */
async function makeShop() {
  const db = openDb(':memory:');
  const clock = { now: START };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r11-inv-'));
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

// ---- 1. The new products ------------------------------------------------------------------------------------------------

test('Brown Cull Chicken, Ducks and Catfish are added once, without invented prices; Brown Cull is a CULL chicken, Ducks and Catfish are other products', async () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a','A','x','admin','2026-01-01')").run();
  seedStarterCatalog(db);
  assert.deepEqual(seedRevision11Products(db), ['Brown Cull Chicken', 'Ducks', 'Catfish']);
  assert.deepEqual(seedRevision11Products(db), [], 'never twice');
  const brown = db.prepare("SELECT * FROM products WHERE name = 'Brown Cull Chicken'").get();
  assert.deepEqual([brown.category, brown.price_per_kg_centavos, brown.active], ['CULL', 0, 0], 'a cull product, no price, waiting for the admin');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM products WHERE name IN ('Ducks','Catfish')").get().n, 0, 'Ducks and Catfish are not chicken');
  for (const name of ['Ducks', 'Catfish']) {
    const p = db.prepare('SELECT * FROM other_products WHERE name = ?').get(name);
    assert.equal(p.kind, 'OTHER');
    const opts = db.prepare('SELECT unit, price_centavos, active FROM other_product_options WHERE product_id = ? ORDER BY id').all(p.id);
    assert.deepEqual(opts.map((o) => [o.unit, o.price_centavos, o.active]), [['piece', 0, 0], ['pack', 0, 0], ['sack', 0, 0], ['kg', 0, 0]]);
  }
  // renamed later: not added again on the next start
  db.prepare("UPDATE other_products SET name = 'Duck' WHERE name = 'Ducks'").run();
  assert.deepEqual(seedRevision11Products(db), []);
  // an existing product of that name is left alone
  const db2 = openDb(':memory:');
  db2.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at, category) VALUES ('Brown Cull Chicken', 6000, 1, 'x', 'x', 'CULL')").run();
  assert.deepEqual(seedRevision11Products(db2), ['Ducks', 'Catfish']);
  assert.equal(db2.prepare("SELECT price_per_kg_centavos FROM products WHERE name = 'Brown Cull Chicken'").get().price_per_kg_centavos, 6000);
  db.close(); db2.close();
});

test('Brown Cull Chicken is tracked on its own and reported in the CULL block; the category comes from the product, not the name', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Brown Cull Chicken', { beginning: 10 })).status, 200);
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    const sale = await shop.order(shop.cashier, [live(shop.brown, 2, { weight: '3.2' })], [], { customer_number: 'BC-1' });
    assert.equal(sale.status, 201, JSON.stringify(sale.data));
    assert.equal(sale.data.order.total_centavos, 17920, '3.2 kg x ₱56 = ₱179.20 (weight-based, like every chicken)');
    assert.deepEqual([(await shop.row('Brown Cull Chicken')).sold, (await shop.row('Whole Chicken')).sold], [2000, 0], 'counted on its own row');
    const model = buildModel(gatherDaily(shop.db, { date: '2026-10-15' }));
    const cull = model.blocks.find((b) => b.title === 'CULL');
    assert.deepEqual(cull.lines.map((l) => [l.product, l.heads]), [['Brown Cull Chicken', 2]]);
    assert.equal(model.blocks.find((b) => b.title === 'B-CULL').lines.length, 0, 'not B-CULL, although its name has "B" and "Cull" in it');
    // the category is a real field: moving the product to another block moves its report lines
    assert.equal((await shop.admin.call('PATCH', `/api/products/${shop.brown}`, { category: 'BCULL' })).status, 200);
    assert.equal(buildModel(gatherDaily(shop.db, { date: '2026-10-15' })).blocks.find((b) => b.title === 'B-CULL').lines.length, 1);
    assert.equal((await shop.admin.call('PATCH', `/api/products/${shop.brown}`, { category: 'NOPE' })).status, 400);
    assert.equal((await shop.admin.call('PATCH', `/api/products/${shop.brown}`, { category: 'CULL' })).status, 200);
    // it is in the inventory, the history, and both exports
    const csv = (await shop.manager.call('GET', '/api/export.csv')).data.toString('utf8');
    assert.match(csv, /Brown Cull Chicken,2,3\.2,kg,56\.00,Live/);
    // (Revision 12 replaced Export Inventory History with the Export button of a closed day; see tests/revision12.test.js.)
    assert.ok((await shop.row('Brown Cull Chicken')), 'it has its own Daily Inventory row');
  } finally { shop.close(); }
});

// ---- 2. Other products are counted in pieces, also when sold by the kilo --------------------------------------------------

test('Ducks and Catfish: sold by the kilo, the stock is counted in pieces (1 catfish of 1.2 kg = -1; 3 ducks weighing 4.5 kg = -3)', async () => {
  const shop = await makeShop();
  try {
    const inv = await shop.inventory();
    assert.deepEqual(inv.other.filter((r) => ['Ducks', 'Catfish'].includes(r.product_name)).map((r) => r.name).sort(),
      ['Catfish - pack', 'Catfish - piece', 'Catfish - sack', 'Ducks - pack', 'Ducks - piece', 'Ducks - sack'], 'no kg rows: the stock is pieces');
    assert.ok(!inv.chicken.some((r) => /Duck|Catfish/.test(r.name)), 'not chicken');
    assert.equal((await shop.set('Catfish - piece', { beginning: 10 })).status, 200);
    assert.equal((await shop.set('Ducks - piece', { beginning: 8 })).status, 200);

    const fish = await shop.order(shop.cashier, [], [byKg(shop.option('Catfish', 'kg'), 1.2)]);   // no pieces given: 1
    assert.equal(fish.status, 201, JSON.stringify(fish.data));
    assert.deepEqual([fish.data.order.other_items[0].pieces, fish.data.order.total_centavos], [1, 19200], '1.2 kg x ₱160 = ₱192.00; 1 piece');
    assert.deepEqual([(await shop.row('Catfish - piece')).sold, (await shop.row('Catfish - piece')).new_total], [1000, 9000]);

    const ducks = await shop.order(shop.cashier, [], [byKg(shop.option('Ducks', 'kg'), 4.5, 3)]);
    assert.equal(ducks.status, 201, JSON.stringify(ducks.data));
    assert.deepEqual([ducks.data.order.other_items[0].pieces, ducks.data.order.total_centavos], [3, 144000], '4.5 kg x ₱320 = ₱1,440.00; 3 pieces');
    assert.equal((await shop.row('Ducks - piece')).new_total, 5000);

    // a whole duck sold by the piece and ducks by the kilo come off the same row, and are added up before the check
    const both = await shop.order(shop.cashier, [], [fixed(shop.option('Ducks', 'piece'), 3), byKg(shop.option('Ducks', 'kg'), 3, 3)]);
    assert.equal(both.status, 409);
    assert.equal(both.data.error, 'Insufficient stock. Only 5 pieces of Ducks are available.');
    assert.equal((await shop.order(shop.cashier, [], [fixed(shop.option('Ducks', 'piece'), 2), byKg(shop.option('Ducks', 'kg'), 3, 3)])).status, 201);
    assert.equal((await shop.row('Ducks - piece')).new_total, 0);

    // the piece count is a whole number from 1 to 999, and only for things sold by the kilo
    for (const bad of [0, -1, 1.5, 'two', 1000]) assert.equal((await shop.order(shop.cashier, [], [byKg(shop.option('Catfish', 'kg'), 1, bad)])).status, 400, String(bad));
    assert.equal((await shop.order(shop.cashier, [], [{ ...fixed(shop.option('Ducks', 'piece'), 1), pieces: 1 }])).status, 400);
    // the database refuses a broken piece count even if the app were bypassed
    assert.throws(() => shop.db.prepare('UPDATE order_other_items SET pieces = 0').run(), /cannot be changed|CHECK/);

    // the New order screen gets the same numbers: the kg option points at the piece row
    const cfg = (await shop.cashier.call('GET', '/api/config')).data;
    assert.equal(cfg.stock.other_stock_of[shop.option('Catfish', 'kg').id], shop.option('Catfish', 'piece').id);
    assert.equal(cfg.stock.other_milli[shop.option('Catfish', 'piece').id], 9000);
    assert.ok(cfg.other_products.some((p) => p.name === 'Ducks') && cfg.other_products.some((p) => p.name === 'Catfish'));

    // canceling a by-the-kilo sale gives its pieces back
    assert.equal((await shop.cashier.call('POST', `/api/orders/${fish.data.order.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND', stock_returnable: true })).status, 200);
    assert.equal((await shop.row('Catfish - piece')).new_total, 10000);
    // and the pieces are shown in the reports
    const model = buildModel(gatherDaily(shop.db, { date: '2026-10-15' }));
    assert.deepEqual(model.otherRows.find((r) => r.product === 'Ducks' && r.unit === 'kg').sold, '7.5 kg (6 pcs)');
    const csvDuck = (await shop.manager.call('GET', '/api/export.csv')).data.toString('utf8').split('\r\n').find((l) => l.includes('Ducks,3,4.5,kg'));
    assert.ok(csvDuck, 'the CSV shows the 3 pieces of the 4.5 kg line under Number of Heads');
  } finally { shop.close(); }
});

// ---- 3. Discounts and inventory losses are separate ---------------------------------------------------------------------

test('discounts: Wholesale, Dead and Katay are reasons only - the cashier types the amount, no rate is invented, and nothing touches the inventory', async () => {
  assert.deepEqual(Object.keys(DISCOUNT_REASONS), ['BULK', 'REJECT', 'EMPLOYEE', 'WHOLESALE', 'DEAD', 'KATAY', 'OTHER']);
  assert.equal(discountReasonLabel('SENIOR'), 'Senior citizen (no longer offered)', 'an old saved order still reads correctly');
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 20 })).status, 200);
    const before = await shop.row('Whole Chicken');
    for (const [code, type, value, expected] of [['WHOLESALE', 'PERCENT', '10', 1800], ['DEAD', 'FIXED', '50', 5000], ['KATAY', 'FIXED', '25.50', 2550]]) {
      const r = await shop.order(shop.cashier, [live(shop.whole, 1)], [], { discount: { type, value, reason_code: code } });   // 1.5 kg x ₱120 = ₱180
      assert.equal(r.status, 201, `${code}: ${JSON.stringify(r.data)}`);
      assert.deepEqual([r.data.order.discount.reason_code, r.data.order.discount.amount_centavos, r.data.order.total_centavos], [code, expected, 18000 - expected], code);
      // the discount was counted once: total = subtotal - discount
      assert.equal(r.data.order.subtotal_centavos - r.data.order.discount.amount_centavos, r.data.order.total_centavos);
    }
    assert.equal((await shop.order(shop.cashier, [live(shop.whole, 1)], [], { discount: { type: 'FIXED', reason_code: 'DEAD' } })).status, 400, 'no amount, no discount: nothing is assumed');
    const after = await shop.row('Whole Chicken');
    assert.deepEqual([after.sold, after.reject, after.katay, after.dead, after.pull_out], [3000, 0, 0, 0, 0], 'a Dead or Katay discount records no inventory loss; the heads count only as Sold');
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM inventory_events WHERE field IN ('dead','katay')").get().n, 0);
    assert.equal(before.reject + before.dead, 0);
  } finally { shop.close(); }
});

test('Katay and Dead as inventory losses: their own columns, never a sale and never a discount; 10 + 5 = 15, 4 sold, 11 left, minus 1, 1, 1, 2 = 6', async () => {
  assert.deepEqual(CHICKEN_COLUMNS.slice(6, 10), ['Reject', 'Katay', 'Dead', 'Pull Out'], 'Katay sits between Reject and Dead');
  assert.deepEqual(computeRow('CHICKEN', { beginning: 10000, additional: 5000, reject: 1000, katay: 1000, dead: 1000, pull_out: 2000 }, 4000), { total: 15000, sold: 4000, left: 11000, new_total: 6000 });
  assert.deepEqual(computeRow('OTHER', { beginning: 10000, additional: 5000, reject: 0, katay: 0, dead: 0, pull_out: 0 }, 4000).new_total, 11000);
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10, additional: 5 })).status, 200);
    for (const heads of [3, 1]) assert.equal((await shop.order(shop.cashier, [live(shop.whole, heads)])).status, 201);   // 4 sold
    const canceled = (await shop.order(shop.cashier, [live(shop.whole, 1)])).data.order;                                   // canceled: not sold
    assert.equal((await shop.cashier.call('POST', `/api/orders/${canceled.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND', stock_returnable: true })).status, 200);
    assert.equal((await shop.set('Whole Chicken', { reject: 1, katay: 1, dead: 1, pull_out: 2 })).status, 200);
    const row = await shop.row('Whole Chicken');
    assert.deepEqual([row.beginning, row.additional, row.total, row.sold, row.left, row.reject, row.katay, row.dead, row.pull_out, row.new_total].map((m) => m / 1000), [10, 5, 15, 4, 11, 1, 1, 1, 2, 6]);
    // no discount anywhere, and the gross sales are only the 4 heads sold
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE discount_centavos > 0').get().n, 0, 'recording Katay or Dead never creates a discount');
    const ev = shop.db.prepare("SELECT field, old_milli, new_milli FROM inventory_events WHERE field = 'katay'").all().map((e) => ({ ...e }));
    assert.deepEqual(ev, [{ field: 'katay', old_milli: 0, new_milli: 1000 }], 'the Katay entry is in the history');
    // the losses cannot be more than what is left, Katay included
    const tooMany = await shop.set('Whole Chicken', { katay: 8 });   // 1 + 8 + 1 + 2 = 12 losses, only 11 left (7 would be exactly 11: allowed)
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /Reject, Katay, Dead and Pull Out together/);
    // Katay is whole heads, managers and the admin only, chicken only
    assert.equal((await shop.set('Whole Chicken', { katay: 0.5 })).status, 400);
    assert.equal((await shop.set('Whole Chicken', { katay: 2 }, shop.cashier)).status, 403);
    assert.equal((await shop.set('Ducks - piece', { katay: 1 })).status, 400);
    assert.throws(() => shop.db.prepare("UPDATE inventory_records SET katay_milli = 500 WHERE product_id IS NOT NULL").run(), /CHECK/);
    // the next day starts Katay at 0 and carries the New Total (the orders are handed over first: Ongoing orders block the closing)
    for (const o of shop.db.prepare("SELECT id FROM orders WHERE fulfillment_status = 'ONGOING' AND status = 'COMPLETED'").all()) await shop.move(o.id, 'COMPLETE');
    assert.equal((await shop.submit('2026-10-15')).status, 201);
    shop.clock.now = new Date('2026-10-16T01:00:00Z');
    assert.equal((await shop.manager.call('GET', '/api/inventory')).data.day.business_date, '2026-10-16');   // Revision 13: closed by itself at midnight
    const next = await shop.row('Whole Chicken');
    assert.deepEqual([next.beginning, next.katay, next.dead], [6000, 0, 0]);
  } finally { shop.close(); }
});

// ---- 4. Submit Inventory Today ---------------------------------------------------------------------------------------------

test('Submit Inventory Today: one Excel file saved on this computer and downloaded, every product with a number, zero rows left out with a note', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10, additional: 5 })).status, 200);
    assert.equal((await shop.set('Catfish - piece', { beginning: 4 })).status, 200);
    assert.equal((await shop.order(shop.cashier, [live(shop.whole, 4)], [byKg(shop.option('Catfish', 'kg'), 2.2, 2)])).status, 201);
    assert.equal((await shop.set('Whole Chicken', { reject: 1, katay: 1, dead: 1, pull_out: 2 })).status, 200);

    const r = await shop.submit('2026-10-15');
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const { submission } = r.data;
    assert.match(submission.file_name, /^inventory_2026-10-15_1000\.xlsx$/);
    assert.ok(fs.existsSync(path.join(shop.dir, submission.file_name)), 'the file is saved on this computer');
    assert.equal(r.data.rows_included, 2);
    assert.ok(r.data.rows_left_out > 0, 'Brown Cull Chicken, the ducks, the starter products ... with 0 everywhere are left out');

    const dl = await shop.manager.call('GET', `/api/inventory/submissions/${submission.id}/file`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), new RegExp(submission.file_name.replace('.', '\\.')));
    assert.ok(dl.data.equals(fs.readFileSync(path.join(shop.dir, submission.file_name))), 'the download is the saved file, byte for byte');
    const files = readZip(dl.data);
    assert.deepEqual(sheetNames(files), ['Inventory Today']);   // Revision 13: Beginning Balance edits are notes on this sheet
    const rows = sheetRows(sheet(files, 'Inventory Today'));
    const head = rows.find((x) => x[0] === 'Chicken Product');
    assert.deepEqual(head, ['Chicken Product', 'Beginning Balance', 'Additional', 'Total', 'Sold', 'Left', 'Reject', 'Katay', 'Dead', 'Pull Out', 'New Total']);
    assert.deepEqual(rows.find((x) => x[0] === 'Whole Chicken'), ['Whole Chicken', 10, 5, 15, 4, 11, 1, 1, 1, 2, 6]);
    assert.deepEqual(rows.find((x) => x[0] === 'Other Product'), ['Other Product', 'Beginning Balance', 'Additional', 'Sold', 'Left', 'New Total'], 'no Total column for other products');
    assert.deepEqual(rows.find((x) => x[0] === 'Catfish - piece'), ['Catfish - piece', 4, 0, 2, 2, 2]);
    assert.ok(!rows.some((x) => x[0] === 'Brown Cull Chicken' || x[0] === 'Ducks - piece'), 'rows that are 0 everywhere are not in the record');
    assert.ok(rows.some((x) => x[0] === `Note: ${ZERO_NOTE}`), 'and the file says so under the tables');
    assert.equal(ZERO_NOTE, 'Products with 0 in every column are not included in this record.');
    // live formulas, with the cached results for viewers that do not recalculate
    assert.match(sheet(files, 'Inventory Today'), /<f>F\d+-G\d+-H\d+-I\d+-J\d+<\/f><v>6<\/v>/);
    // it is the open day only, managers and the admin only, and a broken count cannot be submitted
    assert.equal((await shop.submit('2026-10-14')).status, 409);
    assert.equal((await shop.submit('2026-10-15', shop.cashier)).status, 403);
    shop.db.prepare("UPDATE inventory_records SET beginning_milli = 0 WHERE product_id = ?").run(shop.whole);
    const negative = await shop.submit('2026-10-15');
    assert.equal(negative.status, 409);
    assert.equal(negative.data.code, 'NEGATIVE_BALANCE');
    // the submission record cannot be changed or deleted
    assert.throws(() => shop.db.prepare('UPDATE inventory_submissions SET file_name = ?').run('x'), /cannot be changed/);
    assert.throws(() => shop.db.prepare('DELETE FROM inventory_submissions').run(), /cannot be deleted/);
  } finally { shop.close(); }
});

test('Submit Inventory Today: if the file cannot be saved, nothing is recorded and no half file is left behind', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 5 })).status, 200);
    const blocked = path.join(shop.dir, 'not-a-folder');
    fs.writeFileSync(blocked, 'x');                                      // a file where the folder should be: saving must fail
    shop.server.close();
    const config = loadConfig({ dbPath: ':memory:', inventoryDir: blocked, largeWeightKg: 50, sessionIdleMinutes: 60 * 24 * 365 });
    const server = createApp({ db: shop.db, config, clock: () => shop.clock.now }).listen(0);
    try {
      await new Promise((r) => server.once('listening', r));
      const m = client(`http://127.0.0.1:${server.address().port}`);
      await m.login('mgr', 'manager-pass-1');
      const r = await m.call('POST', '/api/inventory/submit', { business_date: '2026-10-15' });
      assert.equal(r.status, 500);
      assert.equal(r.data.code, 'SAVE_FAILED');
      assert.match(r.data.error, /could not be saved.*Nothing was submitted/s);
      assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM inventory_submissions').get().n, 0);
      assert.deepEqual(fs.readdirSync(shop.dir), ['not-a-folder'], 'no half-written file anywhere');
      const close = await m.call('POST', '/api/inventory/close-day', { business_date: '2026-10-15' });
      assert.equal(close.status, 409);
      assert.equal(close.data.code, 'SUBMIT_FIRST', 'a failed export never lets the day be reset');
    } finally { server.close(); }
  } finally { shop.close(); }
});

// ---- 5. Closed Inventory Today and Reset the Day ------------------------------------------------------------------------------

test('closing needs a submission with the final numbers and an intact saved file; it is refused (and nothing changes) otherwise', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    const a = (await shop.order(shop.cashier, [live(shop.whole, 2)])).data.order;
    await shop.move(a.id, 'COMPLETE');
    const unchanged = () => JSON.stringify(shop.db.prepare('SELECT * FROM business_days ORDER BY id').all());
    const start = unchanged();

    let c = await shop.check();
    assert.deepEqual(c.blockers.map((b) => b.code), ['SUBMIT_FIRST']);
    assert.equal((await shop.close2('2026-10-15')).data.code, 'SUBMIT_FIRST');

    const first = (await shop.submit('2026-10-15')).data.submission;
    c = await shop.check();
    assert.equal(c.can_close, true, JSON.stringify(c.blockers));
    assert.equal((await shop.inventory()).submission.current, true);

    // a sale after the submission: the saved file no longer has the final numbers
    const b = (await shop.order(shop.cashier, [live(shop.whole, 1)])).data.order;
    await shop.move(b.id, 'COMPLETE');
    c = await shop.check();
    assert.deepEqual(c.blockers.map((x) => x.code), ['SUBMIT_AGAIN']);
    assert.equal((await shop.inventory()).submission.current, false);
    assert.equal((await shop.close2('2026-10-15')).data.code, 'SUBMIT_AGAIN');
    // a typed number after the submission counts too
    const second = (await shop.submit('2026-10-15')).data.submission;
    assert.notEqual(second.file_name, first.file_name, 'a new file; the first one is kept');
    assert.ok(fs.existsSync(path.join(shop.dir, first.file_name)));
    assert.equal((await shop.set('Whole Chicken', { additional: 1 })).status, 200);
    assert.equal((await shop.check()).blockers[0].code, 'SUBMIT_AGAIN');

    // the saved file was changed or removed on this computer: refused until submitted again
    const third = (await shop.submit('2026-10-15')).data.submission;
    fs.appendFileSync(path.join(shop.dir, third.file_name), 'tampered');
    assert.equal((await shop.check()).blockers[0].code, 'SUBMISSION_FILE');
    assert.equal((await shop.manager.call('GET', `/api/inventory/submissions/${third.id}/file`)).status, 410);
    assert.equal(unchanged(), start, 'every refusal left the business days as they were');

    assert.equal((await shop.submit('2026-10-15')).status, 201);
    const done = await shop.close2('2026-10-15');
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.deepEqual([done.data.closed.business_date, done.data.opened.business_date], ['2026-10-15', '2026-10-16']);
    // the old files are still there; the closed day keeps its submissions
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM inventory_submissions').get().n, 4);
  } finally { shop.close(); }
});

test('closing: Ongoing still blocks; Complete orders leave the Order List and today\'s Orders list but stay saved; Standby stays and is never counted twice', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 20 })).status, 200);
    const place = async (heads, customer) => (await shop.order(shop.cashier, [live(shop.whole, heads)], [], { customer_number: customer })).data.order;
    const ongoing = await place(1, 'ONGOING-1');
    const standby = await place(2, 'STANDBY-1');
    const complete = await place(3, 'COMPLETE-1');
    await shop.move(standby.id, 'STANDBY');
    await shop.move(complete.id, 'COMPLETE');
    assert.equal((await shop.submit('2026-10-15')).status, 201);
    let c = await shop.check();
    assert.deepEqual(c.blockers.map((b) => b.code), ['ONGOING_ORDERS'], 'an order still being prepared blocks the closing');
    await shop.move(ongoing.id, 'COMPLETE');
    assert.equal((await shop.submit('2026-10-15')).status, 201);
    const current = async () => (await shop.cashier.call('GET', '/api/orders?view=current')).data.orders.map((o) => o.customer_number).sort();
    assert.deepEqual(await current(), ['COMPLETE-1', 'ONGOING-1', 'STANDBY-1']);

    shop.clock.now = new Date('2026-10-15T11:00:00Z');                    // 19:00, the end of the day
    const closed = await shop.close2('2026-10-15');
    assert.equal(closed.status, 200, JSON.stringify(closed.data));
    assert.deepEqual([closed.data.standby_orders, closed.data.complete_orders_cleared], [1, 2]);
    // the Orders tab (today's view) and the Order List keep only the Standby order
    assert.deepEqual(await current(), ['STANDBY-1']);
    assert.deepEqual((await shop.cashier.call('GET', '/api/board')).data.orders.map((o) => o.customer_number), ['STANDBY-1']);
    // nothing was deleted: every order is still saved, found by number, by date, and in the reports
    const all = (await shop.cashier.call('GET', '/api/orders?from=2026-10-15&to=2026-10-15')).data.orders;
    assert.deepEqual(all.map((o) => o.customer_number).sort(), ['COMPLETE-1', 'ONGOING-1', 'STANDBY-1']);
    assert.equal((await shop.cashier.call('GET', `/api/orders?q=${complete.order_number}&view=current`)).data.orders.length, 1, 'a search by number looks through everything');
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 3);

    // the Standby order was sold on 15 Oct and is counted there only
    assert.equal((await shop.row('Whole Chicken', '?date=2026-10-15')).sold, 6000);
    assert.equal((await shop.row('Whole Chicken')).sold, 0, 'not counted again on the new day');
    // the customer picks it up the next morning: marked Complete, no new sale, no new deduction
    shop.clock.now = new Date('2026-10-16T01:00:00Z');
    assert.equal((await shop.move(standby.id, 'COMPLETE', shop.cashier)).status, 200);
    assert.equal((await shop.row('Whole Chicken')).sold, 0);
    assert.equal((await shop.row('Whole Chicken', '?date=2026-10-15')).sold, 6000);
    assert.deepEqual(await current(), [], 'a claimed Standby order from a closed day leaves the current list');
    // every report puts it on its original business day
    assert.equal(gatherDaily(shop.db, { date: '2026-10-15' }).orderCount, 3);
    assert.equal(gatherDaily(shop.db, { date: '2026-10-16' }).orderCount, 0);
    assert.deepEqual(gatherExport(shop.db, { from: '2026-10-16', to: '2026-10-16' }).orderRows, []);
    assert.equal(gatherExport(shop.db, { from: '2026-10-15', to: '2026-10-15' }).orderRows.length, 3);
    const csv = (await shop.manager.call('GET', '/api/export.csv?from=2026-10-15&to=2026-10-15')).data.toString('utf8');
    assert.ok(csv.includes(`2026-10-15,${standby.order_number},`));
  } finally { shop.close(); }
});

test('closing twice cannot run the business date ahead of the real date, and a double click closes only once', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 5 })).status, 200);
    assert.equal((await shop.submit('2026-10-15')).status, 201);
    const results = await Promise.all([shop.close2('2026-10-15'), shop.close2('2026-10-15'), shop.close2('2026-10-15', shop.admin)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.data.code === 'ALREADY_CLOSED'));
    assert.equal((await shop.inventory()).day.business_date, '2026-10-16');
    // still 15 October: the day of the 16th has not started, so it cannot be closed (the date would run ahead again)
    assert.equal((await shop.submit('2026-10-16')).status, 201);
    const early = await shop.close2('2026-10-16');
    assert.equal(early.status, 409);
    assert.equal(early.data.code, 'NOT_STARTED');
    assert.match(early.data.error, /has not started yet \(today is 2026-10-15\)/);
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM business_days').get().n, 2);
    // on the 16th it closes normally
    shop.clock.now = new Date('2026-10-16T12:00:00Z');
    assert.equal((await shop.close2('2026-10-16')).status, 200);
    assert.equal((await shop.inventory()).day.business_date, '2026-10-17');
  } finally { shop.close(); }
});

// ---- 6. Export Inventory History -----------------------------------------------------------------------------------------------

test('Export (Revision 12, in place of Export Inventory History): one closed day, in the layout of the submitted file; nothing changes', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 10 })).status, 200);
    const o = (await shop.order(shop.cashier, [live(shop.whole, 4)])).data.order;
    await shop.move(o.id, 'COMPLETE');
    assert.equal((await shop.set('Whole Chicken', { katay: 1 })).status, 200);
    assert.equal((await shop.submit('2026-10-15')).status, 201);
    shop.clock.now = new Date('2026-10-16T01:00:00Z');
    assert.equal((await shop.manager.call('GET', '/api/inventory')).data.day.business_date, '2026-10-16');   // Revision 13: closed by itself at midnight
    const before = JSON.stringify(shop.db.prepare('SELECT * FROM inventory_records ORDER BY id').all());

    // Revision 12: Export Inventory History is gone. A closed day has its own Export file, in the layout of the submitted file.
    assert.equal((await shop.cashier.call('GET', '/api/inventory-history.xlsx')).status, 404);
    const res = await shop.cashier.call('GET', '/api/inventory/day.xlsx?date=2026-10-15');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /inventory_closed_2026-10-15\.xlsx/);
    const files = readZip(res.data);
    assert.deepEqual(sheetNames(files), ['Closed Inventory']);
    const rows = sheetRows(sheet(files, 'Closed Inventory'));
    assert.deepEqual(rows.find((r) => r[0] === 'Whole Chicken').slice(1), [10, 0, 10, 4, 6, 0, 1, 0, 0, 5], 'the closed day as it was closed');
    assert.ok(!rows.some((r) => r[0] === 'Brown Cull Chicken'), 'rows with 0 in every column are left out, like the submitted file');
    assert.ok(rows.some((r) => String(r[0]).includes(ZERO_NOTE)));
    assert.equal((await shop.cashier.call('GET', '/api/inventory/day.xlsx?date=2026-10-16')).status, 409, 'the open day is not exported here');
    assert.equal(JSON.stringify(shop.db.prepare('SELECT * FROM inventory_records ORDER BY id').all()), before, 'exporting changes nothing');
    assert.equal((await client(shop.base).call('GET', '/api/inventory/day.xlsx?date=2026-10-15')).status, 401);
  } finally { shop.close(); }
});

// ---- 7. Daily Report: the discount list --------------------------------------------------------------------------------------

test('Download Daily Report: "Other collections" is replaced by the discount list (customer, reason, discount) and the total of all discounts', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('Whole Chicken', { beginning: 20 })).status, 200);
    const d1 = await shop.order(shop.cashier, [live(shop.whole, 2)], [], { customer_number: 'Aling Rosa', discount: { type: 'FIXED', value: '30', reason_code: 'WHOLESALE' } });
    const d2 = await shop.order(shop.cashier, [live(shop.whole, 1)], [], { customer_number: 'Mang Ben', discount: { type: 'FIXED', value: '20', reason_code: 'OTHER', note: 'regular customer' } });
    const plain = await shop.order(shop.cashier, [live(shop.whole, 1)]);
    for (const r of [d1, d2, plain]) assert.equal(r.status, 201, JSON.stringify(r.data));
    const data = gatherDaily(shop.db, { date: '2026-10-15' });
    assert.deepEqual(data.discounts.map((d) => [d.customer, d.reason, d.amount]), [['Aling Rosa', 'Wholesale', 3000], ['Mang Ben', 'Other (explain below): regular customer', 2000]]);
    assert.equal(data.discount, 5000);
    const files = readZip((await shop.manager.call('GET', '/api/daily-report.xlsx?date=2026-10-15')).data);
    const form = files['xl/worksheets/sheet1.xml'];
    for (const text of ['DISCOUNTS', 'CUSTOMER NAME', 'REASON', 'TOTAL DISCOUNTS', 'Aling Rosa', 'Wholesale', 'Mang Ben', 'regular customer']) assert.ok(form.includes(text), text);
    assert.ok(!form.includes('OTHER COLLECTIONS'));
    assert.match(form, /<f>SUM\([A-Z]+\d+:[A-Z]+\d+\)<\/f><v>50<\/v>/, 'the total of all discounts is a formula');
    const discountTotal = /<c r="([A-Z]+\d+)"[^>]*><f>SUM\([A-Z]+\d+:[A-Z]+\d+\)<\/f><v>50<\/v>/.exec(form)[1];
    assert.match(form, new RegExp(`<f>${discountTotal}</f><v>50</v>`), 'LESS DISCOUNTS takes the total of the list');
    assert.equal((await shop.manager.call('GET', '/api/daily-report.csv?date=2026-10-15')).status, 404, 'the CSV button and its file are gone');
  } finally { shop.close(); }
});

// ---- 8. Product pictures ----------------------------------------------------------------------------------------------------------

test('product pictures: managers and the admin upload a real JPEG/PNG/WebP; everyone signed in sees it; a missing one is a 404 the screen replaces with an icon', async () => {
  const shop = await makeShop();
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' + '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
    const url = `/api/product-images/chicken/${shop.whole}`;
    assert.equal((await shop.cashier.call('GET', url)).status, 404, 'no picture yet');
    assert.equal((await shop.cashier.call('PUT', url, { data_url: `data:image/png;base64,${png.toString('base64')}` })).status, 403, 'cashiers cannot change pictures');
    const up = await shop.manager.call('PUT', url, { data_url: `data:image/png;base64,${png.toString('base64')}` });
    assert.equal(up.status, 200, JSON.stringify(up.data));
    const got = await shop.cashier.call('GET', url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'image/png');
    assert.ok(got.data.equals(png));
    const cfg = (await shop.cashier.call('GET', '/api/config')).data;
    assert.ok(cfg.products.find((p) => p.id === shop.whole).image_version, 'the New order screen knows there is a picture');
    assert.equal(cfg.products.find((p) => p.id === shop.brown).image_version, null, 'and that Brown Cull Chicken has none (it shows an icon)');
    // not a picture, a lie about the type, or too big: refused
    assert.equal((await shop.manager.call('PUT', url, { data_url: 'data:text/html;base64,PGgxPg==' })).status, 400);
    assert.equal((await shop.manager.call('PUT', url, { data_url: `data:image/jpeg;base64,${png.toString('base64')}` })).status, 400);
    assert.equal((await shop.manager.call('PUT', url, { data_url: `data:image/png;base64,${Buffer.concat([png, Buffer.alloc(500_000)]).toString('base64')}` })).status, 400);
    // other products too; unknown kinds and products are 404
    const catfish = shop.other('Catfish').id;
    assert.equal((await shop.admin.call('PUT', `/api/product-images/other/${catfish}`, { data_url: `data:image/png;base64,${png.toString('base64')}` })).status, 200);
    assert.equal((await shop.admin.call('PUT', '/api/product-images/fish/1', { data_url: 'x' })).status, 404);
    assert.equal((await shop.admin.call('PUT', '/api/product-images/chicken/9999', { data_url: 'x' })).status, 404);
    // removing it brings the icon back
    assert.equal((await shop.manager.call('DELETE', url)).status, 200);
    assert.equal((await shop.cashier.call('GET', url)).status, 404);
  } finally { shop.close(); }
});

// ---- 9. The upgrade to version 9 --------------------------------------------------------------------------------------------------

test('upgrade to version 9: categories are filled in, Katay starts at 0, the history is copied exactly, and an old per-kg sale still counts on its old kg row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v9-'));
  const file = path.join(dir, 'pos.db');
  const seed = new DatabaseSync(file);
  seed.exec(fs.readFileSync(path.join(HERE, 'fixtures', 'schema-v7.sql'), 'utf8'));
  seed.exec('PRAGMA user_version = 7');
  const now = '2026-10-14T02:00:00.000Z';
  seed.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('owner','Owner','x','admin',?)").run(now);
  for (const name of ['B-Cull', 'Cull Chicken', 'Broilers', 'Native']) seed.prepare('INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES (?, 5800, 1, ?, ?)').run(name, now, now);
  seed.prepare("INSERT INTO business_days (business_date, status, opened_at) VALUES ('2026-10-14','OPEN',?)").run(now);
  seed.prepare("INSERT INTO other_products (name, active, created_at, updated_at) VALUES ('Garlic',1,?,?)").run(now, now);
  seed.prepare("INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at) VALUES (1,'kg','PER_KG',8000,1,?,?)").run(now, now);
  seed.prepare("INSERT INTO inventory_records (business_day_id, kind, option_id, beginning_milli, updated_at) VALUES (1,'OTHER',1,5000,?)").run(now);
  seed.prepare("INSERT INTO inventory_records (business_day_id, kind, product_id, beginning_milli, reject_milli, updated_at) VALUES (1,'CHICKEN',1,20000,1000,?)").run(now);
  seed.prepare("INSERT INTO inventory_events (record_id, field, old_milli, new_milli, user_id, created_at, note) VALUES (2,'reject',0,1000,1,?,'x')").run(now);
  seed.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key, business_day_id)
                VALUES ('ORD-20261014-001','2026-10-14','COMPLETED',12000,12000,1,?,'k1',1)`).run(now);
  seed.prepare(`INSERT INTO order_other_items (order_id, line_no, other_product_id, option_id, product_name, unit, sold_by, unit_price_centavos, quantity_milli, line_total_centavos)
                VALUES (1,1,1,1,'Garlic','kg','PER_KG',8000,1500,12000)`).run();
  const eventsBefore = seed.prepare('SELECT * FROM inventory_events ORDER BY id').all().map((e) => ({ ...e }));
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
  assert.deepEqual(db.prepare('SELECT name, category FROM products ORDER BY id').all().map((p) => [p.name, p.category]),
    [['B-Cull', 'BCULL'], ['Cull Chicken', 'CULL'], ['Broilers', 'BROILER'], ['Native', 'OTHER']]);
  assert.ok(db.prepare('SELECT katay_milli FROM inventory_records').all().every((r) => r.katay_milli === 0));
  assert.deepEqual(db.prepare('SELECT * FROM inventory_events ORDER BY id').all().map(({ reason_code: _a, reason_note: _b, ...e }) => e), eventsBefore, 'the history is copied across with its own ids and values');
  assert.throws(() => db.prepare("UPDATE inventory_events SET note = 'y'").run(), /cannot be changed/, 'and its protection is back');
  assert.equal(db.prepare('SELECT pieces FROM order_other_items').get().pieces, null);
  assert.ok(fs.readdirSync(dir).some((f) => /\.before-v8-.*\.bak$/.test(f)), 'a safety copy was made first');
  // the old kg row still holds its number and its old sale (saved without a piece count), so it is still shown with that sale:
  // nothing that has a number is hidden. New sales by the kilo count on the piece row, which now exists too.
  const admin = db.prepare("SELECT * FROM users WHERE username = 'owner'").get();
  const inv = getInventory(db, admin, {}, new Date(now));
  const kg = inv.other.find((r) => r.name === 'Garlic - kg');
  assert.deepEqual([kg.beginning, kg.sold, kg.new_total], [5000, 1500, 3500]);
  assert.ok(inv.other.some((r) => r.name === 'Garlic - piece'));
  db.close();
  const again = openDb(file);
  assert.equal(again.prepare('PRAGMA user_version').get().user_version, 14, 'a second start changes nothing');
  assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.bak')).length, 1, 'and makes no second copy');
  again.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
