// Revision 9 acceptance tests: services, cash change, Daily Inventory, stock on New Order, Start New Business Day.
// (Revision 11 removed the Revision 9 Daily Report export from the Inventory page; its replacement, the submitted inventory file, is tested in
// tests/revision11.test.js. Closing a day now needs "Submit Inventory Today" first, which closeDay() below does.)
// Every test builds its own shop (own server, own database), so no test can disturb another and none can touch real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct, createOtherProduct } from '../src/services/catalog.js';
import { createOrder } from '../src/services/orders.js';
import { getInventory, updateRecord } from '../src/services/inventory.js';
import { computeRow, CHICKEN_COLUMNS, OTHER_COLUMNS, insufficientStockMessage } from '../shared/inventory.js';

const START = new Date('2026-10-12T02:00:00Z');   // 10:00 on Monday 12 Oct 2026 in the Philippines

let keyN = 0;
const key = () => `r9-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

function client(base) {
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', 'x-requested-with': 'pos', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.()[0];
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  };
  return { call, async login(username, password) { const r = await call('POST', '/api/login', { username, password }); assert.equal(r.status, 200, JSON.stringify(r.data)); } };
}

/** A complete little shop: three staff, two chicken products, three other products, the shop's service prices. */
async function makeShop({ file = ':memory:' } = {}) {
  const db = openDb(file);
  const clock = { now: START };
  const config = loadConfig({ dbPath: file, largeWeightKg: 50, sessionIdleMinutes: 60 * 24 * 365 });   // the tests move the clock by days
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  createUser(db, { username: 'cash2', display_name: 'Cashier Two', role: 'cashier', password: 'cashier-pass-2' });
  const whole = createProduct(db, adminUser, { name: 'Whole Chicken', price: '120' }).id;
  const cull = createProduct(db, adminUser, { name: 'Cull Chicken', price: '58' }).id;
  // Revision 10: eggs are sold by piece, carton and tray; every other product by piece, pack, sack and kg. Every product has all of them.
  const eggs = createOtherProduct(db, adminUser, { name: 'Eggs', kind: 'EGGS', prices: { piece: '10', tray: '300' } });
  const feeds = createOtherProduct(db, adminUser, { name: 'Feeds', kind: 'OTHER', prices: { sack: '1500' } });
  const garlic = createOtherProduct(db, adminUser, { name: 'Garlic', kind: 'OTHER', prices: { kg: '80' } });
  const opt = (p, unit) => ({ id: p.options.find((o) => o.unit === unit).id, product: p.id });
  const server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier, cashier2] = [client(base), client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1');
  await cashier.login('cash', 'cashier-pass-1'); await cashier2.login('cash2', 'cashier-pass-2');
  assert.equal((await admin.call('PUT', '/api/service-fees/POUR', { amount: '45', basis: 'per_head' })).status, 200);
  assert.equal((await admin.call('PUT', '/api/service-fees/NOT_POUR', { amount: '25', basis: 'per_head' })).status, 200);
  assert.equal((await admin.call('PUT', '/api/service-fees/DUKOT', { amount: '10', basis: 'per_head' })).status, 404, 'Dukot has no fee any more');

  const shop = {
    db, base, clock, config, server, admin, manager, cashier, cashier2, adminUser, whole, cull, eggs: opt(eggs, 'piece'), eggTray: opt(eggs, 'tray'), feeds: opt(feeds, 'sack'), garlic: opt(garlic, 'kg'),
    close: () => { server.close(); try { db.close(); } catch { /* already closed */ } },
    inventory: async (who = manager, query = '') => (await who.call('GET', `/api/inventory${query}`)).data,
    /** Set the numbers of one row by name ("Whole Chicken", "Eggs - piece") on the open day. */
    async set(name, fields) {
      const inv = await shop.inventory();
      const row = [...inv.chicken, ...inv.other].find((r) => r.name === name);
      assert.ok(row, `no inventory row called ${name}`);
      return manager.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, ...fields });
    },
    async row(name, query = '') { const inv = await shop.inventory(manager, query); return [...inv.chicken, ...inv.other].find((r) => r.name === name); },
    async stockUp(amounts) { for (const [name, n] of Object.entries(amounts)) { const r = await shop.set(name, { beginning: n }); assert.equal(r.status, 200, `${name}: ${JSON.stringify(r.data)}`); } },
    order: (who, items = [], other = [], extra = {}) => who.call('POST', '/api/orders', { submission_key: key(), items, other_items: other, ...extra }),
  };
  return shop;
}

const chicken = (product, heads = 1, extra = {}) => ({ product_id: product, weight: String(heads), heads, feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null, ...extra });
const otherLine = (o, quantity) => ({ other_product_id: o.product, option_id: o.id, quantity });

function readZip(buf) {
  const files = {};
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end--;
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    const csize = buf.readUInt32LE(p + 20); const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32); const off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lnlen = buf.readUInt16LE(off + 26); const lelen = buf.readUInt16LE(off + 28);
    const start = off + 30 + lnlen + lelen;
    files[name] = inflateRawSync(buf.subarray(start, start + csize)).toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return files;
}

/** True when every tag in the XML is closed in order (enough to catch a broken workbook part without an XML library). */
function wellFormed(xml) {
  const stack = [];
  for (const m of xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([A-Za-z_][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const [, closing, name, , selfClosing] = m;
    if (selfClosing) continue;
    if (closing) { if (stack.pop() !== name) return false; } else stack.push(name);
  }
  return stack.length === 0 && !/<[^>]*$/.test(xml.replace(/>[^<]*/g, '>'));
}

/** A small CSV reader (quotes, doubled quotes, CRLF), so the test proves the file parses the way Excel will read it. */
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---- Change 1: services ----------------------------------------------------------------------------------------------

test('Change 1: the seven services save, price and read back correctly; Dukot and With Blood carry no fee', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 100 });
    const cases = [
      ['LIVE', { feather: 'LIVE', cut: 'NONE', slice_size: null }, 0],
      ['POUR', { feather: 'POUR', cut: 'NONE', slice_size: null }, 4500],                            // plain Pour: the whole chicken
      ['NOT_POUR', { feather: 'NOT_POUR', cut: 'NONE', slice_size: null }, 2500],                    // plain Dress: the whole chicken
      ['POUR_SLICE', { feather: 'POUR', cut: 'SLICE', slice_size: 'MEDIUM' }, 4500],
      ['NOT_POUR_SLICE', { feather: 'NOT_POUR', cut: 'SLICE', slice_size: 'SMALL' }, 2500],
      ['POUR_DUKOT', { feather: 'POUR', cut: 'DUKOT', slice_size: null }, 4500],                     // only the Pour fee: Dukot has none
      ['NOT_POUR_DUKOT', { feather: 'NOT_POUR', cut: 'DUKOT', slice_size: null }, 2500],
      ['NOT_POUR_DUKOT', { feather: 'NOT_POUR', cut: 'DUKOT', slice_size: null, dara: true }, 2500], // With Blood adds nothing either
    ];
    const saved = [];
    for (const [service, prep, fee] of cases) {
      const r = await shop.order(shop.cashier, [chicken(shop.whole, 1, prep)]);
      assert.equal(r.status, 201, `${service}: ${JSON.stringify(r.data)}`);
      const item = r.data.order.items[0];
      assert.equal(item.service, service);
      assert.equal(item.service_fee_centavos, fee, service);
      assert.equal(r.data.order.total_centavos, 12000 + fee, service);
      const again = (await shop.cashier.call('GET', `/api/orders/${r.data.order.id}`)).data.order.items[0];
      assert.deepEqual([again.service, again.feather, again.cut, again.slice_size], [service, prep.feather, prep.cut, prep.slice_size]);
      saved.push(r.data.order.order_number);
    }
    // conflicting choices are still refused: a slice without a size, a size on a whole or Dukot chicken, cutting on a live one
    for (const bad of [{ feather: 'POUR', cut: 'SLICE', slice_size: null }, { feather: 'NOT_POUR', cut: 'NONE', slice_size: 'SMALL' },
      { feather: 'POUR', cut: 'DUKOT', slice_size: 'SMALL' }, { feather: 'LIVE', cut: 'DUKOT', slice_size: null }, { feather: 'LIVE', cut: 'NONE', slice_size: null, dara: true }]) {
      const r = await shop.order(shop.cashier, [chicken(shop.whole, 1, bad)]);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    // the exported order list names them the way the cashier picked them
    const names = ['Live', 'Pour', 'Dress', 'Po-ur & Slice', 'Dress & Slice', 'Pour & Dukot', 'Dress & Dukot', 'Dress & Dukot'];
    const csv = parseCsv((await shop.manager.call('GET', '/api/export.csv')).data.toString('utf8').replace(/^﻿/, ''));
    const sIdx = csv[0].indexOf('Service');
    const nIdx = csv[0].indexOf('Order Number');
    const byOrder = Object.fromEntries(csv.slice(1).filter((r) => saved.includes(r[nIdx])).map((r) => [r[nIdx], r[sIdx]]));
    assert.deepEqual(saved.map((n) => byOrder[n]), names);
    // the Excel export (every detail) says With Blood, never Dara
    const tx = readZip((await shop.manager.call('GET', '/api/export.xlsx')).data)['xl/worksheets/sheet1.xml'];
    assert.ok(tx.includes('With Blood') && !tx.includes('Dara'), 'the export says With Blood');
  } finally { shop.close(); }
});

// ---- Change 2: cash change -------------------------------------------------------------------------------------------

test('Change 2: Amount Paid ₱456.00 and Money Received ₱1,000.00 give Change ₱544.00, saved with the order', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 50 });
    const r = await shop.order(shop.cashier, [chicken(shop.whole, 1, { weight: '3.8' })], [], { payment: { method: 'CASH', amount: '456', received: '1000' } });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(r.data.order.total_centavos, 45600);
    const p = r.data.order.payments[0];
    assert.deepEqual([p.method, p.amount_centavos, p.received_centavos, p.change_centavos], ['CASH', 45600, 100000, 54400]);
    const saved = (await shop.manager.call('GET', `/api/orders/${r.data.order.id}`)).data.order;
    assert.equal(saved.payments[0].amount_centavos, saved.total_centavos, 'what is saved matches the final order amount');
    const row = shop.db.prepare('SELECT amount_centavos, received_centavos, change_centavos FROM payments WHERE order_id = ?').get(r.data.order.id);
    assert.deepEqual({ ...row }, { amount_centavos: 45600, received_centavos: 100000, change_centavos: 54400 });
  } finally { shop.close(); }
});

test('Change 2: exact payment gives ₱0.00 change, overpayment the right change, and centavos are exact', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 50 });
    const pay = async (received) => {
      const r = await shop.order(shop.cashier, [chicken(shop.whole, 1, { weight: '3.8' })], [], { payment: { method: 'CASH', received } });
      assert.equal(r.status, 201, `${received}: ${JSON.stringify(r.data)}`);
      return r.data.order.payments[0];
    };
    assert.equal((await pay('456')).change_centavos, 0);
    assert.equal((await pay('456.00')).change_centavos, 0);
    assert.equal((await pay('500')).change_centavos, 4400);
    assert.equal((await pay('456.01')).change_centavos, 1);
    assert.equal((await pay('1000.50')).change_centavos, 54450);
    // the server is strict ("1,5" could mean 1.5 or 15), so the screen removes thousands commas ("1,000") before it sends the number
    const comma = await shop.order(shop.cashier, [chicken(shop.whole, 1, { weight: '3.8' })], [], { payment: { method: 'CASH', received: '1,000' } });
    assert.equal(comma.status, 400);
  } finally { shop.close(); }
});

test('Change 2: insufficient, blank, invalid and negative values are refused or handled safely, and nothing is saved', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 50 });
    const before = shop.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
    const refused = async (payment, pattern, label) => {
      const r = await shop.order(shop.cashier, [chicken(shop.whole, 1, { weight: '3.8' })], [], { payment });
      assert.equal(r.status, 400, `${label}: ${JSON.stringify(r.data)}`);
      assert.match(JSON.stringify(r.data), pattern, label);
    };
    await refused({ method: 'CASH', received: '400' }, /Insufficient payment/, 'money received below the amount');
    await refused({ method: 'CASH', amount: '400', received: '1000' }, /Insufficient payment/, 'amount paid below the order total');
    await refused({ method: 'CASH', amount: '500', received: '1000' }, /more than the order total/, 'amount paid above the order total');
    await refused({ method: 'CASH', received: '-5' }, /Money received/, 'negative');
    await refused({ method: 'CASH', received: '0' }, /Money received/, 'zero');
    await refused({ method: 'CASH', received: 'abc' }, /Money received/, 'letters');
    await refused({ method: 'CASH', received: '1e3' }, /Money received/, 'exponent');
    await refused({ method: 'CASH', received: '12.345' }, /Money received/, 'fractions of a centavo');
    await refused({ method: 'CASH', amount: '-456', received: '1000' }, /Payment amount/, 'negative amount');
    await refused({ method: 'GCASH', received: '1000' }, /only for cash/, 'money received on a non-cash method');
    await refused({ method: 'MAYA', received: '1000' }, /only for cash/, 'money received on Maya');
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, before, 'not one refused order was saved');
    // blank Money received on cash is allowed at the API (the screen asks for it); nothing is invented
    const blank = await shop.order(shop.cashier, [chicken(shop.whole, 1, { weight: '3.8' })], [], { payment: { method: 'CASH', received: '' } });
    assert.equal(blank.status, 201);
    assert.deepEqual([blank.data.order.payments[0].received_centavos, blank.data.order.payments[0].change_centavos], [null, null]);
    // other methods still save as before, with no cash fields
    const gcash = await shop.order(shop.cashier, [chicken(shop.whole, 1, { weight: '3.8' })], [], { payment: { method: 'GCASH', reference: 'R1' } });
    assert.equal(gcash.status, 201);
    assert.deepEqual([gcash.data.order.payments[0].amount_centavos, gcash.data.order.payments[0].received_centavos, gcash.data.order.payments[0].change_centavos], [45600, null, null]);
  } finally { shop.close(); }
});

test('Change 2: the database itself refuses a cash change that does not add up', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 50 });
    const r = await shop.order(shop.cashier, [chicken(shop.whole, 1, { weight: '3.8' })]);
    const insert = (method, amount, received, change) => shop.db.prepare(`INSERT INTO payments (order_id, method, amount_centavos, received_centavos, change_centavos, recorded_by, recorded_at)
      VALUES (?,?,?,?,?,1,'2026-10-12T02:00:00Z')`).run(r.data.order.id, method, amount, received, change);
    assert.throws(() => insert('CASH', 45600, 100000, 50000), /change|CHECK|constraint/i);   // 1000 - 456 is not 500
    assert.throws(() => insert('CASH', 45600, 40000, 0), /change|CHECK|constraint/i);        // received less than paid
    assert.throws(() => insert('GCASH', 45600, 100000, 54400), /change|CHECK|constraint/i);  // cash fields on a non-cash method
    insert('CASH', 45600, 100000, 54400);
  } finally { shop.close(); }
});

// ---- Change 3: Daily Inventory ---------------------------------------------------------------------------------------

test('Change 3: the columns are in the required order and the formulas give 100, 20, 120, 35, 85, 2, 1, 5, 77', async () => {
  // Revision 11 adds Katay between Reject and Dead (0 here, so the Revision 9 example is unchanged).
  assert.deepEqual(CHICKEN_COLUMNS, ['Chicken Category', 'Beginning Balance', 'Additional', 'Total', 'Sold', 'Left', 'Reject', 'Katay', 'Dead', 'Pull Out', 'New Total']);
  assert.deepEqual(OTHER_COLUMNS, ['Product Name', 'Beginning Balance', 'Additional', 'Total', 'Sold', 'Left', 'New Total']);
  assert.deepEqual(computeRow('CHICKEN', { beginning: 100, additional: 20, reject: 2, katay: 0, dead: 1, pull_out: 5 }, 35), { total: 120, sold: 35, left: 85, new_total: 77 });
  assert.deepEqual(computeRow('OTHER', { beginning: 20, additional: 5, reject: 9, dead: 9, pull_out: 9 }, 10), { total: 25, sold: 10, left: 15, new_total: 15 }, 'other products have no Reject, Dead or Pull Out');

  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 100 });
    assert.equal((await shop.set('Whole Chicken', { additional: 20 })).status, 200);
    for (const heads of [10, 10, 10, 5]) assert.equal((await shop.order(shop.cashier, [chicken(shop.whole, heads)])).status, 201);   // 35 heads sold in four orders
    assert.equal((await shop.set('Whole Chicken', { reject: 2, dead: 1, pull_out: 5 })).status, 200);
    const row = await shop.row('Whole Chicken');
    assert.deepEqual([row.beginning, row.additional, row.total, row.sold, row.left, row.reject, row.dead, row.pull_out, row.new_total].map((m) => m / 1000), [100, 20, 120, 35, 85, 2, 1, 5, 77]);
    assert.equal(row.unit, 'heads');
    // Reject, Dead and Pull Out are adjustments, not sales: Sold is still 35
    assert.equal(row.sold / 1000, 35);
    const inv = await shop.inventory();
    assert.ok(inv.chicken.every((r) => 'reject' in r && 'dead' in r && 'pull_out' in r));
    assert.ok(inv.other.every((r) => r.reject === null && r.dead === null && r.pull_out === null), 'other products have no Reject, Dead or Pull Out');
  } finally { shop.close(); }
});

test('Change 3: other products have no adjustment columns and New Total equals Left', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Eggs - piece': 20, 'Feeds - sack': 15 });
    assert.equal((await shop.set('Eggs - piece', { additional: 10 })).status, 200);
    assert.equal((await shop.order(shop.cashier, [], [otherLine(shop.eggs, 12)])).status, 201);
    const eggs = await shop.row('Eggs - piece');
    assert.deepEqual([eggs.beginning, eggs.additional, eggs.total, eggs.sold, eggs.left, eggs.new_total].map((m) => m / 1000), [20, 10, 30, 12, 18, 18]);
    assert.equal(eggs.new_total, eggs.left);
    for (const f of ['reject', 'katay', 'dead', 'pull_out']) {
      const r = await shop.set('Eggs - piece', { [f]: 1 });
      assert.equal(r.status, 400, f);
    }
    // stock is counted in whole units (Revision 11: also for products sold by the kilo, which are counted in pieces; there is no kg row)
    assert.equal((await shop.set('Feeds - sack', { additional: 1.5 })).status, 400);
    assert.equal(await shop.row('Garlic - kg'), undefined);
    assert.equal((await shop.set('Garlic - piece', { beginning: 12.5 })).status, 400);
    assert.equal((await shop.set('Garlic - piece', { beginning: 12 })).status, 200);
    assert.equal((await shop.row('Garlic - piece')).beginning, 12000);
  } finally { shop.close(); }
});

test('Change 3: numbers are checked on the server - negative, blank, text, decimals for heads, and losses above what is left', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 10 });
    for (const bad of [-1, 'abc', '1e2', 2.5, '', null, '1,5']) {
      const r = await shop.set('Whole Chicken', { additional: bad });
      assert.equal(r.status, 400, `additional ${JSON.stringify(bad)}: ${JSON.stringify(r.data)}`);
    }
    assert.equal((await shop.order(shop.cashier, [chicken(shop.whole, 4)])).status, 201);          // 4 sold, 6 left
    const tooMany = await shop.set('Whole Chicken', { reject: 3, dead: 3, pull_out: 1 });          // 7 > 6 left
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /cannot be more than what is left/);
    assert.equal((await shop.set('Whole Chicken', { reject: 3, dead: 2, pull_out: 1 })).status, 200);   // 6 = 6 left: allowed
    assert.equal((await shop.row('Whole Chicken')).new_total, 0);
    // the Beginning Balance cannot be lowered below what is already sold
    const low = await shop.set('Whole Chicken', { beginning: 3 });
    assert.equal(low.status, 400);
    // nothing to change, and an unknown row
    assert.equal((await shop.set('Whole Chicken', {})).status, 400);
    assert.equal((await shop.manager.call('PATCH', '/api/inventory/records/99999', { rev: 0, additional: 1 })).status, 404);
    // the database refuses a negative figure even if the app were bypassed
    assert.throws(() => shop.db.prepare('UPDATE inventory_records SET reject_milli = -1').run(), /CHECK|constraint|negative/i);
  } finally { shop.close(); }
});

test('Change 3: viewing is for everyone signed in; typing numbers is for managers and the admin; a stale screen cannot overwrite a newer number', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.cashier.call('GET', '/api/inventory')).status, 200);
    const inv = await shop.inventory(shop.cashier);
    assert.deepEqual([inv.can_edit, inv.can_close], [false, false]);
    const row = inv.chicken[0];
    assert.equal((await shop.cashier.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, additional: 5 })).status, 403);
    assert.equal((await shop.cashier.call('GET', '/api/inventory/close-check')).status, 403);
    assert.equal((await shop.cashier.call('POST', '/api/inventory/close-day', { business_date: '2026-10-12' })).status, 403);
    const anon = client(shop.base);
    assert.equal((await anon.call('GET', '/api/inventory')).status, 401);
    assert.equal((await anon.call('GET', '/api/inventory/day.xlsx?date=2026-10-12')).status, 401);
    assert.equal((await shop.cashier.call('POST', '/api/inventory/submit', { business_date: '2026-10-12' })).status, 403);

    const m = await shop.inventory(shop.manager);
    assert.deepEqual([m.can_edit, m.can_close], [true, true]);
    const stale = m.chicken[0];
    assert.equal((await shop.manager.call('PATCH', `/api/inventory/records/${stale.id}`, { rev: stale.rev, beginning: 10 })).status, 200);
    const again = await shop.admin.call('PATCH', `/api/inventory/records/${stale.id}`, { rev: stale.rev, beginning: 99 });   // the old rev
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'CONFLICT');
    assert.equal((await shop.row(stale.name)).beginning, 10000, 'the newer number was kept');
    // every change is written to an append-only log
    const log = shop.db.prepare('SELECT * FROM inventory_events ORDER BY id').all();
    assert.ok(log.length >= 1 && log[0].field === 'beginning' && log[0].new_milli === 10000);
    assert.throws(() => shop.db.prepare('UPDATE inventory_events SET new_milli = 1').run(), /cannot be changed/);
    assert.throws(() => shop.db.prepare('DELETE FROM inventory_events').run(), /cannot be deleted/);
  } finally { shop.close(); }
});

test('Change 3: one record per product and business day - a duplicate is refused by the database', async () => {
  const shop = await makeShop();
  try {
    const inv = await shop.inventory();
    const row = inv.chicken[0];
    const rec = shop.db.prepare('SELECT * FROM inventory_records WHERE id = ?').get(row.id);
    assert.throws(() => shop.db.prepare(`INSERT INTO inventory_records (business_day_id, kind, product_id, beginning_milli, updated_at) VALUES (?, 'CHICKEN', ?, 0, 'x')`)
      .run(rec.business_day_id, rec.product_id), /UNIQUE/i);
    // asking for the screen many times never makes extra records
    const count = () => shop.db.prepare('SELECT COUNT(*) AS n FROM inventory_records').get().n;
    const n = count();
    for (let i = 0; i < 5; i++) await shop.inventory();
    assert.equal(count(), n);
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM business_days WHERE status = 'OPEN'").get().n, 1);
    assert.throws(() => shop.db.prepare("INSERT INTO business_days (business_date, status, opened_at) VALUES ('2030-01-01', 'OPEN', 'x')").run(), /UNIQUE|one open/i, 'only one business day can be open');
  } finally { shop.close(); }
});

test('Change 3: the saved numbers survive a restart, and the Beginning Balance can be typed in once when there is no earlier record', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r9-'));
  const file = path.join(dir, 'pos.db');
  const shop = await makeShop({ file });
  try {
    const first = await shop.set('Whole Chicken', { beginning: 42, additional: 8 });
    assert.equal(first.status, 200);
    assert.equal(first.data.row.beginning_editable, true, 'no earlier record, so it can be typed in');
  } finally { shop.close(); }
  const db = openDb(file);                       // the app starts again on the same file
  try {
    const admin = db.prepare("SELECT * FROM users WHERE username = 'owner'").get();
    const inv = getInventory(db, admin, {}, START);
    const row = inv.chicken.find((r) => r.name === 'Whole Chicken');
    assert.deepEqual([row.beginning, row.additional, row.total, row.new_total].map((m) => m / 1000), [42, 8, 50, 50]);
    assert.equal(inv.day.business_date, '2026-10-12');
  } finally { db.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Change 4: stock on New Order ------------------------------------------------------------------------------------

test('Change 4: the New Order screen reads the same stock numbers as the Daily Inventory (one source)', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 12, 'Cull Chicken': 7, 'Eggs - piece': 20, 'Feeds - sack': 15 });
    assert.equal((await shop.order(shop.cashier, [chicken(shop.whole, 2)], [otherLine(shop.eggs, 5)])).status, 201);
    const cfg = (await shop.cashier.call('GET', '/api/config')).data;
    assert.deepEqual(cfg.stock.chicken_heads, { [shop.whole]: 10, [shop.cull]: 7 });
    assert.equal(cfg.stock.other_milli[shop.eggs.id], 15000);
    assert.equal(cfg.stock.other_milli[shop.feeds.id], 15000);
    assert.equal(cfg.stock.business_date, '2026-10-12');
    const inv = await shop.inventory();
    for (const r of inv.chicken) assert.equal(cfg.stock.chicken_heads[r.item_id], Math.max(r.new_total, 0) / 1000, r.name);
    for (const r of inv.other) assert.equal(cfg.stock.other_milli[r.item_id], Math.max(r.new_total, 0), r.name);
    // a product nobody has typed a Beginning Balance for has no stock, so it cannot be sold. Garlic by the kilo is counted on its piece row.
    const garlicPiece = cfg.stock.other_stock_of[shop.garlic.id];
    assert.ok(garlicPiece, 'the kg option points to the piece row');
    assert.equal(cfg.stock.other_milli[garlicPiece], 0);
    assert.equal(cfg.stock.other_milli[shop.garlic.id], undefined, 'kg has no stock of its own');
  } finally { shop.close(); }
});

test('Change 4: "Insufficient stock. Only 3 heads of Whole Chicken are available." - exact wording, nothing saved', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 3, 'Eggs - piece': 20, 'Feeds - sack': 15 });
    const r = await shop.order(shop.cashier, [chicken(shop.whole, 4)]);
    assert.equal(r.status, 409);
    assert.equal(r.data.code, 'INSUFFICIENT_STOCK');
    assert.equal(r.data.error, 'Insufficient stock. Only 3 heads of Whole Chicken are available.');
    assert.equal(insufficientStockMessage('CHICKEN', 'Whole Chicken', 'heads', 3000), 'Insufficient stock. Only 3 heads of Whole Chicken are available.');
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
    const eggs = await shop.order(shop.cashier, [], [otherLine(shop.eggs, 21)]);
    assert.equal(eggs.status, 409);
    assert.equal(eggs.data.error, 'Insufficient stock. Only 20 pieces of Eggs are available.');
    const feeds = await shop.order(shop.cashier, [], [otherLine(shop.feeds, 16)]);
    assert.equal(feeds.data.error, 'Insufficient stock. Only 15 sacks of Feeds are available.');
    assert.equal((await shop.order(shop.cashier, [chicken(shop.whole, 3)], [otherLine(shop.eggs, 20), otherLine(shop.feeds, 15)])).status, 201, 'exactly what is in stock can be sold');
    const none = await shop.order(shop.cashier, [chicken(shop.whole, 1)]);
    assert.equal(none.data.error, 'Insufficient stock. Only 0 heads of Whole Chicken are available.');
  } finally { shop.close(); }
});

test('Change 4: invalid and non-positive quantities are rejected, and several lines of one product are added up before the check', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 5, 'Eggs - piece': 10 });
    for (const heads of [0, -1, 1.5, 'abc', null, 1000]) {
      const r = await shop.order(shop.cashier, [chicken(shop.whole, heads, { heads })]);
      assert.equal(r.status, 400, `heads ${JSON.stringify(heads)}`);
    }
    for (const q of ['0', '-3', 'abc', '2.5', '']) {
      const r = await shop.order(shop.cashier, [], [otherLine(shop.eggs, q)]);
      assert.equal(r.status, 400, `eggs ${JSON.stringify(q)}`);
    }
    // two lines of the same product: 3 + 3 asks for 6 of 5
    const split = await shop.order(shop.cashier, [chicken(shop.whole, 3), chicken(shop.whole, 3)]);
    assert.equal(split.status, 409);
    assert.match(split.data.error, /Only 5 heads of Whole Chicken/);
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
  } finally { shop.close(); }
});

test('Change 4: simultaneous orders cannot oversell - 8 cashiers racing for 5 heads get exactly 5', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 5, 'Eggs - piece': 3 });
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => shop.order(i % 2 ? shop.cashier : shop.cashier2, [chicken(shop.whole, 1)], [otherLine(shop.eggs, 1)])));
    const ok = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 3, 'the eggs run out first (3 pieces)');
    assert.equal(refused.length, 5);
    assert.ok(refused.every((r) => r.data.code === 'INSUFFICIENT_STOCK'));
    const heads = await shop.row('Whole Chicken');
    assert.deepEqual([heads.sold / 1000, heads.new_total / 1000], [3, 2]);
    assert.equal((await shop.row('Eggs - piece')).new_total, 0);
    // and racing for heads alone
    const more = await Promise.all(Array.from({ length: 6 }, () => shop.order(shop.cashier, [chicken(shop.whole, 1)])));
    assert.equal(more.filter((r) => r.status === 201).length, 2);
    assert.equal((await shop.row('Whole Chicken')).new_total, 0);
  } finally { shop.close(); }
});

test('Change 4: two programs using the same database file cannot both be given the last chicken', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r9-'));
  const file = path.join(dir, 'pos.db');
  const a = openDb(file);
  const admin = createUser(a, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  const cull = createProduct(a, admin, { name: 'Cull Chicken', price: '58' }).id;
  const b = openDb(file);                                   // a second connection, as a second program or a second cashier PC would be
  const config = loadConfig({ dbPath: file });
  const inv = getInventory(a, admin, {}, START);
  updateRecord(a, admin, inv.chicken[0].id, { rev: inv.chicken[0].rev, beginning: 5 }, START);
  const line = (n) => [{ product_id: cull, weight: String(n), heads: n, feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null }];
  const order = (db, n) => createOrder(db, admin, { submission_key: key(), items: line(n) }, { config, now: START });
  order(a, 3);
  assert.throws(() => order(b, 3), (err) => err.status === 409 && err.message === 'Insufficient stock. Only 2 heads of Cull Chicken are available.');
  order(b, 2);
  assert.throws(() => order(a, 1), (err) => err.status === 409);
  assert.equal(a.prepare('SELECT SUM(heads) AS n FROM order_items').get().n, 5);
  a.close(); b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Change 4: stock policy - Ongoing, Standby and Complete all count as sold once; cancel and change free the stock; a refund does not; nothing is deducted twice', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 10, 'Eggs - piece': 10 });
    const sold = async () => (await shop.row('Whole Chicken')).sold / 1000;
    const left = async () => (await shop.row('Whole Chicken')).new_total / 1000;
    const a = (await shop.order(shop.cashier, [chicken(shop.whole, 2)], [otherLine(shop.eggs, 2)])).data.order;
    assert.deepEqual([await sold(), await left()], [2, 8], 'saved as Ongoing: counted at once');
    for (const status of ['STANDBY', 'COMPLETE', 'ONGOING', 'STANDBY']) {
      assert.equal((await shop.cashier.call('POST', `/api/orders/${a.id}/fulfillment`, { status })).status, 200);
      assert.deepEqual([await sold(), await left()], [2, 8], `moving the card to ${status} changes nothing`);
    }
    // a repeated submission (double click) with the same key is the same order, not a second deduction
    const key1 = key();
    const first = await shop.cashier.call('POST', '/api/orders', { submission_key: key1, items: [chicken(shop.whole, 1)] });
    const second = await shop.cashier.call('POST', '/api/orders', { submission_key: key1, items: [chicken(shop.whole, 1)] });
    assert.deepEqual([first.status, second.status, second.data.duplicate], [201, 200, true]);
    assert.equal(await sold(), 3);

    // cancel, and the chicken can go back: stock is free again
    const b = (await shop.order(shop.cashier, [chicken(shop.whole, 4)])).data.order;
    assert.equal(await left(), 3);
    assert.equal((await shop.cashier.call('POST', `/api/orders/${b.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND', stock_returnable: true })).status, 200);
    assert.deepEqual([await sold(), await left()], [3, 7]);
    // cancel, and the chicken cannot go back (burned / dressed): not sold any more, so the heads are recorded as Reject and the New Total does not rise
    const c = (await shop.order(shop.cashier, [chicken(shop.whole, 2)])).data.order;
    assert.equal(await left(), 5);
    assert.equal((await shop.cashier.call('POST', `/api/orders/${c.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND', stock_returnable: false })).status, 200);
    const afterReject = await shop.row('Whole Chicken');
    assert.deepEqual([afterReject.sold / 1000, afterReject.reject / 1000, afterReject.new_total / 1000], [3, 2, 5]);
    // a second cancel is refused, so the stock cannot be freed twice
    assert.equal((await shop.cashier.call('POST', `/api/orders/${c.id}/cancel`, { reason_code: 'WRONG_WEIGHT', stock_returnable: false })).status, 409);
    assert.equal((await shop.row('Whole Chicken')).reject / 1000, 2);
    // a refund is money only: the order stays sold and nothing goes back
    const d = (await shop.order(shop.cashier, [chicken(shop.whole, 1)])).data.order;
    assert.equal(await left(), 4);
    assert.equal((await shop.manager.call('POST', `/api/orders/${d.id}/refund`, { reason_code: 'CUSTOMER_NOT_SATISFIED' })).status, 200);
    assert.deepEqual([await sold(), await left()], [4, 4]);
    // changing an order replaces it: the original stops counting, the replacement counts, so a same-size change needs no extra stock
    await shop.stockUp({});
    const e = (await shop.order(shop.cashier, [chicken(shop.whole, 4)])).data.order;
    assert.equal(await left(), 0);
    const change = await shop.cashier.call('POST', `/api/orders/${e.id}/change`, { submission_key: key(), reason_code: 'WRONG_WEIGHT', items: [chicken(shop.whole, 4, { weight: '4.2' })] });
    assert.equal(change.status, 201, JSON.stringify(change.data));
    assert.deepEqual([await sold(), await left()], [8, 0], 'replaced: 4 heads counted once, not twice');
    const tooBig = await shop.cashier.call('POST', `/api/orders/${change.data.order.id}/change`, { submission_key: key(), reason_code: 'WRONG_WEIGHT', items: [chicken(shop.whole, 5)] });
    assert.equal(tooBig.status, 409);
    assert.match(tooBig.data.error, /Only 4 heads of Whole Chicken/, 'the order being replaced counts as free, nothing more');
    assert.equal((await shop.cashier.call('GET', `/api/orders/${change.data.order.id}`)).data.order.status, 'COMPLETED', 'the failed change left the order alone');
  } finally { shop.close(); }
});

// ---- A busy day (the Revision 9 Daily Report export it was made for was removed in Revision 11; its file is tested in revision11.test.js) ----

async function busyDay(shop) {
  await shop.stockUp({ 'Whole Chicken': 100, 'Cull Chicken': 30, 'Eggs - piece': 50, 'Feeds - sack': 15 });
  await shop.set('Whole Chicken', { additional: 20 });
  const o1 = await shop.order(shop.cashier, [chicken(shop.whole, 10, { feather: 'POUR', cut: 'SLICE', slice_size: 'LARGE' })], [otherLine(shop.eggs, 12)], { customer_number: 'C-1', payment: { method: 'CASH', received: '5000' } });
  const o2 = await shop.order(shop.cashier2, [chicken(shop.whole, 25)], [], { customer_number: 'Aling Rosa' });
  const o3 = await shop.order(shop.manager, [chicken(shop.cull, 3, { feather: 'NOT_POUR', cut: 'DUKOT', slice_size: null })], [otherLine(shop.feeds, 2)], { payment: { method: 'GCASH', reference: 'GC-1' } });
  for (const r of [o1, o2, o3]) assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await shop.manager.call('POST', `/api/orders/${o3.data.order.id}/fulfillment`, { status: 'COMPLETE' })).status, 200);
  assert.equal((await shop.set('Whole Chicken', { reject: 2, dead: 1, pull_out: 5 })).status, 200);
  return { o1: o1.data.order, o2: o2.data.order, o3: o3.data.order };
}

// ---- Change 6: Start New Business Day --------------------------------------------------------------------------------

// Revision 11: a day is closed in two steps, "Submit Inventory Today" and then "Closed Inventory Today and Reset the Day".
const submitDay = (shop, date, who = shop.manager) => who.call('POST', '/api/inventory/submit', { business_date: date });
const closeDay = async (shop, date, who = shop.manager) => {
  await submitDay(shop, date, who);   // refused (and harmless) when the day is not the open day or does not add up; the close then says why
  return who.call('POST', '/api/inventory/close-day', { business_date: date });
};

test('Change 6: an Ongoing order blocks the reset and says why; Standby and Complete do not block (Standby carries over with a notice)', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 20 });
    const a = (await shop.order(shop.cashier, [chicken(shop.whole, 2)])).data.order;
    const b = (await shop.order(shop.cashier, [chicken(shop.whole, 3)])).data.order;
    let check = (await shop.manager.call('GET', '/api/inventory/close-check')).data;
    assert.equal(check.can_close, false);
    assert.equal(check.blockers[0].code, 'ONGOING_ORDERS');
    assert.deepEqual(check.blockers[0].orders.sort(), [a.order_number, b.order_number].sort());
    assert.match(check.blockers[0].message, /Ongoing/);
    const blocked = await closeDay(shop, '2026-10-12');
    assert.equal(blocked.status, 409);
    assert.equal(blocked.data.code, 'ONGOING_ORDERS');
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM business_days").get().n, 1, 'blocked: no new day, nothing changed');
    assert.equal(shop.db.prepare("SELECT status FROM business_days").get().status, 'OPEN');

    await shop.cashier.call('POST', `/api/orders/${a.id}/fulfillment`, { status: 'STANDBY' });
    await shop.cashier.call('POST', `/api/orders/${b.id}/fulfillment`, { status: 'COMPLETE' });
    assert.equal((await submitDay(shop, '2026-10-12')).status, 201);
    check = (await shop.manager.call('GET', '/api/inventory/close-check')).data;
    assert.equal(check.can_close, true);
    assert.deepEqual(check.blockers, []);
    assert.equal(check.notices[0].code, 'STANDBY_ORDERS');
    assert.equal(check.notices[0].count, 1);
  } finally { shop.close(); }
});

test('Change 6: confirming closes the day, carries New Total into the next Beginning Balance, zeroes the counters and keeps every record', async () => {
  const shop = await makeShop();
  try {
    await busyDay(shop);
    for (const o of shop.db.prepare("SELECT id FROM orders WHERE fulfillment_status = 'ONGOING'").all()) await shop.manager.call('POST', `/api/orders/${o.id}/fulfillment`, { status: 'STANDBY' });
    const before = await shop.inventory();
    const ordersBefore = shop.db.prepare('SELECT * FROM orders ORDER BY id').all();
    const productsBefore = JSON.stringify(shop.db.prepare('SELECT * FROM products ORDER BY id').all());

    shop.clock.now = new Date('2026-10-13T01:00:00Z');                      // the next morning, 09:00
    const stale = (await shop.inventory()).day;
    assert.deepEqual([stale.business_date, stale.stale], ['2026-10-12', true], 'the screen says the open day is yesterday\'s');
    const r = await closeDay(shop, '2026-10-12');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual([r.data.closed.business_date, r.data.closed.status, r.data.opened.business_date, r.data.opened.status], ['2026-10-12', 'CLOSED', '2026-10-13', 'OPEN']);
    assert.equal(r.data.standby_orders, 2, 'two Standby orders carry over (the third order is Complete)');

    const now = await shop.inventory();
    assert.equal(now.day.business_date, '2026-10-13');
    const w = now.chicken.find((x) => x.name === 'Whole Chicken');
    assert.deepEqual([w.beginning, w.additional, w.total, w.sold, w.left, w.reject, w.dead, w.pull_out, w.new_total].map((m) => m / 1000), [77, 0, 77, 0, 77, 0, 0, 0, 77], 'yesterday\'s New Total is today\'s Beginning Balance; the counters start at zero');
    for (const row of [...now.chicken, ...now.other]) {
      const was = [...before.chicken, ...before.other].find((x) => x.name === row.name);
      assert.equal(row.beginning, was.new_total, `${row.name}: Beginning = previous New Total`);
      assert.deepEqual([row.additional, row.sold], [0, 0], row.name);
      assert.equal(row.beginning_editable, true, 'a carried Beginning Balance can now be corrected (with a reason) by a manager or admin');
      assert.equal(row.beginning_carried, true);
    }
    // history is preserved: the closed day is still there with its numbers
    const old = await shop.inventory(shop.manager, '?date=2026-10-12');
    assert.equal(old.day.status, 'CLOSED');
    assert.equal(old.can_edit, false);
    for (const row of [...old.chicken, ...old.other]) {
      const was = [...before.chicken, ...before.other].find((x) => x.name === row.name);
      assert.deepEqual([row.beginning, row.additional, row.sold, row.new_total], [was.beginning, was.additional, was.sold, was.new_total], row.name);
    }
    // a closed day can be exported later, from its frozen figures (Revision 12: the Export button beside "Closed")
    const exported = readZip((await shop.manager.call('GET', '/api/inventory/day.xlsx?date=2026-10-12')).data);
    const closedSheet = exported['xl/worksheets/sheet1.xml'];
    const wholeRow = [...closedSheet.matchAll(/<row r="\d+"[^>]*>(.*?)<\/row>/g)].map((m) => m[1]).find((r2) => r2.includes('>Whole Chicken<'));
    assert.ok(wholeRow, 'the closed day is in the export');
    assert.deepEqual([...wholeRow.matchAll(/<v>([\d.]+)<\/v>/g)].map((m) => Number(m[1])), [100, 20, 120, 35, 85, 2, 0, 1, 5, 77], 'Beginning ... Reject, Katay, Dead, Pull Out, New Total');
    // orders, products and payments are untouched; the Standby orders are still on the Order List
    assert.equal(JSON.stringify(shop.db.prepare('SELECT * FROM orders ORDER BY id').all()), JSON.stringify(ordersBefore));
    assert.equal(JSON.stringify(shop.db.prepare('SELECT * FROM products ORDER BY id').all()), productsBefore);
    const board = (await shop.cashier.call('GET', '/api/board')).data.orders;
    assert.equal(board.filter((o) => o.fulfillment_status === 'STANDBY').length, 2);
    // the new day sells from the carried balance; the old day's sold figure does not move
    assert.equal((await shop.order(shop.cashier, [chicken(shop.whole, 7)])).status, 201);
    assert.equal((await shop.row('Whole Chicken')).sold, 7000);
    assert.equal((await shop.row('Whole Chicken', '?date=2026-10-12')).sold, 35000);
    // closed days cannot be edited
    const oldRow = old.chicken[0];
    const edit = await shop.manager.call('PATCH', `/api/inventory/records/${oldRow.id}`, { rev: (await shop.row(oldRow.name, '?date=2026-10-12')).rev, additional: 1 });
    assert.equal(edit.status, 409);
    assert.equal(edit.data.code, 'DAY_CLOSED');
    assert.throws(() => shop.db.prepare("UPDATE inventory_records SET additional_milli = 1 WHERE id = ?").run(oldRow.id), /closed/i);
    assert.throws(() => shop.db.prepare("DELETE FROM inventory_records WHERE id = ?").run(oldRow.id), /closed/i);
  } finally { shop.close(); }
});

test('Change 6: a second click, a second person, or a second request cannot reset twice', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 10 });
    const results = await Promise.all([closeDay(shop, '2026-10-12'), closeDay(shop, '2026-10-12', shop.admin), closeDay(shop, '2026-10-12')]);
    assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409 && r.data.code === 'ALREADY_CLOSED'));
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM business_days').get().n, 2, 'exactly one new day');
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM business_days WHERE status = 'OPEN'").get().n, 1);
    // the new (open) day is not closed by a late repeat of the old request
    const late = await closeDay(shop, '2026-10-12');
    assert.equal(late.status, 409);
    assert.equal(shop.db.prepare("SELECT status FROM business_days ORDER BY id DESC").get().status, 'OPEN');
    // the day being closed must be named
    assert.equal((await shop.manager.call('POST', '/api/inventory/close-day', {})).status, 400);
    assert.equal((await closeDay(shop, '2030-01-01')).status, 400);
    // no duplicate inventory records for the new day
    const dup = shop.db.prepare('SELECT business_day_id, product_id, COUNT(*) AS n FROM inventory_records WHERE product_id IS NOT NULL GROUP BY 1, 2 HAVING n > 1').all();
    assert.deepEqual(dup, []);
  } finally { shop.close(); }
});

test('Change 6: if the reset fails half way, nothing is changed (all or nothing)', async () => {
  const shop = await makeShop();
  try {
    await busyDay(shop);
    for (const o of shop.db.prepare("SELECT id FROM orders WHERE fulfillment_status = 'ONGOING'").all()) await shop.manager.call('POST', `/api/orders/${o.id}/fulfillment`, { status: 'COMPLETE' });
    const snapshot = () => JSON.stringify({
      days: shop.db.prepare('SELECT * FROM business_days ORDER BY id').all(), records: shop.db.prepare('SELECT * FROM inventory_records ORDER BY id').all(),
      events: shop.db.prepare('SELECT * FROM inventory_events ORDER BY id').all(),
    });
    const before = snapshot();
    // Make the last step fail: opening the next day is refused by a trigger. By then the old day's Sold figures have been frozen and the day marked closed.
    shop.db.exec("CREATE TRIGGER zz_test_fail BEFORE INSERT ON business_days WHEN NEW.business_date = '2026-10-13' BEGIN SELECT RAISE(ABORT, 'test: cannot open the next day'); END");
    shop.clock.now = new Date('2026-10-13T01:00:00Z');
    const r = await closeDay(shop, '2026-10-12');
    assert.equal(r.status, 500);
    assert.match(r.data.error, /Nothing was changed/);
    assert.equal(snapshot(), before, 'the old day is still open and unfrozen, and no new day or record exists');
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM inventory_records WHERE sold_milli IS NOT NULL").get().n, 0);
    // the shop can carry on selling on the open day, and the reset works once the problem is gone
    const extra = await shop.order(shop.cashier, [chicken(shop.whole, 1)]);
    assert.equal(extra.status, 201);
    assert.equal((await shop.manager.call('POST', `/api/orders/${extra.data.order.id}/fulfillment`, { status: 'COMPLETE' })).status, 200);
    shop.db.exec('DROP TRIGGER zz_test_fail');
    const ok = await closeDay(shop, '2026-10-12');
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(ok.data.opened.business_date, '2026-10-13');
  } finally { shop.close(); }
});

test('Change 6: a wrong count (a negative New Total) blocks the reset until it is fixed', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 10 });
    assert.equal((await shop.order(shop.cashier, [chicken(shop.whole, 6)])).status, 201);
    const o = shop.db.prepare('SELECT id FROM orders').get();
    await shop.cashier.call('POST', `/api/orders/${o.id}/fulfillment`, { status: 'COMPLETE' });
    shop.db.prepare('UPDATE inventory_records SET beginning_milli = 4000 WHERE product_id IS NOT NULL AND beginning_milli = 10000').run();   // as if the count were edited behind the app's back
    const check = (await shop.manager.call('GET', '/api/inventory/close-check')).data;
    assert.equal(check.can_close, false);
    assert.equal(check.blockers[0].code, 'NEGATIVE_BALANCE');
    assert.match(check.blockers[0].message, /Whole Chicken/);
    const r = await closeDay(shop, '2026-10-12');
    assert.equal(r.status, 409);
    assert.equal(shop.db.prepare('SELECT COUNT(*) AS n FROM business_days').get().n, 1);
  } finally { shop.close(); }
});

test('Change 6: the day label is today\'s date, or the next date when the day being closed is already today', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 10 });
    // closing in the middle of the same calendar date: the next business day is the next date, so dates never repeat
    const same = await closeDay(shop, '2026-10-12');
    assert.equal(same.data.opened.business_date, '2026-10-13');
    // two days later the shop starts a new day: the label is that day's own date
    shop.clock.now = new Date('2026-10-15T01:00:00Z');
    assert.equal((await shop.inventory()).day.stale, true);
    const late = await closeDay(shop, '2026-10-13');
    assert.equal(late.data.opened.business_date, '2026-10-15');
    // order numbers still follow the calendar date and keep counting
    const o = await shop.order(shop.cashier, [chicken(shop.whole, 1)]);
    assert.match(o.data.order.order_number, /^ORD-20261015-001$/);
    assert.equal(shop.db.prepare("SELECT business_date FROM business_days WHERE status = 'OPEN'").get().business_date, '2026-10-15');
  } finally { shop.close(); }
});

test('Change 6: a product added later gets a record with a zero balance, and an old day is never rewritten for it', async () => {
  const shop = await makeShop();
  try {
    await shop.stockUp({ 'Whole Chicken': 10 });
    await closeDay(shop, '2026-10-12');
    const added = await shop.admin.call('POST', '/api/products', { name: 'Native Chicken', price: '200' });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    const inv = await shop.inventory();
    const native = inv.chicken.find((r) => r.name === 'Native Chicken');
    assert.deepEqual([native.beginning, native.beginning_editable], [0, true]);
    const old = await shop.inventory(shop.manager, '?date=2026-10-12');
    assert.equal(old.chicken.find((r) => r.name === 'Native Chicken'), undefined, 'the closed day was not changed');
  } finally { shop.close(); }
});
