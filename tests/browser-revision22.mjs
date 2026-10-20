// Browser test for Revision 22 (Edit menu, Units and prices, Advanced, chicken pecks, phones). Real screens in Chromium, own in-memory database. Run:  npm run test:browser
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
const phone = () => browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });


const mgr = await newPage(await ctx());
await login(mgr, 'mgr', 'manager-pass-1');
await mgr.goto(base + '/#/products');
const owner = await newPage(await ctx());
await login(owner, 'owner', 'owner-pass-1');
await owner.goto(base + '/#/products');

await check('Products: one Edit menu per row with the right items; Esc and an outside click close it', async () => {
  await owner.waitForSelector('[data-menu]');
  const row = rowOf(owner, 'Broiler');
  assert.equal(await row.locator('[data-menu]').count(), 1);
  assert.equal(await row.locator('button.btn').count(), 1, 'only one visible button on the row');
  assert.equal(await row.locator('.row-menu-list').isHidden(), true);
  await row.locator('[data-menu]').click();
  assert.deepEqual(await row.locator('.row-menu-list button').allInnerTexts(), ['Edit', 'Picture', 'Deactivate']);
  await owner.screenshot({ path: SHOTS + '/r22-1-menu.png' });
  await owner.keyboard.press('Escape');
  assert.equal(await row.locator('.row-menu-list').isHidden(), true);
  await row.locator('[data-menu]').click();
  await owner.mouse.click(5, 5);
  assert.equal(await row.locator('.row-menu-list').isHidden(), true);
  await row.locator('[data-menu]').click();
  await row.locator('[data-picture]').click();
  await owner.waitForSelector('dialog[open]');
  await owner.keyboard.press('Escape');
});

await check('Other products: the menu holds Units & prices, Picture, Rename, Deactivate; Deactivate still opens the two-choice box', async () => {
  await owner.click('[data-tab="other"]');
  await owner.waitForSelector('tr:has-text("Ducks")');
  const row = rowOf(owner, 'Ducks');
  await row.locator('[data-menu]').click();
  assert.deepEqual(await row.locator('.row-menu-list button').allInnerTexts(), ['Units & prices', 'Picture', 'Rename', 'Deactivate']);
  await row.locator('[data-toggle]').click();
  await owner.waitForSelector('input[name="dChoice"][value="deactivate"]');
  await owner.click('dialog button:has-text("Cancel")');
});

await check('the Units column shows only units on sale (active and priced), unit on the left and price on the right', async () => {
  const cell = rowOf(owner, 'Garlic').locator('.unit-list');
  assert.deepEqual(await cell.locator('li').allInnerTexts(), ['piece\n₱50.00']);
  assert.equal(await rowOf(owner, 'Garlic').locator('.chip').count(), 0, 'no hidden-unit chips any more');
});

await check('Units & prices box: a table, Save all saves two changed units at once, hidden units are folded', async () => {
  const row = rowOf(owner, 'Garlic');
  await row.locator('[data-menu]').click();
  await row.locator('[data-options]').click();
  await owner.waitForSelector('.opts-table');
  assert.deepEqual(await owner.locator('.opts-table').first().locator('thead th').allInnerTexts(), ['Unit', 'Sold by', 'Price (₱)', 'On sale']);
  const hidden = owner.locator('details[data-hidden-units]');
  assert.ok(await hidden.count(), 'unpriced units are under Hidden units');
  assert.match(await hidden.locator('summary').innerText(), /Hidden units \(\d+\)/);
  assert.equal(await hidden.getAttribute('open'), null, 'folded');
  await hidden.locator('summary').click();
  await hidden.locator('input[aria-label="Price per pack in pesos"]').fill('120');
  assert.equal(await hidden.locator('input[aria-label="pack on sale"]').isChecked(), true, 'a price turns the unit on');
  await hidden.locator('input[aria-label="Price per sack in pesos"]').fill('900');
  await owner.waitForTimeout(400);
  await owner.screenshot({ path: SHOTS + '/r22-2-units.png' });
  await owner.click('dialog button:has-text("Save all")');
  await owner.waitForSelector('dialog[open]', { state: 'detached' });
  await owner.waitForFunction(() => /pack/.test(document.querySelector('tr .unit-list')?.closest('table')?.innerText ?? '') && /sack/.test(document.body.innerText));
  const items = await rowOf(owner, 'Garlic').locator('.unit-list li').allInnerTexts();
  assert.deepEqual(items.map((t) => t.replace(/\s+/g, ' ')), ['piece ₱50.00', 'pack ₱120.00', 'sack ₱900.00']);
});

await check('Service fees: the admin keeps Save on the row, the manager sees only the menu; Remove only for an added service', async () => {
  await owner.click('[data-tab="fees"]');
  await owner.waitForSelector('[data-row]');
  const first = owner.locator('[data-row]').first();
  assert.ok(await first.locator('[data-save]').count(), 'admin Save stays');
  await first.locator('[data-menu]').click();
  assert.deepEqual(await first.locator('.row-menu-list button').allInnerTexts(), ['Edit', 'Deactivate']);
  await owner.keyboard.press('Escape');
  await mgr.goto(base + '/#/products');
  await mgr.click('[data-tab="fees"]');
  await mgr.waitForSelector('[data-row]');
  const m = mgr.locator('[data-row]').first();
  assert.equal(await m.locator('[data-save]').count(), 0);
  await m.locator('[data-menu]').click();
  assert.deepEqual(await m.locator('.row-menu-list button').allInnerTexts(), ['Deactivate']);
});

const cashCtx = await ctx();
const cash = await newPage(cashCtx);
await login(cash, 'cash', 'cashier-pass-1');
await check('Advanced > Ref stock: a short line, and Read more is closed until pressed', async () => {
  await cash.click('[data-tab="advanced"]');
  await cash.waitForSelector('.ref-short');
  const more = cash.locator('details.how', { hasText: 'Read more' });
  assert.equal(await more.getAttribute('open'), null);
  assert.ok((await cash.locator('.ref-short').innerText()).length < 90);
  assert.equal(await more.locator('.how-body').isHidden(), true);
  await more.locator('summary').click();
  assert.match(await more.locator('.how-body').innerText(), /Add to order/);
  await cash.screenshot({ path: SHOTS + '/r22-3-ref.png' });
});

await check('Advanced > Cash breakdown: steps 1, 2, 3; totals update; Loss is red and Excess is green', async () => {
  await cash.click('[data-adv="section"][data-v="cash"]');
  await cash.waitForSelector('[data-step="3"]');
  for (const n of [1, 2, 3]) assert.equal(await cash.locator(`[data-step="${n}"] .cash-n`).innerText(), String(n));
  assert.equal(await cash.locator('.cash-cols table').count(), 2, 'bills and coins side by side');
  await cash.fill('[data-adv-count="1000"]', '3');
  assert.match(await cash.locator('#cashTotal').innerText(), /3,000/);
  assert.match(await cash.locator('#cashExcess').innerText(), /excess/);
  assert.equal(await cash.locator('#cashExcess').evaluate((e) => e.className), 'cash-excess');
  const green = await cash.locator('.cash-result').evaluate((e) => getComputedStyle(e).backgroundColor);
  await cash.fill('[data-adv-count="1000"]', '');
  await cash.evaluate(() => { document.querySelector('#cashExpected').dataset.expected = '500000'; });   // pretend the drawer should hold ₱5,000
  await cash.fill('[data-adv-count="1"]', '1');
  assert.equal(await cash.locator('#cashExcess').evaluate((e) => e.className), 'cash-loss');
  const red = await cash.locator('.cash-result').evaluate((e) => getComputedStyle(e).backgroundColor);
  assert.notEqual(green, red);
  await cash.screenshot({ path: SHOTS + '/r22-4-cash.png', fullPage: true });
});

const funCtx = (chance) => browser.newContext({ viewport: { width: 1280, height: 800 } }).then(async (c) => { await c.addInitScript((g) => { window.__posIdleMs = 1000; window.__posGlassChance = g; window.__posStareChance = 0; }, chance); return c; });
await check('chicken: pecking the ground makes feed and no crack', async () => {
  const p = await newPage(await funCtx(0));
  await login(p, 'cash', 'cashier-pass-1');
  await p.mouse.move(20, 20);
  await p.evaluate(() => { window.__seen = { crack: 0, feed: 0, dust: 0 }; new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) { for (const k of Object.keys(window.__seen)) if (n.classList?.contains(k)) window.__seen[k] += 1; } }).observe(document.body, { subtree: true, childList: true }); });
  await p.waitForFunction(() => window.__seen.feed >= 3, null, { timeout: 30000 });
  assert.equal(await p.evaluate(() => window.__seen.crack), 0, 'no crack from the ground');
  assert.ok(await p.evaluate(() => window.__seen.dust) >= 1, 'dust puff');
  await p.context().close();
});

await check('chicken: tapping the glass turns to you, leans in and cracks the screen', async () => {
  const p = await newPage(await funCtx(1));
  await login(p, 'cash', 'cashier-pass-1');
  await p.mouse.move(20, 20);
  await p.evaluate(() => { window.__seen = new Set(); new MutationObserver(() => { for (const c of ['looking', 'close']) if (document.querySelector('.hen.' + c)) window.__seen.add(c); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] }); });
  await p.waitForSelector('#fun-layer .crack', { state: 'attached', timeout: 30000 });
  assert.ok(await p.evaluate(() => window.__seen.has('looking') && window.__seen.has('close')), 'turned to you and leaned in');
  await p.screenshot({ path: SHOTS + '/r22-5-glass.png' });
  await p.mouse.move(400, 400); await p.mouse.move(420, 410);
  await p.waitForFunction(() => !document.querySelector('#fun-layer .crack'), null, { timeout: 3000 });
  await p.context().close();
});

for (const [who, pw, screens] of [['cash', 'cashier-pass-1', ['new', 'orders', 'inventory', 'board']], ['owner', 'owner-pass-1', ['products', 'users']]]) {
  await check(`phone (390 wide): ${screens.join(', ')} do not scroll sideways`, async () => {
    const p = await newPage(await phone());
    await login(p, who, pw);
    for (const sc of screens) {
      await p.goto(base + '/#/' + sc);
      await p.waitForTimeout(700);
      const w = await p.evaluate(() => ({ s: Math.max(document.documentElement.scrollWidth, ...[...document.querySelectorAll('main *')].filter((e) => { for (let a = e.parentElement; a && a.id !== 'main'; a = a.parentElement) if (/auto|scroll|hidden/.test(getComputedStyle(a).overflowX)) return false; return getComputedStyle(e).position !== 'fixed'; }).map((e) => Math.ceil(e.getBoundingClientRect().right))), i: window.innerWidth }));
      assert.ok(w.s <= w.i + 1, `${sc}: page is ${w.s}px wide on a ${w.i}px screen`);
      await p.screenshot({ path: SHOTS + `/r22-m-${sc}.png` });
    }
    await p.context().close();
  });
}

await check('phone: Products rows become cards and the Edit menu works; Advanced and Units box fit', async () => {
  const p = await newPage(await phone());
  await login(p, 'owner', 'owner-pass-1');
  await p.goto(base + '/#/products');
  await p.waitForSelector('table.data--cards');
  assert.equal(await p.locator('table.data--cards thead').evaluate((e) => getComputedStyle(e).position), 'absolute');
  await p.click('[data-tab="other"]');
  const row = rowOf(p, 'Garlic');
  await row.locator('[data-menu]').click();
  await row.locator('[data-options]').click();
  await p.waitForSelector('.opts-table');
  const box = await p.locator('dialog[open]').boundingBox();
  assert.ok(box.width <= 390, 'dialog fits: ' + box.width);
  await p.screenshot({ path: SHOTS + '/r22-m-units.png' });
  await p.keyboard.press('Escape');
  await p.goto(base + '/#/new');
  await p.waitForSelector('.tab--adv', { state: 'attached' });
  await p.click('.tab--adv');
  await p.click('[data-adv="section"][data-v="cash"]');
  await p.waitForSelector('[data-step="3"]');
  const w = await p.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 391, 'cash fits: ' + w);
  await p.screenshot({ path: SHOTS + '/r22-m-cash.png' });
  await p.context().close();
});

await check('no script errors on any page', async () => { assert.deepEqual(errs, []); });
await browser.close(); server.close();
const passed = out.filter((l) => l.startsWith('PASS')).length;
console.log('\n' + passed + ' of ' + out.length + ' browser checks passed');
process.exit(passed === out.length ? 0 : 1);
