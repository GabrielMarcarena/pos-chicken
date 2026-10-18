// End-to-end API tests: a real server on a random port with an in-memory database.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { inflateRawSync } from 'node:zlib';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct, createOtherProduct, seedStarterCatalog, listOtherProducts } from '../src/services/catalog.js';
import { listBoard } from '../src/services/orders.js';
import { gatherDaily, buildModel } from '../src/services/dailyReport.js';
import { gatherExport } from '../src/services/export.js';

let server, base, db;
const clock = { now: new Date('2026-10-09T02:00:00Z') }; // 10:00 in the Philippines
const config = loadConfig({ dbPath: ':memory:', largeWeightKg: 50, sessionIdleMinutes: 240 });

function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
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
  return {
    call,
    async login(username, password) { const r = await call('POST', '/api/login', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r; },
  };
}

let admin, manager, cashier, cull, bcull, broilers, eggs, eggCarton, eggPiece, garlic, garlicKg;
let keyN = 0;
const key = () => `test-key-${++keyN}-${Math.random().toString(36).slice(2)}`;
// A live chicken (no preparation) and a Pour / Dress line with a cutting choice.
const live = (product, weight, extra = {}) => ({ product_id: product, weight, feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null, ...extra });
const po = (product, weight, size = 'MEDIUM', extra = {}) => ({ product_id: product, weight, feather: 'POUR', dara: false, cut: 'SLICE', slice_size: size, ...extra });
const dressed = (product, weight, size = 'MEDIUM', extra = {}) => ({ product_id: product, weight, feather: 'NOT_POUR', dara: false, cut: 'SLICE', slice_size: size, ...extra });
const other = (option, quantity) => ({ other_product_id: option.product, option_id: option.id, quantity });

// Revision 9: orders are checked against the Daily Inventory, so the tests give every product plenty of stock first.
// (Tests of the stock rules themselves are in tests/inventory.test.js and use small numbers.)
async function stockUp(who, amount) {
  const inv = await who.call('GET', '/api/inventory');
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  for (const row of [...inv.data.chicken, ...inv.data.other]) {
    if (row.beginning >= amount * 1000) continue;
    const r = await who.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: amount });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
}

before(async () => {
  db = openDb(':memory:');
  const a = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  cull = createProduct(db, a, { name: 'Cull Chicken', price: '58' }).id;
  broilers = createProduct(db, a, { name: 'Broilers', price: '120' }).id;
  bcull = createProduct(db, a, { name: 'Broiler Breeder Cull', price: '52' }).id;
  // Eggs are sold by piece, carton and tray; every other product by piece, pack, sack and kg (revision 10).
  const e = createOtherProduct(db, a, { name: 'Eggs (Small)', kind: 'EGGS', prices: { carton: '120', piece: '10' } });
  eggs = e.id; eggCarton = { id: e.options.find((o) => o.unit === 'carton').id, product: eggs }; eggPiece = { id: e.options.find((o) => o.unit === 'piece').id, product: eggs };
  const g = createOtherProduct(db, a, { name: 'Garlic', kind: 'OTHER', prices: { kg: '80' } });
  garlic = g.id; garlicKg = { id: g.options.find((o) => o.unit === 'kg').id, product: garlic };
  server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client(); manager = client(); cashier = client();
  await admin.login('owner', 'owner-pass-1');
  await manager.login('mgr', 'manager-pass-1');
  await cashier.login('cash', 'cashier-pass-1');
  await stockUp(manager, 5000);
  // The shop's service prices: Live no fee, Pour (burn chicken) 45, Dress (dress chicken) 25.
  assert.equal((await admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_item' })).status, 200);
  assert.equal((await admin.call('PUT', '/api/service-fees/NOT_POUR', { amount: '25', basis: 'per_item' })).status, 200);
});
after(() => server.close());

test('sign-in is required, wrong passwords are refused, and writes need the app header', async () => {
  const anon = client();
  const me = await anon.call('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.data.user, null);
  assert.equal((await anon.call('GET', '/api/config')).status, 401);
  assert.equal((await anon.call('POST', '/api/login', { username: 'cash', password: 'nope' })).status, 401);
  const noHeader = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noHeader.status, 403);
});

test('roles are enforced on the server', async () => {
  assert.equal((await cashier.call('GET', '/api/users')).status, 403);
  assert.equal((await cashier.call('GET', '/api/export.csv')).status, 403);
  assert.equal((await cashier.call('POST', '/api/products', { name: 'X' })).status, 403);
  assert.equal((await cashier.call('POST', '/api/other-products', { name: 'X' })).status, 403);
  assert.equal((await manager.call('GET', '/api/users')).status, 403);
  assert.equal((await manager.call('PUT', '/api/service-fees/POUR', { amount: '5', basis: 'per_item' })).status, 403);
  assert.equal((await admin.call('GET', '/api/users')).status, 200);
});

test('all editable prices belong to the admin; managers can add products but not set prices', async () => {
  // chicken
  const added = await manager.call('POST', '/api/products', { name: 'Native Chicken' });
  assert.equal(added.data.product.active, false);
  assert.equal((await manager.call('POST', '/api/products', { name: 'Priced by manager', price: '99' })).status, 403);
  assert.equal((await manager.call('PATCH', `/api/products/${cull}`, { price: '70' })).status, 403);
  assert.equal((await manager.call('PATCH', `/api/products/${added.data.product.id}`, { active: true })).status, 400);
  const priced = await admin.call('PATCH', `/api/products/${added.data.product.id}`, { price: '95', active: true });
  assert.equal(priced.data.product.price_per_kg_centavos, 9500);
  // other products: a manager can add a product. It gets all of its ways of selling at once (piece, pack, sack, kg), all inactive until the admin prices them
  const etag = await manager.call('POST', '/api/other-products', { name: 'Etag (Smoked)', kind: 'OTHER' });
  assert.equal(etag.status, 201, JSON.stringify(etag.data));
  assert.equal(etag.data.other_product.kind, 'OTHER');
  assert.deepEqual(etag.data.other_product.options.map((o) => o.unit), ['piece', 'pack', 'sack', 'kg']);
  assert.ok(etag.data.other_product.options.every((o) => o.active === false && o.price_centavos === 0));
  assert.deepEqual(etag.data.other_product.options.map((o) => o.sold_by), ['FIXED', 'FIXED', 'FIXED', 'PER_KG']);
  const opt = etag.data.other_product.options.find((o) => o.unit === 'kg');
  assert.equal((await manager.call('POST', '/api/other-products', { name: 'Priced by manager', kind: 'OTHER', prices: { kg: '5' } })).status, 403);
  assert.equal((await manager.call('POST', '/api/other-products', { name: 'Eggs with kg', kind: 'EGGS', prices: { kg: '5' } })).status, 400);   // eggs are not sold by kg
  assert.equal((await manager.call('POST', '/api/other-products', { name: 'Fruit', kind: 'FRUIT' })).status, 400);
  const newEggs = await manager.call('POST', '/api/other-products', { name: 'Eggs (Jumbo)', kind: 'EGGS' });
  assert.equal(newEggs.status, 201);
  assert.deepEqual(newEggs.data.other_product.options.map((o) => o.unit), ['piece', 'carton', 'tray']);
  assert.equal((await manager.call('POST', '/api/other-products', { name: 'No kind given' })).data.other_product.kind, 'OTHER');   // the default
  assert.equal((await manager.call('PATCH', `/api/other-product-options/${eggCarton.id}`, { price: '999' })).status, 403);
  assert.equal((await manager.call('PATCH', `/api/other-product-options/${opt.id}`, { active: true })).status, 400);
  const live = await admin.call('PATCH', `/api/other-product-options/${opt.id}`, { price: '450', active: true });
  assert.equal(live.status, 200);
  assert.equal(live.data.other_product.options.find((o) => o.unit === 'kg').price_centavos, 45000);
  // a unit never changes (stock and saved orders are counted in it)
  assert.equal((await admin.call('PATCH', `/api/other-product-options/${opt.id}`, { unit: 'pack' })).status, 400);
  // the admin can price a new product's ways of selling when it is added, and a first price switches the option on
  const priced2 = await admin.call('POST', '/api/other-products', { name: 'Onion Leeks', kind: 'OTHER', prices: { kg: '90', pack: '25' } });
  assert.equal(priced2.status, 201);
  assert.deepEqual(priced2.data.other_product.options.map((o) => [o.unit, o.price_centavos, o.active]), [['piece', 0, false], ['pack', 2500, true], ['sack', 0, false], ['kg', 9000, true]]);
  // a manager may rename and switch products on and off
  assert.equal((await manager.call('PATCH', `/api/other-products/${etag.data.other_product.id}`, { name: 'Etag (Smoked) Special' })).status, 200);
  // the ways of selling already exist, so adding one again is refused, and so is a unit outside the product's list
  assert.equal((await manager.call('POST', `/api/other-products/${etag.data.other_product.id}/options`, { unit: 'pack' })).status, 409);
  assert.equal((await manager.call('POST', `/api/other-products/${etag.data.other_product.id}/options`, { unit: 'dozen' })).status, 400);
  assert.equal((await manager.call('POST', `/api/other-products/${newEggs.data.other_product.id}/options`, { unit: 'sack' })).status, 400);
});

test('the cashier screen only offers products with an active, priced option', async () => {
  const cfg = (await cashier.call('GET', '/api/config')).data;
  const names = cfg.other_products.map((p) => p.name);
  assert.ok(names.includes('Eggs (Small)') && names.includes('Garlic'));
  assert.ok(!names.some((n) => n.startsWith('Priced by manager')));
  assert.equal(cfg.fees.POUR.amount, 4500);
  assert.ok(cfg.discount_reasons.WHOLESALE && !cfg.discount_reasons.SENIOR);   // Revision 11: Senior citizen and VIP are no longer offered
});

test('first-run starter data: service prices and the shop\'s other products, all waiting for prices', () => {
  const fresh = openDb(':memory:');
  fresh.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a','A','x','admin','2026-01-01')").run();
  assert.equal(seedStarterCatalog(fresh), true);
  assert.equal(seedStarterCatalog(fresh), false); // never twice
  const fees = Object.fromEntries(fresh.prepare('SELECT code, amount_centavos FROM service_fees').all().map((f) => [f.code, f.amount_centavos]));
  assert.deepEqual([fees.POUR, fees.NOT_POUR], [4500, 2500]);
  const bases = Object.fromEntries(fresh.prepare('SELECT code, basis FROM service_fees').all().map((f) => [f.code, f.basis]));
  assert.deepEqual([bases.POUR, bases.NOT_POUR], ['per_head', 'per_head']);   // services are per head
  assert.equal(bases.DARA, undefined, 'With Blood and Dukot have no fee any more, so a new install does not even list them');
  assert.equal(bases.DUKOT, undefined);
  const all = listOtherProducts(fresh, { includeInactive: true });
  assert.deepEqual(all.map((p) => p.name).sort(), ['Eggs (Large)', 'Eggs (Medium)', 'Eggs (Small)', 'Etag (Smoked)', 'Etag (Sun-Dried)', 'Garlic', 'Laya', 'Onions']);
  assert.deepEqual(all.find((p) => p.name === 'Eggs (Small)').options.map((o) => o.unit), ['piece', 'carton', 'tray']);
  assert.deepEqual(all.find((p) => p.name === 'Etag (Sun-Dried)').options.map((o) => o.unit), ['piece', 'pack', 'sack', 'kg']);
  assert.deepEqual(all.map((p) => [p.name, p.kind]).filter(([, k]) => k === 'EGGS').map(([n]) => n).sort(), ['Eggs (Large)', 'Eggs (Medium)', 'Eggs (Small)']);
  assert.ok(all.every((p) => p.options.every((o) => o.price_centavos === 0 && o.active === false)));
  assert.equal(listOtherProducts(fresh).length, 0); // nothing sellable until the admin sets prices
});

test('an old database file is refused with a clear message instead of being damaged', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pos-old-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE users (id INTEGER PRIMARY KEY); PRAGMA user_version = 0;');
  old.close();
  assert.throws(() => openDb(file), /first version/);
});

test('Cull Chicken 3.6 kg: Live ₱208.80, Pour ₱253.80, Dress ₱233.80, and the first order number', async () => {
  const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '3.6', 'MEDIUM', { dara: true })] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const o = r.data.order;
  assert.equal(o.order_number, 'ORD-20261009-001');
  assert.equal(o.total_centavos, 25380);
  assert.equal(o.items[0].weight_amount_centavos, 20880);
  assert.equal(o.items[0].service_fee_centavos, 4500);
  assert.deepEqual([o.items[0].feather, o.items[0].dara, o.items[0].cut, o.items[0].slice_size], ['POUR', true, 'SLICE', 'MEDIUM']);
  assert.equal(o.customer_number, 'WALK-IN');
  const d = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [dressed(cull, '3.6', 'SMALL')] });
  assert.equal(d.data.order.total_centavos, 23380);
  const l = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '3.6')] });
  assert.equal(l.data.order.total_centavos, 20880);
  assert.equal(l.data.order.items[0].service_fee_centavos, 0);
});

test('Dukot is a cutting choice with its own (default none) fee; the slice size never changes the price', async () => {
  const dukot = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [{ ...po(cull, '3.6'), cut: 'DUKOT', slice_size: null }] });
  assert.equal(dukot.status, 201);
  assert.equal(dukot.data.order.total_centavos, 25380);
  const sizes = [];
  for (const size of ['SMALL', 'MEDIUM', 'LARGE']) sizes.push((await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '3.6', size)] })).data.order.total_centavos);
  assert.deepEqual(new Set(sizes).size, 1);
});

test('several chicken items plus eggs (fixed price) and garlic (per kg) add up correctly', async () => {
  const r = await cashier.call('POST', '/api/orders', {
    submission_key: key(), customer_number: 'C-1001',
    items: [live(cull, '3.6'), live(broilers, '2')],
    other_items: [other(eggCarton, '2'), other(eggPiece, '5'), other(garlicKg, '1.5')],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const o = r.data.order;
  // 208.80 + 240.00 + (2 x 120.00) + (5 x 10.00) + (1.5 x 80.00)
  assert.equal(o.total_centavos, 20880 + 24000 + 24000 + 5000 + 12000);
  assert.equal(o.customer_number, 'C-1001');
  assert.deepEqual(o.items.map((i) => i.line_no).concat(o.other_items.map((i) => i.line_no)), [1, 2, 3, 4, 5]);
  assert.deepEqual(o.other_items.map((i) => [i.unit, i.sold_by, i.quantity_milli]), [['carton', 'FIXED', 2000], ['piece', 'FIXED', 5000], ['kg', 'PER_KG', 1500]]);
});

test('fixed-price items need whole numbers; per-kg items take decimals; unavailable options are refused', async () => {
  const bad = async (other_items, expected) => {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), other_items });
    assert.equal(r.status, 400, JSON.stringify(other_items));
    assert.match(JSON.stringify(r.data), expected);
  };
  await bad([other(eggCarton, '1.5')], /whole number of carton/);
  await bad([other(eggCarton, '0')], /whole number/);
  await bad([other(garlicKg, '0')], /weight above 0/);
  await bad([other(garlicKg, '1.2345')], /weight above 0/);
  await bad([{ other_product_id: garlic, option_id: eggCarton.id, quantity: '1' }], /not found/);   // option belongs to another product
  await bad([{ other_product_id: garlic, quantity: '1' }], /not found/);
  const ok = await cashier.call('POST', '/api/orders', { submission_key: key(), other_items: [other(eggCarton, '3')] });
  assert.equal(ok.status, 201);                                                                    // an order of only other products is fine
  assert.equal(ok.data.order.total_centavos, 36000);
});

test('the server ignores prices sent by the browser and refuses a stale total', async () => {
  const sneaky = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [{ ...live(cull, '1'), price_per_kg_centavos: 1, line_total_centavos: 1 }] });
  assert.equal(sneaky.data.order.total_centavos, 5800);
  const stale = await cashier.call('POST', '/api/orders', { submission_key: key(), expected_total_centavos: 1234, items: [live(cull, '1')] });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, 'PRICE_CHANGED');
});

test('submitting the same order twice creates only one order', async () => {
  const k = key();
  const before = (await cashier.call('GET', '/api/orders')).data.orders.length;
  const a = await cashier.call('POST', '/api/orders', { submission_key: k, items: [live(cull, '1.5')] });
  const b = await cashier.call('POST', '/api/orders', { submission_key: k, items: [live(cull, '1.5')] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.data.duplicate, true);
  assert.equal(a.data.order.order_number, b.data.order.order_number);
  assert.equal((await cashier.call('GET', '/api/orders')).data.orders.length, before + 1);
});

test('parallel submissions never share an order number', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')] })));
  const numbers = results.map((r) => r.data.order.order_number);
  assert.equal(new Set(numbers).size, 12);
  assert.ok(results.every((r) => r.status === 201));
});

test('invalid orders are rejected with plain messages', async () => {
  const bad = async (payload, expected) => {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), ...payload });
    assert.equal(r.status, 400, JSON.stringify(payload));
    if (expected) assert.match(JSON.stringify(r.data), expected);
  };
  await bad({ items: [] }, /at least one item/);
  await bad({ items: [live(cull, '0')] }, /weight/);
  await bad({ items: [live(cull, '-2')] }, /weight/);
  await bad({ items: [live(cull, '')] }, /weight/);
  await bad({ items: [live(cull, '1.2345')] }, /weight/);
  await bad({ items: [live(cull, '1', { feather: null })] }, /Choose a service/);
  await bad({ items: [po(cull, '1', null)] }, /slice size/);                                      // slice without a size
  await bad({ items: [{ ...po(cull, '1'), cut: 'NONE', slice_size: 'SMALL' }] }, /not sliced cannot have a slice size/);   // a whole chicken has no slice size
  await bad({ items: [{ ...po(cull, '1'), cut: 'CHOP', slice_size: null }] }, /cutting option/);
  await bad({ items: [{ ...po(cull, '1'), cut: 'DUKOT', slice_size: 'SMALL' }] }, /Dukot service is not sliced/);
  await bad({ items: [po(cull, '1', 'GIANT')] }, /slice size/);
  await bad({ items: [live(cull, '1', { dara: true })] }, /live chicken cannot have With Blood/);
  await bad({ items: [live(cull, '1', { cut: 'DUKOT' })] }, /live chicken has no cutting/);
  await bad({ items: [live(cull, '1', { cut: 'SLICE', slice_size: 'SMALL' })] }, /live chicken has no cutting/);
  await bad({ items: [live(9999, '1')] }, /not found/);
  await bad({ items: [live(cull, '1')], payment: { method: 'BITCOIN', amount: '10' } }, /payment method/);
  await bad({ items: [live(cull, '1')], customer_number: '<script>' }, /not allowed/);
});

test('a missing submission key is refused', async () => {
  const r = await cashier.call('POST', '/api/orders', { items: [live(cull, '1')] });
  assert.equal(r.status, 400);
});

test('weights above the limit need a confirmation', async () => {
  const k = key();
  const first = await cashier.call('POST', '/api/orders', { submission_key: k, items: [live(cull, '60')] });
  assert.equal(first.status, 400);
  assert.equal(first.data.code, 'WEIGHT_CONFIRM');
  const second = await cashier.call('POST', '/api/orders', { submission_key: k, items: [live(cull, '60', { confirm_large: true })] });
  assert.equal(second.status, 201);
});

test('discounts: fixed or percentage, optional, with a reason, and never the whole order', async () => {
  const items = [po(cull, '3.6')]; // subtotal ₱253.80
  const send = (discount, extra = {}) => cashier.call('POST', '/api/orders', { submission_key: key(), items, discount, ...extra });
  const pct = await send({ type: 'PERCENT', value: '20', reason_code: 'WHOLESALE' }, { expected_total_centavos: 20304 });
  assert.equal(pct.status, 201, JSON.stringify(pct.data));
  assert.equal(pct.data.order.subtotal_centavos, 25380);
  assert.deepEqual([pct.data.order.discount.type, pct.data.order.discount.amount_centavos, pct.data.order.discount.reason_code], ['PERCENT', 5076, 'WHOLESALE']);
  assert.equal(pct.data.order.total_centavos, 20304);
  const fixed = await send({ type: 'FIXED', value: '50', reason_code: 'OTHER', note: 'Regular customer' });
  assert.equal(fixed.data.order.total_centavos, 20380);
  assert.equal(fixed.data.order.discount.note, 'Regular customer');
  const none = await send({ type: 'NONE' });
  assert.equal(none.data.order.total_centavos, 25380);
  assert.equal(none.data.order.discount.amount_centavos, 0);
  // refusals
  const refused = async (discount, expected) => { const r = await send(discount); assert.equal(r.status, 400, JSON.stringify(discount)); assert.match(JSON.stringify(r.data), expected); };
  await refused({ type: 'PERCENT', value: '100', reason_code: 'WHOLESALE' }, /less than the order subtotal/);
  await refused({ type: 'PERCENT', value: '101', reason_code: 'WHOLESALE' }, /0% and at most 100%/);
  await refused({ type: 'PERCENT', value: '0', reason_code: 'WHOLESALE' }, /above 0%/);
  await refused({ type: 'FIXED', value: '253.80', reason_code: 'WHOLESALE' }, /less than the order subtotal/);
  await refused({ type: 'FIXED', value: '999', reason_code: 'WHOLESALE' }, /less than the order subtotal/);
  await refused({ type: 'FIXED', value: '-5', reason_code: 'WHOLESALE' }, /above ₱0\.00/);
  await refused({ type: 'FIXED', value: '10' }, /reason for the discount/);
  await refused({ type: 'FIXED', value: '10', reason_code: 'OTHER' }, /Explain the discount/);
  await refused({ type: 'BIGSALE', value: '10', reason_code: 'WHOLESALE' }, /fixed or a percentage/);
  // the discount applies to the whole order, other products included
  const mixed = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')], other_items: [other(eggCarton, '1')], discount: { type: 'PERCENT', value: '10', reason_code: 'WHOLESALE' } });
  assert.equal(mixed.data.order.subtotal_centavos, 5800 + 12000);
  assert.equal(mixed.data.order.total_centavos, 17800 - 1780);
});

test('a refund returns the discounted total, and a discount cannot be edited afterwards', async () => {
  const o = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [dressed(cull, '2')], discount: { type: 'FIXED', value: '16', reason_code: 'WHOLESALE' } })).data.order;
  assert.equal(o.total_centavos, 11600 + 2500 - 1600);
  const r = await manager.call('POST', `/api/orders/${o.id}/refund`, { reason_code: 'WRONG_PRODUCT' });
  assert.equal(r.data.order.refund_centavos, 12500);
  assert.throws(() => db.prepare('UPDATE orders SET discount_centavos = 0 WHERE id = ?').run(o.id), /cannot be changed/);
});

test('service fees and other-product prices can change without touching past orders', async () => {
  const before = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '3.6')], other_items: [other(eggCarton, '1')] })).data.order;
  assert.equal(before.total_centavos, 25380 + 12000);
  assert.equal((await admin.call('PUT', '/api/service-fees/POUR', { amount: '60', basis: 'per_item' })).status, 200);
  assert.equal((await admin.call('PATCH', `/api/other-product-options/${eggCarton.id}`, { price: '130' })).status, 200);
  assert.equal((await admin.call('PATCH', `/api/products/${cull}`, { price: '60' })).status, 200);
  const old = (await cashier.call('GET', `/api/orders/${before.id}`)).data.order;
  assert.equal(old.total_centavos, 37380);
  assert.equal(old.items[0].price_per_kg_centavos, 5800);
  assert.equal(old.items[0].service_fee_centavos, 4500);
  assert.equal(old.other_items[0].unit_price_centavos, 12000);
  const fresh = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '1')], other_items: [other(eggCarton, '1')] })).data.order;
  assert.equal(fresh.total_centavos, 6000 + 6000 + 13000);
  await admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_item' });
  await admin.call('PATCH', `/api/other-product-options/${eggCarton.id}`, { price: '120' });
  await admin.call('PATCH', `/api/products/${cull}`, { price: '58' });
  const history = (await admin.call('GET', '/api/price-history')).data.history;
  assert.ok(history.some((h) => h.kind === 'SERVICE_FEE' && h.subject === 'POUR' && h.old_value === 4500 && h.new_value === 6000));
  assert.ok(history.some((h) => h.kind === 'OTHER_PRICE' && h.subject_name === 'Eggs (Small) (carton)' && h.new_value === 13000));
  assert.ok(history.some((h) => h.kind === 'CHICKEN_PRICE' && h.old_value === 5800 && h.new_value === 6000));
});

test('payment details are saved; cashiers see account details masked, managers see them in full', async () => {
  const r = await cashier.call('POST', '/api/orders', {
    submission_key: key(), items: [live(cull, '1')],
    payment: { method: 'GCASH', amount: '58', paid_at: '2026-10-09T10:15', account_name: 'Juan Dela Cruz', account_number: '09171234567', reference: 'REF 123' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const p = r.data.order.payments[0];
  assert.equal(p.amount_centavos, 5800);
  assert.equal(p.paid_at, '2026-10-09T02:15:00.000Z');
  assert.equal(p.account_number, '•••••••4567');
  assert.equal(p.account_name, 'J••• D••• C•••');
  const seen = (await manager.call('GET', `/api/orders/${r.data.order.id}`)).data.order.payments[0];
  assert.equal(seen.account_number, '09171234567');
  assert.equal(seen.account_name, 'Juan Dela Cruz');
  const cash = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')], payment: { method: 'CASH', amount: '58', received: '100', account_number: '123' } });
  assert.equal(cash.data.order.payments[0].account_number, null);
});

test('cancel needs a reason, keeps the order, and cannot be repeated', async () => {
  const o = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '2')] })).data.order;
  assert.equal((await cashier.call('POST', `/api/orders/${o.id}/cancel`, {})).status, 400);
  assert.equal((await cashier.call('POST', `/api/orders/${o.id}/cancel`, { reason_code: 'OTHER' })).status, 400);
  const done = await cashier.call('POST', `/api/orders/${o.id}/cancel`, { reason_code: 'OTHER', reason_note: 'Customer left without paying', stock_returnable: true });
  assert.equal(done.status, 200);
  assert.equal(done.data.order.status, 'CANCELED');
  assert.equal(done.data.order.items.length, 1);
  assert.equal(done.data.order.total_centavos, 11600);
  const e = done.data.order.events.at(-1);
  assert.deepEqual([e.action_type, e.reason_code, e.reason_note, e.user_name, e.stock_returnable], ['CANCEL', 'OTHER', 'Customer left without paying', 'Cashier', true]);
  assert.equal((await cashier.call('POST', `/api/orders/${o.id}/cancel`, { reason_code: 'WRONG_WEIGHT' })).status, 409);
  assert.equal((await manager.call('POST', `/api/orders/${o.id}/refund`, { reason_code: 'WRONG_WEIGHT' })).status, 409);
});

test('refund is for managers, is its own status, and keeps the original order', async () => {
  const o = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(broilers, '2')] })).data.order;
  assert.equal((await cashier.call('POST', `/api/orders/${o.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 403);
  const r = await manager.call('POST', `/api/orders/${o.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED', reason_note: 'Smelled off' });
  assert.equal(r.status, 200);
  assert.equal(r.data.order.status, 'REFUNDED');
  assert.equal(r.data.order.refund_centavos, 24000);
  assert.equal((await manager.call('POST', `/api/orders/${o.id}/refund`, { reason_code: 'WRONG_WEIGHT' })).status, 409);
});

test('change = void and replace, linked both ways; the discount can be carried over', async () => {
  const o = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '3.0')], discount: { type: 'PERCENT', value: '20', reason_code: 'WHOLESALE' } })).data.order;
  const r = await cashier.call('POST', `/api/orders/${o.id}/change`, {
    submission_key: key(), reason_code: 'WRONG_WEIGHT', items: [po(cull, '3.6')], discount: { type: 'PERCENT', value: '20', reason_code: 'WHOLESALE' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const replacement = r.data.order;
  assert.equal(replacement.replaces_number, o.order_number);
  assert.equal(replacement.total_centavos, 25380 - 5076);
  const original = (await cashier.call('GET', `/api/orders/${o.id}`)).data.order;
  assert.equal(original.status, 'REPLACED');
  assert.equal(original.replaced_by_number, replacement.order_number);
  assert.equal(original.items[0].weight_g, 3000);
  assert.equal(original.discount.amount_centavos, 4380);             // 20% of ₱219.00, kept on the original
  assert.equal(original.events.at(-1).action_type, 'CHANGE');
  assert.equal(original.events.at(-1).related_number, replacement.order_number);
  assert.equal((await cashier.call('POST', `/api/orders/${o.id}/change`, { submission_key: key(), reason_code: 'WRONG_WEIGHT', items: [live(cull, '1')] })).status, 409);
});

test('number of heads: 3 heads of B-cull weighed together at 5.4 kg is saved and priced on the total weight', async () => {
  const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(bcull, '5.4', { heads: 3 })] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const item = r.data.order.items[0];
  assert.deepEqual([item.heads, item.weight_g, item.price_per_kg_centavos, item.weight_amount_centavos, item.line_total_centavos], [3, 5400, 5200, 28080, 28080]);
  assert.equal(r.data.order.total_centavos, 28080);                               // ₱280.80
  const again = (await cashier.call('GET', `/api/orders/${r.data.order.id}`)).data.order;
  assert.equal(again.items[0].heads, 3);
  // heads is optional and means 1; both forms give the same price
  const single = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(bcull, '1.8')] });
  assert.equal(single.data.order.items[0].heads, 1);
  const explicit = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(bcull, '1.8', { heads: '1' })] });
  assert.equal(explicit.data.order.total_centavos, single.data.order.total_centavos);
  // the service and cutting work the same way with several heads (flat fee: once per line)
  const sliced = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(bcull, '5.4', 'LARGE', { heads: 3 })] });
  assert.equal(sliced.data.order.total_centavos, 28080 + 4500);
});

test('number of heads: invalid values are refused, and a per-head fee is multiplied by the heads', async () => {
  const bad = async (heads) => {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(bcull, '5.4', { heads })] });
    assert.equal(r.status, 400, `heads ${JSON.stringify(heads)}`);
    assert.match(JSON.stringify(r.data), /number of heads must be a whole number from 1 to 999/);
  };
  for (const heads of [0, -2, 1.5, '2.5', 1000, 'three', null, '']) await bad(heads);
  assert.equal((await admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_head' })).status, 200);
  try {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(bcull, '5.4', 'MEDIUM', { heads: 3 })] });
    assert.equal(r.data.order.items[0].service_fee_centavos, 13500);              // 3 x ₱45
    assert.equal(r.data.order.total_centavos, 28080 + 13500);                      // ₱415.80
    assert.deepEqual([r.data.order.items[0].fees[0].basis, r.data.order.items[0].fees[0].rate], ['per_head', 4500]);
    const one = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(bcull, '1.8', 'MEDIUM')] });
    assert.equal(one.data.order.items[0].service_fee_centavos, 4500);              // one head: same as before
    const live3 = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(bcull, '5.4', { heads: 3 })] });
    assert.equal(live3.data.order.total_centavos, 28080);                          // Live has no fee
  } finally {
    await admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_item' });
  }
  assert.equal((await manager.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_head' })).status, 403);
});

test('searching orders by number and filtering by status', async () => {
  const all = (await cashier.call('GET', '/api/orders?q=ORD-20261009-001')).data.orders;
  assert.equal(all.length, 1);
  const canceled = (await cashier.call('GET', '/api/orders?status=CANCELED')).data.orders;
  assert.ok(canceled.length >= 1 && canceled.every((x) => x.status === 'CANCELED'));
  assert.equal((await cashier.call('GET', '/api/orders?from=2030-01-01')).data.orders.length, 0);
});

test('users: the last admin is protected and idle sessions expire', async () => {
  const me = (await admin.call('GET', '/api/me')).data.user;
  assert.equal((await admin.call('PATCH', `/api/users/${me.id}`, { active: false })).status, 400);
  assert.equal((await admin.call('PATCH', `/api/users/${me.id}`, { role: 'manager' })).status, 400);
  const idle = client();
  await idle.login('cash', 'cashier-pass-1');
  assert.equal((await idle.call('GET', '/api/me')).status, 200);
  clock.now = new Date(clock.now.getTime() + 5 * 3600 * 1000);
  try {
    assert.equal((await idle.call('GET', '/api/me')).data.user, null);
    assert.equal((await idle.call('GET', '/api/config')).status, 401);
  } finally {
    clock.now = new Date('2026-10-09T02:00:00Z');
  }
});

// ---- Daily Sales Report ---------------------------------------------------------------------------

test('daily report: the paper form, filled in with what the app knows (per-head services, eggs, others, totals)', async () => {
  // Revision 13: sold on the open day, at the time the other tests use. (A jump to a later date would close the day at midnight, and the
  // tests after this one, which go back to 9 October, would then sell on a day that only exists in the future.)
  const day = '2026-10-09';
  const ca = client(), mg = client(), ad = client();
  await ca.login('cash', 'cashier-pass-1'); await mg.login('mgr', 'manager-pass-1'); await ad.login('owner', 'owner-pass-1');
  assert.equal((await ad.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_head' })).status, 200);
  assert.equal((await ad.call('PUT', '/api/service-fees/NOT_POUR', { amount: '25', basis: 'per_head' })).status, 200);
  try {
    // cashier: 3 heads of B-cull burned and sliced (3 x 45), then eggs and garlic with a GCash payment (must not appear in the report)
    const o1 = await ca.call('POST', '/api/orders', { submission_key: key(), customer_number: 'C-7001', items: [po(bcull, '5.4', 'MEDIUM', { heads: 3 })] });
    const o2 = await ca.call('POST', '/api/orders', {
      submission_key: key(), customer_number: 'Aling Rosa', items: [dressed(cull, '3.6', 'LARGE'), live(broilers, '2.2', { heads: 2 })],
      other_items: [other(eggCarton, '2'), other(eggPiece, '5'), other(garlicKg, '0.5')],
      payment: { method: 'GCASH', account_name: 'Juan Dela Cruz', account_number: '09171234567' },
    });
    const o3 = await ca.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')] });                     // will be canceled
    // manager: one more order, then a refund
    const o4 = await mg.call('POST', '/api/orders', { submission_key: key(), items: [dressed(cull, '2')], other_items: [other(garlicKg, '1')] });
    for (const r of [o1, o2, o3, o4]) assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await ca.call('POST', `/api/orders/${o3.data.order.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' })).status, 200);
    assert.equal((await mg.call('POST', `/api/orders/${o4.data.order.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 200);

    // Revision 11: the report is Excel only ("Download Daily Report"); the CSV (one row per sale line) is gone. The data behind it is checked here.
    assert.equal((await mg.call('GET', `/api/daily-report.csv?date=${day}`)).status, 404);
    // Revision 11: the report date is the BUSINESS DAY the orders were counted on. Revision 13: a day closes by itself at midnight, so
    // the business day of an order is the date it was sold on.
    const bday = db.prepare('SELECT d.business_date AS d FROM orders o JOIN business_days d ON d.id = o.business_day_id WHERE o.id = ?').get(o1.data.order.id).d;
    assert.equal(bday, day);
    const ours = new Set([o1, o2, o3, o4].map((r) => r.data.order.order_number));
    const full = gatherDaily(db, { date: bday });
    const data = { ...full, chicken: full.chicken.filter((l) => ours.has(l.order)), other: full.other.filter((l) => ours.has(l.order)) };   // this test's orders only
    const lines = [...data.chicken, ...data.other];
    // canceled order is not listed; the refunded one is, and is marked
    assert.ok(!lines.some((l) => l.order === o3.data.order.order_number));
    assert.ok(lines.some((l) => l.order === o4.data.order.order_number && l.refunded));
    // 3 heads of B-cull: 5.4 kg x 52 = 280.80, service 3 x 45 = 135, amount 415.80, in the B-CULL block (its category)
    const model = buildModel(data);
    const bc = model.blocks.find((b) => b.title === 'B-CULL').lines.find((l) => l.customer === 'C-7001');
    assert.deepEqual([bc.heads, bc.kilos, bc.price, bc.service, bc.weightAmount, bc.amount], [3, 5.4, 5200, 13500, 28080, 41580]);
    // the other chicken lines of Aling Rosa land in CULL and BROILER; eggs in their own units under EGGS; garlic (0.5 kg, 1 piece) under OTHERS
    const blockOf = (customer) => model.blocks.flatMap((b) => b.lines.filter((l) => l.customer === customer).map((l) => `${b.title}:${l.product}:${l.kilos} kg`));
    assert.deepEqual(blockOf('Aling Rosa').sort(), ['BROILER:Broilers:2.2 kg', 'CULL:Cull Chicken:3.6 kg']);
    assert.equal(model.eggRows.find((r) => r.size === 'Sm.').sold, '2 carton + 5 piece');
    assert.deepEqual(model.otherRows.map((r) => [r.product, r.sold]), [['Garlic', '1.5 kg (2 pcs)']]);
    // a cashier only ever gets their own sales, even if they ask for someone else (the route decides who the report is for)
    const cashierSheet = readZip((await ca.call('GET', `/api/daily-report.xlsx?date=${bday}&cashier=999`)).data)['xl/worksheets/sheet1.xml'];
    assert.match(cashierSheet, /CASHIER: Cashier</);
    // a manager can pick one cashier
    const managerId = (await mg.call('GET', '/api/me')).data.user.id;
    const onlyManager = gatherDaily(db, { date: bday, cashierId: managerId });
    assert.equal([...onlyManager.chicken, ...onlyManager.other].filter((l) => ours.has(l.order)).length, 2);   // the manager's one order here has two lines: chicken and garlic
    assert.ok([...onlyManager.chicken, ...onlyManager.other].every((l) => l.cashier === 'Manager'));
    assert.match(readZip((await mg.call('GET', `/api/daily-report.xlsx?date=${bday}&cashier=${managerId}`)).data)['xl/worksheets/sheet1.xml'], /CASHIER: Manager</);

    // the Excel file: laid out like the form (Revision 14: the paper form again, landscape), with the right numbers
    const res = await ad.call('GET', `/api/daily-report.xlsx?date=${bday}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), new RegExp(`daily-sales-report_${bday}\\.xlsx`));
    const files = readZip(res.data);
    const sheet = files['xl/worksheets/sheet1.xml'];
    assert.match(files['xl/workbook.xml'], /name="Daily Sales Report"/);
    for (const text of ['DAILY SALES REPORT', 'B-CULL', 'Chicken Balance', 'Additional', 'EXPENSES', 'DISCOUNTS', 'TOTAL DISCOUNTS', 'CASH BREAKDOWN', 'GROSS SALES', 'NET SALES', 'EXCESS/LOSS', 'EGGS', 'OTHERS']) assert.ok(sheet.includes(text), `missing ${text}`);
    assert.ok(!sheet.includes('OTHER COLLECTIONS'), 'Other collections was replaced by the discount list');
    assert.match(sheet, /<mergeCell ref=/);
    assert.match(sheet, /orientation="landscape"/);
    assert.match(sheet, /fitToWidth="1"/);
    assert.ok(!/GCash|Juan|09171234567/.test(sheet));
    assert.match(sheet, /<f>SUM\(/);                       // totals are formulas, so they follow anything typed into the empty boxes
    assert.match(sheet, /<v>415\.8<\/v>/);
    assert.match(files['xl/worksheets/sheet2.xml'], /Left empty on purpose/);
    // an unknown or missing date means today; the report needs a signed-in user
    assert.equal((await ca.call('GET', '/api/daily-report.xlsx?date=not-a-date')).status, 200);
    assert.equal((await client().call('GET', `/api/daily-report.xlsx?date=${day}`)).status, 401);
    // the cashier list for the filter is for managers
    assert.equal((await ca.call('GET', '/api/staff')).status, 403);
    assert.ok((await mg.call('GET', '/api/staff')).data.staff.some((u) => u.display_name === 'Cashier'));
  } finally {
    clock.now = new Date('2026-10-09T02:00:00Z');
    await admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_item' });
    await admin.call('PUT', '/api/service-fees/NOT_POUR', { amount: '25', basis: 'per_item' });
  }
});

// ---- Export ---------------------------------------------------------------------------------------

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

test('CSV export (Revision 11): exactly the shop\'s 18 report columns, in order, sold orders only, the order total only once', async () => {
  const res = await manager.call('GET', '/api/export.csv?from=2026-10-09&to=2026-10-09');
  assert.equal(res.status, 200);
  const text = res.data.toString('utf8').replace(/^\ufeff/, '');
  const [head, ...rows] = text.trim().split('\r\n');
  assert.deepEqual(head.split(','), ['Transaction Date', 'Order Number', 'Cashier or User', 'Customer Number', 'Product Name', 'Number of Heads',
    'Quantity (kg for chicken)', 'Unit', 'Unit Price (\u20b1)', 'Service', 'Service Fees (\u20b1)', 'Item Total (\u20b1)',
    'Order Subtotal (\u20b1)', 'Discount (\u20b1)', 'Discount Reason', 'Order Total (\u20b1)', 'Payment Method', 'Amount Paid (\u20b1)']);
  const cols = head.split(',');
  const idx = (name) => cols.indexOf(name);
  const first = rows.find((r) => r.includes('ORD-20261009-001'));
  assert.match(first, /^2026-10-09,ORD-20261009-001,Cashier,WALK-IN,Cull Chicken,1,3\.6,kg,58\.00,Po-ur & Slice,45\.00,253\.80,/);
  const multi = rows.filter((r) => r.includes('ORD-20261009-00') && r.includes('C-1001'));
  assert.equal(multi.length, 5);
  assert.deepEqual(multi.map((r) => r.split(',')[idx('Order Total (\u20b1)')]), ['858.80', '', '', '', '']);   // once per order
  assert.ok(multi.some((r) => r.includes('Eggs (Small),,2,carton,120.00,')));
  assert.ok(multi.some((r) => r.includes('Garlic,1,1.5,kg,80.00,')));   // a per-kg line shows its pieces under Number of Heads
  const discounted = rows.find((r) => r.includes('Wholesale (20%)'));
  assert.ok(discounted, 'a discounted order is in the export');
  const dcols = discounted.split(',');
  assert.deepEqual([dcols[idx('Order Subtotal (\u20b1)')], dcols[idx('Discount (\u20b1)')], dcols[idx('Order Total (\u20b1)')]], ['253.80', '50.76', '203.04']);
  // only sold orders: canceled and replaced orders stay in the Excel file (marked), not in this report
  const all = gatherExport(db, { from: '2026-10-09', to: '2026-10-09' });
  for (const o of all.orderRows.filter((x) => x.status === 'CANCELED' || x.status === 'REPLACED')) assert.ok(!text.includes(`${o.number},`), `${o.number} is not in the CSV`);
  const heads = rows.find((r) => r.includes('Broiler Breeder Cull') && r.includes(',5.4,kg,'));
  assert.ok(heads, 'the heads order is in the export');
  assert.equal(heads.split(',')[idx('Number of Heads')], '3');
  assert.equal(heads.split(',')[idx('Quantity (kg for chicken)')], '5.4');                  // the combined weight
  // sorted by date, then order number
  const keys = rows.map((r) => r.split(',').slice(0, 2).join(' '));
  assert.deepEqual(keys, [...keys].sort());
});

test('XLSX export: red rows for canceled orders, status text, formulas, discounts and filters', async () => {
  const res = await manager.call('GET', '/api/export.xlsx');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /spreadsheetml/);
  const files = readZip(res.data);
  const book = files['xl/workbook.xml'];
  for (const name of ['Transactions', 'Orders', 'Audit Log', 'By Product', 'By Day', 'By Week', 'By Month', 'Definitions']) assert.ok(book.includes(`name="${name}"`), name);
  const tx = files['xl/worksheets/sheet1.xml'];
  assert.match(tx, /<formula>\$S2=&quot;CANCELED&quot;<\/formula>/);
  assert.match(tx, /dxfId="0"/);
  assert.match(tx, /<autoFilter ref="A1:AI/);
  assert.match(tx, />CANCELED</);
  assert.match(tx, />Po-ur &amp; Slice</);
  assert.match(files['xl/styles.xml'], /FFFFC7CE/);
  assert.match(files['xl/worksheets/sheet5.xml'], /SUMIFS/);
  assert.match(files['xl/worksheets/sheet2.xml'], /Discount Reason/);
});

test('export keeps canceled orders out of sales totals', async () => {
  // The Excel file keeps every order and says which ones count as a sale; the CSV holds only orders that count as a sale.
  const data = gatherExport(db, {});
  assert.ok(['CANCELED', 'REFUNDED', 'REPLACED'].every((s) => data.orderRows.some((o) => o.status === s)));
  const files = readZip((await manager.call('GET', '/api/export.xlsx')).data);
  assert.match(files['xl/worksheets/sheet1.xml'], /Counts as Sale/);
  const csv = (await manager.call('GET', '/api/export.csv')).data.toString('utf8');
  for (const o of data.orderRows) {
    const sold = o.status === 'COMPLETED' || o.status === 'REFUNDED' || o.status === 'PARTIALLY_REFUNDED';
    assert.equal(csv.includes(`,${o.number},`), sold, `${o.number} (${o.status})`);
  }
});

// ---- Revision 5/6: payments (as in Version 4), new discount reasons, Order List (Kanban board) ------------------------------------

test('payments behave exactly as in Version 4: Not recorded saves no payment, every method saves, the amount defaults to the total, bad values are refused', async () => {
  const placed = async (payment, label) => {
    const body = { submission_key: key(), items: [live(cull, '1')], ...(payment === undefined ? {} : { payment }) };
    const r = await cashier.call('POST', '/api/orders', body);
    assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.data)}`);
    return r.data.order;
  };
  // "Not recorded" (no payment, null, or method NONE) saves the order with no payment row, as in Version 4
  for (const [payment, label] of [[undefined, 'no payment sent'], [null, 'null'], [{ method: 'NONE' }, 'method NONE'], [{}, 'empty object']]) {
    const o = await placed(payment, label);
    assert.equal(o.payments.length, 0, label);
  }
  // every method saves; the amount defaults to the order total; the account details are optional
  for (const method of ['CASH', 'GCASH', 'MAYA', 'BANK', 'OTHER']) {
    const o = await placed({ method }, method);
    assert.deepEqual([o.payments.length, o.payments[0].method, o.payments[0].amount_centavos], [1, method, 5800]);
  }
  // Revision 9: the amount paid must be the order total. Less is "Insufficient payment", more is refused, so a saved payment always matches the order.
  assert.equal((await placed({ method: 'CASH', amount: '58' }, 'typed amount equal to the total')).payments[0].amount_centavos, 5800);
  for (const amount of ['100', '57.99']) {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')], payment: { method: 'CASH', amount } });
    assert.equal(r.status, 400, `amount ${amount} on a ₱58.00 order`);
  }
  // validation from Version 4 is unchanged
  const bad = async (payment, pattern) => {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')], payment });
    assert.equal(r.status, 400, JSON.stringify(payment));
    assert.match(JSON.stringify(r.data), pattern);
  };
  await bad({ method: 'BITCOIN' }, /payment method/);
  await bad({ method: 'CASH', amount: '0' }, /Payment amount must be above/);
  await bad({ method: 'CASH', amount: '-5' }, /Payment amount must be above/);
  await bad({ method: 'GCASH', paid_at: 'not a date' }, /date and time/);
});

test('discount reasons (Revision 11): Bulk Order, Reject, Employee, Wholesale, Dead, Katay and Other; Senior citizen and VIP are gone', async () => {
  const config = (await cashier.call('GET', '/api/config')).data;
  assert.deepEqual(Object.keys(config.discount_reasons), ['BULK', 'REJECT', 'EMPLOYEE', 'WHOLESALE', 'DEAD', 'KATAY', 'OTHER']);
  for (const old of ['SENIOR', 'VIP']) {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '10')], discount: { type: 'PERCENT', value: '10', reason_code: old } });
    assert.equal(r.status, 400, `${old} is no longer accepted`);
  }
  for (const [code, label] of [['BULK', 'Bulk Order Discount'], ['REJECT', 'Reject'], ['EMPLOYEE', 'Employee Discount'], ['WHOLESALE', 'Wholesale'], ['DEAD', 'Dead'], ['KATAY', 'Katay']]) {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '10')], discount: { type: 'PERCENT', value: '10', reason_code: code } });
    assert.equal(r.status, 201, `${code}: ${JSON.stringify(r.data)}`);
    assert.deepEqual([r.data.order.discount.reason_code, r.data.order.discount.amount_centavos, r.data.order.total_centavos], [code, 5800, 52200]);
    const fixed = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '10')], discount: { type: 'FIXED', value: '50', reason_code: code } });
    assert.equal(fixed.status, 201, `${code} fixed`);
    assert.equal(fixed.data.order.total_centavos, 53000);
    const csv = (await manager.call('GET', '/api/export.csv')).data.toString('utf8');
    assert.ok(csv.includes(`${label}`), `${label} appears in the export`);
  }
  // an unknown reason is still refused, "Other" still needs an explanation
  const unknown = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '10')], discount: { type: 'PERCENT', value: '10', reason_code: 'FRIEND' } });
  assert.equal(unknown.status, 400);
  const noNote = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '10')], discount: { type: 'PERCENT', value: '10', reason_code: 'OTHER' } });
  assert.equal(noNote.status, 400);
});

const boardOf = async (who = cashier, query = '') => (await who.call('GET', `/api/board${query}`)).data;
const column = (board, status) => board.orders.filter((o) => o.fulfillment_status === status).map((o) => o.order_number);
const submitPlain = async (extra = {}) => (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')], ...extra })).data.order;

test('Order List: a new order starts in Ongoing and appears exactly once on the board', async () => {
  const o = await submitPlain({ customer_number: 'C-77', other_items: [other(eggCarton, '2')] });
  assert.equal(o.fulfillment_status, 'ONGOING');
  const board = await boardOf();
  assert.deepEqual(board.columns, ['ONGOING', 'STANDBY', 'COMPLETE']);
  assert.equal(board.orders.filter((x) => x.id === o.id).length, 1);
  const card = board.orders.find((x) => x.id === o.id);
  assert.deepEqual([card.fulfillment_status, card.order_number, card.customer_number, card.total_centavos, card.business_date], ['ONGOING', o.order_number, 'C-77', 5800 + 24000, '2026-10-09']);
  assert.deepEqual(card.items.map((i) => [i.name, i.heads, i.weight_g]), [['Cull Chicken', 1, 1000]]);
  assert.deepEqual(card.other_items.map((i) => [i.name, i.unit, i.quantity_milli]), [['Eggs (Small)', 'carton', 2000]]);
  assert.ok(card.submitted_at && card.cashier_name);
  // no payment account details are on the board
  assert.equal(JSON.stringify(card).includes('account'), false);
  // the order list and the order detail carry the pickup status too
  assert.equal((await cashier.call('GET', '/api/orders')).data.orders.find((x) => x.id === o.id).fulfillment_status, 'ONGOING');
  assert.equal((await cashier.call('GET', `/api/orders/${o.id}`)).data.order.fulfillment_status, 'ONGOING');
});

test('Order List: moving an order is saved at once, shown in the right column, never duplicated, and logged', async () => {
  const o = await submitPlain();
  const move = (status, who = cashier) => who.call('POST', `/api/orders/${o.id}/fulfillment`, { status });

  const toStandby = await move('STANDBY');
  assert.equal(toStandby.status, 200, JSON.stringify(toStandby.data));
  assert.deepEqual([toStandby.data.changed, toStandby.data.order.fulfillment_status], [true, 'STANDBY']);
  let board = await boardOf();
  assert.deepEqual([column(board, 'ONGOING').includes(o.order_number), column(board, 'STANDBY').includes(o.order_number), column(board, 'COMPLETE').includes(o.order_number)], [false, true, false]);

  assert.equal((await move('COMPLETE', manager)).data.order.fulfillment_status, 'COMPLETE');          // a manager can move it too
  board = await boardOf(admin);                                                                            // and an admin sees the same board
  assert.deepEqual([column(board, 'ONGOING').includes(o.order_number), column(board, 'STANDBY').includes(o.order_number), column(board, 'COMPLETE').includes(o.order_number)], [false, false, true]);
  assert.equal(board.orders.filter((x) => x.id === o.id).length, 1);                                       // one card, whatever the status

  // a completed order stays visible and can be moved back (a mistake can be corrected)
  assert.equal((await move('ONGOING', admin)).data.order.fulfillment_status, 'ONGOING');
  assert.ok(column(await boardOf(), 'ONGOING').includes(o.order_number));

  // moving to the column it is already in does nothing: no second audit row
  const same = await move('ONGOING');
  assert.deepEqual([same.status, same.data.changed], [200, false]);
  const events = (await cashier.call('GET', `/api/orders/${o.id}`)).data.order.events;
  assert.deepEqual(events.map((e) => e.action_type), ['SUBMIT', 'MOVE', 'MOVE', 'MOVE']);
  assert.deepEqual(events.filter((e) => e.action_type === 'MOVE').map((e) => e.reason_note), ['Ongoing → Standby', 'Standby → Complete', 'Complete → Ongoing']);
  assert.deepEqual(events.filter((e) => e.action_type === 'MOVE').map((e) => e.user_name), ['Cashier', 'Manager', 'Owner']);

  // the sale itself is untouched: same status, total, lines and payment
  const after = (await cashier.call('GET', `/api/orders/${o.id}`)).data.order;
  assert.deepEqual([after.status, after.total_centavos, after.items.length, after.payments.length], ['COMPLETED', 5800, 1, o.payments.length]);   // payments are exactly what they were
  assert.equal(after.order_number, o.order_number);
});

test('Order List: bad moves are refused with plain messages', async () => {
  const o = await submitPlain();
  for (const status of ['DONE', '', null, undefined, 'standby', 'COMPLETED', 5]) {
    const r = await cashier.call('POST', `/api/orders/${o.id}/fulfillment`, status === undefined ? {} : { status });
    assert.equal(r.status, 400, String(status));
    assert.match(r.data.error ?? JSON.stringify(r.data), /Ongoing, Standby or Complete/);
  }
  assert.equal((await cashier.call('POST', '/api/orders/999999/fulfillment', { status: 'STANDBY' })).status, 404);
  assert.equal((await cashier.call('POST', '/api/orders/abc/fulfillment', { status: 'STANDBY' })).status, 404);
  assert.equal((await client().call('POST', `/api/orders/${o.id}/fulfillment`, { status: 'STANDBY' })).status, 401);   // sign-in is required
  const noHeader = await fetch(`${base}/api/orders/${o.id}/fulfillment`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"STANDBY"}' });
  assert.equal(noHeader.status, 403);
  assert.equal((await boardOf()).orders.find((x) => x.id === o.id).fulfillment_status, 'ONGOING');                       // nothing changed
});

test('Order List: canceled and replaced orders leave the board; refunded orders stay, marked; a replacement starts in Ongoing', async () => {
  const toCancel = await submitPlain();
  const toRefund = await submitPlain();
  const toChange = await submitPlain();
  await cashier.call('POST', `/api/orders/${toRefund.id}/fulfillment`, { status: 'STANDBY' });
  await cashier.call('POST', `/api/orders/${toChange.id}/fulfillment`, { status: 'STANDBY' });

  assert.equal((await cashier.call('POST', `/api/orders/${toCancel.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' })).status, 200);
  assert.equal((await manager.call('POST', `/api/orders/${toRefund.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 200);
  const changed = await cashier.call('POST', `/api/orders/${toChange.id}/change`, { submission_key: key(), reason_code: 'WRONG_WEIGHT', items: [live(cull, '2')] });
  assert.equal(changed.status, 201);

  const board = await boardOf();
  const numbers = board.orders.map((o) => o.order_number);
  assert.equal(numbers.includes(toCancel.order_number), false, 'canceled order is not on the board');
  assert.equal(numbers.includes(toChange.order_number), false, 'replaced order is not on the board');
  const refunded = board.orders.find((o) => o.id === toRefund.id);
  assert.deepEqual([refunded.status, refunded.fulfillment_status, refunded.refund_centavos], ['REFUNDED', 'STANDBY', 5800]);
  const replacement = board.orders.find((o) => o.id === changed.data.order.id);
  assert.equal(replacement.fulfillment_status, 'ONGOING');
  assert.equal(new Set(numbers).size, numbers.length, 'no duplicate cards');

  // a canceled or replaced order cannot be moved
  for (const o of [toCancel, toChange]) {
    const r = await cashier.call('POST', `/api/orders/${o.id}/fulfillment`, { status: 'COMPLETE' });
    assert.equal(r.status, 409);
    assert.match(JSON.stringify(r.data), /not on the Order List/);
  }
  // a refunded order can still be moved
  assert.equal((await cashier.call('POST', `/api/orders/${toRefund.id}/fulfillment`, { status: 'COMPLETE' })).status, 200);
});

test('Order List: Ongoing and Standby show every open order; Complete shows the orders claimed on the open business day', async () => {
  const ongoing = await submitPlain();
  const standby = await submitPlain();
  const done = await submitPlain();
  await cashier.call('POST', `/api/orders/${standby.id}/fulfillment`, { status: 'STANDBY' });
  await cashier.call('POST', `/api/orders/${done.id}/fulfillment`, { status: 'COMPLETE' });
  // ten days later the open orders are still there, and so is the claimed one: its business day is still open (nobody has closed it)
  const board = listBoard(db);
  const column = (o) => board.orders.find((x) => x.order_number === o.order_number)?.fulfillment_status;
  assert.deepEqual([column(ongoing), column(standby), column(done)], ['ONGOING', 'STANDBY', 'COMPLETE']);
  assert.match(board.open_day, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(board.orders.every((o) => o.from_earlier_day === false), 'everything here was sold on the open business day');
  // the old "show completed orders from" setting is gone: the API ignores it and says nothing about it
  const same = await boardOf(cashier, '?complete_days=1');
  assert.equal(same.complete_days, undefined);
  assert.equal(same.orders.length, (await boardOf(cashier, '?complete_days=all')).orders.length);
});

test('Order List: pickup moves are not sale actions, so the export still shows the real last action', async () => {
  const o = await submitPlain({ customer_number: 'EXPORT-CHECK' });
  assert.equal((await cashier.call('POST', `/api/orders/${o.id}/cancel`, { reason_code: 'PRICING_ERROR' })).status, 200);
  // moves recorded before the cancel on a still-open order must not appear as "Last Action"
  const open = await submitPlain({ customer_number: 'EXPORT-OPEN' });
  await cashier.call('POST', `/api/orders/${open.id}/fulfillment`, { status: 'STANDBY' });
  await cashier.call('POST', `/api/orders/${open.id}/fulfillment`, { status: 'COMPLETE' });
  // (The Action Type column is in the Excel file; the Revision 11 CSV has only the report columns.)
  const tx = gatherExport(db, {}).tx;
  const row = (number) => tx.find((l) => l.number === number);
  assert.equal(row(open.order_number).action, '', 'moves do not count as a last action');
  assert.equal(row(o.order_number).action, 'Canceled');
  // ...but the audit log sheet records every move
  const files = readZip((await manager.call('GET', '/api/export.xlsx')).data);
  const audit = Object.entries(files).filter(([name]) => name.startsWith('xl/worksheets/sheet')).map(([, xml]) => xml).join('\n');
  assert.match(audit, /Moved on the Order List/);
  assert.match(audit, /Standby → Complete/);
});

test('Order List: concurrent moves of the same order leave one card in one column', async () => {
  const o = await submitPlain();
  const results = await Promise.all(['STANDBY', 'COMPLETE', 'ONGOING', 'STANDBY', 'COMPLETE'].map((status) =>
    cashier.call('POST', `/api/orders/${o.id}/fulfillment`, { status })));
  assert.ok(results.every((r) => r.status === 200));
  const board = await boardOf();
  assert.equal(board.orders.filter((x) => x.id === o.id).length, 1);
  const final = board.orders.find((x) => x.id === o.id).fulfillment_status;
  assert.equal((await cashier.call('GET', `/api/orders/${o.id}`)).data.order.fulfillment_status, final);
  // the audit trail matches what happened: one row per real change
  const moves = db.prepare("SELECT COUNT(*) AS n FROM order_events WHERE order_id = ? AND action_type = 'MOVE'").get(o.id).n;
  assert.ok(moves >= 1 && moves <= 5);
});

test('Order List: the database refuses a made-up pickup status and still protects submitted orders', async () => {
  const o = await submitPlain();
  assert.throws(() => db.prepare("UPDATE orders SET fulfillment_status = 'DELIVERED' WHERE id = ?").run(o.id), /CHECK|constraint/i);
  assert.throws(() => db.prepare('UPDATE orders SET total_centavos = 1, subtotal_centavos = 1 WHERE id = ?').run(o.id), /cannot be changed after submission/);
  assert.throws(() => db.prepare('DELETE FROM orders WHERE id = ?').run(o.id), /cannot be deleted/);
  db.prepare("UPDATE orders SET fulfillment_status = 'STANDBY' WHERE id = ?").run(o.id);                  // the one field that may change
  assert.equal(db.prepare('SELECT fulfillment_status FROM orders WHERE id = ?').get(o.id).fulfillment_status, 'STANDBY');
});

// ---- Revision 6: the Orders screen and the Order List read the same saved status ----------------------------------------

test('the Orders list, the order details and the Order List all report the same status for the same order id, after every move', async () => {
  const a = await submitPlain({ customer_number: 'SAME-NAME' });
  const b = await submitPlain({ customer_number: 'SAME-NAME' });          // same customer on purpose: orders are told apart by id
  const seen = async (id) => {
    const inList = (await cashier.call('GET', '/api/orders?q=SAME-NAME')).data.orders.find((o) => o.id === id);
    const detail = (await cashier.call('GET', `/api/orders/${id}`)).data.order;
    const card = (await boardOf()).orders.find((o) => o.id === id);
    const saved = db.prepare('SELECT fulfillment_status AS f FROM orders WHERE id = ?').get(id).f;
    return { list: inList.fulfillment_status, detail: detail.fulfillment_status, board: card?.fulfillment_status, saved };
  };
  assert.deepEqual(await seen(a.id), { list: 'ONGOING', detail: 'ONGOING', board: 'ONGOING', saved: 'ONGOING' });
  for (const status of ['STANDBY', 'COMPLETE', 'ONGOING', 'COMPLETE', 'STANDBY']) {
    assert.equal((await cashier.call('POST', `/api/orders/${a.id}/fulfillment`, { status })).status, 200);
    assert.deepEqual(await seen(a.id), { list: status, detail: status, board: status, saved: status }, `after moving to ${status}`);
    assert.deepEqual(await seen(b.id), { list: 'ONGOING', detail: 'ONGOING', board: 'ONGOING', saved: 'ONGOING' }, 'the other order, same customer, is not touched');
  }
});

test('the Orders list can be filtered by Order List status and agrees with the board; sale-status filters still work; canceled orders are in no Order List status', async () => {
  const open = await submitPlain();
  const standby = await submitPlain();
  const done = await submitPlain();
  const canceled = await submitPlain();
  await cashier.call('POST', `/api/orders/${standby.id}/fulfillment`, { status: 'STANDBY' });
  await cashier.call('POST', `/api/orders/${done.id}/fulfillment`, { status: 'COMPLETE' });
  await cashier.call('POST', `/api/orders/${canceled.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' });

  const listed = async (query) => (await cashier.call('GET', `/api/orders?${query}`)).data.orders;
  const board = await boardOf(cashier, '?complete_days=all');
  for (const status of ['ONGOING', 'STANDBY', 'COMPLETE']) {
    const rows = await listed(`pickup=${status}`);
    assert.deepEqual(rows.map((o) => o.order_number).sort(), column(board, status).sort(), `pickup=${status} is exactly that Order List column`);
    assert.ok(rows.every((o) => o.fulfillment_status === status));
  }
  assert.ok((await listed('pickup=ONGOING')).some((o) => o.id === open.id));
  assert.ok((await listed('pickup=STANDBY')).some((o) => o.id === standby.id));
  assert.ok((await listed('pickup=COMPLETE')).some((o) => o.id === done.id));
  // the canceled order keeps its recorded pickup value but is in no Order List status
  for (const status of ['ONGOING', 'STANDBY', 'COMPLETE']) assert.ok(!(await listed(`pickup=${status}`)).some((o) => o.id === canceled.id), `canceled order is not ${status}`);
  assert.deepEqual((await listed('status=CANCELED')).some((o) => o.id === canceled.id), true);
  // the sale-status filter is unchanged
  assert.ok((await listed('status=COMPLETED')).every((o) => o.status === 'COMPLETED'));
  assert.ok((await listed('status=COMPLETED')).some((o) => o.id === open.id));
  // both filters together
  assert.deepEqual((await listed('pickup=COMPLETE&status=CANCELED')), []);
  // a made-up value is refused with a plain message
  const bad = await cashier.call('GET', '/api/orders?pickup=DELIVERED');
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.data), /Choose Ongoing, Standby or Complete/);
});

test('a refunded order keeps its Order List status in both views; a replacement order starts Ongoing and the replaced one has no Order List status', async () => {
  const refund = await submitPlain();
  const change = await submitPlain();
  await cashier.call('POST', `/api/orders/${refund.id}/fulfillment`, { status: 'STANDBY' });
  assert.equal((await manager.call('POST', `/api/orders/${refund.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 200);
  const r = (await cashier.call('GET', '/api/orders?pickup=STANDBY')).data.orders.find((o) => o.id === refund.id);
  assert.deepEqual([r.status, r.fulfillment_status], ['REFUNDED', 'STANDBY']);
  assert.equal((await boardOf()).orders.find((o) => o.id === refund.id).fulfillment_status, 'STANDBY');

  const changed = await cashier.call('POST', `/api/orders/${change.id}/change`, { submission_key: key(), reason_code: 'WRONG_WEIGHT', items: [live(cull, '2')] });
  assert.equal(changed.status, 201);
  const rows = (await cashier.call('GET', '/api/orders?q=ORD-')).data.orders;
  assert.equal(rows.find((o) => o.id === changed.data.order.id).fulfillment_status, 'ONGOING');
  assert.equal(rows.find((o) => o.id === change.id).status, 'REPLACED');
  assert.ok(!(await cashier.call('GET', '/api/orders?pickup=ONGOING')).data.orders.some((o) => o.id === change.id), 'a replaced order is in no Order List status');
});

// ---- Revision 7: bookmarks ---------------------------------------------------------------------------------------------

const bookmark = (who, id, value) => who.call('PUT', `/api/orders/${id}/bookmark`, { bookmarked: value });
const cardOf = async (id, who = cashier) => (await boardOf(who, '?complete_days=all')).orders.find((o) => o.id === id);
const sameSaleData = (id) => JSON.stringify((({ bookmarked: _b, ...rest }) => rest)(db.prepare('SELECT * FROM orders WHERE id = ?').get(id)));

test('bookmarks: a new order is not bookmarked; any staff member can switch it on and off; the card says so', async () => {
  const o = await submitPlain();
  assert.equal((await cardOf(o.id)).bookmarked, false);
  const on = await bookmark(cashier, o.id, true);
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.deepEqual([on.data.id, on.data.bookmarked, on.data.changed], [o.id, true, true]);
  assert.equal((await cardOf(o.id)).bookmarked, true);
  assert.equal(db.prepare('SELECT bookmarked FROM orders WHERE id = ?').get(o.id).bookmarked, 1);
  const off = await bookmark(manager, o.id, false);
  assert.deepEqual([off.status, off.data.bookmarked, off.data.changed], [200, false, true]);
  assert.equal((await cardOf(o.id)).bookmarked, false);
});

test('bookmarks: asking twice for the same state is harmless (a double click or repeated request cannot flip it back)', async () => {
  const o = await submitPlain();
  const [a, b] = await Promise.all([bookmark(cashier, o.id, true), bookmark(cashier, o.id, true)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal([a.data.changed, b.data.changed].filter(Boolean).length, 1, 'only one of the two requests changed anything');
  assert.equal((await cardOf(o.id)).bookmarked, true);
  assert.equal((await bookmark(cashier, o.id, false)).data.changed, true);
  assert.equal((await bookmark(cashier, o.id, false)).data.changed, false);
});

test('bookmarks: only the flag changes. Status, pickup status, lines, totals, payment and the audit trail stay exactly as they were', async () => {
  const o = await submitPlain({ payment: { method: 'GCASH', account_name: 'Juan Dela Cruz', account_number: '09171234567', reference: 'REF 9' }, other_items: [other(eggCarton, '1')] });
  const before = { order: (await admin.call('GET', `/api/orders/${o.id}`)).data, row: sameSaleData(o.id), payments: db.prepare('SELECT * FROM payments WHERE order_id = ?').all(o.id), items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id), events: db.prepare('SELECT * FROM order_events WHERE order_id = ?').all(o.id) };
  await bookmark(cashier, o.id, true);
  const after = { order: (await admin.call('GET', `/api/orders/${o.id}`)).data, row: sameSaleData(o.id), payments: db.prepare('SELECT * FROM payments WHERE order_id = ?').all(o.id), items: db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id), events: db.prepare('SELECT * FROM order_events WHERE order_id = ?').all(o.id) };
  assert.deepEqual(after, before);
  assert.equal(after.order.order.status, 'COMPLETED');
  assert.equal(after.order.order.fulfillment_status, 'ONGOING');
});

test('bookmarks: the flag belongs to the order id, so it stays on the right card through every move, a refund, and a reload', async () => {
  const a = await submitPlain({ customer_number: 'TWIN' });
  const b = await submitPlain({ customer_number: 'TWIN' });
  await bookmark(cashier, a.id, true);
  for (const status of ['STANDBY', 'COMPLETE', 'ONGOING', 'STANDBY']) {
    assert.equal((await cashier.call('POST', `/api/orders/${a.id}/fulfillment`, { status })).status, 200);
    const cardA = await cardOf(a.id), cardB = await cardOf(b.id);
    assert.deepEqual([cardA.fulfillment_status, cardA.bookmarked], [status, true], `bookmark follows the order to ${status}`);
    assert.deepEqual([cardB.fulfillment_status, cardB.bookmarked], ['ONGOING', false], 'the twin order is not bookmarked');
  }
  // moving the other order does not touch the bookmark either
  await cashier.call('POST', `/api/orders/${b.id}/fulfillment`, { status: 'STANDBY' });
  assert.equal((await cardOf(a.id)).bookmarked, true);
  assert.equal((await cardOf(b.id)).bookmarked, false);
  // a refund keeps the flag
  assert.equal((await manager.call('POST', `/api/orders/${a.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 200);
  const refunded = await cardOf(a.id);
  assert.deepEqual([refunded.status, refunded.bookmarked], ['REFUNDED', true]);
  // "reload": a brand new sign-in sees the same thing
  const fresh = client(); await fresh.login('cash', 'cashier-pass-1');
  assert.equal((await cardOf(a.id, fresh)).bookmarked, true);
});

test('bookmarks: bad requests are refused with plain messages and change nothing', async () => {
  const o = await submitPlain();
  for (const body of [{}, { bookmarked: 'yes' }, { bookmarked: 1 }, { bookmarked: null }]) {
    const r = await cashier.call('PUT', `/api/orders/${o.id}/bookmark`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, /true or false/);
  }
  assert.equal((await cardOf(o.id)).bookmarked, false);
  assert.equal((await bookmark(cashier, 999999, true)).status, 404);
  assert.equal((await bookmark(cashier, 'abc', true)).status, 404);
  const canceled = await submitPlain();
  await cashier.call('POST', `/api/orders/${canceled.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' });
  const r = await bookmark(cashier, canceled.id, true);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /not on the Order List/);
  // not signed in, or no app header
  assert.equal((await bookmark(client(), o.id, true)).status, 401);
  const noHeader = await fetch(`${base}/api/orders/${o.id}/bookmark`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"bookmarked":true}' });
  assert.equal(noHeader.status, 403);
  assert.equal((await cardOf(o.id)).bookmarked, false);
});

test('bookmarks: the database accepts only 0 or 1, and submitted orders are still protected', async () => {
  const o = await submitPlain();
  assert.throws(() => db.prepare('UPDATE orders SET bookmarked = 2 WHERE id = ?').run(o.id), /CHECK|constraint/i);
  db.prepare('UPDATE orders SET bookmarked = 1 WHERE id = ?').run(o.id);                                    // allowed: not part of the sale
  assert.throws(() => db.prepare('UPDATE orders SET total_centavos = 1, subtotal_centavos = 1 WHERE id = ?').run(o.id), /cannot be changed after submission/);
  assert.throws(() => db.prepare('DELETE FROM orders WHERE id = ?').run(o.id), /cannot be deleted/);
});

test('Order List cards carry what the expanded card shows (items, discount, payment) but never the payment account details', async () => {
  const o = await submitPlain({
    items: [live(cull, '1.5'), po(bcull, '2')], other_items: [other(garlicKg, '0.5')],
    discount: { type: 'FIXED', value: '20', reason_code: 'BULK' },
    payment: { method: 'GCASH', account_name: 'Juan Dela Cruz', account_number: '09171234567', reference: 'REF 77' },
  });
  const card = await cardOf(o.id);
  assert.equal(card.items.length, 2);
  assert.equal(card.other_items.length, 1);
  assert.deepEqual([card.subtotal_centavos - card.discount_centavos, card.discount_reason], [card.total_centavos, 'BULK']);
  assert.deepEqual(card.payments.map((p) => [p.method, p.amount_centavos, p.reference]), [['GCASH', card.total_centavos, 'REF 77']]);
  assert.ok(!JSON.stringify(card).includes('09171234567') && !JSON.stringify(card).includes('Juan'), 'no account name or number on the board');
  const none = await cardOf((await submitPlain()).id);
  assert.deepEqual(none.payments, []);
});

// ---- Revision 7: Delete Account ----------------------------------------------------------------------------------------

let nameN = 0;
const newStaff = async (role = 'cashier') => {
  const username = `temp${++nameN}-${Math.random().toString(36).slice(2, 7)}`;
  const r = await admin.call('POST', '/api/users', { username, display_name: `Temp ${nameN}`, role, password: 'temp-pass-123' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...r.data.user, username, password: 'temp-pass-123' };
};
const asUser = async (u) => { const c = client(); await c.login(u.username, u.password); return c; };
const del = (who, id) => who.call('DELETE', `/api/users/${id}`);
const userRow = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
const usersListed = async () => (await admin.call('GET', '/api/users')).data.users;
const history = (id) => JSON.stringify({
  orders: db.prepare('SELECT * FROM orders WHERE cashier_id = ? ORDER BY id').all(id),
  payments: db.prepare('SELECT * FROM payments WHERE recorded_by = ? ORDER BY id').all(id),
  events: db.prepare('SELECT * FROM order_events WHERE user_id = ? ORDER BY id').all(id),
});

test('delete account: cashiers and managers are refused on the server, whatever the screen shows, and the account is untouched', async () => {
  const victim = await newStaff();
  const before = JSON.stringify(userRow(victim.id));
  for (const [who, name] of [[cashier, 'cashier'], [manager, 'manager'], [await asUser(victim), 'the account itself']]) {
    const r = await del(who, victim.id);
    assert.equal(r.status, 403, `${name} must not delete accounts`);
    assert.match(r.data.error, /cannot do this/);
  }
  assert.equal((await del(client(), victim.id)).status, 401, 'not signed in');
  const noHeader = await fetch(`${base}/api/users/${victim.id}`, { method: 'DELETE' });
  assert.equal(noHeader.status, 403, 'a request without the app header is blocked');
  assert.equal(JSON.stringify(userRow(victim.id)), before);
  assert.ok((await usersListed()).some((u) => u.id === victim.id));
  // the cashier cannot even list users, so the button could never have been offered
  assert.equal((await cashier.call('GET', '/api/users')).status, 403);
});

test('delete account: an account nobody has used is removed completely, its sign-in stops at once and the username can be used again', async () => {
  const u = await newStaff('manager');
  const session = await asUser(u);
  assert.equal((await session.call('GET', '/api/config')).status, 200);
  const r = await del(admin, u.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.ok, r.data.outcome, r.data.user.username], [true, 'deleted', u.username]);
  assert.equal(userRow(u.id), undefined, 'the row is gone');
  assert.ok(!(await usersListed()).some((x) => x.id === u.id));
  assert.equal((await session.call('GET', '/api/config')).status, 401, 'the open session no longer works');
  assert.equal((await client().call('POST', '/api/login', { username: u.username, password: u.password })).status, 401);
  assert.equal((await del(admin, u.id)).status, 404, 'asking again finds nothing and changes nothing');
  assert.equal((await admin.call('POST', '/api/users', { username: u.username, role: 'cashier', password: 'another-pass-1' })).status, 201, 'a never-used username is free again');
});

test('delete account: an account with orders, payments and audit records is closed, not erased, and every record keeps its name', async () => {
  const u = await newStaff('cashier');
  const mine = await asUser(u);
  const placed = (await mine.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '2')], customer_number: 'HIST', payment: { method: 'CASH', amount: '116' } })).data.order;
  await mine.call('POST', `/api/orders/${placed.id}/fulfillment`, { status: 'STANDBY' });
  const orderBefore = JSON.stringify((await admin.call('GET', `/api/orders/${placed.id}`)).data.order);
  const recordsBefore = history(u.id);
  const allOrders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const allPayments = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
  const allEvents = db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n;

  const r = await del(admin, u.id);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.outcome, 'removed');
  const row = userRow(u.id);
  assert.ok(row && row.deleted_at, 'the row stays so old records keep their name');
  assert.deepEqual([row.active, row.password_hash], [0, 'deleted'], 'sign-in is off and the password is wiped');
  assert.ok(!(await usersListed()).some((x) => x.id === u.id), 'hidden from the Users list');
  assert.ok(!(await manager.call('GET', '/api/staff')).data.staff.some((x) => x.id === u.id), 'and from the report filter');
  // history is exactly as before
  assert.equal(history(u.id), recordsBefore);
  assert.equal(JSON.stringify((await admin.call('GET', `/api/orders/${placed.id}`)).data.order), orderBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, allOrders);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, allPayments);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n, allEvents);
  assert.equal((await admin.call('GET', `/api/orders/${placed.id}`)).data.order.cashier_name, u.display_name);
  assert.equal((await admin.call('GET', `/api/orders/${placed.id}`)).data.order.payments[0].recorded_by_name, u.display_name);
  assert.ok((await boardOf(admin, '?complete_days=all')).orders.some((o) => o.id === placed.id), 'the order is still on the Order List');
  assert.equal((await admin.call('GET', '/api/export.csv')).status, 200, 'exports still work');
  assert.equal((await manager.call('GET', '/api/daily-report.xlsx?date=2026-10-09')).status, 200);
  // cannot sign in, old session is dead, cannot be edited or brought back, username stays reserved
  assert.equal((await mine.call('GET', '/api/config')).status, 401);
  assert.equal((await client().call('POST', '/api/login', { username: u.username, password: u.password })).status, 401);
  assert.equal((await admin.call('PATCH', `/api/users/${u.id}`, { active: true, password: 'brand-new-pass-1' })).status, 404);
  assert.equal(userRow(u.id).active, 0);
  const again = await admin.call('POST', '/api/users', { username: u.username, role: 'cashier', password: 'another-pass-1' });
  assert.equal(again.status, 409);
  assert.match(again.data.error, /deleted account/);
  assert.equal((await del(admin, u.id)).status, 404, 'a repeated request does nothing');
});

test('delete account: nobody can delete themselves, the main owner account, or the last active admin', async () => {
  // yourself
  const self = await del(admin, userRow(db.prepare('SELECT id FROM users WHERE username = ?').get('owner').id).id);
  assert.equal(self.status, 403);
  assert.equal(self.data.code, 'SELF_DELETE');
  const second = await newStaff('admin');
  const secondClient = await asUser(second);
  const own = await del(secondClient, second.id);
  assert.deepEqual([own.status, own.data.code], [403, 'SELF_DELETE']);
  // the main owner account (the first account ever made) is protected even from another admin
  const ownerId = db.prepare('SELECT MIN(id) AS id FROM users').get().id;
  const owner = await del(secondClient, ownerId);
  assert.deepEqual([owner.status, owner.data.code], [409, 'PROTECTED']);
  assert.match(owner.data.error, /main owner account/);
  assert.ok(userRow(ownerId) && !userRow(ownerId).deleted_at);
  // the Users screen is told in advance
  const listed = (await admin.call('GET', '/api/users')).data.users;
  assert.equal(listed.find((u) => u.id === ownerId).delete_blocked.code, 'SELF_DELETE', 'for the admin looking at it, the owner row is "you"');
  assert.equal(listed.find((u) => u.id === second.id).delete_blocked, null, 'a second admin may be deleted');
  assert.equal(listed.find((u) => u.username === 'cash').delete_blocked, null);
  const seenBySecond = (await secondClient.call('GET', '/api/users')).data.users;
  assert.equal(seenBySecond.find((u) => u.id === ownerId).delete_blocked.code, 'PROTECTED');
  assert.equal(seenBySecond.find((u) => u.id === second.id).delete_blocked.code, 'SELF_DELETE');
  // another admin can be deleted by the owner
  assert.equal((await del(admin, second.id)).data.outcome, 'deleted');
});

test('delete account: the last active admin is kept even when the caller is not that admin (service level)', async () => {
  const { deleteUser, deleteBlocker } = await import('../src/services/users.js');
  const solo = createUser(db, { username: `solo${++nameN}`, role: 'admin', password: 'solo-pass-123' });
  const ownerId = db.prepare('SELECT MIN(id) AS id FROM users').get().id;
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(ownerId);                                      // the owner is switched off, so solo is the only active admin
  try {
    assert.equal(deleteBlocker(db, { id: 999999 }, userRow(solo.id)).code, 'LAST_ADMIN');
    assert.throws(() => deleteUser(db, { id: 999999 }, solo.id), (e) => e.status === 409 && e.code === 'LAST_ADMIN');
    assert.ok(userRow(solo.id) && !userRow(solo.id).deleted_at);
  } finally {
    db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(ownerId);
    deleteUser(db, { id: ownerId }, solo.id);
  }
});

test('delete account: two requests at once delete once; the second is answered "not found" and nothing breaks', async () => {
  const u = await newStaff();
  const [a, b] = await Promise.all([del(admin, u.id), del(admin, u.id)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 404]);
  assert.equal(userRow(u.id), undefined);
  assert.equal((await del(admin, 999999)).status, 404);
  assert.equal((await del(admin, 'abc')).status, 404);
});

test('delete account: other staff and their sessions are not affected by deleting one account', async () => {
  const keep = await newStaff();
  const keepClient = await asUser(keep);
  const gone = await newStaff();
  await del(admin, gone.id);
  assert.equal((await keepClient.call('GET', '/api/config')).status, 200);
  assert.ok((await usersListed()).some((x) => x.id === keep.id));
  assert.equal(userRow(keep.id).active, 1);
});

// Revision 13: last in this file. Going past midnight closes the open day by itself, so every test after this one would sell on 10 Oct.
test('order numbers follow the Philippine date, not UTC', async () => {
  clock.now = new Date('2026-10-09T17:30:00Z'); // already 10 Oct 01:30 in Manila
  const late = client();
  await late.login('cash', 'cashier-pass-1');
  const r = await late.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')] });
  assert.equal(r.data.order.order_number, 'ORD-20261010-001');
  clock.now = new Date('2026-10-09T02:00:00Z');
});
