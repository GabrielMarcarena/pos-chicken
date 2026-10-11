// Unit tests: money maths, preparation rules, fees, discounts, and the database's own safeguards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeightToGrams, parsePesosToCentavos, parseQuantityToMilli, parseWholeQuantityToMilli, parsePercentToBp, parseHeads, formatPeso, formatPercent, mulDivRound } from '../shared/money.js';
import { emptyPrep, applyPrepChange, validatePrep } from '../shared/rules.js';
import { chickenLine, otherLine, grandTotal, discountAmount } from '../shared/pricing.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';
import { blockFor, eggSize } from '../src/services/dailyReport.js';

const noFees = {};
const SHOP_FEES = { POUR: { amount: 4500, basis: 'per_item' }, NOT_POUR: { amount: 2500, basis: 'per_item' }, DARA: { amount: 0, basis: 'per_item' }, DUKOT: { amount: 0, basis: 'per_item' } };
const live = { feather: 'LIVE', dara: false, cut: 'NONE', sliceSize: null };
const poSlice = (size = 'MEDIUM') => ({ feather: 'POUR', dara: false, cut: 'SLICE', sliceSize: size });
const dressedSlice = (size = 'MEDIUM') => ({ feather: 'NOT_POUR', dara: false, cut: 'SLICE', sliceSize: size });

test('3.6 kg of Cull Chicken at ₱58.00/kg is ₱208.80 (live, no fee)', () => {
  const line = chickenLine({ pricePerKgCentavos: 5800, weightG: parseWeightToGrams('3.6'), prep: live, fees: SHOP_FEES });
  assert.equal(line.weightAmount, 20880);
  assert.equal(line.lineTotal, 20880);
  assert.equal(formatPeso(line.lineTotal), '₱208.80');
});

test('services: Po-ur & Slice adds ₱45, Dressed & Slice adds ₱25, Live adds nothing', () => {
  const g = parseWeightToGrams('3.6');
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: poSlice(), fees: SHOP_FEES }).lineTotal, 20880 + 4500);       // ₱253.80
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: dressedSlice('SMALL'), fees: SHOP_FEES }).lineTotal, 20880 + 2500); // ₱233.80
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: live, fees: SHOP_FEES }).lineTotal, 20880);
});

test('the slice size does not change the price; Dukot adds only its own fee (default none)', () => {
  const g = 3600;
  const sizes = ['SMALL', 'MEDIUM', 'LARGE'].map((s) => chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: poSlice(s), fees: SHOP_FEES }).lineTotal);
  assert.deepEqual(new Set(sizes).size, 1);
  const dukot = { feather: 'POUR', dara: false, cut: 'DUKOT', sliceSize: null };
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: dukot, fees: SHOP_FEES }).lineTotal, 20880 + 4500);
  const withDukotFee = { ...SHOP_FEES, DUKOT: { amount: 1000, basis: 'per_item' } };
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: dukot, fees: withDukotFee }).lineTotal, 20880 + 4500 + 1000);
});

test('fees can be per item or per kg, and Dara can carry a fee', () => {
  const fees = { POUR: { amount: 500, basis: 'per_kg' }, DARA: { amount: 700, basis: 'per_item' } };
  const line = chickenLine({ pricePerKgCentavos: 5800, weightG: 3600, prep: { ...poSlice(), dara: true }, fees });
  assert.deepEqual(line.fees.map((f) => [f.code, f.amount]), [['POUR', 1800], ['DARA', 700]]);
  assert.equal(line.lineTotal, 20880 + 1800 + 700);
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: 3600, prep: live, fees }).serviceFee, 0);
});

test('weights accept 1.25, 3.6 and 4.75 and reject bad input', () => {
  assert.equal(parseWeightToGrams('1.25'), 1250);
  assert.equal(parseWeightToGrams('3.6'), 3600);
  assert.equal(parseWeightToGrams(4.75), 4750);
  for (const bad of ['', ' ', '0', '0.000', '-1', 'abc', '1,5', '1.2345', '1e3', null, undefined, true, '1.2.3']) {
    assert.equal(parseWeightToGrams(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('pesos, quantities, whole quantities and percentages parse exactly', () => {
  assert.equal(parsePesosToCentavos('58'), 5800);
  assert.equal(parsePesosToCentavos('58.5'), 5850);
  assert.equal(parsePesosToCentavos('58.555'), null);
  assert.equal(parseQuantityToMilli('1.5'), 1500);
  assert.equal(parseQuantityToMilli('0'), null);
  assert.equal(parseWholeQuantityToMilli('2'), 2000);
  assert.equal(parseWholeQuantityToMilli('2.5'), null);   // a dozen is not sold in halves
  assert.equal(parsePercentToBp('20'), 2000);
  assert.equal(parsePercentToBp('12.5'), 1250);
  assert.equal(parsePercentToBp('0'), null);
  assert.equal(parsePercentToBp('100.01'), null);
  assert.equal(formatPercent(2000), '20%');
  assert.equal(formatPercent(1250), '12.5%');
});

test('rounding is half up to the centavo, once per amount', () => {
  assert.equal(mulDivRound(5801, 1, 1000), 6);
  assert.equal(mulDivRound(1005, 500, 1000), 503);
  assert.equal(mulDivRound(1004, 500, 1000), 502);
  assert.equal(grandTotal([10, 20]), 30);
});

test('several lines add up (₱448.80) and fixed-price and per-kg other products both work', () => {
  const a = chickenLine({ pricePerKgCentavos: 5800, weightG: 3600, prep: live, fees: noFees });
  const b = chickenLine({ pricePerKgCentavos: 12000, weightG: 2000, prep: live, fees: noFees });
  assert.equal(grandTotal([a.lineTotal, b.lineTotal]), 44880);
  assert.equal(otherLine({ unitPriceCentavos: 12000, quantityMilli: 2000 }).lineTotal, 24000); // 2 dozen eggs at ₱120 each dozen
  assert.equal(otherLine({ unitPriceCentavos: 8000, quantityMilli: 1500 }).lineTotal, 12000);  // 1.5 kg at ₱80/kg
  assert.equal(otherLine({ unitPriceCentavos: 1000, quantityMilli: 1000 }).lineTotal, 1000);   // 1 piece
});

test('discounts: fixed amount and percentage, rounded half up', () => {
  assert.equal(discountAmount(25380, 'FIXED', 5000), 5000);
  assert.equal(discountAmount(25380, 'PERCENT', 2000), 5076);   // 20% of ₱253.80
  assert.equal(discountAmount(10025, 'PERCENT', 1000), 1003);   // 10% of ₱100.25 = 10.025 -> 10.03
  assert.equal(discountAmount(25380, 'NONE', 0), 0);
});

test('services are exclusive: Live, Po-ur & Slice and Dressed & Slice', () => {
  let p = applyPrepChange(emptyPrep(), { feather: 'POUR' });
  assert.equal(p.feather, 'POUR');
  p = applyPrepChange(p, { feather: 'NOT_POUR' });
  assert.equal(p.feather, 'NOT_POUR');
  p = applyPrepChange(p, { feather: 'LIVE' });
  assert.equal(p.feather, 'LIVE');
});

test('cutting is one choice: small, medium, large pieces or Dukot; Dukot clears the size', () => {
  let p = applyPrepChange(emptyPrep(), { feather: 'POUR' });
  p = applyPrepChange(p, { cut: 'SMALL' });
  assert.deepEqual([p.cut, p.sliceSize], ['SLICE', 'SMALL']);
  p = applyPrepChange(p, { cut: 'LARGE' });
  assert.deepEqual([p.cut, p.sliceSize], ['SLICE', 'LARGE']);   // only one size at a time
  p = applyPrepChange(p, { cut: 'DUKOT' });
  assert.deepEqual([p.cut, p.sliceSize], ['DUKOT', null]);
  p = applyPrepChange(p, { cut: 'MEDIUM' });
  assert.deepEqual([p.cut, p.sliceSize], ['SLICE', 'MEDIUM']);  // Slice and Dukot never together
});

test('changing the service never resets Dara or the cutting choice', () => {
  let p = applyPrepChange(emptyPrep(), { feather: 'POUR' });
  p = applyPrepChange(p, { dara: true });
  p = applyPrepChange(p, { cut: 'MEDIUM' });
  p = applyPrepChange(p, { feather: 'NOT_POUR' });
  assert.deepEqual(p, { feather: 'NOT_POUR', dara: true, cut: 'SLICE', sliceSize: 'MEDIUM' });
  p = applyPrepChange(p, { dara: false });
  assert.deepEqual(p, { feather: 'NOT_POUR', dara: false, cut: 'SLICE', sliceSize: 'MEDIUM' });
});

test('choosing Live clears and disables Dara and cutting', () => {
  let p = { feather: 'POUR', dara: true, cut: 'SLICE', sliceSize: 'MEDIUM' };
  p = applyPrepChange(p, { feather: 'LIVE' });
  assert.deepEqual(p, { feather: 'LIVE', dara: false, cut: 'NONE', sliceSize: null });
  p = applyPrepChange(p, { dara: true });
  p = applyPrepChange(p, { cut: 'DUKOT' });
  assert.deepEqual(p, { feather: 'LIVE', dara: false, cut: 'NONE', sliceSize: null });
  // leaving Live does not bring the old choices back
  p = applyPrepChange(p, { feather: 'POUR' });
  assert.deepEqual(p, { feather: 'POUR', dara: false, cut: 'NONE', sliceSize: null });
  assert.ok(validatePrep(p).length, 'Po-ur needs a cutting choice');
});

test('validatePrep accepts good combinations and rejects every conflicting one', () => {
  assert.deepEqual(validatePrep(live), []);
  assert.deepEqual(validatePrep(poSlice('LARGE')), []);
  assert.deepEqual(validatePrep({ ...dressedSlice('SMALL'), dara: true }), []);
  assert.deepEqual(validatePrep({ feather: 'POUR', dara: false, cut: 'DUKOT', sliceSize: null }), []);
  assert.ok(validatePrep(emptyPrep()).length, 'service is required');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'NONE', sliceSize: null }).length, 'Po-ur always needs slice or Dukot');
  assert.ok(validatePrep({ feather: 'NOT_POUR', dara: false, cut: 'NONE', sliceSize: null }).length, 'Dressed always needs slice or Dukot');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'SLICE', sliceSize: null }).length, 'slice needs a size');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'SLICE', sliceSize: 'HUGE' }).length, 'unknown size');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'DUKOT', sliceSize: 'SMALL' }).length, 'dukot keeps no size');
  assert.ok(validatePrep({ feather: 'LIVE', dara: true, cut: 'NONE', sliceSize: null }).length, 'live has no dara');
  assert.ok(validatePrep({ feather: 'LIVE', dara: false, cut: 'DUKOT', sliceSize: null }).length, 'live has no cutting');
  assert.ok(validatePrep({ feather: 'LIVE', dara: false, cut: 'SLICE', sliceSize: 'SMALL' }).length, 'live is never sliced');
  assert.ok(validatePrep({ feather: 'ROASTED', dara: false, cut: 'NONE', sliceSize: null }).length, 'unknown service');
});

// ---- The database enforces the same rules even if the app is bypassed -------------------------------

function seededDb() {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('u','U','x','admin',?)").run(now);
  db.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('Cull Chicken', 5800, 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key) VALUES ('ORD-1','2026-10-09','COMPLETED',20880,20880,1,?,'k1')").run(now);
  return db;
}
let lineNo = 0;
const insertLine = (db, feather, dara, cut, size, fee = 0) => db.prepare(`INSERT INTO order_items
  (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, service_fee_centavos, line_total_centavos)
  VALUES (1, ?, 1, 'Cull Chicken', 5800, 3600, 20880, ?, ?, ?, ?, ?, ?)`).run(++lineNo, feather, dara, cut, size, fee, 20880 + fee);

test('database: valid lines save, conflicting lines are refused', () => {
  const db = seededDb();
  insertLine(db, 'POUR', 1, 'SLICE', 'MEDIUM', 4500);
  insertLine(db, 'NOT_POUR', 0, 'DUKOT', null, 2500);
  insertLine(db, 'LIVE', 0, 'NONE', null, 0);
  assert.throws(() => insertLine(db, 'POUR', 0, 'NONE', null, 4500), /CHECK/);      // Po-ur is always sliced or Dukot
  assert.throws(() => insertLine(db, 'NOT_POUR', 0, 'NONE', null, 2500), /CHECK/);  // so is Dressed
  assert.throws(() => insertLine(db, 'POUR', 0, 'SLICE', null), /CHECK/);           // slice without a size
  assert.throws(() => insertLine(db, 'POUR', 0, 'DUKOT', 'SMALL'), /CHECK/);        // dukot with a size
  assert.throws(() => insertLine(db, 'LIVE', 1, 'NONE', null), /CHECK/);            // live with dara
  assert.throws(() => insertLine(db, 'LIVE', 0, 'SLICE', 'SMALL'), /CHECK/);        // live sliced
  assert.throws(() => insertLine(db, 'LIVE', 0, 'NONE', null, 100), /CHECK/);       // live with a fee
  assert.throws(() => insertLine(db, 'ROASTED', 0, 'NONE', null), /CHECK/);         // unknown service
});

test('database: discount figures must add up, and a zero discount cannot be labelled as one', () => {
  const db = seededDb();
  const now = new Date().toISOString();
  const add = (k, type, value, amount, total) => db.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, discount_type, discount_value, discount_centavos, total_centavos, cashier_id, submitted_at, submission_key)
    VALUES (?, '2026-10-09', 'COMPLETED', 10000, ?, ?, ?, ?, 1, ?, ?)`).run(`ORD-${k}`, type, value, amount, total, now, `key-${k}`);
  add('a', 'PERCENT', 2000, 2000, 8000);
  add('b', 'FIXED', 500, 500, 9500);
  assert.throws(() => add('c', 'PERCENT', 2000, 2000, 9000), /CHECK/);  // total does not match
  assert.throws(() => add('d', 'NONE', 0, 500, 9500), /CHECK/);          // "no discount" but money taken off
  assert.throws(() => add('e', 'FIXED', 500, 0, 10000), /CHECK/);        // a discount that is worth nothing
});

test('database: other-product lines are whole numbers unless sold per kg', () => {
  const db = seededDb();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO other_products (name, active, created_at, updated_at) VALUES ('Eggs (Small)', 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO other_products (name, active, created_at, updated_at) VALUES ('Garlic', 1, ?, ?)").run(now, now);
  db.prepare("INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at) VALUES (1,'dozen','FIXED',12000,1,?,?)").run(now, now);
  db.prepare("INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at) VALUES (2,'kg','PER_KG',8000,1,?,?)").run(now, now);
  const line = (n, option, product, unit, soldBy, price, qty) => db.prepare(`INSERT INTO order_other_items (order_id, line_no, other_product_id, option_id, product_name, unit, sold_by, unit_price_centavos, quantity_milli, line_total_centavos)
    VALUES (1, ?, ?, ?, 'x', ?, ?, ?, ?, 100)`).run(n, product, option, unit, soldBy, price, qty);
  line(1, 1, 1, 'dozen', 'FIXED', 12000, 2000);
  line(2, 2, 2, 'kg', 'PER_KG', 8000, 1500);
  assert.throws(() => line(3, 1, 1, 'dozen', 'FIXED', 12000, 2500), /CHECK/);   // half a dozen
  // a per-kg option must be in kg; an option cannot be active without a price
  assert.throws(() => db.prepare("INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, created_at, updated_at) VALUES (2,'dozen','PER_KG',100,?,?)").run(now, now), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at) VALUES (1,'piece','FIXED',0,1,?,?)").run(now, now), /CHECK/);
});

test('database: submitted lines, audit rows and orders cannot be edited or deleted', () => {
  const db = seededDb();
  insertLine(db, 'POUR', 0, 'DUKOT', null, 4500);
  assert.throws(() => db.prepare('UPDATE order_items SET weight_g = 1').run(), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM order_items').run(), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE orders SET total_centavos = 1').run(), /cannot be changed/);
  assert.throws(() => db.prepare("UPDATE orders SET discount_type = 'FIXED'").run(), /cannot be changed/);
  assert.throws(() => db.prepare("UPDATE orders SET order_number = 'X'").run(), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM orders').run(), /cannot be deleted/);
  db.prepare("INSERT INTO order_events (order_id, action_type, user_id, created_at) VALUES (1,'SUBMIT',1,'2026-10-09T00:00:00Z')").run();
  assert.throws(() => db.prepare('UPDATE order_events SET reason_note = ?').run('x'), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM order_events').run(), /cannot be deleted/);
});

test('database: order status can only move forward from Completed', () => {
  const db = seededDb();
  db.prepare("UPDATE orders SET status = 'CANCELED'").run();
  assert.throws(() => db.prepare("UPDATE orders SET status = 'COMPLETED'").run(), /no longer change status/);
  assert.throws(() => db.prepare("UPDATE orders SET status = 'REFUNDED'").run(), /no longer change status/);
});

test('database: an active product needs a price, and an old database file is refused with a clear message', () => {
  const db = openDb(':memory:');
  const now = new Date().toISOString();
  assert.throws(() => db.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('X', 0, 1, ?, ?)").run(now, now), /CHECK/);
});

// ---- Number of heads -------------------------------------------------------------------------------

test('heads: 3 heads of B-cull weighing 5.4 kg together is priced on the total weight', () => {
  const g = parseWeightToGrams('5.4');
  const one = chickenLine({ pricePerKgCentavos: 5200, weightG: g, heads: 1, prep: live, fees: SHOP_FEES });
  const three = chickenLine({ pricePerKgCentavos: 5200, weightG: g, heads: 3, prep: live, fees: SHOP_FEES });
  assert.equal(three.weightAmount, 28080);                 // 5.4 kg x ₱52.00 = ₱280.80, whatever the number of heads
  assert.equal(three.lineTotal, one.lineTotal);
  assert.equal(chickenLine({ pricePerKgCentavos: 5200, weightG: g, prep: live, fees: SHOP_FEES }).lineTotal, 28080); // heads is optional (1)
});

test('heads: a flat fee is charged once per line, a per-head fee is multiplied by the heads, a per-kg fee ignores heads', () => {
  const g = parseWeightToGrams('5.4');
  const mk = (basis, amount = 4500) => chickenLine({ pricePerKgCentavos: 5200, weightG: g, heads: 3, prep: poSlice(), fees: { POUR: { amount, basis } } });
  assert.equal(mk('per_item').serviceFee, 4500);            // ₱45 once
  assert.equal(mk('per_head').serviceFee, 13500);           // 3 x ₱45
  assert.equal(mk('per_kg', 500).serviceFee, 2700);         // ₱5/kg x 5.4 kg
  assert.equal(mk('per_head').lineTotal, 28080 + 13500);    // ₱415.80
  assert.equal(mk('per_head').fees[0].amount, 13500);
  const live3 = chickenLine({ pricePerKgCentavos: 5200, weightG: g, heads: 3, prep: live, fees: { POUR: { amount: 4500, basis: 'per_head' } } });
  assert.equal(live3.serviceFee, 0);                        // Live never has a fee
});

test('heads must be a whole number from 1 to 999', () => {
  assert.equal(parseHeads('3'), 3);
  assert.equal(parseHeads(12), 12);
  assert.equal(parseHeads(' 999 '), 999);
  for (const bad of ['', '0', '-1', '1.5', '1000', 'abc', '3 heads', null, undefined, true, '01a']) assert.equal(parseHeads(bad), null, `should reject ${JSON.stringify(bad)}`);
});

test('database: heads must be between 1 and 999', () => {
  const db = seededDb();
  const add = (n, heads) => db.prepare(`INSERT INTO order_items
    (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, service_fee_centavos, line_total_centavos)
    VALUES (1, ?, 1, 'Cull Chicken', 5800, 5400, ?, 31320, 'LIVE', 0, 'NONE', NULL, 0, 31320)`).run(n, heads);
  add(1, 1); add(2, 3); add(3, 999);
  assert.throws(() => add(4, 0), /CHECK/);
  assert.throws(() => add(5, 1000), /CHECK/);
  assert.throws(() => add(6, null), /NOT NULL/);
  assert.equal(db.prepare('SELECT heads FROM order_items WHERE line_no = 2').get().heads, 3);
  assert.throws(() => db.prepare('UPDATE order_items SET heads = 9').run(), /cannot be changed/); // submitted lines stay fixed
});

test('upgrade 2 -> 3: a version 2 database with orders keeps every order, gets heads = 1, and a safety copy is saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v2-'));
  const file = path.join(dir, 'pos.db');
  // Build a database that looks exactly like version 2: no heads column, old fee CHECK, user_version 2.
  const seed = openDb(file);
  seed.exec('DROP TABLE service_fees');
  seed.exec(`CREATE TABLE service_fees (code TEXT PRIMARY KEY CHECK (code IN ('POUR','NOT_POUR','DARA','DUKOT')),
    amount_centavos INTEGER NOT NULL DEFAULT 0 CHECK (amount_centavos >= 0),
    basis TEXT NOT NULL DEFAULT 'per_item' CHECK (basis IN ('per_item','per_kg')), updated_at TEXT NOT NULL)`);
  seed.exec("INSERT INTO service_fees VALUES ('POUR', 4500, 'per_item', '2026-10-01'), ('NOT_POUR', 2500, 'per_item', '2026-10-01'), ('DARA', 0, 'per_item', '2026-10-01'), ('DUKOT', 0, 'per_kg', '2026-10-01')");
  seed.exec('ALTER TABLE order_items DROP COLUMN heads');
  const now = '2026-10-09T02:00:00.000Z';
  seed.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('u','U','x','admin',?)").run(now);
  seed.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('Cull Chicken', 5800, 1, ?, ?)").run(now, now);
  seed.prepare("INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key) VALUES ('ORD-20261009-001','2026-10-09','COMPLETED',25380,25380,1,?,'k1')").run(now);
  seed.exec(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos)
             VALUES (1, 1, 1, 'Cull Chicken', 5800, 3600, 20880, 'POUR', 0, 'SLICE', 'MEDIUM', '[]', 4500, 25380)`);
  seed.exec('PRAGMA user_version = 2');
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);     // 2 -> 3 -> 4 in one start
  const line = db.prepare('SELECT * FROM order_items').get();
  assert.deepEqual([line.weight_g, line.line_total_centavos, line.feather_prep, line.slice_size, line.heads], [3600, 25380, 'POUR', 'MEDIUM', 1]);
  assert.equal(db.prepare('SELECT order_number, total_centavos FROM orders').get().total_centavos, 25380);
  const fees = Object.fromEntries(db.prepare('SELECT code, amount_centavos, basis FROM service_fees').all().map((f) => [f.code, [f.amount_centavos, f.basis]]));
  // amounts are untouched; fees that were flat are now per head; a fee the admin had set per kg stays per kg
  assert.deepEqual([fees.POUR, fees.NOT_POUR, fees.DUKOT], [[4500, 'per_head'], [2500, 'per_head'], [0, 'per_kg']]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE kind = 'SERVICE_FEE' AND new_basis = 'per_head'").get().n, 3);
  assert.throws(() => db.prepare("UPDATE service_fees SET basis = 'weekly' WHERE code = 'POUR'").run(), /CHECK/);
  assert.throws(() => db.prepare('UPDATE order_items SET weight_g = 1').run(), /cannot be changed/);   // protections survived
  assert.throws(() => db.prepare('DELETE FROM orders').run(), /cannot be deleted/);
  assert.ok(fs.readdirSync(dir).some((f) => /^pos\.db\.before-v3-.*\.bak$/.test(f)), 'a safety copy was saved');
  const copy = new DatabaseSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.bak'))));
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  db.close();
  openDb(file).close();                                                                           // opening again does not migrate twice
});

test('upgrade 3 -> 4: flat service fees become per head, amounts and saved orders stay as they were, and it is logged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v3-'));
  const file = path.join(dir, 'pos.db');
  const seed = openDb(file);
  const now = '2026-10-09T02:00:00.000Z';
  seed.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('owner','Owner','x','admin',?)").run(now);
  seed.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('Cull Chicken', 5800, 1, ?, ?)").run(now, now);
  seed.prepare("INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key) VALUES ('ORD-20261009-001','2026-10-09','COMPLETED',29880,29880,1,?,'k1')").run(now);
  seed.exec(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos)
             VALUES (1, 1, 1, 'Cull Chicken', 5800, 3600, 3, 20880, 'POUR', 0, 'SLICE', 'MEDIUM', '[]', 9000, 29880)`);
  seed.exec("UPDATE service_fees SET basis = 'per_item', amount_centavos = 4500 WHERE code = 'POUR'");   // as version 3 left them
  seed.exec("UPDATE service_fees SET basis = 'per_item', amount_centavos = 2500 WHERE code = 'NOT_POUR'");
  seed.exec("UPDATE service_fees SET basis = 'per_item' WHERE code = 'DARA'");
  seed.exec("UPDATE service_fees SET basis = 'per_kg', amount_centavos = 500 WHERE code = 'DUKOT'");
  seed.exec('PRAGMA user_version = 3');
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
  const fees = Object.fromEntries(db.prepare('SELECT code, amount_centavos, basis FROM service_fees').all().map((f) => [f.code, [f.amount_centavos, f.basis]]));
  assert.deepEqual([fees.POUR, fees.NOT_POUR, fees.DARA, fees.DUKOT], [[4500, 'per_head'], [2500, 'per_head'], [0, 'per_head'], [500, 'per_kg']]);
  assert.equal(db.prepare('SELECT total_centavos FROM orders').get().total_centavos, 29880);                  // a saved order is never recalculated
  assert.equal(db.prepare('SELECT service_fee_centavos FROM order_items').get().service_fee_centavos, 9000);
  const history = db.prepare("SELECT subject, old_basis, new_basis, changed_by FROM price_history WHERE kind = 'SERVICE_FEE' ORDER BY subject").all();
  assert.deepEqual(history.map((h) => [h.subject, h.old_basis, h.new_basis, h.changed_by]), [['DARA', 'per_item', 'per_head', 1], ['NOT_POUR', 'per_item', 'per_head', 1], ['POUR', 'per_item', 'per_head', 1]]);
  assert.ok(fs.readdirSync(dir).some((f) => /\.before-v4-.*\.bak$/.test(f)), 'a safety copy was saved');
  db.close();
  const again = openDb(file);                                                                                   // a second start changes nothing
  assert.equal(again.prepare("SELECT COUNT(*) AS n FROM price_history WHERE kind = 'SERVICE_FEE'").get().n, 3);
  again.close();
});

test('a new install charges every service per head', () => {
  const db = openDb(':memory:');
  const fees = db.prepare('SELECT code, basis FROM service_fees ORDER BY code').all();
  assert.deepEqual(fees.map((f) => f.basis), ['per_head', 'per_head', 'per_head', 'per_head']);
});

test('per head with the shop example: 3 heads of B-cull as a ₱25 service is 3 x ₱25 = ₱75', () => {
  const line = chickenLine({ pricePerKgCentavos: 5200, weightG: 5400, heads: 3, prep: dressedSlice(), fees: { NOT_POUR: { amount: 2500, basis: 'per_head' } } });
  assert.equal(line.serviceFee, 7500);
  assert.equal(line.lineTotal, 28080 + 7500);
});

test('daily report: products land in the form\'s blocks (B-CULL, CULL, BROILER) and anything else gets its own block', () => {
  assert.equal(blockFor('Broiler Breeder Cull').title, 'B-CULL');
  assert.equal(blockFor('B-Cull').title, 'B-CULL');
  assert.equal(blockFor('b cull').title, 'B-CULL');
  assert.equal(blockFor('Cull Chicken').title, 'CULL');
  assert.equal(blockFor('Broilers').title, 'BROILER');
  assert.deepEqual(blockFor('Native Chicken'), { key: 'OTHER:native chicken', title: 'NATIVE CHICKEN' });
});

test('daily report: egg products land in the form\'s egg sizes; other products are not eggs', () => {
  assert.equal(eggSize('Eggs (Small)'), 'Sm.');
  assert.equal(eggSize('Eggs (Medium)'), 'Med.');
  assert.equal(eggSize('Eggs (Large)'), 'Lar.');
  assert.equal(eggSize('Eggs (XL)'), 'XL');
  assert.equal(eggSize('Eggs (Extra Large)'), 'XL');
  assert.equal(eggSize('Eggs (Assorted)'), 'Asst.');
  assert.equal(eggSize('Eggs'), 'Asst.');
  assert.equal(eggSize('Garlic'), null);
  assert.equal(eggSize('Etag (Smoked)'), null);
});
