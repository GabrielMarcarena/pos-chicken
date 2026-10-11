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

let admin, manager, cashier, cull, bcull, broilers, eggs, eggDozen, eggPiece, garlic, garlicKg;
let keyN = 0;
const key = () => `test-key-${++keyN}-${Math.random().toString(36).slice(2)}`;
// A live chicken (no preparation) and a Po-ur / Dressed line with a cutting choice.
const live = (product, weight, extra = {}) => ({ product_id: product, weight, feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null, ...extra });
const po = (product, weight, size = 'MEDIUM', extra = {}) => ({ product_id: product, weight, feather: 'POUR', dara: false, cut: 'SLICE', slice_size: size, ...extra });
const dressed = (product, weight, size = 'MEDIUM', extra = {}) => ({ product_id: product, weight, feather: 'NOT_POUR', dara: false, cut: 'SLICE', slice_size: size, ...extra });
const other = (option, quantity) => ({ other_product_id: option.product, option_id: option.id, quantity });

before(async () => {
  db = openDb(':memory:');
  const a = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  cull = createProduct(db, a, { name: 'Cull Chicken', price: '58' }).id;
  broilers = createProduct(db, a, { name: 'Broilers', price: '120' }).id;
  bcull = createProduct(db, a, { name: 'Broiler Breeder Cull', price: '52' }).id;
  const e = createOtherProduct(db, a, { name: 'Eggs (Small)', options: [{ unit: 'dozen', sold_by: 'FIXED', price: '120' }, { unit: 'piece', sold_by: 'FIXED', price: '10' }] });
  eggs = e.id; eggDozen = { id: e.options.find((o) => o.unit === 'dozen').id, product: eggs }; eggPiece = { id: e.options.find((o) => o.unit === 'piece').id, product: eggs };
  const g = createOtherProduct(db, a, { name: 'Garlic', options: [{ unit: 'kg', sold_by: 'PER_KG', price: '80' }] });
  garlic = g.id; garlicKg = { id: g.options[0].id, product: garlic };
  server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  admin = client(); manager = client(); cashier = client();
  await admin.login('owner', 'owner-pass-1');
  await manager.login('mgr', 'manager-pass-1');
  await cashier.login('cash', 'cashier-pass-1');
  // The shop's service prices: Live no fee, Po-ur & Slice (burn chicken) 45, Dressed & Slice (dress chicken) 25.
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
  // other products: a manager can add a product and options, but the options stay inactive until the admin prices them
  const etag = await manager.call('POST', '/api/other-products', { name: 'Etag (Smoked)', options: [{ unit: 'kg', sold_by: 'PER_KG' }] });
  assert.equal(etag.status, 201, JSON.stringify(etag.data));
  const opt = etag.data.other_product.options[0];
  assert.equal(opt.active, false);
  assert.equal((await manager.call('POST', '/api/other-products', { name: 'Priced by manager', options: [{ unit: 'kg', sold_by: 'PER_KG', price: '5' }] })).status, 403);
  assert.equal((await manager.call('PATCH', `/api/other-product-options/${eggDozen.id}`, { price: '999' })).status, 403);
  assert.equal((await manager.call('PATCH', `/api/other-product-options/${opt.id}`, { active: true })).status, 400);
  const live = await admin.call('PATCH', `/api/other-product-options/${opt.id}`, { price: '450', active: true });
  assert.equal(live.status, 200);
  assert.equal(live.data.other_product.options[0].price_centavos, 45000);
  // a manager may rename and switch products on and off
  assert.equal((await manager.call('PATCH', `/api/other-products/${etag.data.other_product.id}`, { name: 'Etag (Smoked) Special' })).status, 200);
  // a second way of selling the same product
  const more = await manager.call('POST', `/api/other-products/${etag.data.other_product.id}/options`, { unit: 'pack', sold_by: 'FIXED' });
  assert.equal(more.status, 201);
  assert.equal((await manager.call('POST', `/api/other-products/${etag.data.other_product.id}/options`, { unit: 'pack', sold_by: 'FIXED' })).status, 409);
});

test('the cashier screen only offers products with an active, priced option', async () => {
  const cfg = (await cashier.call('GET', '/api/config')).data;
  const names = cfg.other_products.map((p) => p.name);
  assert.ok(names.includes('Eggs (Small)') && names.includes('Garlic'));
  assert.ok(!names.some((n) => n.startsWith('Priced by manager')));
  assert.equal(cfg.fees.POUR.amount, 4500);
  assert.ok(cfg.discount_reasons.SENIOR);
});

test('first-run starter data: service prices and the shop\'s other products, all waiting for prices', () => {
  const fresh = openDb(':memory:');
  fresh.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('a','A','x','admin','2026-01-01')").run();
  assert.equal(seedStarterCatalog(fresh), true);
  assert.equal(seedStarterCatalog(fresh), false); // never twice
  const fees = Object.fromEntries(fresh.prepare('SELECT code, amount_centavos FROM service_fees').all().map((f) => [f.code, f.amount_centavos]));
  assert.deepEqual([fees.POUR, fees.NOT_POUR], [4500, 2500]);
  const bases = Object.fromEntries(fresh.prepare('SELECT code, basis FROM service_fees').all().map((f) => [f.code, f.basis]));
  assert.deepEqual([bases.POUR, bases.NOT_POUR, bases.DARA, bases.DUKOT], ['per_head', 'per_head', 'per_head', 'per_head']);   // services are per head
  const all = listOtherProducts(fresh, { includeInactive: true });
  assert.deepEqual(all.map((p) => p.name).sort(), ['Eggs (Large)', 'Eggs (Medium)', 'Eggs (Small)', 'Etag (Smoked)', 'Etag (Sun-Dried)', 'Garlic', 'Laya', 'Onions']);
  const eggUnits = all.find((p) => p.name === 'Eggs (Small)').options.map((o) => o.unit).sort();
  assert.deepEqual(eggUnits, ['batch', 'dozen', 'piece']);
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

test('Cull Chicken 3.6 kg: Live ₱208.80, Po-ur & Slice ₱253.80, Dressed & Slice ₱233.80, and the first order number', async () => {
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
    other_items: [other(eggDozen, '2'), other(eggPiece, '5'), other(garlicKg, '1.5')],
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const o = r.data.order;
  // 208.80 + 240.00 + (2 x 120.00) + (5 x 10.00) + (1.5 x 80.00)
  assert.equal(o.total_centavos, 20880 + 24000 + 24000 + 5000 + 12000);
  assert.equal(o.customer_number, 'C-1001');
  assert.deepEqual(o.items.map((i) => i.line_no).concat(o.other_items.map((i) => i.line_no)), [1, 2, 3, 4, 5]);
  assert.deepEqual(o.other_items.map((i) => [i.unit, i.sold_by, i.quantity_milli]), [['dozen', 'FIXED', 2000], ['piece', 'FIXED', 5000], ['kg', 'PER_KG', 1500]]);
});

test('fixed-price items need whole numbers; per-kg items take decimals; unavailable options are refused', async () => {
  const bad = async (other_items, expected) => {
    const r = await cashier.call('POST', '/api/orders', { submission_key: key(), other_items });
    assert.equal(r.status, 400, JSON.stringify(other_items));
    assert.match(JSON.stringify(r.data), expected);
  };
  await bad([other(eggDozen, '1.5')], /whole number of dozen/);
  await bad([other(eggDozen, '0')], /whole number/);
  await bad([other(garlicKg, '0')], /weight above 0/);
  await bad([other(garlicKg, '1.2345')], /weight above 0/);
  await bad([{ other_product_id: garlic, option_id: eggDozen.id, quantity: '1' }], /not found/);   // option belongs to another product
  await bad([{ other_product_id: garlic, quantity: '1' }], /not found/);
  const ok = await cashier.call('POST', '/api/orders', { submission_key: key(), other_items: [other(eggDozen, '3')] });
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

test('order numbers follow the Philippine date, not UTC', async () => {
  clock.now = new Date('2026-10-09T17:30:00Z'); // already 10 Oct 01:30 in Manila
  const late = client();
  await late.login('cash', 'cashier-pass-1');
  const r = await late.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')] });
  assert.equal(r.data.order.order_number, 'ORD-20261010-001');
  clock.now = new Date('2026-10-09T02:00:00Z');
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
  await bad({ items: [live(cull, '1', { feather: null })] }, /Choose Live/);
  await bad({ items: [po(cull, '1', null)] }, /slice size/);                                      // slice without a size
  await bad({ items: [{ ...po(cull, '1'), cut: 'NONE', slice_size: null }] }, /slice size or Dukot/); // Po-ur is always sliced or Dukot
  await bad({ items: [{ ...dressed(cull, '1'), cut: 'NONE', slice_size: null }] }, /slice size or Dukot/);
  await bad({ items: [{ ...po(cull, '1'), cut: 'DUKOT', slice_size: 'SMALL' }] }, /Dukot cannot have a slice size/);
  await bad({ items: [po(cull, '1', 'GIANT')] }, /slice size/);
  await bad({ items: [live(cull, '1', { dara: true })] }, /live chicken cannot have Dara/);
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
  const pct = await send({ type: 'PERCENT', value: '20', reason_code: 'SENIOR' }, { expected_total_centavos: 20304 });
  assert.equal(pct.status, 201, JSON.stringify(pct.data));
  assert.equal(pct.data.order.subtotal_centavos, 25380);
  assert.deepEqual([pct.data.order.discount.type, pct.data.order.discount.amount_centavos, pct.data.order.discount.reason_code], ['PERCENT', 5076, 'SENIOR']);
  assert.equal(pct.data.order.total_centavos, 20304);
  const fixed = await send({ type: 'FIXED', value: '50', reason_code: 'OTHER', note: 'Regular customer' });
  assert.equal(fixed.data.order.total_centavos, 20380);
  assert.equal(fixed.data.order.discount.note, 'Regular customer');
  const none = await send({ type: 'NONE' });
  assert.equal(none.data.order.total_centavos, 25380);
  assert.equal(none.data.order.discount.amount_centavos, 0);
  // refusals
  const refused = async (discount, expected) => { const r = await send(discount); assert.equal(r.status, 400, JSON.stringify(discount)); assert.match(JSON.stringify(r.data), expected); };
  await refused({ type: 'PERCENT', value: '100', reason_code: 'SENIOR' }, /less than the order subtotal/);
  await refused({ type: 'PERCENT', value: '101', reason_code: 'SENIOR' }, /0% and at most 100%/);
  await refused({ type: 'PERCENT', value: '0', reason_code: 'SENIOR' }, /above 0%/);
  await refused({ type: 'FIXED', value: '253.80', reason_code: 'SENIOR' }, /less than the order subtotal/);
  await refused({ type: 'FIXED', value: '999', reason_code: 'SENIOR' }, /less than the order subtotal/);
  await refused({ type: 'FIXED', value: '-5', reason_code: 'SENIOR' }, /above ₱0\.00/);
  await refused({ type: 'FIXED', value: '10' }, /reason for the discount/);
  await refused({ type: 'FIXED', value: '10', reason_code: 'OTHER' }, /Explain the discount/);
  await refused({ type: 'BIGSALE', value: '10', reason_code: 'SENIOR' }, /fixed or a percentage/);
  // the discount applies to the whole order, other products included
  const mixed = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')], other_items: [other(eggDozen, '1')], discount: { type: 'PERCENT', value: '10', reason_code: 'SENIOR' } });
  assert.equal(mixed.data.order.subtotal_centavos, 5800 + 12000);
  assert.equal(mixed.data.order.total_centavos, 17800 - 1780);
});

test('a refund returns the discounted total, and a discount cannot be edited afterwards', async () => {
  const o = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [dressed(cull, '2')], discount: { type: 'FIXED', value: '16', reason_code: 'SENIOR' } })).data.order;
  assert.equal(o.total_centavos, 11600 + 2500 - 1600);
  const r = await manager.call('POST', `/api/orders/${o.id}/refund`, { reason_code: 'WRONG_PRODUCT' });
  assert.equal(r.data.order.refund_centavos, 12500);
  assert.throws(() => db.prepare('UPDATE orders SET discount_centavos = 0 WHERE id = ?').run(o.id), /cannot be changed/);
});

test('service fees and other-product prices can change without touching past orders', async () => {
  const before = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '3.6')], other_items: [other(eggDozen, '1')] })).data.order;
  assert.equal(before.total_centavos, 25380 + 12000);
  assert.equal((await admin.call('PUT', '/api/service-fees/POUR', { amount: '60', basis: 'per_item' })).status, 200);
  assert.equal((await admin.call('PATCH', `/api/other-product-options/${eggDozen.id}`, { price: '130' })).status, 200);
  assert.equal((await admin.call('PATCH', `/api/products/${cull}`, { price: '60' })).status, 200);
  const old = (await cashier.call('GET', `/api/orders/${before.id}`)).data.order;
  assert.equal(old.total_centavos, 37380);
  assert.equal(old.items[0].price_per_kg_centavos, 5800);
  assert.equal(old.items[0].service_fee_centavos, 4500);
  assert.equal(old.other_items[0].unit_price_centavos, 12000);
  const fresh = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '1')], other_items: [other(eggDozen, '1')] })).data.order;
  assert.equal(fresh.total_centavos, 6000 + 6000 + 13000);
  await admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_item' });
  await admin.call('PATCH', `/api/other-product-options/${eggDozen.id}`, { price: '120' });
  await admin.call('PATCH', `/api/products/${cull}`, { price: '58' });
  const history = (await admin.call('GET', '/api/price-history')).data.history;
  assert.ok(history.some((h) => h.kind === 'SERVICE_FEE' && h.subject === 'POUR' && h.old_value === 4500 && h.new_value === 6000));
  assert.ok(history.some((h) => h.kind === 'OTHER_PRICE' && h.subject_name === 'Eggs (Small) (dozen)' && h.new_value === 13000));
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
  const cash = await cashier.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')], payment: { method: 'CASH', amount: '60', account_number: '123' } });
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
  const o = (await cashier.call('POST', '/api/orders', { submission_key: key(), items: [po(cull, '3.0')], discount: { type: 'PERCENT', value: '20', reason_code: 'SENIOR' } })).data.order;
  const r = await cashier.call('POST', `/api/orders/${o.id}/change`, {
    submission_key: key(), reason_code: 'WRONG_WEIGHT', items: [po(cull, '3.6')], discount: { type: 'PERCENT', value: '20', reason_code: 'SENIOR' },
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
  const day = '2026-11-01';
  clock.now = new Date('2026-11-01T02:00:00Z'); // 10:00 on 1 Nov in the Philippines
  const ca = client(), mg = client(), ad = client();
  await ca.login('cash', 'cashier-pass-1'); await mg.login('mgr', 'manager-pass-1'); await ad.login('owner', 'owner-pass-1');
  assert.equal((await ad.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_head' })).status, 200);
  assert.equal((await ad.call('PUT', '/api/service-fees/NOT_POUR', { amount: '25', basis: 'per_head' })).status, 200);
  try {
    // cashier: 3 heads of B-cull burned and sliced (3 x 45), then eggs and garlic with a GCash payment (must not appear in the report)
    const o1 = await ca.call('POST', '/api/orders', { submission_key: key(), customer_number: 'C-7001', items: [po(bcull, '5.4', 'MEDIUM', { heads: 3 })] });
    const o2 = await ca.call('POST', '/api/orders', {
      submission_key: key(), customer_number: 'Aling Rosa', items: [dressed(cull, '3.6', 'LARGE'), live(broilers, '2.2', { heads: 2 })],
      other_items: [other(eggDozen, '2'), other(eggPiece, '5'), other(garlicKg, '0.5')],
      payment: { method: 'GCASH', amount: '800', account_name: 'Juan Dela Cruz', account_number: '09171234567' },
    });
    const o3 = await ca.call('POST', '/api/orders', { submission_key: key(), items: [live(cull, '1')] });                     // will be canceled
    // manager: one more order, then a refund
    const o4 = await mg.call('POST', '/api/orders', { submission_key: key(), items: [dressed(cull, '2')], other_items: [other(garlicKg, '1')] });
    for (const r of [o1, o2, o3, o4]) assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await ca.call('POST', `/api/orders/${o3.data.order.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' })).status, 200);
    assert.equal((await mg.call('POST', `/api/orders/${o4.data.order.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 200);

    const read = async (who, query = '') => (await who.call('GET', `/api/daily-report.csv?date=${day}${query}`)).data.toString('utf8').replace(/^\ufeff/, '').trim().split('\r\n');
    const rows = await read(mg);
    const [head, ...lines] = rows;
    const col = (name) => head.split(',').indexOf(name);
    assert.deepEqual(head.split(',').slice(0, 6), ['Date', 'Time', 'Order Number', 'Cashier', "Customer's #/Name", 'Section']);
    // canceled order is not listed; the refunded one is, and is marked
    assert.ok(!lines.some((l) => l.includes(o3.data.order.order_number)));
    assert.ok(lines.some((l) => l.includes(o4.data.order.order_number) && l.endsWith(',Refunded')));
    // 3 heads of B-cull: 5.4 kg x 52 = 280.80, service 3 x 45 = 135, amount 415.80
    const bc = lines.find((l) => l.includes('C-7001'));
    const c = bc.split(',');
    assert.deepEqual([c[col('Section')], c[col('# of Heads')], c[col('Kilos or Quantity')], c[col('Price (per kg or per unit)')], c[col('Service')], c[col('Price (kilos x price)')], c[col('Amount')]],
      ['B-CULL', '3', '5.4', '52.00', '135.00', '280.80', '415.80']);
    // other products: eggs go to the EGGS section in their own units, garlic to OTHERS
    const sections = lines.filter((l) => l.includes('Aling Rosa')).map((l) => `${l.split(',')[col('Section')]}:${l.split(',')[col('Product')]}:${l.split(',')[col('Kilos or Quantity')]} ${l.split(',')[col('Unit')]}`);
    assert.deepEqual(sections.sort(), ['BROILER:Broilers:2.2 kg', 'CULL:Cull Chicken:3.6 kg', 'EGGS:Eggs (Small):2 dozen', 'EGGS:Eggs (Small):5 piece', 'OTHERS:Garlic:0.5 kg']);
    // no payment details anywhere in the report
    const everything = rows.join('\n');
    assert.ok(!/GCash|GCASH|Juan|09171234567/.test(everything));

    // a cashier only ever gets their own sales, even if they ask for someone else
    const mine = await read(ca, '&cashier=999');
    assert.ok(mine.slice(1).length > 0 && mine.slice(1).every((l) => l.split(',')[col('Cashier')] === 'Cashier'));
    assert.ok(!mine.some((l) => l.includes(o4.data.order.order_number)));
    // a manager can pick one cashier
    const managerId = (await mg.call('GET', '/api/me')).data.user.id;
    const onlyManager = await read(mg, `&cashier=${managerId}`);
    assert.ok(onlyManager.slice(1).every((l) => l.split(',')[col('Cashier')] === 'Manager'));
    assert.equal(onlyManager.length - 1, 2);            // the manager's one order has two lines: chicken and garlic

    // the Excel file: laid out like the form, landscape, with the right numbers
    const res = await ad.call('GET', `/api/daily-report.xlsx?date=${day}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /daily-sales-report_2026-11-01\.xlsx/);
    const files = readZip(res.data);
    const sheet = files['xl/worksheets/sheet1.xml'];
    assert.match(files['xl/workbook.xml'], /name="Daily Sales Report"/);
    for (const text of ['DAILY SALES REPORT', 'B-CULL', 'Chicken Balance', 'Additional', 'EXPENSES', 'OTHER COLLECTIONS', 'CASH BREAKDOWN', 'GROSS SALES', 'NET SALES', 'EXCESS/LOSS', 'EGGS', 'OTHERS']) assert.ok(sheet.includes(text), `missing ${text}`);
    assert.match(sheet, /<mergeCell ref=/);
    assert.match(sheet, /orientation="landscape"/);
    assert.match(sheet, /fitToWidth="1"/);
    assert.ok(!/GCash|Juan|09171234567/.test(sheet));
    assert.match(sheet, /<f>SUM\(/);                       // totals are formulas, so they follow anything typed into the empty boxes
    assert.match(sheet, /<v>415\.8<\/v>/);
    assert.match(files['xl/worksheets/sheet2.xml'], /Left empty on purpose/);
    // an unknown or missing date means today; the report needs a signed-in user
    assert.equal((await ca.call('GET', '/api/daily-report.csv?date=not-a-date')).status, 200);
    assert.equal((await client().call('GET', `/api/daily-report.csv?date=${day}`)).status, 401);
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

test('CSV export: required fields, service names, other-product units, discounts, and the order total only once', async () => {
  const res = await manager.call('GET', '/api/export.csv?from=2026-10-09&to=2026-10-09');
  assert.equal(res.status, 200);
  const text = res.data.toString('utf8').replace(/^\ufeff/, '');
  const [head, ...rows] = text.trim().split('\r\n');
  for (const col of ['Transaction Date', 'Transaction Time', 'Customer Number', 'Order Number', 'Product Name', 'Product ID', 'Unit Price (₱)',
    'Quantity (kg for chicken)', 'Unit', 'Service', 'Dara', 'Cutting Method', 'Igorot Slice Size', 'Item Total (₱)', 'Order Total (₱)',
    'Status', 'Reason', 'Cashier or User', 'Payment Method', 'Payment Account Name', 'Payment Account Number', 'Order Subtotal (₱)', 'Discount (₱)', 'Discount Reason', 'Number of Heads']) {
    assert.ok(head.includes(col), `missing column ${col}`);
  }
  const cols = head.split(',');
  const idx = (name) => cols.indexOf(name);
  const first = rows.find((r) => r.includes('ORD-20261009-001'));
  assert.match(first, /Cull Chicken,CH-001,58,3\.6,kg,Po-ur & Slice \(burn chicken\),Yes,Slice,Medium pieces,45,253\.8/);
  const multi = rows.filter((r) => r.includes('ORD-20261009-00') && r.includes('C-1001'));
  assert.equal(multi.length, 5);
  const totals = multi.map((r) => r.split(',')[idx('Order Total (₱)')]);
  assert.deepEqual(totals, ['858.8', '', '', '', '']);
  assert.ok(multi.some((r) => r.includes('Eggs (Small),OP-001,120,2,dozen')));
  assert.ok(multi.some((r) => r.includes('Garlic,OP-002,80,1.5,kg')));
  const discounted = rows.find((r) => r.includes('Senior citizen (20%)'));
  assert.ok(discounted, 'a discounted order is in the export');
  const dcols = discounted.split(',');
  assert.equal(dcols[idx('Order Subtotal (₱)')], '253.8');
  assert.equal(dcols[idx('Discount (₱)')], '50.76');
  assert.equal(dcols[idx('Order Total (₱)')], '203.04');
  const canceled = rows.find((r) => r.includes('CANCELED'));
  assert.match(canceled, /Customer left without paying/);
  const heads = rows.find((r) => r.includes('Broiler Breeder Cull') && r.includes(',5.4,kg,Live'));
  assert.ok(heads, 'the heads order is in the export');
  assert.equal(heads.split(',')[idx('Number of Heads')], '3');
  assert.equal(heads.split(',')[idx('Quantity (kg for chicken)')], '5.4');                  // the combined weight
  assert.equal(multi.map((r) => r.split(',')[idx('Number of Heads')]).filter(Boolean).length, 2);   // chicken lines show heads, other products do not
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
  assert.match(tx, /Po-ur &amp; Slice \(burn chicken\)/);
  assert.match(files['xl/styles.xml'], /FFFFC7CE/);
  assert.match(files['xl/worksheets/sheet5.xml'], /SUMIFS/);
  assert.match(files['xl/worksheets/sheet2.xml'], /Discount Reason/);
});

test('export keeps canceled orders out of sales totals', async () => {
  const csv = (await manager.call('GET', '/api/export.csv')).data.toString('utf8');
  assert.ok(csv.includes('CANCELED') && csv.includes('REFUNDED') && csv.includes('REPLACED'));
  const lines = csv.split('\r\n').filter((l) => l.includes(',CANCELED,') || l.includes(',REPLACED,'));
  assert.ok(lines.length >= 2);
  const col = csv.split('\r\n')[0].split(',').indexOf('Counts as Sale');
  assert.ok(lines.every((l) => l.split(',')[col] === 'No'));
});
