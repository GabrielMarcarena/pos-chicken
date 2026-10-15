// Clear the example / test records:   npm run clear-records
//
// Deletes ALL orders (with their items, payments and history), the price history and the CLOSED days of the Daily Inventory.
// Keeps your users, chicken products, other products, current prices, service fees and the open business day with the stock
// numbers typed on it. Order numbers start again at -001.
//
//   npm run clear-records                          asks you to type CLEAR before it deletes anything
//   npm run clear-records -- --keep-price-history  keep the price history, clear only the orders
//   npm run clear-records -- --confirm CLEAR       no question (for scripts; the safety copy is still made)
//
// Stop the app first (Ctrl+C). A safety copy of the whole database is saved next to it before anything is deleted.
import fs from 'node:fs';
import net from 'node:net';
import readline from 'node:readline/promises';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { clearRecords, countKept, countRecords } from '../src/clearRecords.js';

const args = process.argv.slice(2);
const keepPriceHistory = args.includes('--keep-price-history');
const given = args.includes('--confirm') ? args[args.indexOf('--confirm') + 1] : null;
const config = loadConfig();
const stop = (message, code = 1) => { console.error(message); process.exit(code); };

if (!fs.existsSync(config.dbPath)) stop(`No database found at ${config.dbPath}. Nothing to clear.`);

// The app must not be running: it could be saving an order while the records are removed.
const running = await new Promise((resolve) => {
  const socket = net.connect({ port: config.port, host: '127.0.0.1' });
  const done = (value) => { socket.destroy(); resolve(value); };
  socket.setTimeout(1000, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});
if (running) stop(`Something is running on port ${config.port}, probably the app. Stop it first (press Ctrl+C in the window where it runs), then try again. Nothing was changed.`);

// Opening the database brings an older one up to date first (the same safe upgrade the app does at start, with a safety copy).
const peek = new DatabaseSync(config.dbPath, { readOnly: true });
const versionBefore = peek.prepare('PRAGMA user_version').get().user_version;
peek.close();
const db = openDb(config.dbPath);
const versionNow = db.prepare('PRAGMA user_version').get().user_version;
if (versionNow !== versionBefore) console.log(`Note: the database was upgraded from version ${versionBefore} to ${versionNow} first (a safety copy of the old file was saved next to it), the same upgrade that happens when the app starts.\n`);
const will = countRecords(db);
const kept = countKept(db);
const nothing = !(will.orders || will.lines || will.payments || will.history || will.inventoryDays || (!keepPriceHistory && will.priceChanges));
if (nothing) { db.close(); stop('There are no orders, closed inventory days or price history to clear. Nothing was deleted.', 0); }

console.log(`Database: ${config.dbPath}\n`);
console.log('This will PERMANENTLY DELETE:');
console.log(`  - ${will.orders} order(s), with ${will.lines} item line(s), ${will.payments} payment record(s) and ${will.history} history entries`);
console.log(`  - ${will.inventoryDays} closed Daily Inventory day(s), with ${will.inventoryRecords} stock record(s)`);
console.log(keepPriceHistory ? '  (the price history is kept)' : `  - ${will.priceChanges} price history entries`);
console.log('\nThis stays exactly as it is:');
console.log(`  - ${kept.users} user account(s), ${kept.chickenProducts} chicken product(s), ${kept.otherProducts} other product(s), the current prices and the service fees`);
console.log(`  - the open business day and the stock numbers typed on it (Beginning Balance, Additional, Reject, Dead, Pull Out)`);
console.log('\nOrder numbers will start again at -001. A safety copy is saved first.\n');

let answer = given;
if (answer === null) {
  if (!process.stdin.isTTY) { db.close(); stop('This needs a person to confirm it. Run it in a terminal, or add --confirm CLEAR. Nothing was deleted.'); }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  answer = await rl.question('Type CLEAR (capital letters) to delete these records, or anything else to cancel: ');
  rl.close();
}
if (answer !== 'CLEAR') { db.close(); stop('Cancelled. Nothing was deleted.'); }

// Safety copy of the whole database (consistent, even if there are -wal files), checked before anything is deleted.
const stamp = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace(/[-:T]/g, '');
const copy = `${config.dbPath}.before-clear-${stamp}.bak`;
try {
  db.prepare('VACUUM INTO ?').run(copy);
  const check = new DatabaseSync(copy, { readOnly: true });
  const same = check.prepare('SELECT COUNT(*) AS n FROM orders').get().n === will.orders
    && check.prepare('SELECT COUNT(*) AS n FROM price_history').get().n === will.priceChanges;
  check.close();
  if (!same) throw new Error('the copy does not match the database');
} catch (err) {
  db.close();
  stop(`The safety copy could not be made (${err.message}), so nothing was deleted.`);
}

try {
  const deleted = clearRecords(db, { keepPriceHistory });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(`\nDone. Deleted ${deleted.orders} order(s)${keepPriceHistory ? '' : ` and ${deleted.priceChanges} price history entries`}.`);
  console.log(`Safety copy (everything as it was before): ${copy}`);
  console.log('Start the app again with: npm start');
} catch (err) {
  stop(`\nNothing was deleted. ${err.message}\nThe safety copy is at ${copy}`);
} finally {
  db.close();
}
