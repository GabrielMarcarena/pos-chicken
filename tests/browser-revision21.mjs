// Browser test for Revision 21 (Deactivate or Remove). Real screens in Chromium, own in-memory database. Run:  npm run test:browser
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
const { createProduct, createOtherProduct, createService } = await import(path.join(root, 'src/services/catalog.js'));
const req = createRequire(import.meta.url);
const { chromium } = (() => { try { return req('playwright'); } catch { return req('playwright-core'); } })();   // npm install playwright (or playwright-core)
const SHOTS = process.env.SHOTS ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pos-shots-'));

const db = openDb(':memory:');
const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
createProduct(db, admin, { name: 'Broiler', price: '100', category: 'BROILER' });
createOtherProduct(db, admin, { name: 'Eggs (Small)', kind: 'EGGS', prices: { piece: '10' } });
createOtherProduct(db, admin, { name: 'Ducks', kind: 'OTHER', prices: { piece: '300' } });
createOtherProduct(db, admin, { name: 'Garlic', kind: 'OTHER', prices: { piece: '50' } });
createService(db, admin, { label: 'Deboned', kind: 'NOT_POUR', cut: 'NONE', fee: '30', basis: 'per_head' });
const server = createApp({ db, config: loadConfig({ dbPath: ':memory:' }) }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch(process.env.EXE ? { executablePath: process.env.EXE } : {});
const out = [];
const check = async (name, fn) => { try { await fn(); out.push('PASS ' + name); } catch (e) { out.push('FAIL ' + name + ' :: ' + String(e.message).split('\n').slice(0, 5).join(' | ')); } console.log(out.at(-1)); };
const errs = [];
const newPage = async (ctx) => { const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', (e) => errs.push(e.message)); return p; };
const login = async (p, u, pw) => { await p.goto(base); await p.fill('#username', u); await p.fill('#password', pw); await p.click('#loginBtn'); await p.waitForSelector('#topbar:not([hidden])'); };
const ctx = () => browser.newContext({ viewport: { width: 1280, height: 900 } });
const rowOf = (p, text) => p.locator('tr', { hasText: text }).first();
/** Revision 22: the row buttons live in the Edit menu, so open it first. */
const pick = async (row, sel) => { await row.locator('[data-menu]').click(); await row.locator(sel).click(); };

const mgr = await newPage(await ctx());
await login(mgr, 'mgr', 'manager-pass-1');
await mgr.goto(base + '/#/products');

await check('chicken products: Deactivate opens a box with two choices, and Remove is greyed out with the reason', async () => {
  await mgr.waitForSelector('[data-menu]');
  await pick(rowOf(mgr, 'Broiler'), '[data-toggle]');
  await mgr.waitForSelector('input[name="dChoice"][value="remove"]');
  assert.equal(await mgr.locator('input[name="dChoice"][value="deactivate"]').isChecked(), true);
  assert.equal(await mgr.locator('input[name="dChoice"][value="remove"]').isDisabled(), true);
  assert.match(await mgr.locator('.choice-rows').innerText(), /main products\. They can be deactivated, but not removed/);
  await mgr.screenshot({ path: SHOTS + '/r21-1-chicken-box.png' });
  await mgr.click('dialog button:has-text("Cancel")');
});

await check('chicken: choosing Deactivate hides it, and the row offers Reactivate (no Remove)', async () => {
  await pick(rowOf(mgr, 'Broiler'), '[data-toggle]');
  await mgr.click('dialog button:has-text("Continue")');
  await mgr.waitForFunction(() => /Reactivate/.test([...document.querySelectorAll('tr')].find((r) => /Broiler/.test(r.textContent))?.textContent ?? ''));
  assert.equal(await rowOf(mgr, 'Broiler').locator('[data-remove]').count(), 0);
  await pick(rowOf(mgr, 'Broiler'), '[data-toggle]');   // Reactivate
  await mgr.waitForFunction(() => /Deactivate/.test([...document.querySelectorAll('tr')].find((r) => /Broiler/.test(r.textContent))?.textContent ?? ''));
});

await check('other products: Remove works for Ducks (empty stock); eggs are locked', async () => {
  await mgr.click('[data-tab="other"]');
  await mgr.waitForSelector('tr:has-text("Ducks")');
  await pick(rowOf(mgr, 'Eggs (Small)'), '[data-toggle]');
  await mgr.waitForSelector('input[name="dChoice"][value="remove"]');
  assert.equal(await mgr.locator('input[name="dChoice"][value="remove"]').isDisabled(), true);
  assert.match(await mgr.locator('.choice-rows').innerText(), /Egg products are main products/);
  await mgr.click('dialog button:has-text("Cancel")');

  await pick(rowOf(mgr, 'Ducks'), '[data-toggle]');
  await mgr.waitForSelector('input[name="dChoice"][value="remove"]:not([disabled])');
  await mgr.check('input[name="dChoice"][value="remove"]');
  await mgr.screenshot({ path: SHOTS + '/r21-2-remove-box.png' });
  await mgr.click('dialog button:has-text("Continue")');
  await mgr.waitForFunction(() => !/Ducks/.test(document.querySelector('#tabBody').innerText));
  assert.equal(await mgr.locator('#removedBox').count(), 0, 'a manager does not see the Removed list');
});

await check('service fees: a manager sees Deactivate on every row and Remove only for the added service; built-ins cannot be removed', async () => {
  await mgr.click('[data-tab="fees"]');
  await mgr.waitForSelector('[data-row]');
  assert.equal(await mgr.locator('[data-row] [data-toggle]').count(), 7);   // 6 built-in + Deboned
  await pick(rowOf(mgr, 'Po-ur & Slice'), '[data-toggle]');
  await mgr.waitForSelector('input[name="dChoice"][value="remove"]');
  assert.equal(await mgr.locator('input[name="dChoice"][value="remove"]').isDisabled(), true);
  assert.match(await mgr.locator('.choice-rows').innerText(), /Built-in services can be deactivated, but not removed/);
  await mgr.click('dialog button:has-text("Cancel")');
  await pick(rowOf(mgr, 'Deboned'), '[data-toggle]');
  await mgr.waitForSelector('input[name="dChoice"][value="remove"]:not([disabled])');
  await mgr.click('dialog button:has-text("Continue")');   // Deactivate (the default)
  await mgr.waitForFunction(() => /hidden/.test([...document.querySelectorAll('tr')].find((r) => /Deboned/.test(r.textContent))?.textContent ?? ''));
  assert.ok(await rowOf(mgr, 'Deboned').locator('[data-remove]').count(), 'an inactive added service offers Remove');
  await pick(rowOf(mgr, 'Deboned'), '[data-remove]');
  await mgr.waitForSelector('dialog button:has-text("Remove")');
  await mgr.click('dialog button:has-text("Remove")');
  await mgr.waitForFunction(() => !/Deboned/.test(document.querySelector('#tabBody').innerText));
});

const own = await newPage(await ctx());
await login(own, 'owner', 'owner-pass-1');
await own.goto(base + '/#/products');

await check('the admin sees Removed (Ducks), with the days left, and can Restore it; it comes back deactivated', async () => {
  await own.click('[data-tab="other"]');
  await own.waitForSelector('#removedBox');
  await own.click('#removedBox summary');
  assert.match(await own.locator('#removedBox').innerText(), /Ducks[\s\S]*7 days to restore/);
  await own.screenshot({ path: SHOTS + '/r21-3-removed-list.png' });
  await own.click('[data-restore]');
  await own.waitForSelector('tr:has-text("Ducks") [data-menu]');
  assert.equal(await own.locator('#removedBox').count(), 0, 'the Removed list is empty again');
  assert.match(await rowOf(own, 'Ducks').innerText(), /Inactive/);
  assert.match(await rowOf(own, 'Ducks').locator('[data-toggle]').textContent(), /Reactivate/);
  assert.ok(await rowOf(own, 'Ducks').locator('[data-remove]').count(), 'and can be removed again');
});

await check('a cashier has no Products screen at all', async () => {
  const c = await newPage(await ctx());
  await login(c, 'cash', 'cashier-pass-1');
  assert.equal(await c.locator('#topbar a[href="#/products"]').count(), 0);
  await c.goto(base + '/#/products');
  await c.waitForTimeout(500);
  assert.equal(await c.locator('[data-toggle]').count(), 0);
  await c.context().close();
});

await check('no script errors on any page', async () => { assert.deepEqual(errs, []); });
await browser.close(); server.close();
const passed = out.filter((l) => l.startsWith('PASS')).length;
console.log('\n' + passed + ' of ' + out.length + ' browser checks passed');
process.exit(passed === out.length ? 0 : 1);
