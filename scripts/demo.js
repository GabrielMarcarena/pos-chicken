// Demo mode:  npm run demo
// Uses its own database file (data/demo.db) so sample products and sample orders can never mix with real records.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createUser } from '../src/services/users.js';
import { createProduct, listOtherProducts, listProducts, updateOption, updateProduct, seedStarterCatalog, seedRevision11Products } from '../src/services/catalog.js';
import { getInventory, updateRecord } from '../src/services/inventory.js';

const config = loadConfig({ dbPath: 'data/demo.db' });
const fresh = !fs.existsSync(config.dbPath);
const db = openDb(config.dbPath);

if (fresh) {
  const admin = createUser(db, { username: 'demo-admin', display_name: 'Demo Admin', role: 'admin', password: 'demo-admin-1' });
  createUser(db, { username: 'demo-manager', display_name: 'Demo Manager', role: 'manager', password: 'demo-manager-1' });
  createUser(db, { username: 'demo-cashier', display_name: 'Demo Cashier', role: 'cashier', password: 'demo-cashier-1' });
  // SAMPLE chicken catalog. Names and prices are examples only.
  createProduct(db, admin, { name: 'Broiler Breeder Cull', price: '52', description: 'Sample product' });
  createProduct(db, admin, { name: 'Cull Chicken', price: '58', description: 'Sample product' });
  createProduct(db, admin, { name: 'Broilers', price: '120', description: 'Sample product' });
  // The shop's service prices (Pour 45, Dress 25) and the other products it named come from the starter data.
  seedStarterCatalog(db);
  seedRevision11Products(db);
  // SAMPLE prices for the other products, so the demo screens are not empty. The real prices are set by the admin.
  const sample = { piece: 9, pack: 45, sack: 900, carton: 280, tray: 250, dozen: 100, batch: 270, kg: 100 };
  const byName = { 'Etag (Sun-Dried)': 520, 'Etag (Smoked)': 560, Garlic: 140, Onions: 90, Laya: 80, Ducks: 320, Catfish: 160 };
  for (const p of listOtherProducts(db, { includeInactive: true })) {
    for (const o of p.options) updateOption(db, admin, o.id, { price: String(o.unit === 'kg' ? byName[p.name] ?? sample.kg : sample[o.unit]), active: true });
  }
  // SAMPLE price for Brown Cull Chicken (demo only; the real price is set by the admin).
  const brown = listProducts(db, { includeInactive: true }).find((p) => p.name === 'Brown Cull Chicken');
  if (brown) updateProduct(db, admin, brown.id, { price: '56', active: true });
  // SAMPLE stock (Revision 9). Orders are checked against the Daily Inventory, so the demo needs a Beginning Balance to sell from.
  // These numbers are made up for the demo only. In the real shop a manager types the real counts on the Daily Inventory screen.
  const inventory = getInventory(db, admin, {}, new Date());
  for (const row of [...inventory.chicken, ...inventory.other]) {
    updateRecord(db, admin, row.id, { rev: row.rev, beginning: row.kind === 'CHICKEN' ? '60' : '40' }, new Date());
  }
}
createApp({ db, config }).listen(config.port, () => {
  console.log(`DEMO MODE: http://localhost:${config.port}   (database: ${config.dbPath} - sample data only)`);
  console.log('Sign in with demo-cashier / demo-cashier-1, demo-manager / demo-manager-1, or demo-admin / demo-admin-1');
});
