// Browser test: drives the real screens in Chromium (needs Playwright: `npm install` then `npx playwright install chromium`).
// It starts its own server with an in-memory database, so it never touches real data.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createUser } from '../src/services/users.js';
import { createOrder } from '../src/services/orders.js';
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
    results.push(`FAIL  ${name}\n      ${String(err.message).split('\n').slice(0, 12).join(' | ')}`); problems.push(name);
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
  // Payments are as in Version 4: "Not recorded" is the starting choice and does not block submitting; only the heading word changed to (required).
  assert.match(await cashier.locator('#payPanel h3').innerText(), /Payment details \(required\)/);
  assert.doesNotMatch(await cashier.locator('#payPanel h3').innerText(), /optional/);
  assert.deepEqual(await cashier.locator('#payMethod option').allInnerTexts(), ['Not recorded', 'Cash', 'GCash', 'Maya', 'Bank transfer', 'Other']);
  assert.equal(await cashier.locator('#payMethod').inputValue(), 'NONE');
  assert.equal(await cashier.locator('#payAmount').count(), 0, 'no amount box while the payment is not recorded');
  assert.equal(await cashier.locator('#payWarn').innerText(), '');
  assert.match(await cashier.locator('#payPanel').innerText(), /does not charge anyone and does not replace the official receipt/);
  // Cash: method + amount (starts at the order total). GCash adds date and time, account name, account number and reference number.
  await cashier.selectOption('#payMethod', 'CASH');
  assert.equal(await cashier.locator('#payAmount').count(), 1);
  assert.equal(await cashier.locator('#payWhen, #payName, #payNumber, #payRef').count(), 0, 'cash has no account fields');
  await cashier.selectOption('#payMethod', 'GCASH');
  assert.equal(await cashier.locator('#payAmount').count(), 1);
  assert.deepEqual(await cashier.locator('#payPanel label').allInnerTexts().then((t) => t.map((x) => x.replace(/\s+/g, ' ').trim())),
    ['How did the customer pay?', 'Amount paid (₱)', 'Payment date and time (optional)', 'Account name (optional)', 'Account or mobile number (optional)', 'Reference number (optional)']);
  await cashier.selectOption('#payMethod', 'NONE');
  assert.equal(await cashier.locator('#payAmount').count(), 0, 'back to Not recorded: the amount box goes away again');
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), false, 'no discount is fine');
  await cashier.selectOption('#discType', 'PERCENT');
  await cashier.fill('#discValue', '20');
  assert.equal(await cashier.locator('#submitBtn').isDisabled(), true, 'a discount without a reason blocks submitting');
  assert.match(await cashier.locator('#discWarn').innerText(), /Choose a reason/);
  // the discount reasons, including the four added in revision 5
  assert.deepEqual(await cashier.locator('#discReason option').allInnerTexts(), ['Choose a reason', 'Senior citizen', 'Bulk Order Discount', 'Reject', 'Employee Discount', 'VIP', 'Other (explain below)']);
  for (const [code, text] of [['BULK', 'Bulk Order Discount'], ['REJECT', 'Reject'], ['EMPLOYEE', 'Employee Discount'], ['VIP', 'VIP']]) {
    await cashier.selectOption('#discReason', code);
    assert.equal(await cashier.locator('#discWarn').innerText(), '', code);
    assert.equal(await cashier.locator('#submitBtn').isDisabled(), false, `${text} is a valid reason`);
    assert.match(await cashier.locator('#totalsBody').innerText(), new RegExp(`Discount: ${text} \\(20%\\)[\\s\\S]*−₱168\\.80`));
  }
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
  await cashier.selectOption('#payMethod', 'CASH');   // the payment method is saved with the order, and copied back when the order is changed
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
  assert.equal(await cashier.inputValue('#payMethod'), 'CASH', 'the payment method of the original order is filled in on a change');
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

// ---- Revision 5: Order List (Kanban board) ----------------------------------------------------------------------------
const col = (page, name) => page.locator(`.kcol--${name}`);
const numbersIn = (page, name) => page.locator(`.kcol--${name} .kcard .kcard-no`).allInnerTexts();
const cardOf = (page, number) => page.locator('.kcard', { has: page.locator(`.kcard-no:text-is("${number}")`) });
const dbNumbers = (status) => db.prepare("SELECT order_number FROM orders WHERE status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED') AND fulfillment_status = ? ORDER BY id DESC").all(status).map((r) => r.order_number);
const dbStatus = (number) => db.prepare('SELECT fulfillment_status AS s FROM orders WHERE order_number = ?').get(number).s;
const moves = (number) => db.prepare("SELECT e.reason_note FROM order_events e JOIN orders o ON o.id = e.order_id WHERE o.order_number = ? AND e.action_type = 'MOVE' ORDER BY e.id").all(number).map((r) => r.reason_note);
const waitStatus = async (page, number, status) => {
  for (let i = 0; i < 60; i++) { if (dbStatus(number) === status) return; await page.waitForTimeout(50); }
  throw new Error(`${number} is ${dbStatus(number)} in the database, expected ${status}`);
};
const sameAsDatabase = async (page) => {
  for (const [name, status] of [['ongoing', 'ONGOING'], ['standby', 'STANDBY'], ['complete', 'COMPLETE']]) {
    assert.deepEqual([...await numbersIn(page, name)].sort(), dbNumbers(status).sort(), `${name} column matches the saved statuses`);
  }
  const all = await page.locator('.kcard .kcard-no').allInnerTexts();
  assert.equal(new Set(all).size, all.length, 'no order appears twice');
};
const menuItems = (page) => page.locator('.kmenu-item').allInnerTexts().then((t) => t.map((x) => x.replace(/\s+/g, ' ').trim()));

// A new open order, made the way the New order screen's Submit does (same API), so the board steps always have one to work with.
const createOrderWith = async (page, build) => {
  const ids = {
    cull: db.prepare("SELECT id FROM products WHERE name = 'Cull Chicken'").get().id,
    bcull: db.prepare("SELECT id FROM products WHERE name = 'Broiler Breeder Cull'").get().id,
    egg: db.prepare("SELECT o.id AS option_id, o.product_id FROM other_product_options o WHERE o.unit = 'dozen' LIMIT 1").get(),
  };
  const payload = build(ids);
  return page.evaluate(async (body) => {
    const key = `e2e-${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    const res = await fetch('/api/orders', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pos' },
      body: JSON.stringify({ submission_key: key, ...body }),
    });
    if (!res.ok) throw new Error(`order failed ${res.status} ${await res.text()}`);
    return (await res.json()).order.order_number;
  }, payload);
};
const createOpenOrder = (page) => createOrderWith(page, (ids) => ({ items: [{ product_id: ids.cull, weight: '1.2', feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null }], payment: { method: 'CASH' } }));
const refreshBoard = async (page, number) => {
  await page.click('#boardRefresh');
  await page.waitForFunction((n) => [...document.querySelectorAll('.kcard-no')].some((e) => e.textContent === n), number);
};

await step('Order List: a tab right next to New order; the New order screen still works', async () => {
  const links = await cashier.locator('.nav a').allInnerTexts();
  assert.deepEqual(links.slice(0, 3), ['New order', 'Order List', 'Orders']);
  await cashier.click('a[href="#/board"]');
  await cashier.waitForSelector('.kboard');
  assert.equal(await cashier.locator('.nav a[aria-current="page"]').innerText(), 'Order List');
  assert.equal(await cashier.locator('.kcol').count(), 3);
  assert.deepEqual(await cashier.locator('.kcol h2').allInnerTexts(), ['Ongoing', 'Standby', 'Complete']);
  await cashier.click('a[href="#/new"]');
  await cashier.waitForSelector('.product-grid, [data-action="new-order"]');
  if (await cashier.locator('[data-action="new-order"]').count()) await cashier.click('[data-action="new-order"]');
  await cashier.waitForSelector('.product-card');
});

await step('Order List: every open order is on the board once, new orders start in Ongoing, canceled and replaced ones are not shown', async () => {
  await cashier.click('a[href="#/board"]');
  await cashier.waitForSelector('.kcard');
  await sameAsDatabase(cashier);
  const ongoing = await numbersIn(cashier, 'ongoing');
  assert.ok(ongoing.length >= 3);
  assert.equal(await cashier.locator('.kcol--standby .kcard').count(), 0);
  assert.equal(await cashier.locator('.kcol--complete .kcard').count(), 0);
  assert.match(await col(cashier, 'standby').innerText(), /No standby orders/);
  const everyNumber = await cashier.locator('.kcard-no').allInnerTexts();
  for (const hidden of db.prepare("SELECT order_number FROM orders WHERE status IN ('CANCELED','REPLACED')").all()) {
    assert.ok(!everyNumber.includes(hidden.order_number), `${hidden.order_number} is canceled or replaced and is not on the board`);
  }
  // a card carries the order number, customer, items with quantity, date and total
  const heads = db.prepare("SELECT o.order_number, o.total_centavos FROM orders o JOIN order_items i ON i.order_id = o.id WHERE i.heads = 3 AND o.status = 'COMPLETED' ORDER BY o.id DESC").get();
  // (Revision 7: a card is folded until it is clicked, so open it to see every line.)
  const total = new RegExp(`₱${(heads.total_centavos / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`.replace('.', '\\.'));
  const folded = await cardOf(cashier, heads.order_number).innerText();
  assert.match(folded, /Walk-in/); assert.match(folded, /Ongoing/); assert.match(folded, /\d{4}|\d{1,2}:\d{2}/); assert.match(folded, total);
  await cardOf(cashier, heads.order_number).locator('.kcard-toggle').click();
  const text = await cardOf(cashier, heads.order_number).innerText();
  assert.match(text, /Customer\s+Walk-in/); assert.match(text, /Broiler Breeder Cull/); assert.match(text, /3 heads · 5\.4 kg/);
  assert.match(text, /\d{4}/); assert.match(text, total);
  await cardOf(cashier, heads.order_number).locator('.kcard-toggle').click();
  await cashier.screenshot({ path: '/tmp/shots/13-board.png' });
});

await step('Order List: dragging a card shows where it can be dropped, and dropping on its own column does nothing', async () => {
  const [first] = await numbersIn(cashier, 'ongoing');
  const box = await cardOf(cashier, first).boundingBox();
  await cashier.mouse.move(box.x + 40, box.y + 20);
  await cashier.mouse.down();
  await cashier.mouse.move(box.x + 160, box.y + 60, { steps: 4 });
  const target = await col(cashier, 'complete').locator('.kcol-body').boundingBox();
  await cashier.mouse.move(target.x + 60, target.y + 60, { steps: 6 });
  await cashier.waitForTimeout(200);
  await cashier.mouse.move(target.x + 70, target.y + 70, { steps: 2 });
  await cashier.waitForTimeout(200);
  assert.equal(await cashier.locator('.kboard').evaluate((e) => e.classList.contains('kboard--dragging')), true, 'the board shows it is in drag mode');
  assert.equal(await cashier.locator('.kcard--dragging').count(), 1, 'the dragged card looks lifted');
  assert.equal(await col(cashier, 'complete').evaluate((e) => e.classList.contains('kcol--over')), true, 'the column under the card lights up');
  assert.equal(await col(cashier, 'ongoing').evaluate((e) => e.classList.contains('kcol--source')), true);
  assert.equal(await col(cashier, 'standby').locator('.kcol-drop').isVisible(), true, 'a drop hint is shown on the other columns');
  await cashier.screenshot({ path: '/tmp/shots/14-board-dragging.png' });
  // back over its own column and let go: nothing happens
  const own = await col(cashier, 'ongoing').locator('.kcol-body').boundingBox();
  await cashier.mouse.move(own.x + 60, own.y + 60, { steps: 6 });
  await cashier.mouse.up();
  await cashier.waitForTimeout(300);
  assert.equal(await cashier.locator('.kcol--over, .kcol--source, .kcard--dragging, .kboard--dragging').count(), 0, 'the drag highlights are gone');
  assert.equal(await cashier.locator('#dialog[open]').count(), 0);
  assert.equal(dbStatus(first), 'ONGOING');
  assert.deepEqual(moves(first), []);
});

let dragged;
await step('Order List: drag and drop Ongoing -> Standby is saved at once and the card moves, once', async () => {
  [dragged] = await numbersIn(cashier, 'ongoing');
  await cardOf(cashier, dragged).dragTo(col(cashier, 'standby').locator('.kcol-body'));
  await waitStatus(cashier, dragged, 'STANDBY');
  assert.deepEqual(await numbersIn(cashier, 'standby'), [dragged]);
  assert.ok(!(await numbersIn(cashier, 'ongoing')).includes(dragged));
  assert.equal(await col(cashier, 'standby').locator('.kcount').innerText(), '1');
  await sameAsDatabase(cashier);
  assert.deepEqual(moves(dragged), ['Ongoing → Standby']);
});

await step('Order List: Complete asks first; "Not yet" changes nothing, "Yes" saves it and the card stays visible in Complete', async () => {
  await cardOf(cashier, dragged).dragTo(col(cashier, 'complete').locator('.kcol-body'));
  await cashier.waitForSelector('#dialog[open]');
  assert.match(await cashier.locator('#dialog').innerText(), new RegExp(`Mark ${dragged} as Complete\\?[\\s\\S]*customer has already received it`));
  await cashier.click('[data-dlg-action]:has-text("Not yet")');
  await cashier.waitForTimeout(250);
  assert.equal(dbStatus(dragged), 'STANDBY');
  assert.deepEqual(await numbersIn(cashier, 'standby'), [dragged]);
  await cardOf(cashier, dragged).dragTo(col(cashier, 'complete').locator('.kcol-body'));
  await cashier.waitForSelector('#dialog[open]');
  await cashier.click('[data-dlg-action]:has-text("Yes, the customer has it")');
  await waitStatus(cashier, dragged, 'COMPLETE');
  assert.deepEqual(await numbersIn(cashier, 'complete'), [dragged]);
  assert.ok(!(await numbersIn(cashier, 'ongoing')).includes(dragged) && !(await numbersIn(cashier, 'standby')).includes(dragged));
  await sameAsDatabase(cashier);
  assert.deepEqual(moves(dragged), ['Ongoing → Standby', 'Standby → Complete']);
  await cashier.screenshot({ path: '/tmp/shots/15-board-moved.png' });
});

let menued;
await step('Order List: right-click opens Move to Ongoing / Move to Standby / Mark as Complete, and each one saves', async () => {
  [menued] = await numbersIn(cashier, 'ongoing');
  await cardOf(cashier, menued).click({ button: 'right' });
  await cashier.waitForSelector('.kmenu');
  assert.deepEqual(await menuItems(cashier), ['⏳ Move to Ongoing (current)', '🛍️ Move to Standby', '✅ Mark as Complete', '☆ Bookmark this order', 'View order details']);
  assert.equal(await cashier.locator('[data-menu-move="ONGOING"]').isDisabled(), true, 'the column it is already in is disabled');
  await cashier.screenshot({ path: '/tmp/shots/16-board-menu.png' });
  await cashier.keyboard.press('Escape');
  assert.equal(await cashier.locator('.kmenu').count(), 0, 'Escape closes the menu');
  await cardOf(cashier, menued).click({ button: 'right' });
  await cashier.waitForSelector('.kmenu');
  await cashier.mouse.click(5, 300);
  assert.equal(await cashier.locator('.kmenu').count(), 0, 'clicking elsewhere closes the menu');
  // Move to Standby
  await cardOf(cashier, menued).click({ button: 'right' });
  await cashier.click('[data-menu-move="STANDBY"]');
  await waitStatus(cashier, menued, 'STANDBY');
  assert.ok((await numbersIn(cashier, 'standby')).includes(menued));
  // Move to Ongoing
  await cardOf(cashier, menued).click({ button: 'right' });
  await cashier.click('[data-menu-move="ONGOING"]');
  await waitStatus(cashier, menued, 'ONGOING');
  assert.ok((await numbersIn(cashier, 'ongoing')).includes(menued));
  // Mark as Complete (asks first)
  await cardOf(cashier, menued).click({ button: 'right' });
  await cashier.click('[data-menu-move="COMPLETE"]');
  await cashier.waitForSelector('#dialog[open]');
  await cashier.click('[data-dlg-action]:has-text("Yes, the customer has it")');
  await waitStatus(cashier, menued, 'COMPLETE');
  assert.deepEqual(await numbersIn(cashier, 'complete').then((n) => n.sort()), [dragged, menued].sort());
  await sameAsDatabase(cashier);
  assert.deepEqual(moves(menued), ['Ongoing → Standby', 'Standby → Ongoing', 'Ongoing → Complete']);
});

await step('Order List: statuses survive a refresh and leaving the screen and coming back; completed orders stay in Complete', async () => {
  await cashier.reload();
  await cashier.waitForSelector('.kcard');
  await sameAsDatabase(cashier);
  assert.deepEqual(await numbersIn(cashier, 'complete').then((n) => n.sort()), [dragged, menued].sort());
  await cashier.click('a[href="#/orders"]');
  await cashier.waitForSelector('#filters');
  await cashier.click('a[href="#/new"]');
  await cashier.waitForSelector('.product-grid, [data-action="new-order"]');
  await cashier.click('a[href="#/board"]');
  await cashier.waitForSelector('.kcard');
  await sameAsDatabase(cashier);
  assert.deepEqual(await numbersIn(cashier, 'complete').then((n) => n.sort()), [dragged, menued].sort());
});

await step('Order List: the order details show the pickup status and every move in the history', async () => {
  await cardOf(cashier, dragged).locator('.kcard-toggle').click();               // Details sits on the open card
  await cardOf(cashier, dragged).locator('[data-open]').click();
  await cashier.waitForSelector('dialog[open] [data-dlg-action]:has-text("Close")');
  const text = await cashier.locator('dialog').innerText();
  assert.match(text, /Pickup status\s+Complete/);
  assert.match(text, /Moved on the Order List[\s\S]*Ongoing → Standby/);
  assert.match(text, /Moved on the Order List[\s\S]*Standby → Complete/);
  assert.equal((await cashier.locator('dialog [data-order-status]').innerText()).trim(), 'Complete', 'the details show the same status as the board');
  assert.equal(db.prepare('SELECT status FROM orders WHERE order_number = ?').get(dragged).status, 'COMPLETED');   // the sale status itself is unchanged
  await cashier.click('[data-dlg-action]:has-text("Close")');
  await cashier.waitForTimeout(150);
});

// ---- Revision 6: the Orders screen shows the same status as the Order List -------------------------------------------------
const goOrders = async (page) => { await page.click('a[href="#/orders"]'); await page.waitForSelector('#filters'); };
const searchOrders = async (page, text, status = '') => {
  await page.fill('#fq', text);
  await page.selectOption('#fstatus', status);
  await Promise.all([page.waitForResponse((r) => r.url().includes('/api/orders?')), page.click('#filters button[type="submit"]')]);
  await page.waitForFunction(() => !document.querySelector('#results .spinner'));
};
const orderRow = (page, number) => page.locator('tr[data-order-id]', { has: page.locator(`strong:text-is("${number}")`) });
const ordersStatus = async (page, number) => {
  await goOrders(page);
  await searchOrders(page, number);
  const row = orderRow(page, number);
  await row.waitFor();
  return (await row.locator('[data-order-status]').innerText()).replace(/\s+/g, ' ').trim();
};
const boardStage = async (page, number) => {
  await page.click('a[href="#/board"]');
  await page.waitForSelector('.kboard .kcard');
  return page.locator('.kcol', { has: cardOf(page, number) }).locator('h2').innerText();
};
const listedNumbers = (page) => page.locator('#results tr[data-order-id] strong').allInnerTexts();

let syncA, syncB;
await step('Orders screen: an order shows the same status as its Order List column, matched by the order itself, after every move and after a refresh', async () => {
  syncA = await createOpenOrder(cashier);
  syncB = await createOpenOrder(cashier);
  assert.equal(await boardStage(cashier, syncA), 'Ongoing');
  assert.equal(await ordersStatus(cashier, syncA), 'Ongoing', 'a new order is Ongoing on both screens');
  assert.equal(await ordersStatus(cashier, syncB), 'Ongoing');

  // drag A to Standby on the Order List
  await boardStage(cashier, syncA);
  await cardOf(cashier, syncA).dragTo(col(cashier, 'standby').locator('.kcol-body'));
  await waitStatus(cashier, syncA, 'STANDBY');
  assert.equal(await ordersStatus(cashier, syncA), 'Standby', 'the Orders screen follows the move');
  assert.equal(await ordersStatus(cashier, syncB), 'Ongoing', 'the other order is not touched: the two are told apart by the order, not by position or customer');
  assert.equal(await boardStage(cashier, syncA), 'Standby');

  // right-click A -> Mark as Complete (asks first)
  await cardOf(cashier, syncA).click({ button: 'right' });
  await cashier.locator('.kmenu-item:has-text("Mark as Complete")').click();
  await cashier.waitForSelector('#dialog[open]');
  await cashier.click('[data-dlg-action]:has-text("Yes, the customer has it")');
  await waitStatus(cashier, syncA, 'COMPLETE');
  assert.equal(await ordersStatus(cashier, syncA), 'Complete');
  assert.equal(await ordersStatus(cashier, syncB), 'Ongoing');

  // and back to Ongoing from the menu
  await boardStage(cashier, syncA);
  await cardOf(cashier, syncA).click({ button: 'right' });
  await cashier.locator('.kmenu-item:has-text("Move to Ongoing")').click();
  await waitStatus(cashier, syncA, 'ONGOING');
  assert.equal(await ordersStatus(cashier, syncA), 'Ongoing', 'moving it back is shown too');

  // the saved status survives a full refresh on either screen
  await boardStage(cashier, syncA);
  await cardOf(cashier, syncA).dragTo(col(cashier, 'standby').locator('.kcol-body'));
  await waitStatus(cashier, syncA, 'STANDBY');
  await goOrders(cashier);
  await cashier.reload();
  await cashier.waitForSelector('#topbar:not([hidden])');
  assert.equal(await ordersStatus(cashier, syncA), 'Standby', 'after a refresh the Orders screen still shows the saved status');
  await cashier.reload();
  await cashier.waitForSelector('#topbar:not([hidden])');
  assert.equal(await boardStage(cashier, syncA), 'Standby', 'after a refresh the Order List still shows the same');

  // the details show it too, and the sale status itself is untouched
  await ordersStatus(cashier, syncA);
  await orderRow(cashier, syncA).click();
  await cashier.waitForSelector('dialog[open] [data-dlg-action]:has-text("Close")');
  assert.equal((await cashier.locator('dialog [data-order-status]').innerText()).trim(), 'Standby');
  assert.match(await cashier.locator('dialog').innerText(), /Pickup status\s+Standby/);
  await cashier.screenshot({ path: '/tmp/shots/16-orders-detail-status.png' });
  await cashier.click('[data-dlg-action]:has-text("Close")');
  assert.equal(db.prepare('SELECT status FROM orders WHERE order_number = ?').get(syncA).status, 'COMPLETED');
  await searchOrders(cashier, '');
  await cashier.screenshot({ path: '/tmp/shots/17-orders-status-column.png' });
  await cashier.click('a[href="#/board"]');
  await cashier.waitForSelector('.kboard');
});

await step('colours: Ongoing is yellow, Standby is blue and Complete is green, the same on the Order List columns and on the Orders screen', async () => {
  const expected = { ONGOING: 'rgb(244, 183, 42)', STANDBY: 'rgb(29, 90, 133)', COMPLETE: 'rgb(20, 87, 63)' };
  const colour = (loc, prop) => loc.first().evaluate((e, p) => getComputedStyle(e)[p], prop);
  // an order of each kind exists at this point; the Orders list is searched by status so each badge can be read
  await goOrders(cashier);
  for (const status of ['ONGOING', 'STANDBY', 'COMPLETE']) {
    await searchOrders(cashier, '', `pickup:${status}`);
    const badge = cashier.locator(`#results [data-stage="${status}"]`);
    assert.ok(await badge.count() >= 1, `an order is ${status}`);
    assert.equal(await colour(badge, 'backgroundColor'), expected[status], `${status} badge colour on the Orders screen`);
  }
  await searchOrders(cashier, '', '');
  await cashier.screenshot({ path: '/tmp/shots/19-orders-status-colours.png' });
  await cashier.click('a[href="#/board"]');
  await cashier.waitForSelector('.kboard .kcard');
  for (const [name, status] of [['ongoing', 'ONGOING'], ['standby', 'STANDBY'], ['complete', 'COMPLETE']]) {
    assert.equal(await colour(col(cashier, name), 'borderTopColor'), expected[status], `${status} column colour on the Order List`);
  }
  // an order that is inside the blue Standby column is the one the Orders screen shows in blue
  const inStandby = await numbersIn(cashier, 'standby');
  assert.ok(inStandby.length >= 1);
  await goOrders(cashier);
  await searchOrders(cashier, inStandby[0]);
  const row = orderRow(cashier, inStandby[0]);
  assert.equal((await row.locator('[data-order-status]').innerText()).trim(), 'Standby');
  assert.equal(await colour(row.locator('[data-stage]'), 'backgroundColor'), expected.STANDBY);
  await searchOrders(cashier, '');
  await cashier.click('a[href="#/board"]');
  await cashier.waitForSelector('.kboard');
});

await step('Orders screen: the status filter uses the Order List words; Canceled and Replaced orders show that instead of a column', async () => {
  await goOrders(cashier);
  assert.deepEqual(await cashier.locator('#fstatus option').allInnerTexts(), ['Any status', 'Ongoing', 'Standby', 'Complete', 'Completed', 'Canceled', 'Refunded', 'Partially refunded', 'Replaced']);
  for (const [value, status] of [['pickup:ONGOING', 'ONGOING'], ['pickup:STANDBY', 'STANDBY'], ['pickup:COMPLETE', 'COMPLETE']]) {
    await searchOrders(cashier, '', value);
    assert.deepEqual((await listedNumbers(cashier)).sort(), dbNumbers(status).sort(), `${value} lists exactly the orders in that Order List column`);
    const words = await cashier.locator('#results [data-order-status]').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    assert.ok(words.every((w) => w.startsWith(status[0] + status.slice(1).toLowerCase())), `${value}: every row says so (${[...new Set(words)]})`);
  }
  await searchOrders(cashier, '', 'sale:CANCELED');
  const canceled = db.prepare("SELECT order_number FROM orders WHERE status = 'CANCELED'").all().map((r) => r.order_number);
  assert.ok(canceled.length >= 1);
  assert.deepEqual((await listedNumbers(cashier)).sort(), canceled.sort());
  assert.equal(await cashier.locator('#results [data-stage]').count(), 0, 'a canceled order has no Order List status');
  assert.ok((await cashier.locator('#results [data-order-status]').allInnerTexts()).every((t) => t.trim() === 'Canceled'));
  await searchOrders(cashier, '', 'sale:COMPLETED');
  assert.deepEqual((await listedNumbers(cashier)).sort(), db.prepare("SELECT order_number FROM orders WHERE status = 'COMPLETED'").all().map((r) => r.order_number).sort(), 'the sale status filter still works');
  await searchOrders(cashier, '', '');
  const everything = await cashier.locator('#results [data-order-status]').evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.equal(everything.length, db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 'every order of the day is listed once');
  assert.ok(everything.every((w) => /^(Ongoing|Standby|Complete|Canceled|Replaced|(Ongoing|Standby|Complete) (Refunded|Partially refunded))$/.test(w)), `no row says "Completed": ${[...new Set(everything)]}`);
  // every row agrees with the saved status of that same order id
  const rows = await cashier.locator('#results tr[data-order-id]').evaluateAll((els) => els.map((e) => [Number(e.dataset.orderId), e.querySelector('[data-order-status]').textContent.replace(/\s+/g, ' ').trim()]));
  for (const [id, text] of rows) {
    const o = db.prepare('SELECT status, fulfillment_status AS f FROM orders WHERE id = ?').get(id);
    const expected = ['COMPLETED', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(o.status) ? o.f[0] + o.f.slice(1).toLowerCase() : { CANCELED: 'Canceled', REPLACED: 'Replaced' }[o.status];
    assert.ok(text.startsWith(expected), `order ${id}: ${text} vs ${expected}`);
  }
  await cashier.screenshot({ path: '/tmp/shots/18-orders-filter.png' });
  await cashier.click('a[href="#/board"]');
  await cashier.waitForSelector('.kboard');
});

await step('Orders screen: while it is open it picks up a status moved on another device, without a click, and stops asking when you leave', async () => {
  const watcher = await newPage();
  await watcher.clock.install();                       // fake timers: the 20-second refresh can be fast-forwarded
  await login(watcher, 'cash', 'cashier-pass-1');
  await goOrders(watcher);
  await searchOrders(watcher, syncB);
  assert.equal((await orderRow(watcher, syncB).locator('[data-order-status]').innerText()).trim(), 'Ongoing');
  const id = db.prepare('SELECT id FROM orders WHERE order_number = ?').get(syncB).id;
  await cashier.evaluate(async (orderId) => {           // another device moves it
    const res = await fetch(`/api/orders/${orderId}/fulfillment`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pos' }, body: JSON.stringify({ status: 'STANDBY' }) });
    if (!res.ok) throw new Error(`move failed ${res.status}`);
  }, id);
  await watcher.clock.runFor(21000);
  await watcher.waitForFunction((n) => [...document.querySelectorAll('tr[data-order-id]')].some((r) => r.textContent.includes(n) && r.querySelector('[data-order-status]').textContent.trim() === 'Standby'), syncB);
  // leaving the screen stops the refresh
  await watcher.click('a[href="#/board"]');
  await watcher.waitForSelector('.kboard .kcard');
  let asked = 0;
  watcher.on('request', (r) => { if (/\/api\/orders\?/.test(r.url())) asked++; });
  await watcher.clock.runFor(70000);
  await watcher.waitForTimeout(300);
  assert.equal(asked, 0, 'the Orders list is not requested again after leaving the screen');
  await watcher.context().close();
  await cashier.waitForTimeout(100);
});

await step('Order List: another person sees the same saved board, and a refresh shows what they changed', async () => {
  const other = await newPage();
  await login(other, 'mgr', 'manager-pass-1');
  await other.click('a[href="#/board"]');
  await other.waitForSelector('.kcard');
  await sameAsDatabase(other);
  assert.equal(await other.locator('.nav a').count() > 3, true, 'a manager has the same tab');
  const [victim] = await numbersIn(other, 'ongoing');
  await cardOf(other, victim).dragTo(col(other, 'standby').locator('.kcol-body'));
  await waitStatus(other, victim, 'STANDBY');
  assert.ok(!(await numbersIn(cashier, 'standby')).includes(victim), 'not yet refreshed on the cashier screen');
  await cashier.click('#boardRefresh');
  await cashier.waitForFunction((n) => [...document.querySelectorAll('.kcol--standby .kcard-no')].some((e) => e.textContent === n), victim);
  await sameAsDatabase(cashier);
  assert.deepEqual(moves(victim), ['Ongoing → Standby']);
  assert.equal(db.prepare("SELECT u.display_name AS n FROM order_events e JOIN users u ON u.id = e.user_id JOIN orders o ON o.id = e.order_id WHERE o.order_number = ? AND e.action_type = 'MOVE'").get(victim).n, 'Manager');
  assert.deepEqual(other.errors, []);
  await other.context().close();
});

await step('Order List: an order canceled on the Orders screen leaves the board; its number is not reused', async () => {
  const open = await createOpenOrder(cashier);
  await refreshBoard(cashier, open);
  assert.ok((await numbersIn(cashier, 'ongoing')).includes(open), 'a newly submitted order appears in Ongoing');
  const id = db.prepare('SELECT id FROM orders WHERE order_number = ?').get(open).id;
  await cashier.evaluate(async (orderId) => {
    const res = await fetch(`/api/orders/${orderId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'pos' }, body: JSON.stringify({ reason_code: 'CUSTOMER_CHANGED_MIND' }) });
    if (!res.ok) throw new Error(`cancel failed ${res.status}`);
  }, id);
  await cashier.click('#boardRefresh');
  await cashier.waitForFunction((n) => ![...document.querySelectorAll('.kcard-no')].some((e) => e.textContent === n), open);
  await sameAsDatabase(cashier);
  assert.equal(dbStatus(open), 'ONGOING', 'the pickup status is only a record; the sale status is what changed');
});

await step('Order List: the keyboard works too (Alt + arrow keys on a focused card)', async () => {
  const open = await createOpenOrder(cashier);
  await refreshBoard(cashier, open);
  await cardOf(cashier, open).focus();
  await cashier.keyboard.press('Alt+ArrowRight');
  await waitStatus(cashier, open, 'STANDBY');
  await cashier.waitForSelector('.kcard--saving', { state: 'detached' });     // the screen has finished saving, so the next key is accepted
  await cardOf(cashier, open).focus();
  await cashier.keyboard.press('Alt+ArrowLeft');
  await waitStatus(cashier, open, 'ONGOING');
  await sameAsDatabase(cashier);
});

await step('Order List: on a phone the board scrolls sideways (not the page) and the Move button changes the status', async () => {
  const phone = await newPage({ width: 390, height: 844 });
  await login(phone, 'cash', 'cashier-pass-1');
  await phone.click('a[href="#/board"]');
  await phone.waitForSelector('.kcard');
  const sizes = await phone.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, board: document.querySelector('.kboard').scrollWidth - document.querySelector('.kboard').clientWidth }));
  assert.ok(sizes.page <= 1, `the page is ${sizes.page}px too wide`);
  assert.ok(sizes.board > 100, 'the board itself scrolls sideways');
  await phone.screenshot({ path: '/tmp/shots/17-board-phone.png' });
  const open = await createOpenOrder(phone);
  await refreshBoard(phone, open);
  await cardOf(phone, open).locator('[data-move-menu]').click();
  await phone.waitForSelector('.kmenu');
  assert.equal(await phone.locator('.kmenu').evaluate((m) => { const r = m.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }), true, 'the menu stays on the screen');
  await phone.click('[data-menu-move="STANDBY"]');
  await waitStatus(phone, open, 'STANDBY');
  await phone.waitForSelector('.kcard--saving', { state: 'detached' });       // the screen has finished redrawing
  assert.ok((await numbersIn(phone, 'standby')).includes(open));
  await cardOf(phone, open).locator('[data-move-menu]').click();             // Playwright scrolls the card into view first
  await phone.click('[data-menu-move="ONGOING"]');
  await waitStatus(phone, open, 'ONGOING');
  await phone.waitForSelector('.kcard--saving', { state: 'detached' });
  assert.ok((await numbersIn(phone, 'ongoing')).includes(open));
  assert.deepEqual(phone.errors, []);
  await phone.context().close();
});

// ---- Revision 7: compact cards, bookmarks, sorting ------------------------------------------------------------------------
const eventCount = () => db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n;
const saleSnapshot = () => JSON.stringify({
  orders: db.prepare('SELECT id, order_number, customer_number, status, fulfillment_status, subtotal_centavos, discount_centavos, total_centavos, refund_centavos, submitted_at, cashier_id FROM orders ORDER BY id').all(),
  payments: db.prepare('SELECT * FROM payments ORDER BY id').all(),
  items: db.prepare('SELECT * FROM order_items ORDER BY id').all(),
  events: eventCount(),
});
const gotoBoard = async (page) => { await page.click('a[href="#/board"]'); await page.waitForSelector('.kboard .kcard'); };
const heightOf = (loc) => loc.evaluate((e) => e.getBoundingClientRect().height);
const isOpen = async (page, number) => (await cardOf(page, number).locator('.kcard-toggle').getAttribute('aria-expanded')) === 'true';
const star = (page, number) => cardOf(page, number).locator('[data-bookmark]');
const isStarred = async (page, number) => (await star(page, number).getAttribute('aria-pressed')) === 'true';
const dbMarked = (number) => db.prepare('SELECT bookmarked FROM orders WHERE order_number = ?').get(number).bookmarked;
const overflowing = (loc) => loc.evaluate((e) => e.scrollWidth > e.clientWidth + 1);

let rich;
await step('Order List: cards are compact and folded by default; clicking opens the full order, clicking again folds it, and no button opens a card or changes a status by accident', async () => {
  rich = await createOrderWith(cashier, (ids) => ({
    customer_number: 'Maria Santos',
    items: [
      { product_id: ids.bcull, weight: '4', feather: 'POUR', dara: false, cut: 'SLICE', slice_size: 'SMALL' },
      { product_id: ids.cull, weight: '2', feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null },
    ],
    other_items: [{ other_product_id: ids.egg.product_id, option_id: ids.egg.option_id, quantity: '2' }],
    discount: { type: 'FIXED', value: '20', reason_code: 'BULK' },
    payment: { method: 'GCASH', account_name: 'Maria Santos', account_number: '09171234567', reference: 'REF-4421' },
  }));
  await gotoBoard(cashier);
  await refreshBoard(cashier, rich);
  assert.equal(await cashier.locator('.kcard-detail').count(), 0, 'every card starts folded');
  assert.equal(await cashier.locator('.kcard-toggle[aria-expanded="true"]').count(), 0);
  const card = cardOf(cashier, rich);
  const foldedHeight = await heightOf(card);
  assert.ok(foldedHeight < 190, `a folded card is ${foldedHeight}px tall`);
  const text = (await card.innerText()).replace(/\s+/g, ' ');
  assert.match(text, new RegExp(rich)); assert.match(text, /Maria Santos/); assert.match(text, /Ongoing/); assert.match(text, /Broiler Breeder Cull 4\.0 kg/); assert.match(text, /\+ 2 more/);
  assert.match(text, /Oct \d+, \d+:\d\d/); assert.match(text, /₱[\d,]+\.\d\d/);
  assert.ok(!/Garlic|Eggs|REF-4421|Cashier|Payment|Discount|Po-ur/.test(text), 'the folded card leaves the details out');
  await cashier.screenshot({ path: '/tmp/shots/20-board-folded.png' });

  const before = saleSnapshot();
  const requests = [];
  const log = (r) => { if (r.url().includes('/api/') && r.method() !== 'GET') requests.push(`${r.method()} ${new URL(r.url()).pathname}`); };
  cashier.on('request', log);

  // clicking the card body opens it ...
  await card.locator('.kcard-cust').click();
  await card.locator('.kcard-detail').waitFor();
  assert.equal(await isOpen(cashier, rich), true);
  const open = (await card.innerText()).replace(/\s+/g, ' ');
  for (const part of [/Customer Maria Santos/, /Ordered Oct/, /Broiler Breeder Cull 4\.0 kg/, /Po-ur & Slice/, /Small pieces/, /Cull Chicken 2\.0 kg/, /Live/, /Eggs \(Small\)/, /2 dozen/, /Subtotal ₱/, /Discount −₱20\.00 \(Bulk Order Discount\)/, /Total ₱/, /Payment GCash ₱[\d,.]+ · Ref REF-4421/, /Cashier Cashier/, /Move/, /Details/, /Show less/]) {
    assert.match(open, part);
  }
  assert.ok(!/09171234567|Maria S•••/.test(open), 'no payment account details on the board');
  assert.ok(await heightOf(card) > foldedHeight + 100, 'the open card shows more');
  await cashier.screenshot({ path: '/tmp/shots/21-board-open.png' });
  // ... clicking the header area again folds it
  await card.locator('.kcard-cust').click();
  assert.equal(await card.locator('.kcard-detail').count(), 0);
  assert.equal(await isOpen(cashier, rich), false);
  // the arrow opens, "Show less" folds
  await card.locator('.kcard-toggle').click();
  assert.equal(await isOpen(cashier, rich), true);
  // reading an open card (clicking inside the details) does not fold it
  await card.locator('.kcard-facts').click();
  assert.equal(await isOpen(cashier, rich), true, 'clicking the details does not fold the card');
  await card.locator('.kcard-actions [data-toggle]').click();
  assert.equal(await isOpen(cashier, rich), false);
  // the keyboard: Enter opens, Space folds
  await card.focus();
  await cashier.keyboard.press('Enter');
  assert.equal(await isOpen(cashier, rich), true);
  await cardOf(cashier, rich).focus();
  await cashier.keyboard.press(' ');
  assert.equal(await isOpen(cashier, rich), false);

  // Move, the star and Details work on their own: none of them opens or folds the card
  await card.locator('[data-move-menu]').click();
  await cashier.waitForSelector('.kmenu');
  assert.equal(await isOpen(cashier, rich), false, 'Move does not open the card');
  await cashier.keyboard.press('Escape');
  await star(cashier, rich).click();
  assert.equal(await isOpen(cashier, rich), false, 'the star does not open the card');
  await star(cashier, rich).click();
  await card.locator('.kcard-toggle').click();
  await card.locator('[data-open]').click();
  await cashier.waitForSelector('dialog[open] [data-dlg-action]:has-text("Close")');
  assert.match(await cashier.locator('dialog').innerText(), new RegExp(rich));
  await cashier.click('[data-dlg-action]:has-text("Close")');
  await cashier.waitForTimeout(150);
  await cashier.waitForSelector('dialog[open]', { state: 'detached' }).catch(() => {});
  assert.equal(await isOpen(cashier, rich), true, 'the card is still open after the details dialog');
  await card.locator('.kcard-toggle').click();

  cashier.off('request', log);
  assert.deepEqual(requests.filter((r) => !r.includes('/bookmark')), [], 'opening, folding and Details sent nothing to the server');
  assert.equal(dbStatus(rich), 'ONGOING', 'the status never changed');
  assert.equal(saleSnapshot(), before, 'no order, payment, line or audit row changed');
  assert.equal(dbMarked(rich), 0);
});

await step('Order List: an open card stays open when the board refreshes; long names and long item lists stay inside the card, on a desktop and on a phone', async () => {
  const wide = 'W'.repeat(40);
  const long = await createOrderWith(cashier, (ids) => ({
    customer_number: wide,
    items: Array.from({ length: 8 }, () => ({ product_id: ids.bcull, weight: '1.5', feather: 'POUR', dara: true, cut: 'SLICE', slice_size: 'LARGE' })),
    other_items: [{ other_product_id: ids.egg.product_id, option_id: ids.egg.option_id, quantity: '1' }],
    payment: { method: 'CASH' },
  }));
  await refreshBoard(cashier, long);
  const card = cardOf(cashier, long);
  const check = async (page, c, label) => {
    assert.equal(await overflowing(c), false, `${label}: the card does not overflow sideways`);
    assert.equal(await overflowing(c.locator('xpath=..')), false, `${label}: the column does not scroll sideways`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1), true, `${label}: the page does not scroll sideways`);
    const inside = await c.evaluate((e) => { const r = e.getBoundingClientRect(), p = e.parentElement.getBoundingClientRect(); return r.left >= p.left - 1 && r.right <= p.right + 1; });
    assert.equal(inside, true, `${label}: the card stays inside its column`);
  };
  await check(cashier, card, 'folded');
  assert.ok(await heightOf(card) < 230, 'a folded card with 9 lines and a very long name is still compact');
  assert.match((await card.innerText()).replace(/\s+/g, ' '), /\+ 8 more/);
  await card.locator('.kcard-toggle').click();
  assert.equal(await card.locator('.kcard-lines li').count(), 9, 'the open card lists every line');
  await check(cashier, card, 'open');
  // a refresh (the button, and the 20-second timer does the same call) keeps it open
  await Promise.all([cashier.waitForResponse((r) => r.url().includes('/api/board')), cashier.click('#boardRefresh')]);
  await cashier.waitForTimeout(150);
  assert.equal(await isOpen(cashier, long), true, 'still open after a refresh');
  // leaving the screen and coming back starts folded again
  await cashier.click('a[href="#/orders"]'); await cashier.waitForSelector('#filters');
  await gotoBoard(cashier);
  assert.equal(await cashier.locator('.kcard-detail').count(), 0, 'every card starts folded on a new visit');
  // phone
  const phone = await newPage({ width: 390, height: 844 });
  await login(phone, 'cash', 'cashier-pass-1');
  await gotoBoard(phone);
  const pc = cardOf(phone, long);
  await pc.scrollIntoViewIfNeeded();
  await check(phone, pc, 'phone folded');
  await pc.locator('.kcard-toggle').click();
  await check(phone, pc, 'phone open');
  await phone.screenshot({ path: '/tmp/shots/22-board-phone-open.png' });
  assert.deepEqual(phone.errors, []);
  await phone.context().close();
});

const markedNumbers = () => db.prepare("SELECT order_number FROM orders WHERE bookmarked = 1 AND status IN ('COMPLETED','REFUNDED','PARTIALLY_REFUNDED')").all().map((r) => r.order_number);
await step('Order List: the star bookmarks an order without changing its status; it persists after a refresh and stays with the order when it moves', async () => {
  await gotoBoard(cashier);
  const twin = await createOrderWith(cashier, (ids) => ({ customer_number: 'Maria Santos', items: [{ product_id: ids.cull, weight: '1', feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null }], payment: { method: 'CASH' } }));
  await refreshBoard(cashier, twin);
  const before = saleSnapshot();
  assert.equal(await isStarred(cashier, rich), false);
  assert.match(await star(cashier, rich).locator('xpath=ancestor::article').getAttribute('class'), /^(?!.*kcard--bookmarked)/);
  const puts = [];
  const log = (r) => { if (r.method() === 'PUT' && r.url().includes('/bookmark')) puts.push(r.url()); };
  cashier.on('request', log);
  await star(cashier, rich).dblclick();                                   // a double click: one request, ends bookmarked
  await cashier.waitForFunction((n) => document.querySelector(`[data-card] [data-bookmark][aria-pressed="true"]`) && [...document.querySelectorAll('.kcard')].some((c) => c.querySelector('.kcard-no').textContent === n && c.querySelector('[data-bookmark]').getAttribute('aria-pressed') === 'true'), rich);
  await cashier.waitForTimeout(250);
  cashier.off('request', log);
  assert.equal(puts.length, 1, 'a double click sends one request');
  assert.equal(await isStarred(cashier, rich), true);
  assert.equal(dbMarked(rich), 1);
  assert.match(await cardOf(cashier, rich).getAttribute('class'), /kcard--bookmarked/);
  assert.equal((await star(cashier, rich).innerText()).trim(), '★');
  assert.equal(await isStarred(cashier, twin), false, 'the other order (same customer) is not bookmarked');
  assert.equal(dbStatus(rich), 'ONGOING', 'bookmarking does not change the status');
  assert.equal(await cashier.locator('#markCount').innerText(), String(markedNumbers().length));
  await cashier.screenshot({ path: '/tmp/shots/23-board-bookmarked.png' });
  // after a page refresh it is still bookmarked, and it is not pushed to the top
  await cashier.reload();
  await cashier.waitForSelector('.kcard');
  assert.equal(await isStarred(cashier, rich), true, 'still bookmarked after a refresh');
  const ongoingNumbers = await numbersIn(cashier, 'ongoing');
  assert.ok(ongoingNumbers.indexOf(rich) > 0 || ongoingNumbers.length === 1, 'a bookmarked order keeps its place in the sort; it is not forced to the top');
  // it follows the order from column to column
  for (const target of ['STANDBY', 'ONGOING']) {
    await cardOf(cashier, rich).locator('[data-move-menu]').click();
    await cashier.click(`[data-menu-move="${target}"]`);
    await waitStatus(cashier, rich, target);
    await cashier.waitForSelector('.kcard--saving', { state: 'detached' });
    assert.ok((await numbersIn(cashier, target.toLowerCase())).includes(rich));
    assert.equal(await isStarred(cashier, rich), true, `still bookmarked in ${target}`);
    assert.equal(await isStarred(cashier, twin), false);
  }
  // the right-click menu can do it too
  await cardOf(cashier, twin).click({ button: 'right' });
  assert.match((await menuItems(cashier)).join('|'), /☆ Bookmark this order/);
  await cashier.click('[data-menu-bookmark]');
  await cashier.waitForFunction((n) => [...document.querySelectorAll('.kcard')].some((c) => c.querySelector('.kcard-no').textContent === n && c.querySelector('[data-bookmark]').getAttribute('aria-pressed') === 'true'), twin);
  assert.equal(dbMarked(twin), 1);
  // and the star switches it off again
  await star(cashier, twin).click();
  await cashier.waitForFunction((n) => [...document.querySelectorAll('.kcard')].some((c) => c.querySelector('.kcard-no').textContent === n && c.querySelector('[data-bookmark]').getAttribute('aria-pressed') === 'false'), twin);
  assert.equal(dbMarked(twin), 0);
  await sameAsDatabase(cashier);
  // the two moves wrote two audit rows (Ongoing -> Standby -> Ongoing); bookmarking wrote none, and no sale data changed
  assert.equal(eventCount(), JSON.parse(before).events + 2);
  assert.equal(JSON.stringify(JSON.parse(saleSnapshot()).orders), JSON.stringify(JSON.parse(before).orders), 'every order row is as it was');
  assert.equal(JSON.stringify(JSON.parse(saleSnapshot()).payments), JSON.stringify(JSON.parse(before).payments));
  assert.equal(JSON.stringify(JSON.parse(saleSnapshot()).items), JSON.stringify(JSON.parse(before).items));
  // another person sees the same bookmark
  const colleague = await newPage();
  await login(colleague, 'mgr', 'manager-pass-1');
  await colleague.click('a[href="#/board"]');
  await colleague.waitForSelector('.kcard');
  await colleague.waitForSelector(`.kcard:has(.kcard-no:text-is("${rich}")) [data-bookmark][aria-pressed="true"]`);
  await colleague.context().close();
});

await step('Order List: the Bookmarked filter shows only bookmarked orders, keeps the columns, and "All orders" brings everything back', async () => {
  await gotoBoard(cashier);
  const other = await createOpenOrder(cashier);
  await refreshBoard(cashier, other);
  const total = await cashier.locator('.kcard').count();
  const marked = markedNumbers();
  assert.ok(marked.includes(rich) && marked.length < total);
  await cashier.click('.seg-btn[data-filter="bookmarked"]');
  assert.equal(await cashier.locator('.seg-btn[data-filter="bookmarked"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await cashier.locator('.kcol').count(), 3, 'the three columns are still there');
  const shown = await cashier.locator('.kcard-no').allInnerTexts();
  assert.deepEqual([...shown].sort(), [...marked].sort(), 'exactly the bookmarked orders are shown');
  assert.ok(await cashier.locator('.kcard').evaluateAll((cards) => cards.every((c) => c.classList.contains('kcard--bookmarked'))));
  assert.match(await cashier.locator('#boardFilterNote').innerText(), new RegExp(`Showing bookmarked orders only: ${marked.length} of ${total}`));
  for (const status of ['ongoing', 'standby', 'complete']) {
    const n = await numbersIn(cashier, status);
    assert.equal(await col(cashier, status).locator('.kcount').innerText(), String(n.length));
    if (!n.length) assert.match(await col(cashier, status).innerText(), new RegExp(`No bookmarked ${status} orders`));
  }
  await cashier.screenshot({ path: '/tmp/shots/24-board-filter.png' });
  // un-starring inside the filter removes the card from view, and it is only hidden: it is still on the board
  await star(cashier, rich).click();
  await cashier.waitForFunction((n) => ![...document.querySelectorAll('.kcard-no')].some((e) => e.textContent === n), rich);
  assert.equal(dbMarked(rich), 0);
  await cashier.click('#boardFilterNote [data-filter="all"]');
  assert.equal(await cashier.locator('#boardFilterNote').innerText(), '');
  assert.equal(await cashier.locator('.kcard').count(), total, 'every order is back');
  assert.ok((await numbersIn(cashier, 'ongoing')).includes(rich));
  await sameAsDatabase(cashier);
  await star(cashier, rich).click();                                      // bookmark it again for the next checks
  for (let i = 0; i < 40 && dbMarked(rich) !== 1; i++) await cashier.waitForTimeout(50);
  assert.equal(dbMarked(rich), 1);
});

// seven orders with chosen names, dates and numbers, so every sort has one right answer
const SORT_SEED = [
  ['S1', 'ORD-20260301-001', 'Zed',    '2026-03-01T01:00:00.000Z', 'ONGOING'],
  ['S2', 'ORD-20260301-002', 'abby',   '2026-03-01T02:00:00.000Z', 'ONGOING'],
  ['S3', 'ORD-20260228-007', 'Carlo',  '2026-02-28T05:00:00.000Z', 'ONGOING'],
  ['S4', 'ORD-20260302-001', 'WALK-IN', '2026-03-02T01:00:00.000Z', 'ONGOING'],
  ['S5', 'ORD-20260227-003', 'Bea',    'not-a-date',               'ONGOING'],
  ['S6', 'ORD-20260301-003', 'Mike',   '2026-03-01T03:00:00.000Z', 'STANDBY'],
  ['S7', 'ORD-20260301-004', 'Anna',   '2026-03-01T04:00:00.000Z', 'STANDBY'],
];
const seedNo = Object.fromEntries(SORT_SEED.map(([k, no]) => [k, no]));
const seedSet = new Set(Object.values(seedNo));
const seeded = (names) => names.filter((n) => seedSet.has(n));
await step('Order List: each sort option orders every column correctly, on stored dates, names and numbers; a missing date is handled; sorting changes no data', async () => {
  const cashierId = db.prepare("SELECT id FROM users WHERE username = 'cash'").get().id;
  for (const [k, no, name, at, ful] of SORT_SEED) {
    db.prepare(`INSERT INTO orders (order_number, business_date, customer_number, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key, fulfillment_status)
                VALUES (?, ?, ?, 'COMPLETED', 5000, 5000, ?, ?, ?, ?)`).run(no, no.slice(4, 12).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'), name, cashierId, at, `sort-seed-${k}-xxxxxxxx`, ful);
  }
  await gotoBoard(cashier);
  await cashier.click('#boardRefresh');
  await cashier.waitForFunction((n) => [...document.querySelectorAll('.kcard-no')].some((e) => e.textContent === n), seedNo.S7);
  const snapshot = saleSnapshot();
  const S = seedNo;
  const expected = {
    newest: { ongoing: [S.S4, S.S2, S.S1, S.S3, S.S5], standby: [S.S7, S.S6] },
    oldest: { ongoing: [S.S3, S.S1, S.S2, S.S4, S.S5], standby: [S.S6, S.S7] },
    name_az: { ongoing: [S.S2, S.S5, S.S3, S.S1, S.S4], standby: [S.S7, S.S6] },
    name_za: { ongoing: [S.S1, S.S3, S.S5, S.S2, S.S4], standby: [S.S6, S.S7] },
    number: { ongoing: [S.S5, S.S3, S.S1, S.S2, S.S4], standby: [S.S6, S.S7] },
  };
  assert.deepEqual(await cashier.locator('#boardSort option').allInnerTexts(), ['Newest first', 'Oldest first', 'Customer A–Z', 'Customer Z–A', 'Order number']);
  for (const [mode, want] of Object.entries(expected)) {
    await cashier.selectOption('#boardSort', mode);
    for (const column of ['ongoing', 'standby']) {
      assert.deepEqual(seeded(await numbersIn(cashier, column)), want[column], `${mode}: ${column}`);
    }
    // every seeded card stays in the column its saved status says, and the page agrees with the database
    for (const [k, no, , , ful] of SORT_SEED) assert.equal(dbStatus(no), ful, `${k} was not moved by sorting`);
    await sameAsDatabase(cashier);
  }
  assert.match(await cardOf(cashier, S.S5).innerText(), /Date unknown/, 'an order with no usable date says so and still shows');
  assert.equal(saleSnapshot(), snapshot, 'sorting changed no order, payment, line or audit row');

  // the sort choice survives a refresh of the page
  await cashier.selectOption('#boardSort', 'name_za');
  await cashier.reload();
  await cashier.waitForSelector('.kcard');
  assert.equal(await cashier.inputValue('#boardSort'), 'name_za');
  assert.deepEqual(seeded(await numbersIn(cashier, 'ongoing')), expected.name_za.ongoing);

  // sorting and the Bookmarked filter together
  for (const no of [S.S5, S.S3, S.S7]) await star(cashier, no).click();
  for (let i = 0; i < 60 && !(dbMarked(S.S5) && dbMarked(S.S3) && dbMarked(S.S7)); i++) await cashier.waitForTimeout(50);
  await cashier.click('.seg-btn[data-filter="bookmarked"]');
  const together = {
    newest: { ongoing: [S.S3, S.S5], standby: [S.S7] },
    oldest: { ongoing: [S.S3, S.S5], standby: [S.S7] },
    name_az: { ongoing: [S.S5, S.S3], standby: [S.S7] },
    name_za: { ongoing: [S.S3, S.S5], standby: [S.S7] },
    number: { ongoing: [S.S5, S.S3], standby: [S.S7] },
  };
  for (const [mode, want] of Object.entries(together)) {
    await cashier.selectOption('#boardSort', mode);
    for (const column of ['ongoing', 'standby']) assert.deepEqual(seeded(await numbersIn(cashier, column)), want[column], `bookmarked + ${mode}: ${column}`);
    const shown = await cashier.locator('.kcard-no').allInnerTexts();
    assert.deepEqual([...shown].sort(), markedNumbers().sort(), `bookmarked + ${mode}: only bookmarked orders`);
  }
  await cashier.screenshot({ path: '/tmp/shots/25-board-sorted-bookmarked.png' });
  // a move while filtered and sorted keeps the bookmark and the order of the column
  await cardOf(cashier, S.S7).locator('[data-move-menu]').click();
  await cashier.click('[data-menu-move="ONGOING"]');
  await waitStatus(cashier, S.S7, 'ONGOING');
  await cashier.waitForSelector('.kcard--saving', { state: 'detached' });
  await cashier.selectOption('#boardSort', 'name_az');
  assert.deepEqual(seeded(await numbersIn(cashier, 'ongoing')), [S.S7, S.S5, S.S3], 'Anna, Bea, Carlo');
  assert.equal(dbMarked(S.S7), 1);
  await cashier.click('.seg-btn[data-filter="all"]');
  await cashier.selectOption('#boardSort', 'newest');
  assert.deepEqual(saleSnapshot().length > 0, true);
  assert.deepEqual(await cashier.evaluate(() => [...document.querySelectorAll('.kcard--bookmarked')].length > 0), true);
  assert.deepEqual(cashier.errors, []);
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
  await manager.locator('tr.clickable:not(.row--canceled):not(.row--replaced):not(.row--refunded)').first().click();
  await manager.waitForSelector('dialog[open] [data-dlg-action]:has-text("Close")');
  assert.equal(await manager.locator('[data-dlg-action]:has-text("Refund order")').count(), 1);
  await manager.click('[data-dlg-action]:has-text("Refund order")');
  await manager.selectOption('#rCode', 'CUSTOMER_NOT_SATISFIED');
  await manager.click('[data-dlg-action]:has-text("Refund this order")');
  await manager.waitForSelector('tr.row--refunded');
  const refundedStatus = (await manager.locator('tr.row--refunded [data-order-status]').first().innerText()).replace(/\s+/g, ' ').trim();
  assert.match(refundedStatus, /^(Ongoing|Standby|Complete) Refunded$/, 'a refunded order is still on the Order List, so it shows its Order List status and Refunded');
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

// ---- Revision 7: Delete Account -------------------------------------------------------------------------------------------
await step('Users: Delete Account asks first, Cancel changes nothing, a double click deletes once, history is kept, and protected accounts have no button', async () => {
  const config = loadConfig({ dbPath: ':memory:' });
  const mk = (username, role = 'cashier') => createUser(db, { username, display_name: `${username} Person`, role, password: 'temp-pass-123' });
  const spare = mk('spare.one'); const worker = mk('worker.two'); const ghost = mk('ghost.three'); const second = mk('admin.two', 'admin');
  const cullId = db.prepare("SELECT id FROM products WHERE name = 'Cull Chicken'").get().id;
  const placed = createOrder(db, worker, { submission_key: `del-hist-${Date.now()}-xxxxxxxx`, customer_number: 'HISTORY', items: [{ product_id: cullId, weight: '1', feather: 'LIVE', dara: false, cut: 'NONE', slice_size: null }], payment: { method: 'CASH' } }, { config, now: new Date() }).order;
  const ordersBefore = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const paymentsBefore = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
  const eventsBefore = db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n;
  const exists = (id) => !!db.prepare('SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL').get(id);

  const deletes = [];
  adminPage.on('request', (r) => { if (r.method() === 'DELETE') deletes.push(new URL(r.url()).pathname); });
  await adminPage.click('a[href="#/users"]');
  await adminPage.waitForSelector('#userList table');
  const row = (username) => adminPage.locator('#userList tr', { has: adminPage.locator(`td:text-is("${username}")`) });

  // who gets the button: everyone except you, the main owner account, and the last active admin
  assert.equal(await row('owner').locator('[data-delete]').count(), 0, 'no button on your own account');
  assert.match(await row('owner').innerText(), /This is you/);
  for (const name of ['mgr', 'cash', 'spare.one', 'worker.two', 'admin.two']) {
    assert.equal(await row(name).locator('[data-delete]').count(), 1, `${name} can be deleted`);
    assert.equal((await row(name).locator('[data-delete]').innerText()).trim(), 'Delete Account');
  }
  await adminPage.screenshot({ path: '/tmp/shots/26-users.png' });

  // the dialog: warning text, who it is about, Cancel and Delete Account; nothing is sent yet
  await row('spare.one').locator('[data-delete]').click();
  await adminPage.waitForSelector('dialog[open]');
  const dlg = (await adminPage.locator('dialog').innerText()).replace(/\s+/g, ' ');
  assert.match(dlg, /Delete this user account\?/);
  assert.match(dlg, /Are you sure you want to delete this account\? This action may permanently remove the user's access and associated account data\. Please confirm that you want to continue\./);
  assert.match(dlg, /spare\.one Person/); assert.match(dlg, /Username: spare\.one/); assert.match(dlg, /Cashier/);
  assert.deepEqual(await adminPage.locator('dialog .dlg-foot button').allInnerTexts(), ['Cancel', 'Delete Account']);
  await adminPage.screenshot({ path: '/tmp/shots/27-delete-dialog.png' });
  assert.deepEqual(deletes, [], 'opening the dialog deletes nothing');
  assert.equal(exists(spare.id), true);

  // Cancel, and Esc, change nothing
  await adminPage.click('dialog [data-dlg-action]:has-text("Cancel")');
  await adminPage.waitForSelector('dialog[open]', { state: 'detached' });
  assert.equal(exists(spare.id), true); assert.deepEqual(deletes, []);
  assert.equal(await row('spare.one').count(), 1, 'still listed');
  await row('spare.one').locator('[data-delete]').click();
  await adminPage.waitForSelector('dialog[open]');
  await adminPage.keyboard.press('Escape');
  await adminPage.waitForSelector('dialog[open]', { state: 'detached' });
  assert.equal(exists(spare.id), true); assert.deepEqual(deletes, []);

  // Delete Account, double-clicked: one request, the account is gone, the list is refreshed, a message is shown
  await row('spare.one').locator('[data-delete]').click();
  await adminPage.waitForSelector('dialog[open]');
  await adminPage.locator('dialog [data-dlg-action]:has-text("Delete Account")').dblclick();
  await adminPage.waitForSelector('dialog[open]', { state: 'detached' });
  await adminPage.waitForFunction(() => !document.querySelector('#userList')?.innerText.includes('spare.one'));
  assert.equal(deletes.length, 1, 'a double click sends one request');
  assert.equal(db.prepare('SELECT 1 FROM users WHERE id = ?').get(spare.id), undefined, 'a never-used account is removed completely');
  assert.match(await adminPage.locator('#toasts').innerText(), /spare\.one Person was deleted\./);

  // an account with orders and payments: closed, not erased; every record stays
  await row('worker.two').locator('[data-delete]').click();
  await adminPage.waitForSelector('dialog[open]');
  await adminPage.click('dialog [data-dlg-action]:has-text("Delete Account")');
  await adminPage.waitForSelector('dialog[open]', { state: 'detached' });
  await adminPage.waitForFunction(() => !document.querySelector('#userList')?.innerText.includes('worker.two'));
  assert.match(await adminPage.locator('#toasts').innerText(), /worker\.two Person was deleted\. Their past orders and payment records were kept\./);
  assert.equal(exists(worker.id), false, 'no longer an account');
  assert.ok(db.prepare('SELECT deleted_at FROM users WHERE id = ?').get(worker.id).deleted_at, 'the row stays, marked deleted');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, ordersBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM payments').get().n, paymentsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM order_events').get().n, eventsBefore);
  const kept = await adminPage.evaluate(async (id) => (await (await fetch(`/api/orders/${id}`)).json()).order, placed.id);
  assert.equal(kept.cashier_name, 'worker.two Person', 'the old order still names its cashier');
  assert.equal(kept.payments.length, 1);
  assert.equal(deletes.length, 2);

  // an error is shown plainly and the list is brought up to date: the account was deleted somewhere else meanwhile
  await row('ghost.three').locator('[data-delete]').click();
  await adminPage.waitForSelector('dialog[open]');
  db.prepare('DELETE FROM users WHERE id = ?').run(ghost.id);
  await adminPage.click('dialog [data-dlg-action]:has-text("Delete Account")');
  await adminPage.waitForSelector('dialog .error-box');
  assert.match(await adminPage.locator('dialog .error-box').innerText(), /not found\. It may already have been deleted\./);
  await adminPage.waitForFunction(() => !document.querySelector('#userList')?.innerText.includes('ghost.three'));
  await adminPage.click('dialog [data-dlg-action]:has-text("Cancel")');
  await adminPage.waitForSelector('dialog[open]', { state: 'detached' });

  // another admin: the main owner account is protected for them, and they cannot delete themselves
  db.prepare('UPDATE users SET active = 1 WHERE id = ?').run(second.id);
  const adminTwo = await newPage();
  await login(adminTwo, 'admin.two', 'temp-pass-123');
  await adminTwo.click('a[href="#/users"]');
  await adminTwo.waitForSelector('#userList table');
  const row2 = (username) => adminTwo.locator('#userList tr', { has: adminTwo.locator(`td:text-is("${username}")`) });
  assert.equal(await row2('owner').locator('[data-delete]').count(), 0, 'the main owner account cannot be deleted');
  assert.match(await row2('owner').innerText(), /Main owner account/);
  assert.equal(await row2('admin.two').locator('[data-delete]').count(), 0);
  assert.match(await row2('admin.two').innerText(), /This is you/);
  assert.equal(await row2('mgr').locator('[data-delete]').count(), 1);
  await adminTwo.context().close();

  // managers and cashiers never see Users, and a hand-made request is refused by the server
  const cashierNow = await newPage();                                   // the earlier cashier page was signed out in an earlier check
  await login(cashierNow, 'cash', 'cashier-pass-1');
  assert.equal(await manager.locator('[href="#/users"]').count(), 0);
  assert.equal(await cashierNow.locator('[href="#/users"]').count(), 0);
  const victim = db.prepare("SELECT id FROM users WHERE username = 'mgr'").get().id;
  for (const page of [cashierNow, manager]) {
    const status = await page.evaluate(async (id) => (await fetch(`/api/users/${id}`, { method: 'DELETE', headers: { 'X-Requested-With': 'pos' } })).status, victim);
    assert.equal(status, 403, 'a direct request from a non-admin is refused');
  }
  await cashierNow.context().close();
  assert.equal(exists(victim), true);
  adminPage.removeAllListeners('request');
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
