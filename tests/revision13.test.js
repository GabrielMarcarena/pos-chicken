// Revision 13 acceptance tests: the Daily Inventory "Save" (one row per day), the automatic close at midnight (New Total carried into the
// Beginning Balance, nothing lost, Ongoing orders do not stop it), Beginning Balance edits as notes in the submitted file, the ref counted
// per chicken (Katay / Dead sold names the chicken it came from), the Daily Sales Report laid out top to bottom with Katay and Dead under
// their chicken, and the upgrade to version 11.
// Every test builds its own shop (own server, own database, own inventory folder), so none can disturb another or touch real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct } from '../src/services/catalog.js';
import { gatherDaily, buildModel } from '../src/services/dailyReport.js';
import { midnightClose } from '../src/services/inventoryReport.js';

const START = new Date('2026-10-16T02:00:00Z');   // 10:00 on Friday 16 Oct 2026 in the Philippines
const NEXT_MORNING = new Date('2026-10-17T01:00:00Z');   // 09:00 on 17 Oct
let keyN = 0;
const key = () => `r13-key-${++keyN}-${Math.random().toString(36).slice(2)}`;

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

async function makeShop() {
  const db = openDb(':memory:');
  const clock = { now: START };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-r13-inv-'));
  const config = loadConfig({ dbPath: ':memory:', inventoryDir: dir, largeWeightKg: 50, sessionIdleMinutes: 60 * 24 * 365 });
  const adminUser = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
  createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
  const bcull = createProduct(db, adminUser, { name: 'B-Cull', price: '120', category: 'BCULL' }).id;
  const broiler = createProduct(db, adminUser, { name: 'Broiler', price: '150', category: 'BROILER' }).id;
  const server = createApp({ db, config, clock: () => clock.now }).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const [admin, manager, cashier] = [client(base), client(base), client(base)];
  await admin.login('owner', 'owner-pass-1'); await manager.login('mgr', 'manager-pass-1'); await cashier.login('cash', 'cashier-pass-1');
  const shop = {
    db, clock, dir, server, base, admin, manager, cashier, bcull, broiler,
    close: () => { server.close(); try { db.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); },
    inventory: async (who = manager, query = '') => (await who.call('GET', `/api/inventory${query}`)).data,
    async row(name, query = '') { const inv = await shop.inventory(manager, query); return [...inv.chicken, ...inv.other].find((r) => r.name === name); },
    async set(name, fields, who = manager) {
      const row = await shop.row(name);
      assert.ok(row, `no inventory row called ${name}`);
      return who.call('PATCH', `/api/inventory/records/${row.id}`, { rev: row.rev, ...fields });
    },
    order: (who, items = [], extra = {}) => who.call('POST', '/api/orders', { submission_key: key(), items, other_items: [], ...extra }),
    move: (id, status, who = manager) => who.call('POST', `/api/orders/${id}/fulfillment`, { status }),
    save: (who = manager) => who.call('POST', '/api/inventory/save', {}),
    saves: () => db.prepare('SELECT * FROM inventory_saves ORDER BY id').all(),
    days: () => db.prepare('SELECT business_date, status, closed_by FROM business_days ORDER BY business_date').all().map((d) => ({ ...d })),
  };
  return shop;
}

const live = (product, heads = 1) => ({ product_id: product, weight: String(heads * 1.5), heads, feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null });
const ref = (kind, product, heads, kg, price) => ({ kind, product_id: product, heads, weight: String(kg), price_per_kg: String(price) });
const store = (shop, kind, product, heads, kg) => shop.cashier.call('POST', '/api/ref/store', { kind, product_id: product, heads, weight: String(kg) });

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
const sheetNames = (files) => [...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);

// ---- Change #1: Save -------------------------------------------------------------------------------------------------------------

test('Save: one row per day in the database; saving again replaces it; the screen says when, by whom, and whether the numbers changed since', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.inventory()).saved, null, 'nothing saved yet');
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await shop.save(shop.cashier)).status, 403, 'managers and the admin only');
    const first = await shop.save();
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.deepEqual([first.data.business_date, first.data.saved.by, first.data.saved.how, first.data.saved.current], ['2026-10-16', 'Manager', 'MANUAL', true]);
    assert.equal(shop.saves().length, 1);
    const snap = JSON.parse(shop.saves()[0].snapshot);
    assert.equal(snap.chicken.find((r) => r.name === 'B-Cull').beginning, 10000);

    // a sale changes the numbers: the screen says so, and Save again replaces the same row
    assert.equal((await shop.order(shop.cashier, [live(shop.bcull, 3)])).status, 201);
    assert.equal((await shop.inventory()).saved.current, false);
    shop.clock.now = new Date(START.getTime() + 3600_000);
    assert.equal((await shop.save(shop.admin)).status, 200);
    const rows = shop.saves();
    assert.equal(rows.length, 1, 'still one row for the day');
    assert.equal(JSON.parse(rows[0].snapshot).chicken.find((r) => r.name === 'B-Cull').sold, 3000);
    assert.equal(rows[0].saved_at, shop.clock.now.toISOString());
    assert.equal((await shop.inventory()).saved.by, 'Owner');
    // the saved numbers can be read back for a date
    const back = await shop.manager.call('GET', '/api/inventory/saved?date=2026-10-16');
    assert.equal(back.status, 200);
    assert.equal(back.data.chicken.find((r) => r.name === 'B-Cull').new_total, 7000);
  } finally { shop.close(); }
});

// ---- Change #1: the automatic close at midnight -------------------------------------------------------------------------------------

test('Midnight: a day nobody saved is saved and closed by itself, New Total becomes the Beginning Balance, and its file is kept', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await shop.set('Broiler', { beginning: 6 })).status, 200);
    const o = await shop.order(shop.cashier, [live(shop.bcull, 4)]);
    assert.equal((await shop.move(o.data.order.id, 'COMPLETE')).status, 200);
    assert.equal((await shop.set('B-Cull', { reject: 1 })).status, 200);   // 10 - 4 sold - 1 reject = 5

    shop.clock.now = NEXT_MORNING;
    const closed = midnightClose(shop.db, shop.clock.now, { dir: shop.dir });
    assert.equal(closed, '2026-10-16');
    assert.deepEqual(shop.days(), [
      { business_date: '2026-10-16', status: 'CLOSED', closed_by: null },
      { business_date: '2026-10-17', status: 'OPEN', closed_by: null },
    ]);
    // the closed day's final numbers are saved (how AUTO_CLOSE), and the file of the closed day is in the inventory folder
    const save = shop.saves()[0];
    assert.deepEqual([save.how, save.saved_by], ['AUTO_CLOSE', null]);
    assert.equal(JSON.parse(save.snapshot).chicken.find((r) => r.name === 'B-Cull').new_total, 5000);
    assert.ok(fs.existsSync(path.join(shop.dir, 'inventory_2026-10-16_closed-at-midnight.xlsx')));
    // today starts from yesterday's New Total; the counters start at 0
    const today = await shop.row('B-Cull');
    assert.deepEqual([today.beginning, today.additional, today.sold, today.reject], [5000, 0, 0, 0]);
    assert.equal((await shop.row('Broiler')).beginning, 6000);
    // a second run changes nothing, and does not write the file again
    assert.equal(midnightClose(shop.db, shop.clock.now, { dir: shop.dir }), null);
    assert.equal(fs.readdirSync(shop.dir).length, 1);
    // the closed day stays readable: its status is Closed, its screen and its Export still work
    const old = await shop.inventory(shop.manager, '?date=2026-10-16');
    assert.deepEqual([old.day.status, old.saved.how], ['CLOSED', 'AUTO_CLOSE']);
    const exported = await shop.cashier.call('GET', '/api/inventory/day.xlsx?date=2026-10-16');
    assert.equal(exported.status, 200);
    assert.ok(readZip(exported.data)['xl/worksheets/sheet1.xml'].includes('The app, automatically at midnight'));
    // a closed day's saved row is frozen
    assert.throws(() => shop.db.prepare("UPDATE inventory_saves SET how = 'MANUAL'").run(), /closed day/);
    assert.throws(() => shop.db.prepare('DELETE FROM inventory_saves').run(), /closed day/);
  } finally { shop.close(); }
});

test('Midnight: any request after midnight closes the old day first, so a sale never lands on yesterday; Ongoing orders do not stop it', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    const ongoing = (await shop.order(shop.cashier, [live(shop.bcull, 2)])).data.order;   // left Ongoing overnight
    assert.equal((await shop.save()).status, 200);
    shop.clock.now = NEXT_MORNING;
    const sale = await shop.order(shop.cashier, [live(shop.bcull, 1)]);
    assert.equal(sale.status, 201, JSON.stringify(sale.data));
    const dayOf = (id) => shop.db.prepare('SELECT d.business_date AS d FROM orders o JOIN business_days d ON d.id = o.business_day_id WHERE o.id = ?').get(id).d;
    assert.equal(dayOf(sale.data.order.id), '2026-10-17', 'today\'s sale is on today\'s business day');
    assert.equal(dayOf(ongoing.id), '2026-10-16', 'the Ongoing order stays counted on the day it was sold');
    assert.equal(shop.saves().find((s) => s.how === 'AUTO_CLOSE') !== undefined, true, 'the manual save was replaced by the final one');
    assert.equal(shop.saves().length, 1);
    // the Ongoing order is still on the Order List
    const board = (await shop.cashier.call('GET', '/api/board')).data;
    assert.equal(board.orders.find((x) => x.id === ongoing.id)?.fulfillment_status, 'ONGOING');
    // the Daily Report of the 16th has the order sold on the 16th, the report of the 17th the one sold on the 17th
    assert.equal(gatherDaily(shop.db, { date: '2026-10-16' }).orderCount, 1);
    assert.equal(gatherDaily(shop.db, { date: '2026-10-17' }).orderCount, 1);
    assert.equal((await shop.row('B-Cull')).beginning, 8000);
  } finally { shop.close(); }
});

test('Midnight: after the app was off for three days, the old day is closed once and today opens; no empty days are made', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    shop.clock.now = new Date('2026-10-19T03:00:00Z');
    assert.equal((await shop.inventory()).day.business_date, '2026-10-19');
    assert.deepEqual(shop.days().map((d) => [d.business_date, d.status]), [['2026-10-16', 'CLOSED'], ['2026-10-19', 'OPEN']]);
    assert.equal((await shop.row('B-Cull')).beginning, 10000);
  } finally { shop.close(); }
});

test('Midnight: a New Total below zero does not stop the close; the next day starts that product at 0', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 3 })).status, 200);
    assert.equal((await shop.order(shop.cashier, [live(shop.bcull, 3)])).status, 201);
    shop.db.prepare("UPDATE inventory_records SET beginning_milli = 1000 WHERE beginning_milli = 3000").run();   // a count changed behind the app's back
    shop.clock.now = NEXT_MORNING;
    assert.equal(midnightClose(shop.db, shop.clock.now, { dir: shop.dir }), '2026-10-16');
    assert.equal((await shop.row('B-Cull')).beginning, 0);
  } finally { shop.close(); }
});

// ---- Change #1: Beginning Balance edits as notes ---------------------------------------------------------------------------------------

test('Submit Inventory Today: a Beginning Balance edit is a note under the tables (who, reason, note); with no edit there is no note', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);   // the first number is not an edit
    const plain = await shop.manager.call('POST', '/api/inventory/submit', { business_date: '2026-10-16' });
    assert.equal(plain.status, 201, JSON.stringify(plain.data));
    const plainFile = readZip((await shop.manager.call('GET', `/api/inventory/submissions/${plain.data.submission.id}/file`)).data);
    assert.deepEqual(sheetNames(plainFile), ['Inventory Today']);
    assert.ok(!plainFile['xl/worksheets/sheet1.xml'].includes('BEGINNING BALANCE EDITS'), 'no edit, no note');

    assert.equal((await shop.set('B-Cull', { beginning: 12, reason: 'RECOUNT', reason_note: 'counted again' })).status, 200);
    const edited = await shop.manager.call('POST', '/api/inventory/submit', { business_date: '2026-10-16' });
    const xml = readZip((await shop.manager.call('GET', `/api/inventory/submissions/${edited.data.submission.id}/file`)).data)['xl/worksheets/sheet1.xml'];
    assert.ok(xml.includes('BEGINNING BALANCE EDITS'));
    assert.match(xml, /Note: B-Cull Beginning Balance changed from 10 to 12 by Manager on 2026-10-16 10:00 AM\. Reason: Recount \(stock check\)\. Note: counted again/);
  } finally { shop.close(); }
});

// ---- Change #2: the ref counted per chicken, and the Daily Sales Report --------------------------------------------------------------

test('Ref per chicken: a Katay sale names the chicken; each chicken has its own count; a cancel gives the heads back to the same chicken', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await shop.set('Broiler', { beginning: 10 })).status, 200);
    assert.equal((await store(shop, 'KATAY', shop.bcull, 2, 3)).status, 201);
    assert.equal((await store(shop, 'KATAY', shop.broiler, 3, 4.5)).status, 201);
    const config = (await shop.cashier.call('GET', '/api/config')).data;
    assert.deepEqual(config.stock.ref_by_product.KATAY, { [shop.bcull]: 2, [shop.broiler]: 3 });
    assert.equal(config.stock.ref_heads.KATAY, 5);

    // the chicken must be named
    const bare = await shop.order(shop.cashier, [], { ref_items: [{ kind: 'KATAY', heads: 1, weight: '1.5', price_per_kg: '100' }] });
    assert.equal(bare.status, 400);
    // 3 B-Cull Katay are refused even though 5 Katay are in the ref (only 2 of them are B-Cull)
    const short = await shop.order(shop.cashier, [], { ref_items: [ref('KATAY', shop.bcull, 3, 4.5, 100)] });
    assert.equal(short.status, 409);
    assert.match(short.data.error, /Only 2 heads of Katay Chicken \(B-Cull\)/);
    const sold = await shop.order(shop.cashier, [], { ref_items: [ref('KATAY', shop.bcull, 2, 3, 100)] });
    assert.equal(sold.status, 201, JSON.stringify(sold.data));
    assert.equal(sold.data.order.ref_items[0].product_name, 'Katay Chicken - B-Cull');
    assert.equal(sold.data.order.ref_items[0].product_id, shop.bcull);
    let by = (await shop.cashier.call('GET', '/api/config')).data.stock.ref_by_product.KATAY;
    assert.deepEqual(by, { [shop.broiler]: 3 }, 'B-Cull is empty, Broiler untouched');
    assert.equal((await shop.cashier.call('POST', `/api/orders/${sold.data.order.id}/cancel`, { reason_code: 'CUSTOMER_CHANGED_MIND' })).status, 200);
    by = (await shop.cashier.call('GET', '/api/config')).data.stock.ref_by_product.KATAY;
    assert.deepEqual(by, { [shop.bcull]: 2, [shop.broiler]: 3 }, 'back to the B-Cull part of the ref');
    // the Advanced screen splits the ref by chicken
    const kinds = (await shop.cashier.call('GET', '/api/advanced')).data.ref.kinds;
    assert.deepEqual(kinds.find((k) => k.kind === 'KATAY').products.map((p) => [p.product, p.heads]).sort(), [['B-Cull', 2], ['Broiler', 3]]);
  } finally { shop.close(); }
});

test('Daily Sales Report: Katay and Dead sit under the chicken they came from, with their own heads and kilos; live totals leave them out', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await shop.set('Broiler', { beginning: 10 })).status, 200);
    assert.equal((await shop.order(shop.cashier, [live(shop.bcull, 2)])).status, 201);          // live B-Cull: 2 heads, 3 kg, ₱360
    assert.equal((await store(shop, 'KATAY', shop.bcull, 1, 1.2)).status, 201);
    assert.equal((await store(shop, 'DEAD', shop.broiler, 1, 1.4)).status, 201);
    assert.equal((await shop.order(shop.cashier, [], { ref_items: [ref('KATAY', shop.bcull, 1, 1.2, 100)] })).status, 201);   // ₱120
    assert.equal((await shop.order(shop.cashier, [], { ref_items: [ref('DEAD', shop.broiler, 1, 1.4, 50)] })).status, 201);   // ₱70

    const model = buildModel(gatherDaily(shop.db, { date: '2026-10-16' }));
    const b = model.blocks.find((x) => x.title === 'B-CULL');
    assert.deepEqual([b.heads, b.kilos, b.amount], [2, 3, 36000], 'live B-Cull only');
    assert.deepEqual([b.katayTotal.heads, b.katayTotal.kilos, b.katayTotal.amount], [1, 1.2, 12000]);
    assert.equal(b.dead.length, 0);
    const br = model.blocks.find((x) => x.title === 'BROILER');
    assert.deepEqual([br.heads, br.lines.length, br.deadTotal.heads, br.deadTotal.amount], [0, 0, 1, 7000]);
    assert.ok(!model.blocks.some((x) => x.key === 'REF'), 'every sale has its chicken: no "source not recorded" block');

    const res = await shop.manager.call('GET', '/api/daily-report.xlsx?date=2026-10-16');
    const xml = readZip(res.data)['xl/worksheets/sheet1.xml'];
    for (const text of ['B-CULL: KATAY (from the ref), no service fee', 'BROILER: DEAD (from the ref), no service fee', 'LIVE', 'KATAY', 'DEAD', 'TOTAL AMOUNT', 'SOLD (live)', 'DISCOUNTS', 'EXPENSES']) {
      assert.ok(xml.includes(text), text);
    }
    assert.match(xml, /orientation="landscape"/);
    assert.ok(!xml.includes('KATAY / DEAD (REF)'), 'the old shared block is gone');
    assert.ok(!xml.includes('SUMMARY'), 'the top-to-bottom summary is gone: this is the paper form again');
    // GROSS SALES adds the money of live, Katay and Dead: 360 + 120 + 70 = 550
    assert.match(xml, /<f>SUM\([A-Z]+\d+:[A-Z]+\d+\)<\/f><v>550<\/v>/);
  } finally { shop.close(); }
});

test('Daily Sales Report (Revision 14): a clean rectangle: every block\'s TOTAL AMOUNT, the expenses TOTAL AMOUNT and EXCESS/LOSS are on the last row; DISCOUNTS is above EXPENSES', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await shop.order(shop.cashier, [live(shop.bcull, 2)], { discount: { type: 'FIXED', value: '20', reason_code: 'WHOLESALE' }, customer_number: 'Aling Rosa' })).status, 201);
    assert.equal((await store(shop, 'KATAY', shop.bcull, 1, 1.2)).status, 201);
    assert.equal((await shop.order(shop.cashier, [], { ref_items: [ref('KATAY', shop.bcull, 1, 1.2, 100)] })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/expenses', { items: [{ item: 'Coke', amount: '75' }] })).status, 201);
    assert.equal((await shop.cashier.call('POST', '/api/cash-count', { counts: { 1000: '1' } })).status, 201);
    const xml = readZip((await shop.manager.call('GET', '/api/daily-report.xlsx?date=2026-10-16')).data)['xl/worksheets/sheet1.xml'];
    const rows = [...xml.matchAll(/<row r="(\d+)"[^>]*>(.*?)<\/row>/g)].map((m) => ({ n: Number(m[1]), xml: m[2] }));
    const textOf = (rowXml) => [...rowXml.matchAll(/<c r="([A-Z]+)\d+"[^>]*><is><t[^>]*>(.*?)<\/t><\/is><\/c>/g)].map((c) => [c[1], c[2]]);
    const last = rows.at(-1);
    const lastTexts = textOf(last.xml);
    assert.ok(lastTexts.some(([, t]) => t === 'EXCESS/LOSS'), 'EXCESS/LOSS is on the last row');
    assert.equal(lastTexts.filter(([, t]) => t === 'TOTAL AMOUNT').length, 4, 'B-CULL, CULL, BROILER and the expenses: all TOTAL AMOUNT on the last row');
    // no TOTAL AMOUNT or EXCESS/LOSS is lower than that row, and the two sit in different columns
    assert.equal(new Set(lastTexts.filter(([, t]) => t === 'TOTAL AMOUNT' || t === 'EXCESS/LOSS').map(([c]) => c)).size, 5);
    // DISCOUNTS is above EXPENSES, in the same column
    const at = (word) => { for (const r of rows) { const hit = textOf(r.xml).find(([, t]) => t === word); if (hit) return { row: r.n, col: hit[0] }; } return null; };
    const disc = at('DISCOUNTS'); const exp = at('EXPENSES');
    assert.ok(disc && exp && disc.col === exp.col && disc.row < exp.row, JSON.stringify({ disc, exp }));
    assert.ok(at('OTHERS').col !== disc.col, 'DISCOUNTS is not in the OTHERS column any more');
    // the three totals of each block never overlap: Live, Katay and Dead are SUMs over their own rows
    const sums = [...xml.matchAll(/<f>SUM\(A(\d+):A(\d+)\)<\/f>/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.ok(sums.length >= 2);
    for (let i = 1; i < sums.length; i += 1) assert.ok(sums[i][0] > sums[i - 1][1] || sums[i][0] <= sums[i - 1][0], 'ranges do not overlap');
  } finally { shop.close(); }
});

test('Daily Sales Report: a Katay sale from before Revision 13 (no chicken recorded) goes under "source not recorded"', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await store(shop, 'KATAY', shop.bcull, 1, 1.2)).status, 201);
    const o = await shop.order(shop.cashier, [], { ref_items: [ref('KATAY', shop.bcull, 1, 1.2, 100)] });
    // as if it had been sold before the upgrade
    shop.db.exec('DROP TRIGGER order_ref_items_no_update');
    shop.db.prepare("UPDATE order_ref_items SET product_id = NULL, product_name = 'Katay Chicken' WHERE order_id = ?").run(o.data.order.id);
    const model = buildModel(gatherDaily(shop.db, { date: '2026-10-16' }));
    const unknown = model.blocks.find((x) => x.key === 'REF');
    assert.equal(unknown.title, 'KATAY / DEAD (source not recorded)');
    assert.equal(unknown.katay.length, 1);
    assert.equal(model.blocks.at(-1).key, 'REF', 'listed last');
  } finally { shop.close(); }
});

// ---- Upgrade --------------------------------------------------------------------------------------------------------------------

test('upgrade to version 11: a safety copy first; an old Katay sale gets its chicken when only one chicken was ever stored; the save table exists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v11-'));
  const file = path.join(dir, 'pos.db');
  const first = openDb(file);
  const admin = createUser(first, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
  const bcull = createProduct(first, admin, { name: 'B-Cull', price: '120', category: 'BCULL' }).id;
  first.prepare("INSERT INTO business_days (business_date, status, opened_at) VALUES ('2026-10-15', 'OPEN', '2026-10-15T00:00:00Z')").run();
  const day = first.prepare('SELECT id FROM business_days').get().id;
  first.prepare("INSERT INTO ref_stock_entries (ref_kind, heads, source, product_id, business_day_id, user_id, created_at) VALUES ('KATAY', 2, 'ADVANCED', ?, ?, ?, '2026-10-15T01:00:00Z')").run(bcull, day, admin.id);
  first.prepare("INSERT INTO ref_stock_entries (ref_kind, heads, source, product_id, business_day_id, user_id, created_at) VALUES ('DEAD', 1, 'ADVANCED', ?, ?, ?, '2026-10-15T01:00:00Z')").run(bcull, day, admin.id);
  const orderId = Number(first.prepare(`INSERT INTO orders (order_number, business_date, customer_number, status, subtotal_centavos, discount_type, discount_value, discount_centavos, total_centavos, cashier_id, submitted_at, submission_key, business_day_id)
                                        VALUES ('ORD-20261015-001', '2026-10-15', 'WALK-IN', 'COMPLETED', 12000, 'NONE', 0, 0, 12000, ?, '2026-10-15T02:00:00Z', 'k1', ?)`).run(admin.id, day).lastInsertRowid);
  // turn it back into a version 10 database: no product on ref sale lines, no save table
  first.exec('DROP TABLE inventory_saves');
  first.exec('DROP TABLE order_ref_items');
  first.exec(`CREATE TABLE order_ref_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), line_no INTEGER NOT NULL,
              ref_kind TEXT NOT NULL, product_name TEXT NOT NULL, heads INTEGER NOT NULL, weight_g INTEGER NOT NULL, price_per_kg_centavos INTEGER NOT NULL,
              line_total_centavos INTEGER NOT NULL, UNIQUE (order_id, line_no))`);
  first.prepare("INSERT INTO order_ref_items (order_id, line_no, ref_kind, product_name, heads, weight_g, price_per_kg_centavos, line_total_centavos) VALUES (?, 1, 'KATAY', 'Katay Chicken', 1, 1200, 10000, 12000)").run(orderId);
  first.exec('PRAGMA user_version = 10');
  first.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 11);
  assert.ok(fs.readdirSync(dir).some((f) => /\.before-v11-.*\.bak$/.test(f)), 'a safety copy was made first');
  assert.equal(db.prepare('SELECT product_id FROM order_ref_items').get().product_id, bcull, 'every Katay ever stored was B-Cull');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_saves').get().n, 0);
  assert.throws(() => db.prepare('UPDATE order_ref_items SET heads = 2').run(), /cannot be changed/, 'the guard is back');
  db.close();
  assert.equal(openDb(file).prepare('PRAGMA user_version').get().user_version, 11, 'a second start changes nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clear-records: the saved inventory of the closed days goes with them; the open day keeps its own', async () => {
  const { clearRecords } = await import('../src/clearRecords.js');
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await shop.save()).status, 200);
    shop.clock.now = NEXT_MORNING;
    midnightClose(shop.db, shop.clock.now, { dir: shop.dir });
    assert.equal((await shop.save()).status, 200);
    assert.equal(shop.saves().length, 2);
    clearRecords(shop.db);
    const left = shop.db.prepare('SELECT d.business_date AS d FROM inventory_saves s JOIN business_days d ON d.id = s.business_day_id').all().map((r) => r.d);
    assert.deepEqual(left, ['2026-10-17']);
    assert.equal(shop.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'inventory_saves_%'").get().n, 3, 'the protections are back');
  } finally { shop.close(); }
});

test('Ref movements (Revision 14): each movement carries its Philippine date, newest first, so yesterday is not mixed up with today', async () => {
  const shop = await makeShop();
  try {
    assert.equal((await shop.set('B-Cull', { beginning: 10 })).status, 200);
    assert.equal((await store(shop, 'KATAY', shop.bcull, 2, 3)).status, 201);              // 16 Oct
    shop.clock.now = NEXT_MORNING;                                                          // 17 Oct, 09:00
    assert.equal((await store(shop, 'DEAD', shop.bcull, 1, 1.4)).status, 201);
    assert.equal((await shop.order(shop.cashier, [], { ref_items: [ref('KATAY', shop.bcull, 1, 1.2, 100)] })).status, 201);
    const moves = (await shop.cashier.call('GET', '/api/advanced')).data.ref.moves;
    assert.deepEqual(moves.map((m) => m.date), ['2026-10-17', '2026-10-17', '2026-10-16'], 'newest day first');
    assert.deepEqual(moves.map((m) => `${m.date} ${m.kind} ${m.heads}`).sort(), ['2026-10-16 KATAY 2', '2026-10-17 DEAD 1', '2026-10-17 KATAY -1']);
    assert.equal(moves.find((m) => m.heads === -1).from, 'B-Cull', 'a sale names the chicken it came from');
  } finally { shop.close(); }
});
