// Make a consistent copy of the database:  npm run backup
// Safe to run while the server is running. Copies go to backups/ (keep them somewhere other than this computer too).
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (!fs.existsSync(config.dbPath)) {
  console.error(`No database found at ${config.dbPath}.`);
  process.exit(1);
}
const stamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16).replace(/[-:T]/g, '');
const target = path.resolve('backups', `pos-${stamp}.db`);
fs.mkdirSync(path.dirname(target), { recursive: true });
const db = new DatabaseSync(config.dbPath);
db.prepare('VACUUM INTO ?').run(target);
db.close();
console.log(`Backup saved: ${target}`);
