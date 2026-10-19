// Revision 21 tests: Deactivate or Remove. Only a manager or the admin removes; chicken, eggs and the built-in services are never removed; an other
// product only while its stock is empty; the admin restores for 7 days; after that it is gone for good; sold orders never change.
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
import { createProduct, listOtherProducts, createOtherProduct, createService, listServices } from '../src/services/catalog.js';
import { removeItem, restoreItem, listRemoved, purgeExpired } from '../src/services/removal.js';

const START = new Date('2026-10-19T02:00:00Z');
const DAY = 86_400_000;
let keyN = 0;
const key = () => `r21-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

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

async function makeShop() {
  const db = openDb(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r21-'));
  const config = loadConfig({ dbPath: ':memory:', inventoryDir: dir, largeWeightKg: 50, sessionIdleMinutes: 60 });
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  const mgrUser = createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  const broiler = createProduct(db, adminUser, { name: 'Broiler', price: '100', category: 'BROILER' }).id;
  const eggs = createOtherProduct(db, adminUser, { name: 'Eggs (Test)', kind: 'EGGS', prices: { piece: '10' } });
  const clock = { now: START };
  const server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier] = [client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1'); await cashier.login('cash', 'cashier-pass-1');
  const inv = (await manager.call('GET', '/api/inventory')).data;
  for (const row of inv.chicken) await manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: 500, reason: 'RECOUNT' });
  const shop = {
    db, admin, manager, cashier, broiler, eggs, adminUser, mgrUser, clock,
    close: () => { server.closeAllConnections(); server.close(); try { db.close(); } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }); },
    async inventoryRow(name) { return (await manager.call('GET', '/api/inventory')).data.other.find((r) => r.product_name === name); },
    async setStock(name, amount) {
      const row = await shop.inventoryRow(name);
      const r = await manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, beginning: amount, reason: 'RECOUNT' });
      assert.ok(r.status < 300, JSON.stringify(r.data));
    },
    async addProduct(name, kind = 'OTHER') {
      const r = await admin.call('POST', '/api/other-products', { name, kind, prices: kind === 'EGGS' ? { piece: '10' } : { piece: '100' } });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data.other_product;
    },
  };
  return shop;
}
const sellOther = (shop, product, quantity) => shop.cashier.call('POST', '/api/orders', {
  submission_key: key(), items: [], payment: { method: 'CASH', received: '10000' },
  other_items: [{ other_product_id: product.id, option_id: product.options.find((o) => o.unit === 'piece').id, quantity: String(quantity) }],
});

test('a manager removes an other product once its stock is empty; it leaves every list; the orders already sold keep its name and price', async () => {
  const shop = await makeShop();
  try {
    const ducks = await shop.addProduct('Ducks');
    await shop.setStock('Ducks', 2);
    const sold = await sellOther(shop, ducks, 2);
    assert.equal(sold.status, 201, JSON.stringify(sold.data));
    assert.equal((await shop.inventoryRow('Ducks')).new_total, 0, 'sold out: the stock is empty');

    const info = await shop.manager.call('GET', `/api/items/other/${ducks.id}/removable`);
    assert.equal(info.data.removable, true);
    const r = await shop.manager.call('POST', `/api/items/other/${ducks.id}/remove`);
    assert.equal(r.status, 200, JSON.stringify(r.data));

    assert.ok(!(await shop.manager.call('GET', '/api/other-products')).data.other_products.some((p) => p.name === 'Ducks'), 'not on Products');
    assert.ok(!(await shop.cashier.call('GET', '/api/config')).data.other_products?.some?.((p) => p.name === 'Ducks') ?? true);
    assert.equal((await shop.inventoryRow('Ducks')).new_total, 0, "today's row stays only because today's sales are on it; nothing is left to sell, and it is gone from tomorrow");
    const order = (await shop.cashier.call('GET', `/api/orders/${sold.data.order.id}`)).data.order;
    assert.deepEqual([order.other_items[0].product_name, order.total_centavos], ['Ducks', 20000], 'the sale is untouched');
    assert.equal((await sellOther(shop, ducks, 1)).status, 400, 'it cannot be sold any more');
    assert.deepEqual((await shop.admin.call('GET', '/api/removed')).data.removed.map((x) => [x.kind, x.name, x.days_left, x.removed_by]), [['other', 'Ducks', 7, 'Manager']]);
  } finally { shop.close(); }
});

test('an other product with stock cannot be removed, and the message says how much is left', async () => {
  const shop = await makeShop();
  try {
    const ducks = await shop.addProduct('Ducks');
    await shop.setStock('Ducks', 3);
    const r = await shop.manager.call('POST', `/api/items/other/${ducks.id}/remove`);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Ducks still has stock today \(3 piece\)/);
    assert.equal((await shop.manager.call('GET', `/api/items/other/${ducks.id}/removable`)).data.removable, false);
    assert.ok((await shop.manager.call('GET', '/api/other-products')).data.other_products.some((p) => p.name === 'Ducks'), 'still there');
  } finally { shop.close(); }
});

test('main items are never removed: chicken products, egg products and the built-in services (they can be deactivated)', async () => {
  const shop = await makeShop();
  try {
    for (const [kind, k, text] of [['chicken', shop.broiler, /main products/], ['other', shop.eggs.id, /Egg products are main products/], ['service', 'POUR_SLICE', /Built-in services/]]) {
      const r = await shop.admin.call('POST', `/api/items/${kind}/${k}/remove`);
      assert.equal(r.status, 409, kind);
      assert.match(r.data.error, text, kind);
      assert.equal((await shop.admin.call('GET', `/api/items/${kind}/${k}/removable`)).data.removable, false);
    }
    // deactivating them still works: that is what Deactivate is for
    assert.equal((await shop.manager.call('PATCH', `/api/products/${shop.broiler}`, { active: false })).status, 200);
    assert.equal((await shop.manager.call('PUT', '/api/services/POUR_SLICE', { active: false })).status, 200, 'a manager can hide a service');
    assert.equal((await shop.manager.call('PUT', '/api/services/POUR_SLICE', { active: true, fee: '99' })).status, 403, 'but not change its fee');
  } finally { shop.close(); }
});

test('who may do what: a cashier cannot remove; a manager cannot restore; the admin can; a restored item comes back deactivated', async () => {
  const shop = await makeShop();
  try {
    const ducks = await shop.addProduct('Ducks');
    assert.equal((await shop.cashier.call('POST', `/api/items/other/${ducks.id}/remove`)).status, 403);
    assert.equal((await shop.manager.call('POST', `/api/items/other/${ducks.id}/remove`)).status, 200);
    assert.equal((await shop.manager.call('POST', `/api/items/other/${ducks.id}/restore`)).status, 403);
    assert.equal((await shop.manager.call('GET', '/api/removed')).status, 403);
    assert.equal((await shop.admin.call('POST', `/api/items/other/${ducks.id}/restore`)).status, 200);
    const back = (await shop.manager.call('GET', '/api/other-products')).data.other_products.find((p) => p.name === 'Ducks');
    assert.equal(back.active, false, 'it comes back switched off');
    assert.equal((await shop.manager.call('PATCH', `/api/other-products/${back.id}`, { active: true })).status, 200, 'Reactivate turns it on');
    assert.equal((await shop.admin.call('POST', `/api/items/other/${ducks.id}/restore`)).status, 409, 'it is not removed any more');
  } finally { shop.close(); }
});

test('a name that was removed recently cannot be added again, and the message says why', async () => {
  const shop = await makeShop();
  try {
    const ducks = await shop.addProduct('Ducks');
    await shop.manager.call('POST', `/api/items/other/${ducks.id}/remove`);
    const again = await shop.manager.call('POST', '/api/other-products', { name: 'Ducks', kind: 'OTHER' });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /Ducks was removed recently\. Ask the admin to restore it/);
  } finally { shop.close(); }
});

test('after 7 days: it cannot be restored; an unused item is deleted; a used one is hidden for good and its name is free again', () => {
  const db = openDb(':memory:');
  const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  const mgr = createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  const unused = createOtherProduct(db, admin, { name: 'Catfish', kind: 'OTHER' });
  const used = createOtherProduct(db, admin, { name: 'Ducks', kind: 'OTHER', prices: { piece: '100' } });
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('probe', '1')").run();
  removeItem(db, mgr, 'other', unused.id, START);
  removeItem(db, mgr, 'other', used.id, START);
  // "Ducks" was used (a number sits on its record); "Catfish" only has the empty row every product gets
  db.prepare('UPDATE inventory_records SET beginning_milli = 1000 WHERE option_id = ?').run(used.options[0].id);
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM inventory_records WHERE option_id IN (SELECT id FROM other_product_options WHERE product_id = ?)').get(unused.id).n > 0, 'Catfish has an empty open-day row');

  assert.equal(purgeExpired(db, new Date(START.getTime() + 6 * DAY)), 0, 'nothing is gone before 7 days');
  assert.equal(listRemoved(db, new Date(START.getTime() + 6 * DAY)).length, 2);
  const later = new Date(START.getTime() + 7 * DAY + 1000);
  assert.throws(() => restoreItem(db, admin, 'other', used.id, later), /more than 7 days ago/);
  assert.equal(listRemoved(db, later).length, 0, 'the Removed list shows only what can still be restored');
  assert.equal(purgeExpired(db, later), 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM other_products WHERE name = ?').get('Catfish').n, 0, 'unused: deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM other_product_options WHERE product_id = ?').get(unused.id).n, 0);
  const kept = db.prepare('SELECT name, purged, removed_at FROM other_products WHERE id = ?').get(used.id);
  assert.match(kept.name, /^Ducks \(removed 2026-10-19\)$/);
  assert.equal(kept.purged, 1);
  assert.equal(listOtherProducts(db, { includeInactive: true }).some((p) => p.id === used.id), false, 'it is on no list');
  assert.ok(createOtherProduct(db, admin, { name: 'Ducks', kind: 'OTHER' }), 'the name can be used again');
  assert.equal(purgeExpired(db, later), 0, 'a second clean-up does nothing');

  // a service: removed, then after 7 days hidden for good and its name is free again
  const svc = createService(db, admin, { label: 'Deboned', kind: 'NOT_POUR', cut: 'NONE', fee: '30', basis: 'per_head' }, START);
  removeItem(db, mgr, 'service', svc.code, later);
  assert.equal(purgeExpired(db, new Date(later.getTime() + 7 * DAY + 1000)), 1);
  assert.equal(db.prepare('SELECT label FROM services WHERE code = ?').get(svc.code).label.startsWith('Deboned (removed '), true);
  assert.ok(createService(db, admin, { label: 'Deboned', kind: 'POUR', cut: 'NONE', fee: '10', basis: 'per_item' }), 'the service name can be used again');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM services').get().n, 9);
  db.close();
});

test('a service the admin added can be removed, never a built-in one; the order it was sold on keeps its service name', async () => {
  const shop = await makeShop();
  try {
    const svc = (await shop.admin.call('POST', '/api/services', { label: 'Deboned', kind: 'NOT_POUR', cut: 'NONE', fee: '30', basis: 'per_head' })).data.service.code;
    const sold = await shop.cashier.call('POST', '/api/orders', {
      submission_key: key(), other_items: [], payment: { method: 'CASH', received: '10000' },
      items: [{ product_id: shop.broiler, weight: '3.0', heads: 3, dara: false, service: svc }],
    });
    assert.equal(sold.status, 201, JSON.stringify(sold.data));
    assert.equal((await shop.manager.call('POST', `/api/items/service/${svc}/remove`)).status, 200);
    assert.ok(!(await shop.cashier.call('GET', '/api/config')).data.services.some((s) => s.code === svc));
    assert.ok(!(await shop.manager.call('GET', '/api/services')).data.services.some((s) => s.code === svc));
    assert.equal((await shop.cashier.call('POST', '/api/orders', {
      submission_key: key(), other_items: [], payment: { method: 'CASH', received: '10000' }, items: [{ product_id: shop.broiler, weight: '3.0', heads: 3, dara: false, service: svc }],
    })).status, 400, 'a removed service cannot be sold');
    assert.equal((await shop.cashier.call('GET', `/api/orders/${sold.data.order.id}`)).data.order.items[0].service_label, 'Deboned');
    assert.equal((await shop.admin.call('POST', `/api/items/service/${svc}/restore`)).status, 200);
    assert.equal((await shop.admin.call('GET', '/api/services')).data.services.find((s) => s.code === svc).active, false, 'restored, but switched off');
    // a purged service frees its name
    await shop.admin.call('POST', `/api/items/service/${svc}/remove`).catch(() => {});
  } finally { shop.close(); }
});

test('upgrade 14 -> 15: a safety copy first; nothing is changed; the new columns start empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r21-up-'));
  const file = path.join(dir, 'pos.db');
  const db0 = openDb(file);
  const admin = createUser(db0, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createProduct(db0, admin, { name: 'Broiler', price: '100' });
  createOtherProduct(db0, admin, { name: 'Ducks', kind: 'OTHER', prices: { piece: '100' } });
  createService(db0, admin, { label: 'Deboned', kind: 'NOT_POUR', cut: 'NONE', fee: '30', basis: 'per_head' });
  db0.close();
  const raw = new DatabaseSync(file);
  for (const t of ['products', 'other_products', 'services']) raw.exec(`ALTER TABLE ${t} DROP COLUMN removed_at; ALTER TABLE ${t} DROP COLUMN removed_by; ALTER TABLE ${t} DROP COLUMN purged;`);
  raw.exec('PRAGMA user_version = 14;');
  const dump = (d) => JSON.stringify(['products', 'other_products', 'other_product_options', 'services', 'users'].map((t) => d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map(({ removed_at: _a, removed_by: _b, purged: _c, ...r }) => r)));
  const before = dump(raw);
  raw.close();
  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 15);
  assert.ok(fs.readdirSync(dir).some((f) => /^pos\.db\.before-v15-\d+\.bak$/.test(f)), 'a safety copy was made');
  assert.equal(dump(db), before, 'every row is the same');
  for (const t of ['products', 'other_products', 'services']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE removed_at IS NOT NULL OR purged <> 0`).get().n, 0, t);
  }
  assert.equal(listServices(db).length, 8);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
