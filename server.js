// Start the POS server:  npm start
import fs from 'node:fs';
import { loadConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { bootstrapAdmin } from './src/services/users.js';
import { seedStarterCatalog, seedRevision11Products } from './src/services/catalog.js';
import { importSetup } from './src/services/setupData.js';
import { inventoryDir } from './src/services/inventory.js';
import { midnightClose } from './src/services/inventoryReport.js';

const config = loadConfig();
const db = openDb(config.dbPath);

let created;
try {
  created = bootstrapAdmin(db, config);
} catch (err) {
  console.error(`Could not create the first admin account: ${err.message}`);
  console.error('Fix ADMIN_USERNAME and ADMIN_PASSWORD in your .env file (username 3 or more letters/numbers, password 8 or more characters) and start again.');
  process.exit(1);
}
if (created === true) console.log(`Created the first admin account "${config.adminUsername}". Sign in, then change its password in Users.`);
if (created === null) {
  console.log('No users exist yet. Set ADMIN_USERNAME and ADMIN_PASSWORD (see .env.example) and start again,');
  console.log('or run: npm run create-user -- <username> admin');
}

// First run only: the service prices and the other products the shop named (prices for those are set by the admin).
if (seedStarterCatalog(db)) console.log('Added the starter service prices and other products. Set their prices in Products.');
// Revision 11, once: Brown Cull Chicken, Ducks and Catfish, without prices (the admin sets them in Products).
const added = seedRevision11Products(db);
if (added.length) console.log(`Added ${added.join(', ')}. They stay hidden from the cashier until the admin sets their prices in Products.`);

// Revision 18: a hosted copy can start with this shop's products and prices (SETUP_FILE=deploy/setup.json). Once per database.
if (config.setupFile) {
  try {
    const admin = db.prepare("SELECT * FROM users WHERE role = 'admin' AND active = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1").get();
    const done = admin ? importSetup(db, admin, JSON.parse(fs.readFileSync(config.setupFile, 'utf8'))) : null;
    if (done) console.log(`Loaded the setup from ${config.setupFile}: ${done.chicken} chicken product(s), ${done.other} other product(s), ${done.fees} fee(s).`);
  } catch (err) {
    console.error(`Could not load ${config.setupFile} (${err.message}). The app starts without it; add the products in Products.`);
  }
}

// Revision 13: at midnight (PH time) the Daily Inventory saves and closes by itself, and the new day starts with yesterday's New Total.
// Checked at start (the app may have been off overnight) and every minute after.
const closeAtMidnight = () => {
  try {
    const closed = midnightClose(db, new Date(), { dir: inventoryDir(config) });
    if (closed) console.log(`Business day ${closed} was saved and closed at midnight; a new business day has started.`);
  } catch (err) {
    console.error(`The midnight close did not work this time (${err.message}); it is tried again in a minute.`);
  }
};
closeAtMidnight();
const midnightTimer = setInterval(closeAtMidnight, 60_000);

const server = createApp({ db, config }).listen(config.port, config.host || undefined, () => {
  console.log(`Chicken POS is running at http://${config.host || 'localhost'}:${config.port}  (database: ${config.dbPath})`);
});

// Stopping with Ctrl+C closes the database cleanly, so the data file (pos.db) is complete on its own.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('Stopping Chicken POS...');
    clearInterval(midnightTimer);
    server.close();
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
}
