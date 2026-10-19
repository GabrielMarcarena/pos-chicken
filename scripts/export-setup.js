// Write this shop's setup (products, ways of selling, prices, service fees) to a file:  npm run export-setup [-- path]
// Default file: deploy/setup.json. It holds NO users, passwords or orders, so it is safe to commit.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { exportSetup } from '../src/services/setupData.js';

const config = loadConfig();
if (!fs.existsSync(config.dbPath)) { console.error(`No database found at ${config.dbPath}.`); process.exit(1); }
const out = path.resolve(process.argv[2] ?? 'deploy/setup.json');
const db = openDb(config.dbPath);   // brings an older database up to date first (with its usual safety copy), like starting the app
const data = exportSetup(db);
db.close();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(`Saved ${data.chicken.length} chicken product(s), ${data.other.length} other product(s) and ${data.services.length} service(s) to ${out}`);
