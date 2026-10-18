// A throwaway demo of Revision 12 for checking the screens: its own database and inventory folder under /tmp, its own port.
// SAMPLE data only. Never touches the shop's data folder.
import fs from 'node:fs';
const APP = process.argv[2];
const ROOT = '/tmp/cpos-check/demo';
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });
process.chdir(APP);   // the server serves public/ relative to its own file, but keep the cwd sane
const { loadConfig } = await import(`${APP}/src/config.js`);
const { openDb } = await import(`${APP}/src/db.js`);
const { createApp } = await import(`${APP}/src/app.js`);
const { createUser } = await import(`${APP}/src/services/users.js`);
const { createProduct, listOtherProducts, listProducts, updateOption, updateProduct, seedStarterCatalog, seedRevision11Products } = await import(`${APP}/src/services/catalog.js`);
const { getInventory, updateRecord } = await import(`${APP}/src/services/inventory.js`);

const config = loadConfig({ dbPath: `${ROOT}/demo.db`, inventoryDir: `${ROOT}/inventory`, port: 3011 });
const db = openDb(config.dbPath);
const admin = createUser(db, { username: 'demo-admin', display_name: 'Demo Admin', role: 'admin', password: 'demo-admin-1' });
createUser(db, { username: 'demo-cashier', display_name: 'Demo Cashier', role: 'cashier', password: 'demo-cashier-1' });
createProduct(db, admin, { name: 'B-Cull', price: '52' });
createProduct(db, admin, { name: 'Cull Chicken', price: '58' });
createProduct(db, admin, { name: 'Broilers', price: '120' });
seedStarterCatalog(db);
seedRevision11Products(db);
const byName = { 'Etag (Sun-Dried)': 520, 'Etag (Smoked)': 560, Garlic: 140, Onions: 90, Laya: 80, Ducks: 320, Catfish: 160 };
const sample = { piece: 9, pack: 45, sack: 900, carton: 280, tray: 250, kg: 100 };
for (const p of listOtherProducts(db, { includeInactive: true })) {
  for (const o of p.options) updateOption(db, admin, o.id, { price: String(o.unit === 'kg' ? byName[p.name] ?? sample.kg : (p.name === 'Ducks' && o.unit === 'piece' ? 900 : sample[o.unit])), active: true });
}
const brown = listProducts(db, { includeInactive: true }).find((p) => p.name === 'Brown Cull Chicken');
updateProduct(db, admin, brown.id, { price: '56', active: true });
const inv = getInventory(db, admin, {}, new Date());
for (const row of [...inv.chicken, ...inv.other]) updateRecord(db, admin, row.id, { rev: row.rev, beginning: row.kind === 'CHICKEN' ? '40' : '20' }, new Date());
createApp({ db, config }).listen(config.port, () => console.log(`DEMO r12 on http://localhost:${config.port}`));
