// Start the POS server:  npm start
import { loadConfig } from './src/config.js';
import { openDb } from './src/db.js';
import { createApp } from './src/app.js';
import { bootstrapAdmin } from './src/services/users.js';
import { seedStarterCatalog } from './src/services/catalog.js';

const config = loadConfig();
const db = openDb(config.dbPath);

const created = bootstrapAdmin(db, config);
if (created === true) console.log(`Created the first admin account "${config.adminUsername}". Sign in, then change its password in Users.`);
if (created === null) {
  console.log('No users exist yet. Set ADMIN_USERNAME and ADMIN_PASSWORD (see .env.example) and start again,');
  console.log('or run: npm run create-user -- <username> admin');
}

// First run only: the service prices and the other products the shop named (prices for those are set by the admin).
if (seedStarterCatalog(db)) console.log('Added the starter service prices and other products. Set their prices in Products.');

createApp({ db, config }).listen(config.port, () => {
  console.log(`Chicken POS is running at http://localhost:${config.port}  (database: ${config.dbPath})`);
});
