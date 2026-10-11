// Browser test: drives the real screens in Chromium (needs Playwright: `npm install` then `npx playwright install chromium`).
// It starts its own server with an in-memory database, so it never touches real data.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createProduct, createOtherProduct, updateFee } from '../src/services/catalog.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright'));
}

const db = openDb(':memory:');
const admin = createUser(db, { username: 'owner', display_name: 'Owner', role: 'admin', password: 'owner-pass-1' });
createUser(db, { username: 'mgr', display_name: 'Manager', role: 'manager', password: 'manager-pass-1' });
createUser(db, { username: 'cash', display_name: 'Cashier', role: 'cashier', password: 'cashier-pass-1' });
createProduct(db, admin, { name: 'Cull Chicken', price: '58' });
createProduct(db, admin, { name: 'Broilers', price: '120' });
createProduct(db, admin, { name: 'Broiler Breeder Cull', price: '52' });
createOtherProduct(db, admin, { name: 'Eggs (Small)', options: [{ unit: 'dozen', sold_by: 'FIXED', price: '120' }, { unit: 'piece', sold_by: 'FIXED', price: '10' }] });
createOtherProduct(db, admin, { name: 'Garlic', options: [{ unit: 'kg', sold_by: 'PER_KG', price: '80' }] });
updateFee(db, admin, 'POUR', { amount: '45', basis: 'per_item' });   // Po-ur & Slice (burn chicken)
updateFee(db, admin, 'NOT_POUR', { amount: '25', basis: 'per_item' }); // Dressed & Slice (dress chicken)
const server = createApp({ db, config: loadConfig({ dbPath: ':memory:' }) }).listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

fs.mkdirSync('/tmp/shots', { recursive: true });
const browser = await chromium.launch();
const results = [];
const problems = [];
let manager, adminPage;
const cashier0 = [];
const step = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); } catch (err) {
    results.push(`FAIL  ${name}\n      ${String(err.message).split('\n').slice(0, 4).join(' | ')}`); problems.push(name);
    for (const [i, p] of [cashier0[0], manager, adminPage].filter(Boolean).entries()) {
      await p.screenshot({ path: `/tmp/shots/fail-${problems.length}-${i}.png` }).catch(() => {});
      const info = await p.evaluate(() => ({ open: document.querySelector('#dialog').open, dialog: document.querySelector('#dialog').innerText.slice(0, 300), url: location.hash })).catch(() => null);
      console.log(`      [page ${i}] ${JSON.stringify(info)} api errors: ${JSON.stringify(p.apiLog ?? [])}`);
      await p.keyboard.press('Escape').catch(() => {}); // close any open dialog so one failure does not cascade
    }
  }
  console.log(results.at(-1));
};

async function newPage(viewport = { width: 1100, height: 800 }) {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`pageerror: ${e.message}`));
  // Only real script errors and security-policy violations count. Chrome also logs every expected 400/409 reply, which is not a bug.
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) page.errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.url().includes('/api/') && r.request().method() !== 'GET' && r.status() >= 400) page.apiLog = [...(page.apiLog ?? []), `${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`]; });
  return page;
}
async function login(page, user, pass) {
  await page.goto(base);
  await page.fill('#username', user);
  await page.fill('#password', pass);
  await page.click('#loginBtn');
  await page.waitForSelector('#topbar:not([hidden])');
}
const on = async (loc) => (await loc.getAttribute('aria-checked')) === 'true';
const svc = (page, v) => page.locator(`[data-action="prep-feather"][data-v="${v}"]`);
const cut = (page, v) => page.locator(`[data-action="prep-cut"][data-v="${v}"]`);
const dara = (page) => page.locator('[data-action="prep-dara"]');
const typeKeys = async (page, text) => { for (const ch of text) await page.click(`[data-key="${ch}"]`); };
const checkedCuts = (page) => page.locator('[data-action="prep-cut"][aria-checked="true"]').count();

const cashier = await newPage();
cashier0.push(cashier);
await login(cashier, 'cash', 'cashier-pass-1');

await step('cashier sees chicken product cards with a picture and the price per kg', async () => {
  await cashier.waitForSelector('.product-card');
  const text = await cashier.locator('.product-grid').innerText();
  assert.match(text, /Cull Chicken/); assert.match(text, /₱58\.00\/kg/); assert.match(text, /Broilers/);
  assert.ok(await cashier.locator('.product-card .ico').count() >= 2);
  assert.equal(await cashier.locator('[href="#/products"]').count(), 0, 'cashier has no Products link');
  await cashier.screenshot({ path: '/tmp/shots/1-products.png' });
});

await step('3.6 kg at ₱58.00/kg shows ₱208.80 using the number pad; a service must be chosen first', async () => {
  await cashier.click('.product-card:has-text("Cull Chicken")');
  await typeKeys(cashier, '3.6');
  assert.equal(await cashier.inputValue('#amount'), '3.6');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱208.80');
  assert.match(await cashier.locator('#sum').innerText(), /₱58\.00\/kg × 3\.6 kg/);
  assert.equal(await cashier.locator('#addBtn').isDisabled(), true);
  assert.match(await cashier.locator('#hint').innerText(), /Choose Live, Po-ur & Slice or Dressed & Slice/);
});

await step('weight is validated and the price follows every change', async () => {
  await cashier.fill('#amount', '1.25');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱72.50');
  await cashier.fill('#amount', '4.75');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱275.50');
  await cashier.fill('#amount', '-3');
  assert.equal(await cashier.inputValue('#amount'), '3');
  await cashier.fill('#amount', '1.23456');
  assert.equal(await cashier.inputValue('#amount'), '1.234');
  await cashier.fill('#amount', '');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱0.00');
  assert.match(await cashier.locator('#hint').innerText(), /Enter the weight/);
  await cashier.fill('#amount', '3.6');
});

await step('the three services show their fee and exclude each other', async () => {
  const text = await cashier.locator('.service-grid').innerText();
  assert.match(text, /Live[\s\S]*No fee/); assert.match(text, /Po-ur & Slice[\s\S]*Burn chicken[\s\S]*\+₱45\.00/); assert.match(text, /Dressed & Slice[\s\S]*Dress chicken[\s\S]*\+₱25\.00/);
  await svc(cashier, 'POUR').click();
  assert.equal(await on(svc(cashier, 'POUR')), true);
  await svc(cashier, 'NOT_POUR').click();
  assert.equal(await on(svc(cashier, 'NOT_POUR')), true);
  assert.equal(await on(svc(cashier, 'POUR')), false);
  assert.equal(await on(svc(cashier, 'LIVE')), false);
  await svc(cashier, 'POUR').click();
  assert.equal(await on(svc(cashier, 'POUR')), true);
  assert.equal(await on(svc(cashier, 'NOT_POUR')), false);
});

await step('Po-ur & Slice needs a cutting choice: one slice size at a time, or Dukot as the last option', async () => {
  assert.equal(await cashier.locator('#addBtn').isDisabled(), true, 'cannot add before choosing a slice size or Dukot');
  assert.match(await cashier.locator('#hint').innerText(), /slice size or Dukot/);
  const labels = await cashier.locator('[data-action="prep-cut"]').allInnerTexts();
  assert.deepEqual(labels.map((t) => t.split('\n')[0]), ['Small pieces', 'Medium pieces', 'Large pieces', 'Dukot']);
  await cut(cashier, 'SMALL').click();
  await cut(cashier, 'MEDIUM').click();
  assert.equal(await on(cut(cashier, 'MEDIUM')), true);
  assert.equal(await on(cut(cashier, 'SMALL')), false);
  assert.equal(await checkedCuts(cashier), 1);
  await cut(cashier, 'DUKOT').click();
  assert.equal(await on(cut(cashier, 'DUKOT')), true);
  assert.equal(await on(cut(cashier, 'MEDIUM')), false);
  assert.equal(await checkedCuts(cashier), 1);
  assert.equal(await cashier.locator('#addBtn').isDisabled(), false);
  await cut(cashier, 'MEDIUM').click();
  assert.equal(await checkedCuts(cashier), 1);
});

await step('prices: Po-ur & Slice ₱253.80, Dressed & Slice ₱233.80, Live ₱208.80; Dara and the slice size do not change it', async () => {
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱253.80');
  assert.match(await cashier.locator('#sum').innerText(), /Po-ur & Slice[\s\S]*\+₱45\.00/);
  await dara(cashier).click();
  assert.equal(await on(dara(cashier)), true);
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱253.80');
  await cut(cashier, 'LARGE').click();
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱253.80');
  await svc(cashier, 'NOT_POUR').click();
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱233.80');
  assert.equal(await on(dara(cashier)), true, 'changing the service did not reset Dara');
  assert.equal(await on(cut(cashier, 'LARGE')), true, 'changing the service did not reset the cutting choice');
  await cashier.screenshot({ path: '/tmp/shots/2-configure.png' });
});

await step('choosing Live clears and disables Dara and cutting, and leaving Live does not bring them back', async () => {
  await svc(cashier, 'LIVE').click();
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱208.80');
  assert.equal(await dara(cashier).isDisabled(), true);
  assert.equal(await cut(cashier, 'SMALL').isDisabled(), true);
  assert.equal(await cut(cashier, 'DUKOT').isDisabled(), true);
  assert.equal(await on(dara(cashier)), false);
  assert.equal(await checkedCuts(cashier), 0);
  assert.equal(await cashier.locator('#addBtn').isDisabled(), false, 'Live is valid on its own');
  await svc(cashier, 'POUR').click();
  assert.equal(await on(dara(cashier)), false);
  assert.equal(await checkedCuts(cashier), 0);
  assert.equal(await cashier.locator('#addBtn').isDisabled(), true, 'needs a cutting choice again');
  await dara(cashier).click();
  await cut(cashier, 'MEDIUM').click();
});

await step('add the item: the order panel shows weight, price, service, slice size and the fee', async () => {
  await cashier.click('#addBtn');
  const panel = await cashier.locator('#orderPanel').innerText();
  assert.match(panel, /Cull Chicken/); assert.match(panel, /₱253\.80/); assert.match(panel, /3\.6 kg × ₱58\.00\/kg/);
  assert.match(panel, /Po-ur & Slice/); assert.match(panel, /Dara/); assert.match(panel, /Medium pieces/); assert.match(panel, /\+₱45\.00 Po-ur & Slice/);
  assert.equal(await cashier.locator('#orderTotal').innerText(), '₱253.80');
});

await step('a second chicken line (Dressed & Slice, large) has its own price; the total adds up', async () => {
  await cashier.click('.product-card:has-text("Broilers")');
  await cashier.fill('#amount', '2');
  await svc(cashier, 'NOT_POUR').click();
  await cut(cashier, 'LARGE').click();
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱265.00');
  await cashier.click('#addBtn');
  assert.equal(await cashier.locator('#orderTotal').innerText(), '₱518.80');
});

await step('other products: eggs show every way they are sold; fixed prices take whole numbers', async () => {
  await cashier.click('[data-tab="other"]');
  const grid = await cashier.locator('.product-grid').innerText();
  assert.match(grid, /Eggs \(Small\)[\s\S]*₱120\.00\/dozen[\s\S]*₱10\.00\/piece/); assert.match(grid, /Garlic[\s\S]*₱80\.00\/kg/);
  await cashier.fill('#otherSearch', 'gar');
  assert.equal(await cashier.locator('.product-card').count(), 1);
  await cashier.fill('#otherSearch', '');
  await cashier.click('.product-card:has-text("Eggs (Small)")');
  assert.equal(await cashier.locator('[data-key="."]').isDisabled(), true, 'no decimal point for dozens');
  await typeKeys(cashier, '2');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱240.00');           // 2 dozen at ₱120
  await cashier.locator('[data-action="pick-option"]:has-text("Per piece")').click();
  assert.equal(await cashier.inputValue('#amount'), '2');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱20.00');            // 2 pieces at ₱10
  await cashier.fill('#amount', '2.5');
  assert.equal(await cashier.inputValue('#amount'), '25', 'a decimal point is not accepted for pieces');
  await cashier.locator('[data-action="pick-option"]:has-text("Per dozen")').click();
  await cashier.fill('#amount', '2');
  await cashier.screenshot({ path: '/tmp/shots/3-eggs.png' });
  await cashier.click('#addBtn');
  assert.equal(await cashier.locator('#orderTotal').innerText(), '₱758.80');
});

await step('other products: a per-kg item takes a weight with decimals', async () => {
  await cashier.click('[data-tab="other"]');
  await cashier.click('.product-card:has-text("Garlic")');
  assert.equal(await cashier.locator('[data-key="."]').isDisabled(), false);
  assert.equal(await cashier.locator('[data-action="pick-option"]').count(), 1);
  await typeKeys(cashier, '1.5');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱120.00');
  await cashier.click('#addBtn');
  assert.equal(await cashier.locator('#orderTotal').innerText(), '₱878.80');
});

await step('editing a line updates only that line', async () => {
  await cashier.locator('[data-action="edit-line"][data-kind="chicken"]').first().click();
  assert.equal(await cashier.inputValue('#amount'), '3.6');
  assert.equal(await on(svc(cashier, 'POUR')), true);
  assert.equal(await on(cut(cashier, 'MEDIUM')), true);
  await cashier.fill('#amount', '3');
  await cashier.click('#addBtn');
  const lines = cashier.locator('#orderPanel .line');
  assert.equal(await lines.count(), 4);
  assert.match(await lines.nth(0).innerText(), /3\.0 kg × ₱58\.00\/kg/);
  assert.match(await lines.nth(0).innerText(), /₱219\.00/);
  assert.match(await lines.nth(1).innerText(), /Broilers[\s\S]*₱265\.00/);
  assert.match(await lines.nth(2).innerText(), /Eggs \(Small\)[\s\S]*₱240\.00[\s\S]*2 dozen × ₱120\.00\/dozen/);
  assert.match(await lines.nth(3).innerText(), /Garlic[\s\S]*₱120\.00[\s\S]*1\.5 kg × ₱80\.00\/kg/);
  assert.equal(await cashier.locator('#orderTotal').innerText(), '₱844.00');
});

await step('weights over 50 kg ask for confirmation', async () => {
  await cashier.click('[data-tab="chicken"]');
  await cashier.click('.product-card:has-text("Cull Chicken")');
  await cashier.fill('#amount', '60');
  await svc(cashier, 'LIVE').click();
  await cashier.click('#addBtn');
  await cashier.waitForSelector('dialog[open]');
  const dialogText = await cashier.locator('dialog').innerText();
  await cashier.click('[data-dlg-action="0"]');
  assert.match(dialogText, /60\.0 kg is more than 50 kg/);
  await cashier.locator('[data-action="cfg-back"]').first().click();
  assert.equal(await cashier.locator('#orderPanel .line').count(), 4, 'nothing was added');
});

await step('review: warning, locked submit, and Back keeps the order', async () => {
  await cashier.fill('#customer', 'C-2001');
  await cashier.click('[data-action="go-review"]');
  const text = await cashier.locator('.review').innerText();
  assert.match(text, /PLEASE DOUBLE-CHECK THE ORDER\. Verify every chicken type, weight, preparation option, and price before submitting\./);
  assert.match(text, /C-2001/); assert.match(text, /₱844\.00/); assert.match(text, /Order number is assigned when you submit/);
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), true, 'an unreviewed order cannot be submitted');
  await cashier.click('[data-action="review-back"]');
  assert.equal(await cashier.locator('#orderPanel .line').count(), 4);
  assert.equal(await cashier.inputValue('#customer'), 'C-2001');
  await cashier.click('[data-action="go-review"]');
});

await step('discount is optional: percentage or fixed, needs a reason, and can never be the whole order', async () => {
  assert.equal(await cashier.locator('#discType').inputValue(), 'NONE');
  await cashier.check('#reviewed');
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), false, 'no discount is fine');
  await cashier.selectOption('#discType', 'PERCENT');
  await cashier.fill('#discValue', '20');
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), true, 'a discount without a reason blocks submitting');
  assert.match(await cashier.locator('#discWarn').innerText(), /Choose a reason/);
  await cashier.selectOption('#discReason', 'SENIOR');
  assert.equal(await cashier.locator('#discWarn').innerText(), '');
  let totals = await cashier.locator('#totalsBody').innerText();
  assert.match(totals, /Subtotal[\s\S]*₱844\.00/); assert.match(totals, /Discount: Senior citizen \(20%\)[\s\S]*−₱168\.80/); assert.match(totals, /Grand total[\s\S]*₱675\.20/);
  await cashier.fill('#discValue', '100');
  assert.match(await cashier.locator('#discWarn').innerText(), /less than the order subtotal/);
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), true);
  await cashier.selectOption('#discType', 'FIXED');
  await cashier.fill('#discValue', '50');
  await cashier.selectOption('#discReason', 'OTHER');
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), true, 'Other needs an explanation');
  await cashier.fill('#discNote', 'Regular customer');
  totals = await cashier.locator('#totalsBody').innerText();
  assert.match(totals, /Grand total[\s\S]*₱794\.00/);
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), false);
  await cashier.selectOption('#discType', 'PERCENT');          // switch back to the senior citizen discount
  await cashier.fill('#discValue', '20');
  await cashier.selectOption('#discReason', 'SENIOR');
  assert.match(await cashier.locator('#totalsBody').innerText(), /Grand total[\s\S]*₱675\.20/);
  await cashier.screenshot({ path: '/tmp/shots/4-review.png', fullPage: true });
});

await step('a page refresh keeps the unsent order and its discount', async () => {
  await cashier.reload();
  await cashier.waitForSelector('#orderPanel');
  assert.equal(await cashier.locator('#orderPanel .line').count(), 4);
  assert.equal(await cashier.locator('#orderTotal').innerText(), '₱675.20');
  assert.match(await cashier.locator('.plate-note').innerText(), /Subtotal ₱844\.00 − discount ₱168\.80/);
});

await step('payment details: the amount starts at the discounted total and a mismatch is flagged', async () => {
  await cashier.click('[data-action="go-review"]');
  await cashier.selectOption('#payMethod', 'GCASH');
  await cashier.waitForSelector('#payName');
  assert.equal(await cashier.inputValue('#payAmount'), '675.20');
  await cashier.fill('#payAmount', '400');
  assert.match(await cashier.locator('#payWarn').innerText(), /different from the order total/);
  await cashier.fill('#payAmount', '675.20');
  assert.equal(await cashier.locator('#payWarn').innerText(), '');
  await cashier.fill('#payName', 'Juan Dela Cruz');
  await cashier.fill('#payNumber', '09171234567');
  await cashier.fill('#payRef', 'GC-778');
  await cashier.check('#reviewed');
});

let firstNumber;
await step('double-clicking Submit saves exactly one order with every detail', async () => {
  await cashier.dblclick('#submitBtn');
  await cashier.waitForSelector('.order-no-big');
  firstNumber = await cashier.locator('.order-no-big').innerText();
  assert.match(firstNumber, /^ORD-\d{8}-001$/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  const saved = db.prepare('SELECT * FROM order_items ORDER BY line_no').all();
  assert.deepEqual([saved[0].feather_prep, saved[0].dara, saved[0].cut_method, saved[0].slice_size, saved[0].weight_g, saved[0].service_fee_centavos, saved[0].line_total_centavos], ['POUR', 1, 'SLICE', 'MEDIUM', 3000, 4500, 21900]);
  assert.deepEqual([saved[1].feather_prep, saved[1].dara, saved[1].cut_method, saved[1].slice_size, saved[1].service_fee_centavos, saved[1].line_total_centavos], ['NOT_POUR', 0, 'SLICE', 'LARGE', 2500, 26500]);
  const others = db.prepare('SELECT * FROM order_other_items ORDER BY line_no').all();
  assert.deepEqual(others.map((o) => [o.product_name, o.unit, o.sold_by, o.quantity_milli, o.line_total_centavos]), [['Eggs (Small)', 'dozen', 'FIXED', 2000, 24000], ['Garlic', 'kg', 'PER_KG', 1500, 12000]]);
  const order = db.prepare('SELECT * FROM orders').get();
  assert.deepEqual([order.subtotal_centavos, order.discount_type, order.discount_value, order.discount_centavos, order.discount_reason, order.total_centavos], [84400, 'PERCENT', 2000, 16880, 'SENIOR', 67520]);
  assert.equal(order.customer_number, 'C-2001');
  const pay = db.prepare('SELECT * FROM payments').get();
  assert.deepEqual([pay.method, pay.amount_centavos, pay.account_name, pay.account_number, pay.reference], ['GCASH', 67520, 'Juan Dela Cruz', '09171234567', 'GC-778']);
  const slip = await cashier.locator('.slip').first().innerText();
  assert.match(slip, /Not an official receipt/); assert.match(slip, /Discount: Senior citizen \(20%\)/); assert.match(slip, /₱675\.20/);
  await cashier.screenshot({ path: '/tmp/shots/5-done.png', fullPage: true });
});

await step('a new order starts empty', async () => {
  await cashier.click('[data-action="new-order"]');
  assert.equal(await cashier.locator('#orderPanel .line').count(), 0);
  assert.equal(await cashier.locator('#orderTotal').innerText(), '₱0.00');
});

await step('orders: search by number, details show the discount, canceling needs a reason, canceled rows turn red', async () => {
  await cashier.click('a[href="#/orders"]');
  await cashier.fill('#fq', firstNumber);
  await cashier.click('#filters button[type="submit"]');
  await cashier.waitForSelector('tr.clickable');
  await cashier.click('tr.clickable');
  await cashier.waitForSelector('dialog[open] [data-dlg-action]:has-text("Close")');
  const detail = await cashier.locator('dialog').innerText();
  assert.match(detail, /Po-ur & Slice/); assert.match(detail, /Medium pieces/); assert.match(detail, /Dressed & Slice/); assert.match(detail, /GCash/);
  assert.match(detail, /2 dozen/); assert.match(detail, /Discount: Senior citizen \(20%\)/);
  assert.match(detail, /•••••••4567/, 'cashier sees the account number masked');
  assert.doesNotMatch(detail, /09171234567/);
  assert.equal(await cashier.locator('[data-dlg-action]:has-text("Refund order")').count(), 0, 'cashiers cannot refund');
  await cashier.click('[data-dlg-action]:has-text("Cancel order")');
  await cashier.selectOption('#rCode', 'OTHER');
  await cashier.click('[data-dlg-action]:has-text("Cancel this order")');
  await cashier.waitForSelector('#reasonError .error-box');
  assert.match(await cashier.locator('#reasonError').innerText(), /Explain the reason/);
  await cashier.fill('#rNote', 'Customer left without paying');
  await cashier.click('[data-dlg-action]:has-text("Cancel this order")');
  await cashier.waitForSelector('tr.row--canceled');
  assert.match(await cashier.locator('tr.row--canceled').innerText(), /Canceled/);
  assert.equal(db.prepare('SELECT status FROM orders').get().status, 'CANCELED');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_items').get().n, 2, 'original lines are kept');
  await cashier.screenshot({ path: '/tmp/shots/6-orders.png' });
});

await step('change order: loads into checkout and submitting replaces it with a linked order', async () => {
  await cashier.click('a[href="#/new"]');
  await cashier.click('.product-card:has-text("Broilers")');
  await cashier.fill('#amount', '1.5');
  await svc(cashier, 'NOT_POUR').click();
  await cut(cashier, 'SMALL').click();
  await cashier.click('#addBtn');
  await cashier.click('[data-action="go-review"]');
  await cashier.check('#reviewed');
  await cashier.click('#submitBtn');
  await cashier.waitForSelector('.order-no-big');
  const number = await cashier.locator('.order-no-big').innerText();
  assert.match(number, /-002$/, 'numbers continue after a canceled order; 001 is never reused');
  await cashier.click('a[href="#/orders"]');
  await cashier.fill('#fq', number);
  await cashier.click('#filters button[type="submit"]');
  await cashier.click('tr.clickable');
  await cashier.click('[data-dlg-action]:has-text("Change order")');
  await cashier.waitForSelector('.change-banner');
  assert.match(await cashier.locator('.change-banner').innerText(), new RegExp(`Changing ${number}`));
  await cashier.locator('[data-action="edit-line"]').first().click();
  assert.equal(await on(svc(cashier, 'NOT_POUR')), true, 'the service and cutting come back when editing');
  assert.equal(await on(cut(cashier, 'SMALL')), true);
  await cashier.fill('#amount', '2');
  await cashier.click('#addBtn');
  await cashier.click('[data-action="go-review"]');
  await cashier.check('#reviewed');
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), true, 'a reason is required for a change');
  await cashier.selectOption('#reasonCode', 'WRONG_WEIGHT');
  await cashier.click('#submitBtn');
  await cashier.waitForSelector('.order-no-big');
  assert.match(await cashier.locator('.order-no-big').innerText(), /-003$/);
  assert.match(await cashier.locator('.done').innerText(), new RegExp(`Replaces ${number}`));
  assert.equal(db.prepare('SELECT status FROM orders WHERE order_number = ?').get(number).status, 'REPLACED');
  assert.equal(db.prepare('SELECT total_centavos FROM orders WHERE order_number = ?').get(number.replace('002', '003')).total_centavos, 24000 + 2500);
});

await step('number of heads: 3 heads of B-cull weighed together are entered once, priced on the total weight, and saved', async () => {
  await cashier.click('a[href="#/new"]');                 // already on this tab after "Order saved": it starts a fresh screen
  await cashier.click('[data-tab="chicken"]');
  await cashier.click('.product-card:has-text("Broiler Breeder Cull")');
  assert.equal(await cashier.inputValue('#heads'), '1');
  assert.equal(await cashier.locator('#weightLabel').innerText(), 'Weight in kg');
  await cashier.click('[data-action="heads-dec"]');
  assert.equal(await cashier.inputValue('#heads'), '1', 'cannot go below 1 head');
  await cashier.click('[data-action="heads-inc"]');
  await cashier.click('[data-action="heads-inc"]');
  assert.equal(await cashier.inputValue('#heads'), '3');
  assert.equal(await cashier.locator('#weightLabel').innerText(), 'Total weight of all the heads, in kg');
  assert.equal(await cashier.locator('#scaleTag').innerText(), 'Total weight');
  await typeKeys(cashier, '5.4');
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱280.80');           // 5.4 kg x ₱52.00, the same whatever the heads
  assert.match(await cashier.locator('#sum').innerText(), /3 heads · about 1\.8 kg each/);
  assert.match(await cashier.locator('#sum').innerText(), /₱52\.00\/kg × 5\.4 kg/);
  await cashier.screenshot({ path: '/tmp/shots/11-heads.png' });
  await cashier.fill('#heads', '0');
  assert.match(await cashier.locator('#hint').innerText(), /Enter the number of heads/);
  assert.equal(await cashier.locator('#addBtn').isDisabled(), true);
  await cashier.fill('#heads', 'abc4');
  assert.equal(await cashier.inputValue('#heads'), '4', 'only digits are accepted');
  await cashier.fill('#heads', '1000');
  assert.equal(await cashier.inputValue('#heads'), '100', 'at most 3 digits');
  await cashier.fill('#heads', '3');
  await svc(cashier, 'NOT_POUR').click();
  await cut(cashier, 'MEDIUM').click();
  assert.equal(await cashier.locator('#itemTotal').innerText(), '₱305.80');           // ₱280.80 + the flat ₱25.00 service
  await cashier.click('#addBtn');
  const line = await cashier.locator('#orderPanel .line').first().innerText();
  assert.match(line, /Broiler Breeder Cull/); assert.match(line, /₱305\.80/); assert.match(line, /3 heads · 5\.4 kg × ₱52\.00\/kg/);
  await cashier.locator('[data-action="edit-line"]').first().click();
  assert.equal(await cashier.inputValue('#heads'), '3', 'editing keeps the heads');
  assert.equal(await cashier.inputValue('#amount'), '5.4');
  await cashier.locator('[data-action="cfg-back"]').first().click();
  await cashier.click('[data-action="go-review"]');
  assert.match(await cashier.locator('.review').innerText(), /3 heads · 5\.4 kg/);
  await cashier.check('#reviewed');
  await cashier.click('#submitBtn');
  await cashier.waitForSelector('.order-no-big');
  const number = await cashier.locator('.order-no-big').innerText();
  assert.match(await cashier.locator('.slip').first().innerText(), /3 heads · 5\.4 kg/);
  const saved = db.prepare('SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.order_number = ?').get(number);
  assert.deepEqual([saved.product_name, saved.heads, saved.weight_g, saved.price_per_kg_centavos, saved.weight_amount_centavos, saved.service_fee_centavos, saved.line_total_centavos],
    ['Broiler Breeder Cull', 3, 5400, 5200, 28080, 2500, 30580]);
  await cashier.click('a[href="#/orders"]');
  await cashier.fill('#fq', number);
  await cashier.click('#filters button[type="submit"]');
  await cashier.click('tr.clickable');
  await cashier.waitForSelector('dialog[open] [data-dlg-action]:has-text("Close")');
  assert.match(await cashier.locator('dialog').innerText(), /3 heads · 5\.4 kg/);
  await cashier.click('[data-dlg-action]:has-text("Close")');
  await cashier.screenshot({ path: '/tmp/shots/10-heads-orders.png' });
});

await step('a single chicken still looks and saves exactly as before (1 head, no extra wording)', async () => {
  await cashier.click('a[href="#/new"]');
  await cashier.click('[data-tab="chicken"]');
  await cashier.click('.product-card:has-text("Cull Chicken")');
  await typeKeys(cashier, '3.6');
  await svc(cashier, 'LIVE').click();
  await cashier.click('#addBtn');
  const line = await cashier.locator('#orderPanel .line').first().innerText();
  assert.match(line, /3\.6 kg × ₱58\.00\/kg/);
  assert.doesNotMatch(line, /head/);
  await cashier.click('[data-action="go-review"]');
  await cashier.check('#reviewed');
  await cashier.click('#submitBtn');
  await cashier.waitForSelector('.order-no-big');
  const number = await cashier.locator('.order-no-big').innerText();
  assert.equal(db.prepare('SELECT i.heads FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.order_number = ?').get(number).heads, 1);
});

await step('daily sales report: a cashier downloads the paper-form report (Excel) and the line-by-line CSV, with their own sales only', async () => {
  await cashier.click('a[href="#/orders"]');
  await cashier.waitForSelector('#dailyXlsx');
  assert.equal(await cashier.locator('#dCashier').count(), 0, 'a cashier cannot pick another cashier');
  assert.match(await cashier.locator('.panel:has(#dailyXlsx)').innerText(), /parts you count by hand .* left empty/);
  const [xlsx] = await Promise.all([cashier.waitForEvent('download'), cashier.click('#dailyXlsx')]);
  assert.match(xlsx.suggestedFilename(), /^daily-sales-report_\d{4}-\d{2}-\d{2}_cashier-\d+\.xlsx$/);
  assert.ok(fs.statSync(await xlsx.path()).size > 3000);
  const [csv] = await Promise.all([cashier.waitForEvent('download'), cashier.click('#dailyCsv')]);
  const text = fs.readFileSync(await csv.path(), 'utf8').replace(/^\ufeff/, '').trim().split('\r\n');
  const head = text[0].split(',');
  assert.ok(head.includes("Customer's #/Name") && head.includes('# of Heads') && head.includes('Service'));
  const rows = text.slice(1).map((l) => l.split(','));
  assert.ok(rows.length >= 3 && rows.every((r) => r[head.indexOf('Cashier')] === 'Cashier'));
  const heads = rows.find((r) => r[head.indexOf('Product')] === 'Broiler Breeder Cull' && r[head.indexOf('# of Heads')] === '3');
  assert.ok(heads, 'the 3-head B-cull sale is in the report');
  assert.deepEqual([heads[head.indexOf('Section')], heads[head.indexOf('Kilos or Quantity')], heads[head.indexOf('Price (per kg or per unit)')], heads[head.indexOf('Amount')]], ['B-CULL', '5.4', '52.00', '305.80']);
  assert.ok(!rows.some((r) => r[head.indexOf('Order Number')] === ''), 'every row has its order number');
});

await step('sign-out returns to the sign-in screen', async () => {
  await cashier.click('#logout');
  await cashier.waitForSelector('#loginForm');
});

manager = await newPage();
await login(manager, 'mgr', 'manager-pass-1');

await step('manager can refund; price field is locked for non-admins; export downloads work', async () => {
  await manager.click('a[href="#/orders"]');
  await manager.fill('#fq', 'ORD-');
  await manager.click('#filters button[type="submit"]');
  await manager.waitForSelector('tr.clickable');
  await manager.locator('tr.clickable:has-text("Completed")').first().click();
  await manager.waitForSelector('dialog[open] [data-dlg-action]:has-text("Close")');
  assert.equal(await manager.locator('[data-dlg-action]:has-text("Refund order")').count(), 1);
  await manager.click('[data-dlg-action]:has-text("Refund order")');
  await manager.selectOption('#rCode', 'CUSTOMER_NOT_SATISFIED');
  await manager.click('[data-dlg-action]:has-text("Refund this order")');
  await manager.waitForSelector('tr.row--refunded');
  const [xlsx] = await Promise.all([manager.waitForEvent('download'), manager.click('#exportXlsx')]);
  assert.match(xlsx.suggestedFilename(), /\.xlsx$/);
  assert.ok(fs.statSync(await xlsx.path()).size > 2000);
  const [csv] = await Promise.all([manager.waitForEvent('download'), manager.click('#exportCsv')]);
  assert.match(csv.suggestedFilename(), /\.csv$/);
  await manager.click('a[href="#/products"]');
  await manager.click('#addProduct');
  assert.equal(await manager.locator('#pPrice').isDisabled(), true);
  await manager.fill('#pName', 'Native Chicken');
  await manager.click('[data-dlg-action]:has-text("Add product")');
  await manager.waitForSelector('td:has-text("Native Chicken")');
  assert.match(await manager.locator('tr:has-text("Native Chicken")').innerText(), /Inactive/);
  assert.equal(await manager.locator('[href="#/users"]').count(), 0);
});

await step('daily sales report: a manager can choose one cashier or everyone', async () => {
  await manager.click('a[href="#/orders"]');
  await manager.waitForFunction(() => document.querySelectorAll('#dCashier option').length > 1);
  const options = await manager.locator('#dCashier option').allInnerTexts();
  assert.equal(options[0], 'All cashiers');
  assert.ok(options.includes('Cashier') && options.includes('Owner'));
  await manager.selectOption('#dCashier', { label: 'Cashier' });
  const [csv] = await Promise.all([manager.waitForEvent('download'), manager.click('#dailyCsv')]);
  const lines = fs.readFileSync(await csv.path(), 'utf8').replace(/^\ufeff/, '').trim().split('\r\n');
  const col = lines[0].split(',').indexOf('Cashier');
  assert.ok(lines.length >= 4 && lines.slice(1).every((l) => l.split(',')[col] === 'Cashier'));
  const [all] = await Promise.all([manager.waitForEvent('download'), (async () => { await manager.selectOption('#dCashier', ''); await manager.click('#dailyXlsx'); })()]);
  assert.match(all.suggestedFilename(), /^daily-sales-report_\d{4}-\d{2}-\d{2}\.xlsx$/);
  await manager.screenshot({ path: '/tmp/shots/12-daily-panel.png' });
  await manager.click('a[href="#/products"]');                       // the next step starts on the Products screen
});

await step('flexible products: a manager adds etag with two ways of selling; prices stay with the admin', async () => {
  await manager.click('[data-tab="other"]');
  await manager.click('#addOther');
  await manager.fill('#nName', 'Etag (Sun-Dried)');
  await manager.click('[data-dlg-action]:has-text("Add product")');
  await manager.waitForSelector('dialog[open] .price-opt[data-new]');            // the options dialog opens right away
  assert.equal(await manager.locator('dialog [data-f="price"]').first().isDisabled(), true, 'a manager cannot type a price');
  await manager.selectOption('dialog [data-new] [data-f="sold_by"]', 'PER_KG');
  assert.equal(await manager.inputValue('dialog [data-new] [data-f="unit"]'), 'kg');
  await manager.click('dialog [data-save="new"]');
  await manager.waitForSelector('dialog .price-opt[data-opt]');
  await manager.fill('dialog [data-new] [data-f="unit"]', 'pack');
  await manager.click('dialog [data-save="new"]');
  await manager.waitForFunction(() => document.querySelectorAll('dialog .price-opt[data-opt]').length === 2);
  await manager.click('[data-dlg-action]:has-text("Done")');
  await manager.waitForSelector('tr:has-text("Etag (Sun-Dried)") .chip');
  const row = await manager.locator('tr:has-text("Etag (Sun-Dried)")').innerText();
  assert.match(row, /per kg: price not set \(hidden\)/); assert.match(row, /per pack: price not set \(hidden\)/);
  await manager.screenshot({ path: '/tmp/shots/7-products.png' });
});

adminPage = await newPage();
await login(adminPage, 'owner', 'owner-pass-1');

await step('the admin sets the prices and the product appears on the cashier screen', async () => {
  await adminPage.click('a[href="#/products"]');
  await adminPage.click('[data-tab="other"]');
  await adminPage.locator('tr:has-text("Etag (Sun-Dried)") [data-options]').click();
  await adminPage.waitForSelector('dialog .price-opt[data-opt]');
  const rows = adminPage.locator('dialog .price-opt[data-opt]');
  await rows.nth(0).locator('[data-f="price"]').fill('450');
  await rows.nth(0).locator('[data-save]').click();
  await adminPage.waitForFunction(() => document.querySelector('dialog .price-opt[data-opt] [data-f="price"]')?.value === '450.00');
  const second = adminPage.locator('dialog .price-opt[data-opt]').nth(1);
  await second.locator('[data-f="price"]').fill('60');
  await second.locator('[data-save]').click();
  await adminPage.waitForFunction(() => [...document.querySelectorAll('dialog .price-opt[data-opt] [data-f="price"]')].every((i) => i.value));
  await adminPage.click('[data-dlg-action]:has-text("Done")');
  await adminPage.waitForSelector('tr:has-text("Etag (Sun-Dried)"):has-text("₱450.00"):has-text("₱60.00")');
  assert.match(await adminPage.locator('tr:has-text("Etag (Sun-Dried)")').innerText(), /per kg: ₱450\.00[\s\S]*per pack: ₱60\.00/);
  // service fees: the admin can change them and sees the shop's wording
  await adminPage.click('[data-tab="fees"]');
  await adminPage.waitForSelector('[data-fee="POUR"]');
  const fees = await adminPage.locator('#tabBody').innerText();
  assert.match(fees, /Po-ur & Slice \(burn chicken\)/); assert.match(fees, /Dressed & Slice \(dress chicken\)/); assert.match(fees, /Live[\s\S]*never has a fee/);
  assert.equal(await adminPage.inputValue('[data-fee="POUR"]'), '45.00');
  assert.equal(await adminPage.inputValue('[data-fee="NOT_POUR"]'), '25.00');
  await adminPage.screenshot({ path: '/tmp/shots/8-fees.png' });
  // the cashier screen now offers the new product
  await adminPage.click('a[href="#/new"]');
  await adminPage.click('[data-tab="other"]');
  assert.match(await adminPage.locator('.product-grid').innerText(), /Etag \(Sun-Dried\)[\s\S]*₱450\.00\/kg[\s\S]*₱60\.00\/pack/);
  await adminPage.click('.product-card:has-text("Etag (Sun-Dried)")');
  await adminPage.locator('[data-action="pick-option"]:has-text("Per pack")').click();
  await adminPage.fill('#amount', '3');
  assert.equal(await adminPage.locator('#itemTotal').innerText(), '₱180.00');
});

await step('per-head fee: the admin switches Po-ur & Slice to per head and 3 heads pay it three times', async () => {
  await adminPage.click('a[href="#/products"]');
  await adminPage.click('[data-tab="fees"]');
  await adminPage.waitForSelector('[data-fee="POUR"]');
  assert.match(await adminPage.locator('#tabBody').innerText(), /multiplies it by the number of heads/);
  assert.deepEqual(await adminPage.locator('[data-basis="POUR"] option').allInnerTexts(), ['per line (flat)', 'per head', 'per kg']);
  await adminPage.selectOption('[data-basis="POUR"]', 'per_head');
  await adminPage.click('[data-save="POUR"]');
  await adminPage.waitForSelector('.toast:has-text("fee saved")');
  await adminPage.click('a[href="#/new"]');
  await adminPage.click('[data-tab="chicken"]');
  await adminPage.click('.product-card:has-text("Broiler Breeder Cull")');
  await adminPage.click('[data-action="heads-inc"]');
  await adminPage.click('[data-action="heads-inc"]');
  await adminPage.fill('#amount', '5.4');
  assert.match(await adminPage.locator('.service-grid').innerText(), /\+₱45\.00 per head/);
  await svc(adminPage, 'POUR').click();
  await cut(adminPage, 'LARGE').click();
  assert.equal(await adminPage.locator('#itemTotal').innerText(), '₱415.80');         // ₱280.80 + 3 x ₱45.00
  assert.match(await adminPage.locator('#sum').innerText(), /Po-ur & Slice \(3 heads\)[\s\S]*\+₱135\.00/);
  await adminPage.click('#addBtn');
  await adminPage.click('[data-action="go-review"]');
  await adminPage.check('#reviewed');
  await adminPage.click('#submitBtn');
  await adminPage.waitForSelector('.order-no-big');
  const number = await adminPage.locator('.order-no-big').innerText();
  const saved = db.prepare('SELECT i.* FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.order_number = ?').get(number);
  assert.deepEqual([saved.heads, saved.service_fee_centavos, saved.line_total_centavos], [3, 13500, 41580]);
});

await step('phone width: no sideways scrolling on the weight and service screen', async () => {
  const phone = await newPage({ width: 390, height: 844 });
  await login(phone, 'cash', 'cashier-pass-1');
  await phone.click('.product-card:has-text("Cull Chicken")');
  await svc(phone, 'POUR').click();
  assert.equal(await phone.locator('#heads').isVisible(), true);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `page is ${overflow}px too wide`);
  await phone.screenshot({ path: '/tmp/shots/9-phone.png', fullPage: true });
  assert.deepEqual(phone.errors, []);
});

await step('no browser errors or blocked resources on any screen', async () => {
  assert.deepEqual(cashier.errors, []);
  assert.deepEqual(manager.errors, []);
  assert.deepEqual(adminPage.errors, []);
});

await browser.close();
server.close();
console.log(`\n${results.length - problems.length} of ${results.length} browser checks passed`);
process.exit(problems.length ? 1 : 0);
