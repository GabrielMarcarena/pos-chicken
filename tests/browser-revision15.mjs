// Browser test for Revisions 14-15 (tracking number, Butcher and Customer screens). Drives the real screens in Chromium (Playwright). Uses its own in-memory database, never real data.
// Run:  npm run test:browser   (needs `npm install` and `npx playwright install chromium`)
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
const { createProduct } = await import(path.join(root, 'src/services/catalog.js'));
const { getInventory, updateRecord } = await import(path.join(root, 'src/services/inventory.js'));
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-shots-'));

const db = openDb(':memory:');
const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
createUser(db, { username: 'cash2', display_name: 'Cashier Two', role: 'cashier', password: 'cashier-pass-2' });
createUser(db, { username: 'butcher-tv', display_name: 'Butcher TV', role: 'display', password: 'butcher-pass-1' });
createProduct(db, admin, { name: 'Broilers', price: '150' });
for (const row of getInventory(db, admin, {}, new Date()).chicken) updateRecord(db, admin, row.id, { rev: row.rev, beginning: 500, reason: 'RECOUNT' }, new Date());
const server = createApp({ db, config: loadConfig({ dbPath: ':memory:' }) }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch();
const out = [];
const check = async (name, fn) => { try { await fn(); out.push('PASS ' + name); } catch (e) { out.push('FAIL ' + name + ' :: ' + String(e.message).split('\n').slice(0, 4).join(' | ')); } console.log(out.at(-1)); };
const page = async (ctx) => { const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.errs = []; p.on('pageerror', (e) => p.errs.push(e.message)); return p; };
const login = async (p, u, pw) => { await p.goto(base); await p.fill('#username', u); await p.fill('#password', pw); await p.click('#loginBtn'); };

const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const cash = await page(ctxA);
await login(cash, 'cash', 'cashier-pass-1');
await cash.waitForSelector('.product-card');

async function addChicken(p, kg) {
  await p.click('.product-card:has-text("Broilers")');
  for (const ch of String(kg)) await p.click('[data-key="' + ch + '"]');
  await p.click('[data-action="prep-service"][data-v="NOT_POUR_SLICE"]');
  await p.click('[data-action="prep-cut"][data-v="MEDIUM"]');
  await p.click('#addBtn');
}

await check('tracking box appears with the lowest free number once chicken is added', async () => {
  assert.equal(await cash.locator('#tracking').count(), 0, 'no box with an empty order');
  await addChicken(cash, '3.2');
  await cash.waitForSelector('#tracking');
  await cash.waitForFunction(() => document.querySelector('#tracking').value === '1');
  await cash.screenshot({ path: SHOTS + '/1-cashier-tracking.png' });
});

const [customer] = await Promise.all([cash.waitForEvent('popup'), cash.click('[data-action="open-customer"]')]);
customer.setDefaultTimeout(6000); customer.errs = []; customer.on('pageerror', (e) => customer.errs.push(e.message));
await check('customer screen opens clean (no tabs) and shows the item and total', async () => {
  await customer.waitForSelector('.cs');
  assert.equal(await customer.locator('#topbar:not([hidden])').count(), 0);
  await customer.waitForFunction(() => /Broilers/.test(document.body.innerText) && /Total/.test(document.body.innerText));
  await customer.setViewportSize({ width: 1280, height: 720 });
  await customer.screenshot({ path: SHOTS + '/2-customer-order.png' });
});

await check('the number can be typed and non-digits are dropped; Auto brings back the lowest free one', async () => {
  await cash.fill('#tracking', '7x');
  assert.equal(await cash.inputValue('#tracking'), '7');
  await cash.click('[data-action="tracking-auto"]');
  await cash.waitForFunction(() => document.querySelector('#tracking').value === '1');
});

await check('review shows the tracking number; submit saves it; done screen shows it big; customer screen says thank you', async () => {
  await cash.click('[data-action="go-review"]');
  await cash.waitForSelector('.slip-tracking');
  assert.match(await cash.locator('.slip-tracking').innerText(), /#1/);
  await cash.check('#reviewed');
  await cash.selectOption('#payMethod', 'CASH');
  await cash.fill('#payReceived', '1000');
  await customer.waitForFunction(() => /Cash received/.test(document.body.innerText) && /Change/.test(document.body.innerText));
  await customer.screenshot({ path: SHOTS + '/3-customer-cash.png' });
  await cash.click('#submitBtn');
  await cash.waitForSelector('[data-tracking-big]');
  assert.match(await cash.locator('[data-tracking-big]').innerText(), /#1/);
  await cash.screenshot({ path: SHOTS + '/4-cashier-done.png' });
  await customer.waitForFunction(() => /Thank you/.test(document.body.innerText) && /#1/.test(document.body.innerText));
  await customer.screenshot({ path: SHOTS + '/5-customer-thanks.png' });
});

await check('a second cashier typing the same number gets the exact message', async () => {
  const c2 = await page(await browser.newContext({ viewport: { width: 1280, height: 800 } }));
  await login(c2, 'cash2', 'cashier-pass-2');
  await c2.waitForSelector('.product-card');
  await addChicken(c2, '2');
  await c2.waitForFunction(() => document.querySelector('#tracking').value === '2', null, { timeout: 6000 });   // 1 is taken, so Auto says 2
  await c2.fill('#tracking', '1');
  await c2.click('[data-action="go-review"]');
  await c2.check('#reviewed');
  await c2.selectOption('#payMethod', 'CASH');
  await c2.fill('#payReceived', '1000');
  await c2.click('#submitBtn');
  await c2.waitForSelector('#submitError .error-box');
  assert.match(await c2.locator('#submitError').innerText(), /Tracking number 1 is already taken\. Please select a different number\./);
  await c2.screenshot({ path: SHOTS + '/6-duplicate-error.png' });
  await c2.click('[data-action="review-back"]');
  await c2.waitForFunction(() => document.querySelector('#tracking').value === '2');   // a free number is filled back in
});

await check('a Live-only order shows no tracking box', async () => {
  const c3 = await page(await browser.newContext({ viewport: { width: 1280, height: 800 } }));
  await login(c3, 'cash2', 'cashier-pass-2');
  await c3.waitForSelector('.product-card');
  await c3.click('.product-card:has-text("Broilers")');
  for (const ch of '2') await c3.click('[data-key="' + ch + '"]');
  await c3.click('[data-action="prep-service"][data-v="LIVE"]');
  await c3.click('#addBtn');
  await c3.waitForSelector('.line');
  await new Promise((r) => setTimeout(r, 800));
  assert.equal(await c3.locator('#tracking').count(), 0);
});
const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const tv = await page(tvCtx);
await check('butcher TV account signs in straight to the Butcher screen: no tabs, no sign-out, tag #1 big under Ongoing', async () => {
  await login(tv, 'butcher-tv', 'butcher-pass-1');
  await tv.waitForSelector('.bt-card');
  assert.match(tv.url(), /#\/butcher/);
  assert.equal(await tv.locator('#topbar:not([hidden])').count(), 0);
  const text = await tv.locator('.bt-ongoing').innerText();
  assert.match(text, /1/); assert.match(text, /DRESS & SLICE/i); assert.match(text, /MEDIUM/i); assert.doesNotMatch(await tv.locator('body').innerText(), /₱|Total|Sign out/);
  await tv.screenshot({ path: SHOTS + '/7-butcher-ongoing.png' });
});
await check('the TV account cannot open other screens (address is forced back to butcher)', async () => {
  await tv.goto(base + '/#/orders');
  await tv.waitForSelector('.bt');
  assert.match(tv.url(), /#\/butcher/);
});

const api = (method, url) => cash.evaluate(async ([m, u]) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-requested-with': 'pos' }, body: m === 'GET' ? undefined : JSON.stringify({ status: 'STANDBY' }) }); return r.status; }, [method, url]);
await check('moving to Standby shrinks it to the side list within a few seconds; Complete removes it', async () => {
  const id = db.prepare('SELECT id FROM orders ORDER BY id LIMIT 1').get().id;
  // The animation classes only live for a moment, so a watcher records them instead of the test racing to look at the right instant.
  await tv.evaluate(() => {
    window.__seen = new Set();
    const look = () => { if (document.querySelector('.bt-card.bt-leave')) window.__seen.add('leave'); if (document.querySelector('.bt-sbrow.bt-enter')) window.__seen.add('enter'); };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  assert.equal(await api('POST', '/api/orders/' + id + '/fulfillment'), 200);
  await tv.waitForFunction(() => window.__seen.has('leave') && window.__seen.has('enter'), null, { timeout: 8000 });   // the card shrank away while a row slid into Standby
  await tv.waitForFunction(() => document.querySelectorAll('.bt-sbrow').length === 1 && document.querySelectorAll('.bt-card').length === 0, null, { timeout: 8000 });
  await tv.screenshot({ path: SHOTS + '/8-butcher-standby.png' });
  await cash.evaluate(async (i) => { await fetch('/api/orders/' + i + '/fulfillment', { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'pos' }, body: JSON.stringify({ status: 'COMPLETE' }) }); }, id);
  await tv.waitForFunction(() => document.querySelectorAll('.bt-sbrow').length === 0, null, { timeout: 8000 });
});
await check('a new order appears on the TV with the NEW glow', async () => {
  await cash.click('[data-action="new-order"]');
  await addChicken(cash, '1.5');
  await cash.click('[data-action="go-review"]');
  await cash.check('#reviewed'); await cash.selectOption('#payMethod', 'CASH'); await cash.fill('#payReceived', '500'); await cash.click('#submitBtn');
  await cash.waitForSelector('[data-tracking-big]');
  await tv.waitForSelector('.bt-card.bt-new', { timeout: 8000 });
  await tv.screenshot({ path: SHOTS + '/9-butcher-new.png' });
});
await check('Order List card and Orders list show the tracking number', async () => {
  await cash.goto(base + '/#/board');
  await cash.waitForSelector('.kcard-track');
  const [tab] = await Promise.all([ctxA.waitForEvent('page'), cash.click('#boardButcher')]);
  await tab.waitForSelector('.bt');
  assert.equal(await tab.locator('#topbar:not([hidden])').count(), 0);
  assert.equal(await tab.locator('.bt-exit').count(), 0, 'the Back link is gone');
  await tab.close();
  await cash.screenshot({ path: SHOTS + '/10-board.png' });
  await cash.goto(base + '/#/orders');
  await cash.waitForSelector('[data-tracking]');
});
await check('no script errors on any page', async () => { assert.deepEqual([...cash.errs, ...customer.errs, ...tv.errs], []); });

await browser.close(); server.close();
const passed = out.filter((l) => l.startsWith('PASS')).length;
console.log('\n' + passed + ' of ' + out.length + ' browser checks passed');
process.exit(passed === out.length ? 0 : 1);
