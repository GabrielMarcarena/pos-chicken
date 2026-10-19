// Revision 18 tests: the shop's setup (products, ways of selling, prices, fees) can be exported and loaded once into a fresh database,
// without any users, passwords or orders. Also the INVENTORY_DIR / SETUP_FILE settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createOtherProduct, createProduct, listOtherProducts, listProducts, listServices, seedStarterCatalog, seedRevision11Products, updateFee, updateProduct } from '../src/services/catalog.js';
import { exportSetup, importSetup } from '../src/services/setupData.js';
import { inventoryDir } from '../src/services/inventory.js';

function shopWithProducts() {
  const db = openDb(':memory:');
  const admin = createUser(db, { username: 'gabriel', display_name: 'Gabriel', role: 'admin', password: 'gabriel-pass-1' });
  seedStarterCatalog(db); seedRevision11Products(db);
  createProduct(db, admin, { name: 'Cull Chicken', price: '58', category: 'CULL' });
  createProduct(db, admin, { name: 'Broilers', price: '120', category: 'BROILER' });
  createProduct(db, admin, { name: 'Old Hen', price: '70', category: 'OTHER' });
  updateProduct(db, admin, db.prepare("SELECT id FROM products WHERE name = 'Old Hen'").get().id, { active: false });
  createOtherProduct(db, admin, { name: 'Eggs (Jumbo)', kind: 'EGGS', prices: { carton: '120', piece: '10' } });
  createOtherProduct(db, admin, { name: 'Soy Sauce', kind: 'OTHER', prices: { kg: '80', pack: '25' } });
  updateFee(db, admin, 'POUR', { amount: '45', basis: 'per_item' });
  updateFee(db, admin, 'NOT_POUR', { amount: '25', basis: 'per_head' });
  return { db, admin };
}
const fresh = () => {
  const db = openDb(':memory:');
  const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  seedStarterCatalog(db); seedRevision11Products(db);   // what server.js does before loading a setup
  return { db, admin };
};
const shape = (db) => ({
  chicken: listProducts(db, { includeInactive: true }).map((p) => [p.name, p.category, p.price_per_kg_centavos, p.active]),
  other: listOtherProducts(db, { includeInactive: true }).map((p) => [p.name, p.kind, p.active, p.options.map((o) => [o.unit, o.sold_by, o.price_centavos, o.active])]),
  services: listServices(db, { includeInactive: true }).map((x) => [x.code, x.label, x.fee_centavos, x.fee_basis, x.active]),
});

test('a setup survives export, a JSON file and import into a fresh database (same products, ways of selling, prices, fees)', () => {
  const a = shopWithProducts();
  const data = JSON.parse(JSON.stringify(exportSetup(a.db)));
  const b = fresh();
  const done = importSetup(b.db, b.admin, data);
  assert.ok(done.chicken >= 3 && done.other >= 2 && done.services === 7, JSON.stringify(done));
  assert.deepEqual(shape(b.db), shape(a.db));
  assert.equal(b.db.prepare("SELECT active FROM products WHERE name = 'Old Hen'").get().active, 0, 'an inactive product stays inactive');
  assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM price_history').get().n > 0, true, 'the prices are in the price history under the admin');
});

test('it runs once: a second load changes nothing, even if the admin changed a price in between', () => {
  const a = shopWithProducts();
  const data = exportSetup(a.db);
  const b = fresh();
  assert.ok(importSetup(b.db, b.admin, data));
  updateProduct(b.db, b.admin, b.db.prepare("SELECT id FROM products WHERE name = 'Broilers'").get().id, { price: '130' });
  const before = shape(b.db);
  assert.equal(importSetup(b.db, b.admin, data), null);
  assert.deepEqual(shape(b.db), before);
  assert.equal(b.db.prepare("SELECT price_per_kg_centavos AS p FROM products WHERE name = 'Broilers'").get().p, 13000);
});

test('the file holds no users, passwords, sessions or orders', () => {
  const a = shopWithProducts();
  const text = JSON.stringify(exportSetup(a.db));
  for (const word of ['gabriel', 'password', 'hash', 'salt', 'session', 'order', 'username']) assert.ok(!text.toLowerCase().includes(word), word);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['chicken', 'other', 'services', 'version']);
});

test('a file that is not a setup is refused and nothing is changed', () => {
  const b = fresh();
  const before = shape(b.db);
  assert.throws(() => importSetup(b.db, b.admin, { version: 99 }), /not a setup file/);
  assert.deepEqual(shape(b.db), before);
  assert.equal(b.db.prepare("SELECT 1 FROM app_meta WHERE key = 'setup_imported'").get(), undefined, 'not marked as done');
});

test('INVENTORY_DIR and SETUP_FILE are read from the environment', () => {
  const old = { d: process.env.INVENTORY_DIR, s: process.env.SETUP_FILE };
  try {
    delete process.env.INVENTORY_DIR; delete process.env.SETUP_FILE;
    const none = loadConfig({ dbPath: '/data/pos.db' });
    assert.equal(none.setupFile, '');
    assert.equal(inventoryDir(none), path.resolve('backups', 'inventory'), 'default unchanged');
    process.env.INVENTORY_DIR = '/data/inventory'; process.env.SETUP_FILE = 'deploy/setup.json';
    const set = loadConfig({ dbPath: '/data/pos.db' });
    assert.equal(inventoryDir(set), '/data/inventory');
    assert.equal(set.setupFile, 'deploy/setup.json');
  } finally {
    for (const [k, v] of [['INVENTORY_DIR', old.d], ['SETUP_FILE', old.s]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the real server loads the setup file on a brand-new database, once', async () => {
  const a = shopWithProducts();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r18-'));
  const file = path.join(dir, 'setup.json');
  fs.writeFileSync(file, JSON.stringify(exportSetup(a.db)));
  const { spawnSync } = await import('node:child_process');
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..').replace(/%20/g, ' ');
  const run = () => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: root, encoding: 'utf8', timeout: 4000, killSignal: 'SIGTERM',
    env: { ...process.env, DB_PATH: path.join(dir, 'pos.db'), INVENTORY_DIR: path.join(dir, 'inv'), SETUP_FILE: file, PORT: '0', ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'owner-pass-1' },
  });
  const first = run();
  assert.match(first.stdout, /Loaded the setup from .*setup\.json: 4 chicken product\(s\)/, first.stdout + first.stderr);
  const second = run();
  assert.doesNotMatch(second.stdout, /Loaded the setup/);
  const db = openDb(path.join(dir, 'pos.db'));
  assert.deepEqual(shape(db).chicken.map((c) => c[0]).sort(), shape(a.db).chicken.map((c) => c[0]).sort());
  db.close();
});
