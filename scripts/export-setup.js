// Write this shop's setup (products, ways of selling, prices, service fees) to a file:  npm run export-setup [-- path]
// Default file: deploy/setup.json. It holds NO users, passwords or orders, so it is safe to commit.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { exportSetup } from '../src/services/setupData.js';

const config = loadConfig();
if (!fs.existsSync(config.dbPath)) { console.error(`No database found at ${config.dbPath}.`); process.exit(1); }
const out = path.resolve(process.argv[2] ?? 'deploy/setup.json');
const db = new DatabaseSync(config.dbPath, { readOnly: true });
const data = exportSetup(db);
db.close();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(data, null, 2) + '\n');
console.log(`Saved ${data.chicken.length} chicken product(s), ${data.other.length} other product(s) and ${data.fees.length} fee(s) to ${out}`);
