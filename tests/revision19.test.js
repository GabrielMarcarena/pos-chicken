// Revision 19 tests: every service has its own price, the admin can add / rename / hide services, a saved line keeps the name it was sold under,
// and an older database (version 13) upgrades without changing a single price or order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct, updateFee, listServices, getFeeConfig } from '../src/services/catalog.js';
import { applyPrepChange, emptyPrep, serviceOf, needsSliceSize } from '../shared/rules.js';
import { chickenLine } from '../shared/pricing.js';

const START = new Date('2026-10-19T02:00:00Z');
let keyN = 0;
const key = () => `r19-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

function client(base) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', 'x-requested-with': 'pos', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  return { call, async login(u, p) { const r = await call('POST', '/api/login', { username: u, password: p }); assert.equal(r.status, 200, JSON.stringify(r.data)); } };
}

async function makeShop(file = ':memory:') {
  const db = openDb(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r19-'));
  const config = loadConfig({ dbPath: file, inventoryDir: dir, largeWeightKg: 50, sessionIdleMinutes: 60 });
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  createUser(db, { username: 'butcher-tv', display_name: 'Butcher TV', role: 'display', password: 'butcher-pass-1' });
  const broiler = createProduct(db, adminUser, { name: 'Broiler', price: '100', category: 'BROILER' }).id;
  const server = createApp({ db, config, clock: () => START }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier, tv] = [client(base), client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1'); await cashier.login('cash', 'cashier-pass-1'); await tv.login('butcher-tv', 'butcher-pass-1');
  const inv = (await manager.call('GET', '/api/inventory')).data;
  for (const row of [...inv.chicken, ...inv.other]) await manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: 500, reason: 'RECOUNT' });
  return {
    db, admin, manager, cashier, tv, broiler, adminUser, dir,
    close: () => { server.closeAllConnections(); server.close(); try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); },
    order: (items, extra = {}) => cashier.call('POST', '/api/orders', { submission_key: key(), items, other_items: [], payment: { method: 'CASH', received: '10000' }, ...extra }),
  };
}
const line = (product, extra = {}) => ({ product_id: product, weight: '3.0', heads: 3, dara: false, ...extra });

test('every paid service starts with the fee it had (Pour family = Pour fee, Dress family = Dress fee), Live has none, and each can then be priced on its own', async () => {
  const shop = await makeShop();
  try {
    updateFee(shop.db, shop.adminUser, 'POUR', { amount: '45', basis: 'per_head' });
    updateFee(shop.db, shop.adminUser, 'NOT_POUR', { amount: '25', basis: 'per_head' });
    const fees = getFeeConfig(shop.db);
    for (const c of ['POUR', 'POUR_SLICE', 'POUR_DUKOT']) assert.equal(fees[c].amount, 4500, c);
    for (const c of ['NOT_POUR', 'NOT_POUR_SLICE', 'NOT_POUR_DUKOT']) assert.equal(fees[c].amount, 2500, c);
    assert.equal(fees.LIVE, undefined, 'Live has no fee entry');

    // price Po-ur & Slice on its own: 3 heads x 60 = 180; plain Pour is still 3 x 45 = 135
    assert.equal((await shop.admin.call('PUT', '/api/services/POUR_SLICE', { fee: '60', basis: 'per_head' })).status, 200);
    const sliced = await shop.order([line(shop.broiler, { service: 'POUR_SLICE', slice_size: 'SMALL' })]);
    assert.equal(sliced.status, 201, JSON.stringify(sliced.data));
    assert.equal(sliced.data.order.items[0].service_fee_centavos, 18000);
    assert.equal(sliced.data.order.items[0].service, 'POUR_SLICE');
    assert.equal(sliced.data.order.items[0].service_label, 'Po-ur & Slice');
    assert.equal(sliced.data.order.items[0].fees[0].label, 'Pour', 'the receipt keeps the fee name Pour');
    const plain = await shop.order([line(shop.broiler, { service: 'POUR' })]);
    assert.equal(plain.data.order.items[0].service_fee_centavos, 13500);
    const dukot = await shop.order([line(shop.broiler, { service: 'NOT_POUR_DUKOT' })]);
    assert.equal(dukot.data.order.items[0].service_fee_centavos, 7500);
    const live = await shop.order([line(shop.broiler, { service: 'LIVE' })]);
    assert.equal(live.data.order.items[0].service_fee_centavos, 0);

    // the history records the change under the service
    const hist = (await shop.admin.call('GET', '/api/price-history')).data.history;
    assert.ok(hist.some((h) => h.kind === 'SERVICE_FEE' && h.subject === 'POUR_SLICE' && h.new_value === 6000));
  } finally { shop.close(); }
});

test('Live never takes a fee; only the admin changes services; a manager can look', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.admin.call('PUT', '/api/services/LIVE', { fee: '5', basis: 'per_item' })).status, 400);
    assert.equal((await shop.manager.call('PUT', '/api/services/POUR', { fee: '5' })).status, 403);
    assert.equal((await shop.manager.call('POST', '/api/services', { label: 'X', kind: 'POUR' })).status, 403);
    assert.equal((await shop.cashier.call('GET', '/api/services')).status, 403);
    const seen = await shop.manager.call('GET', '/api/services');
    assert.equal(seen.status, 200);
    assert.equal(seen.data.services.length, 7);
    assert.equal((await shop.admin.call('PUT', '/api/services/POUR', { kind: 'NOT_POUR' })).status, 400, 'what a service is cannot change');
    assert.equal((await shop.admin.call('PUT', '/api/services/NOPE', { fee: '1' })).status, 404);
  } finally { shop.close(); }
});

test('a service the admin adds: it is a button, has its own price, saves on the line, reaches the butcher, the board and the export', async () => {
  const shop = await makeShop();
  try {
    const add = await shop.admin.call('POST', '/api/services', { label: 'Deboned', note: 'Bones taken out', kind: 'NOT_POUR', cut: 'NONE', fee: '30', basis: 'per_head' });
    assert.equal(add.status, 201, JSON.stringify(add.data));
    const code = add.data.service.code;
    assert.match(code, /^SVC_\d+$/);
    assert.equal((await shop.admin.call('POST', '/api/services', { label: 'deboned', kind: 'POUR' })).status, 409, 'names are unique');

    const config = (await shop.cashier.call('GET', '/api/config')).data;
    const button = config.services.find((s) => s.code === code);
    assert.deepEqual([button.label, button.note, button.fee_centavos], ['Deboned', 'Bones taken out', 3000]);
    assert.equal(config.services.at(-1).code, code, 'after the built-in ones');
    assert.equal(config.fees[code].amount, 3000);

    const made = await shop.order([line(shop.broiler, { service: code })], { tracking_number: 7 });
    assert.equal(made.status, 201, JSON.stringify(made.data));
    const it = made.data.order.items[0];
    assert.deepEqual([it.service, it.service_label, it.feather, it.cut, it.service_fee_centavos], [code, 'Deboned', 'NOT_POUR', 'NONE', 9000]);
    assert.equal(it.fees[0].label, 'Deboned');

    const butcher = (await shop.tv.call('GET', '/api/butcher')).data;
    assert.equal(butcher.orders[0].items[0].service_label, 'Deboned');
    const board = (await shop.cashier.call('GET', '/api/board')).data;
    assert.equal(board.orders.find((o) => o.id === made.data.order.id).items[0].service_label, 'Deboned');
    const csv = (await shop.manager.call('GET', '/api/export/orders.csv'));
    if (csv.status === 200) assert.match(String(csv.data), /Deboned/);
  } finally { shop.close(); }
});

test('a sliced service the admin adds asks for the size; a Dukot one refuses one; the sold line keeps its name after a rename and after the service is hidden', async () => {
  const shop = await makeShop();
  try {
    const sliced = (await shop.admin.call('POST', '/api/services', { label: 'Pour Quarter', kind: 'POUR', cut: 'SLICE', fee: '10', basis: 'per_item' })).data.service.code;
    const dukot = (await shop.admin.call('POST', '/api/services', { label: 'Dress Special', kind: 'NOT_POUR', cut: 'DUKOT', fee: '0', basis: 'per_item' })).data.service.code;
    assert.equal((await shop.order([line(shop.broiler, { service: sliced })])).status, 400, 'a slice service needs a size');
    const ok = await shop.order([line(shop.broiler, { service: sliced, slice_size: 'LARGE' })]);
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.equal(ok.data.order.items[0].service_fee_centavos, 1000, 'per line');
    assert.equal((await shop.order([line(shop.broiler, { service: dukot, slice_size: 'SMALL' })])).status, 400, 'Dukot has no size');
    assert.equal((await shop.order([line(shop.broiler, { service: dukot })])).status, 201);

    // rename: the old order keeps the name it was sold under; the next one gets the new name
    assert.equal((await shop.admin.call('PUT', `/api/services/${sliced}`, { label: 'Pour Four Pieces' })).status, 200);
    const old = (await shop.cashier.call('GET', `/api/orders/${ok.data.order.id}`)).data.order;
    assert.equal(old.items[0].service_label, 'Pour Quarter');
    const next = await shop.order([line(shop.broiler, { service: sliced, slice_size: 'LARGE' })]);
    assert.equal(next.data.order.items[0].service_label, 'Pour Four Pieces');

    // hide: it can no longer be sold, the old orders still read
    assert.equal((await shop.admin.call('PUT', `/api/services/${sliced}`, { active: false })).status, 200);
    const refused = await shop.order([line(shop.broiler, { service: sliced, slice_size: 'LARGE' })]);
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(refused.data), /not available any more/);
    assert.ok(!(await shop.cashier.call('GET', '/api/config')).data.services.some((s) => s.code === sliced));
    assert.equal((await shop.cashier.call('GET', `/api/orders/${ok.data.order.id}`)).data.order.items[0].service_label, 'Pour Quarter');
    assert.equal((await shop.admin.call('GET', '/api/services')).data.services.find((s) => s.code === sliced).active, false, 'the admin still sees it');
    assert.throws(() => shop.db.exec(`DELETE FROM services WHERE code = '${sliced}'`), /cannot be deleted/);
  } finally { shop.close(); }
});

test('callers that only send feather + cut (the old way) still work and get the built-in service', async () => {
  const shop = await makeShop();
  try {
    updateFee(shop.db, shop.adminUser, 'NOT_POUR', { amount: '25', basis: 'per_head' });
    const r = await shop.order([line(shop.broiler, { feather: 'NOT_POUR', cut: 'SLICE', slice_size: 'MEDIUM' })]);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.deepEqual([r.data.order.items[0].service, r.data.order.items[0].service_label, r.data.order.items[0].service_fee_centavos], ['NOT_POUR_SLICE', 'Dress & Slice', 7500]);
    assert.equal((await shop.order([line(shop.broiler, { feather: null })])).status, 400);
    assert.equal((await shop.order([line(shop.broiler, { service: 'NOT_A_SERVICE' })])).status, 400);
    // a hidden built-in service cannot be reached the old way either
    await shop.admin.call('PUT', '/api/services/NOT_POUR_SLICE', { active: false });
    assert.equal((await shop.order([line(shop.broiler, { feather: 'NOT_POUR', cut: 'SLICE', slice_size: 'MEDIUM' })])).status, 400);
  } finally { shop.close(); }
});

test('the old family shortcut still sets all three services of a family, as one entry in the history', () => {
  const db = openDb(':memory:');
  const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  updateFee(db, admin, 'POUR', { amount: '45', basis: 'per_head' });
  assert.deepEqual(listServices(db).filter((s) => s.kind === 'POUR').map((s) => s.fee_centavos), [4500, 4500, 4500]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE kind = 'SERVICE_FEE'").get().n, 1);
  db.close();
});

test('the shared rules: a service from the list sets feather and cut, only added services are named in the preparation, and a slice size on a whole service switches to its twin', () => {
  const list = [
    { code: 'NOT_POUR', kind: 'NOT_POUR', cut: 'NONE' }, { code: 'NOT_POUR_SLICE', kind: 'NOT_POUR', cut: 'SLICE' },
    { code: 'SVC_1', kind: 'POUR', cut: 'SLICE' }, { code: 'SVC_2', kind: 'NOT_POUR', cut: 'NONE' },
  ];
  let p = applyPrepChange(emptyPrep(), { service: 'SVC_1' }, list);
  assert.deepEqual([p.feather, p.cut, p.service, serviceOf(p), needsSliceSize(serviceOf(p), list)], ['POUR', 'SLICE', 'SVC_1', 'SVC_1', true]);
  p = applyPrepChange(p, { cut: 'SMALL' }, list);
  assert.deepEqual([p.sliceSize, p.service], ['SMALL', 'SVC_1'], 'an added Slice service keeps its name when a size is chosen');
  p = applyPrepChange(p, { service: 'NOT_POUR' }, list);
  assert.deepEqual(p, { feather: 'NOT_POUR', dara: false, cut: 'NONE', sliceSize: null }, 'a built-in service looks exactly as it always did');
  p = applyPrepChange(p, { service: 'SVC_2' }, list);
  p = applyPrepChange(p, { cut: 'LARGE' }, list);
  assert.equal(serviceOf(p), 'NOT_POUR_SLICE', 'a size on a whole added service switches to the built-in Slice twin');
});

test('pricing: the line uses the fee of its own service, then its family, then nothing', () => {
  const fees = { POUR: { amount: 4500, basis: 'per_head', name: 'Pour' }, POUR_SLICE: { amount: 6000, basis: 'per_item', name: 'Pour' }, SVC_1: { amount: 3000, basis: 'per_kg', name: 'Deboned' } };
  const base = { pricePerKgCentavos: 10000, weightG: 3000, heads: 3, fees };
  assert.equal(chickenLine({ ...base, prep: { feather: 'POUR', cut: 'SLICE', sliceSize: 'SMALL' } }).serviceFee, 6000);
  assert.equal(chickenLine({ ...base, prep: { feather: 'POUR', cut: 'NONE' } }).serviceFee, 13500);
  assert.equal(chickenLine({ ...base, prep: { feather: 'NOT_POUR', cut: 'DUKOT', service: 'SVC_1' } }).serviceFee, 9000, 'per kg: 3 kg x 30');
  assert.equal(chickenLine({ ...base, prep: { feather: 'POUR', cut: 'DUKOT' } }).serviceFee, 13500, 'no fee for Pour & Dukot in this list: the family fee');
  assert.equal(chickenLine({ ...base, prep: { feather: 'NOT_POUR', cut: 'NONE' } }).serviceFee, 0);
  assert.equal(chickenLine({ ...base, prep: { feather: 'LIVE', cut: 'NONE' } }).serviceFee, 0);
});

test('upgrade 13 -> 14: a safety copy first; every order, line, fee and total is identical; the services start with the fee they had; old lines read as before', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r19-up-'));
  const file = path.join(dir, 'pos.db');
  const shop = await makeShop(file);
  updateFee(shop.db, shop.adminUser, 'POUR', { amount: '45', basis: 'per_head' });
  updateFee(shop.db, shop.adminUser, 'NOT_POUR', { amount: '25', basis: 'per_item' });
  // updateFee wrote the new services table too; undo that so the file really looks like version 13 (only service_fees existed)
  const sold = await shop.order([line(shop.broiler, { service: 'POUR_SLICE', slice_size: 'SMALL' })]);
  assert.equal(sold.status, 201);
  const sold2 = await shop.order([line(shop.broiler, { service: 'NOT_POUR_DUKOT' })]);
  assert.equal(sold2.status, 201);
  shop.close();

  // make the file a genuine version-13 file: no services table, no service columns on the lines
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE services; ALTER TABLE order_items DROP COLUMN service_code; ALTER TABLE order_items DROP COLUMN service_label;');
  for (const t of ['products', 'other_products']) raw.exec(`ALTER TABLE ${t} DROP COLUMN removed_at; ALTER TABLE ${t} DROP COLUMN removed_by; ALTER TABLE ${t} DROP COLUMN purged;`);
  raw.exec('PRAGMA user_version = 13;');
  const snap = (d) => JSON.stringify(['orders', 'order_items', 'payments', 'service_fees', 'products'].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
  const before = snap(raw);
  raw.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15);
  assert.ok(fs.readdirSync(dir).some((f) => /^pos\.db\.before-v14-\d+\.bak$/.test(f)), 'a safety copy was made');
  const strip = JSON.stringify(JSON.parse(snap(db)).map((rows) => rows.map(({ service_code: _a, service_label: _b, removed_at: _c, removed_by: _d, purged: _e, ...r }) => r)));
  assert.equal(strip, before, 'everything that existed is unchanged');
  assert.deepEqual(db.prepare('SELECT code, fee_centavos, fee_basis FROM services ORDER BY sort').all().map((r) => [r.code, r.fee_centavos, r.fee_basis]), [
    ['LIVE', 0, 'per_head'], ['POUR', 4500, 'per_head'], ['NOT_POUR', 2500, 'per_item'], ['POUR_SLICE', 4500, 'per_head'],
    ['NOT_POUR_SLICE', 2500, 'per_item'], ['POUR_DUKOT', 4500, 'per_head'], ['NOT_POUR_DUKOT', 2500, 'per_item'],
  ]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items WHERE service_code IS NOT NULL').get().n, 0, 'old lines have no saved service name');

  // old lines still read, with the built-in name worked out from feather + cut
  const { getOrder } = await import('../src/services/orders.js');
  const o = getOrder(db, sold.data.order.id, { role: 'admin' });
  assert.deepEqual([o.items[0].service, o.items[0].service_label], ['POUR_SLICE', 'Po-ur & Slice']);
  db.close();
  assert.equal(openDb(file).prepare('PRAGMA user_version').get().user_version, 15, 'a second start changes nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});
