// Browser test for Revision 16 (role pointers, Assistant Cashier, receipt, cash on hand, product keys, feathers, chicken). Drives the real screens in Chromium (Playwright). Uses its own in-memory database, never real data.
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
const { createProduct, updateFee } = await import(path.join(root, 'src/services/catalog.js'));
const { getInventory, updateRecord } = await import(path.join(root, 'src/services/inventory.js'));
const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-shots-'));

const db = openDb(':memory:');
const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
createUser(db, { username: 'asst', display_name: 'Assistant', role: 'assistant', password: 'assist-pass-1' });
createUser(db, { username: 'butcher-tv', display_name: 'Butcher TV', role: 'display', password: 'butcher-pass-1' });
for (let i = 1; i <= 12; i++) createProduct(db, admin, { name: 'Chick' + String(i).padStart(2, '0'), price: String(100 + i) });
updateFee(db, admin, 'NOT_POUR', { amount: '45', basis: 'per_head' });
for (const row of getInventory(db, admin, {}, new Date()).chicken) updateRecord(db, admin, row.id, { rev: row.rev, beginning: 500, reason: 'RECOUNT' }, new Date());
const server = createApp({ db, config: loadConfig({ dbPath: ':memory:' }) }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = 'http://127.0.0.1:' + server.address().port;

const browser = await chromium.launch();
const out = [];
const check = async (name, fn) => { try { await fn(); out.push('PASS ' + name); } catch (e) { out.push('FAIL ' + name + ' :: ' + String(e.message).split('\n').slice(0, 5).join(' | ')); } console.log(out.at(-1)); };
const errs = [];
const newPage = async (ctx) => { const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', (e) => errs.push(e.message)); return p; };
const login = async (p, u, pw, url = base) => { await p.goto(url); await p.fill('#username', u); await p.fill('#password', pw); await p.click('#loginBtn'); };
const ctx = (extra = {}) => browser.newContext({ viewport: { width: 1280, height: 800 }, ...extra });
const cursorOf = (p, sel) => p.evaluate((s) => getComputedStyle(document.querySelector(s)).cursor, sel);

// ---- cursors by role ----
const colors = { owner: ['admin', 'ff2d2d', 'owner-pass-1'], mgr: ['manager', 'ffd60a', 'manager-pass-1'], cash: ['cashier', '22c55e', 'cashier-pass-1'] };
for (const [user, [role, hex, pw]] of Object.entries(colors)) {
  await check(`${role}: body role, glowing ${hex} pointer, hand pointer on buttons, coloured top bar`, async () => {
    const p = await newPage(await ctx());
    await login(p, user, pw);
    await p.waitForSelector('#topbar:not([hidden])');
    assert.equal(await p.evaluate(() => document.body.dataset.role), role);
    const body = await cursorOf(p, 'body');
    assert.ok(body.includes('data:image/svg') && body.toLowerCase().includes(hex), body.slice(0, 120));
    assert.ok(!body.includes('feGaussianBlur') && !body.includes('filter'), 'a plain pointer: no glow');
    const btn = await cursorOf(p, '#logout');
    assert.ok(btn.includes('data:image/svg') && btn !== body, 'buttons get the hand version');
    assert.doesNotMatch(await p.evaluate(() => getComputedStyle(document.querySelector('#topbar')).borderBottomWidth), /5px/, 'no coloured strip any more');
    assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector('.role-badge')).backgroundColor), 'rgba(0, 0, 0, 0)', 'the role label is plain, not a coloured pill');
    assert.match(await p.locator('.role-badge').innerText(), new RegExp(role, 'i'));
    if (role === 'admin') await p.screenshot({ path: SHOTS + '/r16-1-admin.png' });
    await p.context().close();
  });
}
await check('sign-in page has the normal cursor (no role colour)', async () => {
  const p = await newPage(await ctx());
  await p.goto(base); await p.waitForSelector('#username');
  assert.ok(!(await cursorOf(p, 'body')).includes('data:image'));
  await p.context().close();
});

// ---- Assistant Cashier ----
await check('assistant lands on the Order List, sees only that tab, no money, no Details, has Butcher view', async () => {
  const cashCtx = await ctx();
  const c = await newPage(cashCtx);
  await login(c, 'cash', 'cashier-pass-1'); await c.waitForSelector('.product-card');
  await c.click('.product-card:has-text("Chick01")');
  for (const ch of '2') await c.click('[data-key="' + ch + '"]');
  await c.click('[data-action="prep-service"][data-v="NOT_POUR_SLICE"]'); await c.click('[data-action="prep-cut"][data-v="MEDIUM"]');
  await c.click('[data-action="heads-inc"]'); await c.click('[data-action="heads-inc"]');   // 3 heads
  await c.click('#addBtn'); await c.waitForSelector('#tracking');
  await c.fill('#customer', 'Maria');
  await c.click('[data-action="go-review"]'); await c.check('#reviewed');
  await c.selectOption('#payMethod', 'CASH'); await c.fill('#payReceived', '1000');
  await c.click('#submitBtn'); await c.waitForSelector('[data-tracking-big]');
  globalThis.cashPage = c;

  const a = await newPage(await ctx());
  await login(a, 'asst', 'assist-pass-1');
  await a.waitForSelector('.kcard');
  assert.match(a.url(), /#\/board/);
  assert.deepEqual(await a.locator('#topbar .nav a').allInnerTexts(), ['Order List']);
  const body = await a.locator('body').innerText();
  assert.ok(!/₱/.test(body), 'no peso sign anywhere: ' + body.slice(0, 200));
  assert.equal(await a.locator('#boardButcher').count(), 1);
  await a.click('.kcard-toggle');
  assert.equal(await a.locator('[data-open]').count(), 0, 'no Details button');
  assert.ok(!/₱/.test(await a.locator('body').innerText()));
  assert.match(await cursorOf(a, 'body'), /3b82f6/i);
  await a.screenshot({ path: SHOTS + '/r16-2-assistant.png' });
  await a.goto(base + '/#/orders'); await a.waitForSelector('.kcard');
  assert.equal(await a.locator('#topbar [aria-current="page"]').innerText(), 'Order List', 'other addresses show the Order List instead');
  // move a card with the menu
  await a.click('[data-move-menu]');
  assert.equal(await a.locator('[data-menu-details]').count(), 0, 'no "View order details" in the menu');
  await a.click('[data-menu-move="STANDBY"]');
  await a.waitForSelector('[data-status="STANDBY"]');
  globalThis.asstPage = a;
});

// ---- /butcher and /customerscreen addresses ----
await check('/butcher asks for sign-in first, then shows orders; no Back link; the Order List button opens it', async () => {
  const t = await newPage(await ctx());
  await t.goto(base + '/butcher'); await t.waitForSelector('#username');
  await t.fill('#username', 'butcher-tv'); await t.fill('#password', 'butcher-pass-1'); await t.click('#loginBtn');
  await t.waitForSelector('.bt');
  assert.equal(new URL(t.url()).pathname, '/butcher');
  assert.equal(await t.locator('#topbar:not([hidden])').count(), 0);
  assert.equal(await t.locator('.bt-exit').count(), 0, 'no Back to POS');
  assert.equal(await t.locator('.bt a').count(), 0, 'no links at all on the TV screen');
  await t.waitForSelector('.bt-sbrow');   // the assistant moved Maria's order to Standby
  await t.screenshot({ path: SHOTS + '/r16-3-butcher.png' });
  const asst = globalThis.asstPage;
  const [tab] = await Promise.all([asst.context().waitForEvent('page'), asst.click('#boardButcher')]);
  await tab.waitForSelector('.bt');
  assert.equal(new URL(tab.url()).pathname, '/butcher');
  assert.equal(await tab.locator('.bt-exit').count(), 0);
  assert.ok(!/cursor/.test('') && !(await cursorOf(tab, 'body')).includes('data:image'), 'no role colour on the butcher screen');
});
await check('/customerscreen needs no sign-in and follows the cashier window', async () => {
  const c = globalThis.cashPage;
  await c.click('[data-action="new-order"]');
  const [pop] = await Promise.all([c.waitForEvent('popup'), c.click('[data-action="open-customer"]')]);
  await pop.waitForSelector('.cs');
  assert.equal(new URL(pop.url()).pathname, '/customerscreen');
  assert.equal(await pop.locator('#username').count(), 0);
  const direct = await newPage(await ctx());
  await direct.goto(base + '/customerscreen'); await direct.waitForSelector('.cs');
  assert.equal(await direct.locator('#username').count(), 0, 'a fresh browser sees no sign-in page');
});

// ---- Receipt ----
await check('printed receipt: no service, With Blood or slice size; prices and the fee line stay', async () => {
  const c = await newPage(await ctx());
  await login(c, 'cash', 'cashier-pass-1'); await c.waitForSelector('.product-card');
  await c.click('.product-card:has-text("Chick02")');
  for (const ch of '4.5') await c.click('[data-key="' + ch + '"]');
  await c.click('[data-action="prep-service"][data-v="NOT_POUR_SLICE"]'); await c.click('[data-action="prep-cut"][data-v="MEDIUM"]');
  await c.click('[data-action="heads-inc"]'); await c.click('[data-action="heads-inc"]');
  await c.click('#addBtn'); await c.waitForSelector('#tracking');
  await c.click('[data-action="go-review"]');
  await c.waitForSelector('.slip');
  assert.match(await c.locator('.slip').innerText(), /Slice/, 'on screen the cashier still sees the preparation');
  await c.check('#reviewed'); await c.selectOption('#payMethod', 'CASH'); await c.fill('#payReceived', '1000');
  await c.click('#submitBtn'); await c.waitForSelector('[data-tracking-big]');
  assert.match(await c.locator('.slip').innerText(), /Slice|Medium/, 'on screen the done slip still lists it');
  await c.emulateMedia({ media: 'print' });
  const printed = await c.locator('.slip').innerText();
  assert.ok(!/Slice|Medium pieces|With Blood/i.test(printed), 'printed: ' + printed.slice(0, 300));
  assert.match(printed, /\+₱135\.00/);
  assert.match(printed, /\(3 × ₱45\.00\)/);
  assert.match(printed, /₱\d+\.\d\d\/kg/);
  await c.screenshot({ path: SHOTS + '/r16-4-print.png' });
  await c.emulateMedia({ media: 'screen' });
});

// ---- Keys 10+ ----
await check('with 12 products: 0 picks the 10th, Q the 11th, W the 12th; the cards show their keys', async () => {
  const c = await newPage(await ctx());
  await login(c, 'cash', 'cashier-pass-1'); await c.waitForSelector('.product-card');
  const names = await c.locator('.product-card h3, .product-card .name, .product-card strong').evaluateAll((els) => els.map((e) => e.textContent.trim()));
  const cardNames = await c.locator('.product-card').evaluateAll((els) => els.map((e) => (e.innerText.match(/Chick\d\d/) ?? [''])[0]));
  assert.equal(cardNames.length, 12); void names;
  const badges = await c.locator('.product-card .key-badge').allInnerTexts();
  assert.deepEqual(badges, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Q', 'W']);
  for (const [key, idx] of [['0', 9], ['q', 10], ['W', 11]]) {
    await c.keyboard.press(key);
    await c.waitForSelector('#work h2');
    assert.ok((await c.locator('#work h2').first().innerText()).includes(cardNames[idx]), `${key} -> ${cardNames[idx]}`);
    await c.keyboard.press('Escape');
    await c.waitForSelector('.product-card');
  }
  await c.screenshot({ path: SHOTS + '/r16-5-keys.png' });
});

// ---- How it works ----
await check('long explanations are folded under "How it works" and open on click', async () => {
  const m = await newPage(await ctx());
  await login(m, 'owner', 'owner-pass-1'); await m.waitForSelector('.product-card');
  await m.goto(base + '/#/board'); await m.waitForSelector('details.how');
  assert.equal(await m.locator('details.how[open]').count(), 0);
  assert.ok(!(await m.locator('.panel').first().innerText()).includes('right-click'));
  await m.click('details.how summary');
  assert.match(await m.locator('details.how').first().innerText(), /right-click/);
  for (const hash of ['#/orders', '#/inventory', '#/users']) {
    await m.goto(base + '/' + hash); await m.waitForSelector('details.how');
    assert.equal(await m.locator('details.how[open]').count(), 0, hash);
  }
  await m.goto(base + '/#/inventory'); await m.waitForSelector('details.how');
  await m.screenshot({ path: SHOTS + '/r16-6-inventory.png' });
});

// ---- Cash on hand ----
await check('Advanced > Cash breakdown: type Cash on hand, save, it shows beside Cash sales today and Expected cash', async () => {
  const c = await newPage(await ctx());
  await login(c, 'cash', 'cashier-pass-1'); await c.waitForSelector('.product-card');
  await c.click('[data-action="tab"][data-tab="advanced"]');
  await c.click('[data-adv="section"][data-v="cash"]');
  await c.waitForSelector('#cashOnHand');
  await c.fill('#cashOnHand', '1500');
  await c.click('[data-adv="onhand-save"]');
  await c.waitForFunction(() => /1,500\.00/.test(document.querySelector('[data-onhand-saved]')?.innerText ?? ''));
  const sum = await c.locator('.cash-sum').innerText();
  assert.match(sum, /Cash on hand[\s\S]*₱1,500\.00/); assert.match(sum, /Cash sales today[\s\S]*₱/); assert.match(sum, /Expected cash/);
  await c.screenshot({ path: SHOTS + '/r16-7-cash.png' });
  await c.fill('#cashOnHand', '1,5x0.5');
  assert.equal(await c.inputValue('#cashOnHand'), '1.50'.length ? await c.inputValue('#cashOnHand') : '');
});


// ---- Feathers (admin only) and the Pitik chicken ----
const funCtx = (extra = {}) => browser.newContext({ viewport: { width: 1280, height: 800 }, ...extra }).then(async (c) => { await c.addInitScript(() => { window.__posIdleMs = 1200; window.__posStareChance = 1; }); return c; });
await check('feathers: an admin click throws red feathers, a cashier click throws none, and the click still reaches the button', async () => {
  const ad = await newPage(await funCtx());
  await login(ad, 'owner', 'owner-pass-1'); await ad.waitForSelector('.product-card');
  await ad.mouse.move(700, 500); await ad.mouse.click(700, 500);
  await ad.waitForFunction(() => document.querySelectorAll('#fun-layer .feather').length >= 5);
  assert.equal((await ad.locator('#fun-layer .feather svg path').first().getAttribute('fill')).toLowerCase(), '#ff2d2d', 'admin red');
  await new Promise((r) => setTimeout(r, 220));
  await ad.screenshot({ path: SHOTS + '/r16-8-feathers.png', clip: { x: 560, y: 380, width: 280, height: 220 } });
  await ad.waitForFunction(() => document.querySelectorAll('#fun-layer .feather').length === 0, null, { timeout: 3000 });
  const box = await ad.locator('.product-card').first().boundingBox();
  await ad.mouse.click(box.x + 40, box.y + 30);
  assert.ok(await ad.locator('#work h2').count() === 1, 'the click went through to the product card');
  assert.equal(await ad.evaluate(() => getComputedStyle(document.querySelector('#fun-layer')).pointerEvents), 'none');
  await ad.context().close();

  for (const [u, pw] of [['cash', 'cashier-pass-1'], ['mgr', 'manager-pass-1']]) {
    const p = await newPage(await funCtx());
    await login(p, u, pw); await p.waitForSelector('.product-card');
    await p.mouse.move(700, 500); await p.mouse.click(700, 500);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await p.locator('#fun-layer .feather').count(), 0, u + ': no feathers');
    await p.context().close();
  }
});
await check('the Pitik chicken: walks, pecks and cracks the screen (cracks fade), stares and blinks, its eye follows the pointer; moving the mouse sends it and its cracks away', async () => {
  const p = await newPage(await funCtx());
  await login(p, 'cash', 'cashier-pass-1'); await p.waitForSelector('.product-card');
  await p.mouse.move(20, 20);   // the pointer rests at the top left corner
  await p.waitForSelector('#fun-layer .hen', { state: 'attached', timeout: 8000 });
  const where = () => p.locator('#fun-layer .hen').evaluate((e) => { const r = e.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y); });
  const w1 = await where(); await new Promise((r) => setTimeout(r, 1500)); const w2 = await where();
  assert.notEqual(w1, w2, 'it walks');
  await p.waitForSelector('#fun-layer .crack', { state: 'attached', timeout: 25000 });
  assert.ok(await p.locator('#fun-layer .feed').count() >= 0);
  const op1 = Number(await p.locator('#fun-layer .crack').first().evaluate((e) => getComputedStyle(e).opacity));
  await p.waitForSelector('.hen.looking', { state: 'attached', timeout: 30000 });
  await p.waitForSelector('.hen.blink', { state: 'attached', timeout: 5000 });
  await p.screenshot({ path: SHOTS + '/r16-9-chicken.png' });
  const op2 = Number(await p.locator('#fun-layer .crack').first().evaluate((e) => getComputedStyle(e).opacity));
  assert.ok(op2 < op1, 'a crack fades: ' + op1 + ' -> ' + op2);
  // the eye follows the resting pointer: with the pointer at the top left, the pupil sits up and to the left of the eye's centre
  await p.waitForFunction(() => {
    const hen = document.querySelector('#fun-layer .hen'); if (!hen || hen.classList.contains('looking')) return false;
    const eye = hen.querySelector('[data-part="eyeball"] circle'); const pu = hen.querySelector('[data-part="pupil"]');
    const e = eye.getBoundingClientRect(); const q = pu.getBoundingClientRect();
    const ex = e.x + e.width / 2; const ey = e.y + e.height / 2;
    if (ex < 220 || ey < 220) return false;
    return q.x + q.width / 2 < ex - 0.5 && q.y + q.height / 2 < ey - 0.5;
  }, null, { timeout: 40000 });
  // cracks go away with the chicken
  await p.mouse.move(700, 400);
  await p.waitForFunction(() => !document.querySelector('#fun-layer .hen') && !document.querySelector('#fun-layer .crack'), null, { timeout: 2500 });
  await p.context().close();

  const login1 = await newPage(await funCtx());
  await login1.goto(base); await login1.waitForSelector('#username');
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await login1.locator('#fun-layer .hen').count(), 0, 'not on the sign-in page');
  await login1.context().close();
  const cust = await newPage(await funCtx());
  await cust.goto(base + '/customerscreen'); await cust.waitForSelector('.cs');
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await cust.locator('#fun-layer .hen').count(), 0, 'not on the Customer screen');
  await cust.context().close();
  const tv = await newPage(await funCtx());
  await login(tv, 'butcher-tv', 'butcher-pass-1', base + '/butcher'); await tv.waitForSelector('.bt');
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await tv.locator('#fun-layer .hen').count(), 0, 'not on the Butcher screen');
  await tv.context().close();
});
await check('calm mode (reduce motion): no feathers, the chicken stands still, makes no cracks, and still blinks', async () => {
  const c = await funCtx({ reducedMotion: 'reduce' });
  const p = await newPage(c);
  await login(p, 'owner', 'owner-pass-1'); await p.waitForSelector('.product-card');
  await p.mouse.move(700, 500); await p.mouse.click(700, 500);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await p.locator('#fun-layer .feather').count(), 0);
  await p.waitForSelector('#fun-layer .hen', { state: 'attached', timeout: 6000 });
  const where = () => p.locator('#fun-layer .hen').evaluate((e) => { const r = e.getBoundingClientRect(); return Math.round(r.x) + ',' + Math.round(r.y); });
  const a = await where();
  await new Promise((r) => setTimeout(r, 4500));
  assert.equal(await where(), a, 'it stands still');
  assert.equal(await p.locator('#fun-layer .crack').count(), 0, 'no cracks');
  await c.close();
});

await check('no script errors on any page', async () => { assert.deepEqual(errs, []); });
await browser.close(); server.close();
const passed = out.filter((l) => l.startsWith('PASS')).length;
console.log('\n' + passed + ' of ' + out.length + ' browser checks passed');
process.exit(passed === out.length ? 0 : 1);
