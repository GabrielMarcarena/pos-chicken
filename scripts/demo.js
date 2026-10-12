// Demo mode:  npm run demo
// Uses its own database file (data/demo.db) so sample products and sample orders can never mix with real records.
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createUser } from '../src/services/users.js';
import { createProduct, listOtherProducts, updateOption, seedStarterCatalog } from '../src/services/catalog.js';

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
  // The shop's service prices (Po-ur & Slice 45, Dressed & Slice 25) and the other products it named come from the starter data.
  seedStarterCatalog(db);
  // SAMPLE prices for the other products, so the demo screens are not empty. The real prices are set by the admin.
  const sample = { piece: 9, dozen: 100, batch: 270, kg: 100 };
  const byName = { 'Etag (Sun-Dried)': 520, 'Etag (Smoked)': 560, Garlic: 140, Onions: 90, Laya: 80 };
  for (const p of listOtherProducts(db, { includeInactive: true })) {
    for (const o of p.options) updateOption(db, admin, o.id, { price: String(byName[p.name] ?? sample[o.unit]), active: true });
  }
}
createApp({ db, config }).listen(config.port, () => {
  console.log(`DEMO MODE: http://localhost:${config.port}   (database: ${config.dbPath} - sample data only)`);
  console.log('Sign in with demo-cashier / demo-cashier-1, demo-manager / demo-manager-1, or demo-admin / demo-admin-1');
});
