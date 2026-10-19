// Browser test for Revisions 19-20 (every service has its own price on the old-style Service fees table; the admin adds, renames and hides services).
// Drives the real screens in Chromium with its own in-memory database. Run:  npm run test:browser
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { openDb } = await import(path.join(root, 'src/db.js'));
const { createApp } = await import(path.join(root, 'src/app.js'));
const { loadConfig } = await import(path.join(root, 'src/config.js'));
const { createUser } = await import(path.join(root, 'src/services/users.js'));
const { createProduct, updateFee } = await import(path.join(root, 'src/services/catalog.js'));
const { getInventory, updateRecord } = await import(path.join(root, 'src/services/inventory.js'));
const req = createRequire(import.meta.url);
const { chromium } = (() => { try { return req('playwright'); } catch { return req('playwright-core'); } })();   // npm install playwright (or playwright-core)
const SHOTS = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pos-shots-'));

const db = openDb(':memory:');
const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
createUser(db, { username: 'butcher-tv', display_name: 'Butcher TV', role: 'display', password: 'butcher-pass-1' });
createProduct(db, admin, { name: 'Broilers', price: '100' });
updateFee(db, admin, 'POUR', { amount: '45', basis: 'per_head' });
updateFee(db, admin, 'NOT_POUR', { amount: '25', basis: 'per_head' });
for (const row of getInventory(db, admin, {}, new Date()).chicken) updateRecord(db, admin, row.id, { rev: row.rev, beginning: 500, reason: 'RECOUNT' }, new Date());
const server = createApp({ db, config: loadConfig({ dbPath: ':memory:' }) }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
const out = [];
const check = async (name, fn) => { try { await fn(); out.push('PASS ' + name); } catch (e) { out.push('FAIL ' + name + ' :: ' + String(e.message).split('\n').slice(0, 5).join(' | ')); } console.log(out.at(-1)); };
const errs = [];
const newPage = async (ctx) => { const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', (e) => errs.push(e.message)); return p; };
const login = async (p, u, pw, url = base) => { await p.goto(url); await p.fill('#username', u); await p.fill('#password', pw); await p.click('#loginBtn'); };
const ctx = () => browser.newContext({ viewport: { width: 1280, height: 800 } });

const owner = await newPage(await ctx());
await login(owner, 'owner', 'owner-pass-1');
await owner.waitForSelector('#topbar:not([hidden])');
await owner.goto(base + '/#/products');
await owner.click('[data-tab="fees"]');
await owner.waitForSelector('[data-row]');

await check('Service fees keeps the old look: one row per paid service (Live is not listed), each with its own fee, Charged, Save and Edit', async () => {
  assert.match(await owner.locator('[data-tab="fees"]').innerText(), /Service fees/);
  assert.equal(await owner.locator('[data-row]').count(), 6);
  assert.equal(await owner.locator('[data-row="LIVE"]').count(), 0);
  for (const code of ['POUR', 'NOT_POUR', 'POUR_SLICE', 'NOT_POUR_SLICE', 'POUR_DUKOT', 'NOT_POUR_DUKOT']) {
    assert.ok(await owner.locator(`[data-fee="${code}"]`).count(), code);
    assert.ok(await owner.locator(`[data-save="${code}"]`).count() && await owner.locator(`[data-edit="${code}"]`).count(), code);
  }
  assert.equal(await owner.inputValue('[data-fee="POUR_SLICE"]'), '45.00');
  assert.equal(await owner.inputValue('[data-fee="NOT_POUR_DUKOT"]'), '25.00');
  assert.equal(await owner.locator('[data-row] input[type="text"]:not([data-fee])').count(), 0, 'no name boxes in the table: names are changed with Edit');
  assert.ok(await owner.locator('[data-add]').count(), 'the Add service button is there');
  await owner.screenshot({ path: SHOTS + '/r19-1-services.png' });
});

await check('the admin gives Po-ur & Slice its own price', async () => {
  await owner.fill('[data-fee="POUR_SLICE"]', '60');
  await owner.click('[data-save="POUR_SLICE"]');
  await owner.waitForSelector('.toast:has-text("Po-ur & Slice fee saved")');
  const fees = await owner.evaluate(async () => (await (await fetch('/api/services')).json()).services.map((x) => [x.code, x.fee_centavos]));
  assert.deepEqual(fees.filter(([c]) => c.startsWith('POUR')), [['POUR', 4500], ['POUR_SLICE', 6000], ['POUR_DUKOT', 4500]], 'only Po-ur & Slice changed');
});

await check('Add service: a Dress, whole, ₱30 per head service called Deboned appears in the list', async () => {
  await owner.click('[data-add]');
  await owner.waitForSelector('#sLabel');
  await owner.fill('#sLabel', 'Deboned');
  await owner.fill('#sNote', 'Bones taken out');
  await owner.selectOption('#sKind', 'NOT_POUR');
  await owner.selectOption('#sCut', 'NONE');
  await owner.fill('#sFee', '30');
  await owner.screenshot({ path: SHOTS + '/r19-2-add-service.png' });
  await owner.click('dialog button:has-text("Add service")');
  await owner.waitForSelector('[data-row="SVC_1"]');
  assert.match(await owner.locator('[data-row="SVC_1"]').innerText(), /Deboned[\s\S]*\(added\)/);
  assert.equal(await owner.inputValue('[data-fee="SVC_1"]'), '30.00');
  assert.equal(await owner.locator('[data-row]').count(), 7);
});

await check('a duplicate name is refused with a clear message and nothing is added', async () => {
  await owner.click('[data-add]');
  await owner.fill('#sLabel', 'deboned');
  await owner.click('dialog button:has-text("Add service")');
  await owner.waitForSelector('#sErr .error, #sErr [role="alert"], #sErr:has-text("already exists")');
  assert.match(await owner.locator('#sErr').innerText(), /already exists/);
  await owner.click('dialog button:has-text("Cancel")');
  assert.equal(await owner.locator('[data-row]').count(), 7);
});

const cash = await newPage(await ctx());
await login(cash, 'cash', 'cashier-pass-1');
await cash.waitForSelector('.product-card');

await check('New order shows the new button with its own fee, and every service shows its own price', async () => {
  await cash.click('.product-card:has-text("Broilers")');
  await cash.waitForSelector('[data-action="prep-service"]');
  assert.equal(await cash.locator('[data-action="prep-service"]').count(), 8);
  const text = (code) => cash.locator(`[data-action="prep-service"][data-v="${code}"]`).innerText();
  assert.match(await text('SVC_1'), /Deboned[\s\S]*Bones taken out[\s\S]*\+₱30\.00 per head/);
  assert.match(await text('POUR_SLICE'), /\+₱60\.00 per head/);
  assert.match(await text('POUR_DUKOT'), /\+₱45\.00 per head/);
  assert.match(await text('LIVE'), /No fee/);
  await cash.screenshot({ path: SHOTS + '/r19-3-new-order.png' });
});

await check('selling with Deboned: weight 3.0 kg x 100 + 3 heads x 30 = ₱390.00; the receipt names it; the butcher screen shows it', async () => {
  for (const ch of '3.0') await cash.click('[data-key="' + ch + '"]');
  for (let i = 0; i < 2; i++) await cash.click('[data-action="heads-inc"]');
  await cash.click('[data-action="prep-service"][data-v="SVC_1"]');
  await cash.waitForFunction(() => document.querySelector('#itemTotal')?.textContent.includes('390.00'));
  await cash.click('#addBtn');
  await cash.click('[data-action="go-review"]');
  await cash.check('#reviewed'); await cash.selectOption('#payMethod', 'CASH'); await cash.fill('#payReceived', '400'); await cash.click('#submitBtn');
  await cash.waitForSelector('[data-tracking-big]');
  const slip = await cash.locator('.slip, #slip, main').first().innerText();
  assert.match(slip, /\+₱90\.00 Deboned \(3 × ₱30\.00\)/);
  const tv = await newPage(await ctx());
  await login(tv, 'butcher-tv', 'butcher-pass-1', base + '/butcher');
  await tv.waitForSelector('.bt-card');
  assert.match(await tv.locator('.bt-service').first().innerText(), /deboned/i);
  await tv.screenshot({ path: SHOTS + '/r19-4-butcher.png' });
  await tv.context().close();
});

await check('hiding Deboned removes the button; the sold order still shows its name; renaming does not change the old order', async () => {
  await owner.click('[data-edit="SVC_1"]');
  await owner.waitForSelector('#eLabel');
  await owner.fill('#eLabel', 'Deboned Plus');
  await owner.uncheck('#eShown');
  await owner.screenshot({ path: SHOTS + '/r19-5-edit.png' });
  await owner.click('dialog button:has-text("Save changes")');
  await owner.waitForFunction(() => /Deboned Plus[\s\S]*hidden/.test(document.querySelector('[data-row="SVC_1"]')?.innerText ?? ''));
  await cash.reload();
  await cash.waitForSelector('.product-card');
  await cash.click('.product-card:has-text("Broilers")');
  await cash.waitForSelector('[data-action="prep-service"]');
  assert.equal(await cash.locator('[data-action="prep-service"][data-v="SVC_1"]').count(), 0, 'hidden');
  assert.equal(await cash.locator('[data-action="prep-service"]').count(), 7);
  await cash.goto(base + '/#/orders');
  await cash.waitForSelector('tr[data-id], .data tbody tr');
  const r = await cash.evaluate(async () => (await (await fetch('/api/orders/1')).json()).order.items[0].service_label);
  assert.equal(r, 'Deboned', 'the order keeps the name it was sold under');
});

await check('no script errors on any page', async () => { assert.deepEqual(errs, []); });
await browser.close(); server.close();
const passed = out.filter((l) => l.startsWith('PASS')).length;
console.log('\n' + passed + ' of ' + out.length + ' browser checks passed');
process.exit(passed === out.length ? 0 : 1);
