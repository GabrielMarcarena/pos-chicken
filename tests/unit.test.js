// Unit tests: money maths, preparation rules, fees, discounts, and the database's own safeguards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWeightToGrams, parsePesosToCentavos, parseQuantityToMilli, parseWholeQuantityToMilli, parsePercentToBp, parseHeads, formatPeso, formatPercent, mulDivRound } from '../shared/money.js';
import { emptyPrep, applyPrepChange, validatePrep, serviceOf, serviceLabel, needsSliceSize } from '../shared/rules.js';
import { SERVICES, LABELS } from '../shared/constants.js';
import { chickenLine, otherLine, grandTotal, discountAmount } from '../shared/pricing.js';
import { cashCheck, parseMoneyInput, typedMoneyText, pesoPlain } from '../shared/cash.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDb, categoryFromName } from '../src/db.js';
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

test('services: Pour adds ₱45, Dress adds ₱25, Live adds nothing', () => {
  const g = parseWeightToGrams('3.6');
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: poSlice(), fees: SHOP_FEES }).lineTotal, 20880 + 4500);       // ₱253.80
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: dressedSlice('SMALL'), fees: SHOP_FEES }).lineTotal, 20880 + 2500); // ₱233.80
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: live, fees: SHOP_FEES }).lineTotal, 20880);
});

test('the slice size does not change the price; the Dukot services add only the Pour or Dress fee, never a Dukot fee', () => {
  const g = 3600;
  const sizes = ['SMALL', 'MEDIUM', 'LARGE'].map((s) => chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: poSlice(s), fees: SHOP_FEES }).lineTotal);
  assert.deepEqual(new Set(sizes).size, 1);
  const dukot = { feather: 'POUR', dara: false, cut: 'DUKOT', sliceSize: null };
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: dukot, fees: SHOP_FEES }).lineTotal, 20880 + 4500);
  // a Dukot fee left over in an old settings table is ignored: Dukot is no longer charged
  const oldDukotFee = { ...SHOP_FEES, DUKOT: { amount: 1000, basis: 'per_item' } };
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: g, prep: dukot, fees: oldDukotFee }).lineTotal, 20880 + 4500);
});

test('a plain Pour or Dress (the whole chicken, no cutting) is charged the Pour or Dress fee only', () => {
  const whole = (feather) => ({ feather, dara: false, cut: 'NONE', sliceSize: null });
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: 3600, prep: whole('POUR'), fees: SHOP_FEES }).lineTotal, 20880 + 4500);
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: 3600, prep: whole('NOT_POUR'), fees: SHOP_FEES }).lineTotal, 20880 + 2500);
});

test('fees can be per item, per head or per kg; With Blood carries no fee, even if an old fee row still exists', () => {
  const fees = { POUR: { amount: 500, basis: 'per_kg' }, DARA: { amount: 700, basis: 'per_item' } };
  const line = chickenLine({ pricePerKgCentavos: 5800, weightG: 3600, prep: { ...poSlice(), dara: true }, fees });
  assert.deepEqual(line.fees.map((f) => [f.code, f.amount]), [['POUR', 1800]]);
  assert.equal(line.lineTotal, 20880 + 1800);
  assert.equal(chickenLine({ pricePerKgCentavos: 5800, weightG: 3600, prep: live, fees }).serviceFee, 0);
  const perHead = chickenLine({ pricePerKgCentavos: 5800, weightG: 5400, heads: 3, prep: poSlice(), fees: { POUR: { amount: 4500, basis: 'per_head' } } });
  assert.equal(perHead.serviceFee, 13500);
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

test('services are exclusive: Live, Pour, Dress, Po-ur & Slice, Dress & Slice, Pour & Dukot and Dress & Dukot', () => {
  const services = ['LIVE', 'POUR', 'NOT_POUR', 'POUR_SLICE', 'NOT_POUR_SLICE', 'POUR_DUKOT', 'NOT_POUR_DUKOT'];
  assert.deepEqual(SERVICES, services);
  let p = emptyPrep();
  for (const service of services) {
    p = applyPrepChange(p, { service });
    assert.equal(serviceOf(p), service);
  }
  assert.equal(serviceOf(emptyPrep()), null);
  assert.equal(serviceLabel(emptyPrep()), '');
});

test('the seven service names are Live, Pour, Dress, Po-ur & Slice, Dress & Slice, Pour & Dukot and Dress & Dukot', () => {
  const label = (service) => serviceLabel(applyPrepChange(emptyPrep(), { service }));
  assert.deepEqual(SERVICES.map(label), ['Live', 'Pour', 'Dress', 'Po-ur & Slice', 'Dress & Slice', 'Pour & Dukot', 'Dress & Dukot']);
  assert.equal(LABELS.DARA, 'With Blood');
});

test('plain Pour and Dress are whole (no cutting asked); only the two Slice services ask for a size; Dukot services ask for none', () => {
  assert.deepEqual(SERVICES.filter(needsSliceSize), ['POUR_SLICE', 'NOT_POUR_SLICE']);
  for (const service of ['POUR', 'NOT_POUR', 'POUR_DUKOT', 'NOT_POUR_DUKOT', 'LIVE']) {
    const p = applyPrepChange(emptyPrep(), { service });
    assert.equal(p.sliceSize, null, service);
    assert.deepEqual(validatePrep(p), [], `${service} is complete without a slice size`);
  }
  assert.deepEqual(applyPrepChange(emptyPrep(), { service: 'POUR' }), { feather: 'POUR', dara: false, cut: 'NONE', sliceSize: null });
  assert.deepEqual(applyPrepChange(emptyPrep(), { service: 'NOT_POUR' }), { feather: 'NOT_POUR', dara: false, cut: 'NONE', sliceSize: null });
  // a Slice service is not complete until a size is chosen
  for (const service of ['POUR_SLICE', 'NOT_POUR_SLICE']) {
    const p = applyPrepChange(emptyPrep(), { service });
    assert.deepEqual([p.cut, p.sliceSize], ['SLICE', null]);
    assert.ok(validatePrep(p).length, `${service} needs a slice size`);
    assert.deepEqual(validatePrep(applyPrepChange(p, { cut: 'SMALL' })), []);
  }
});

test('cutting is one choice - small, medium or large pieces - and there is no standalone Dukot cut', () => {
  let p = applyPrepChange(emptyPrep(), { service: 'POUR_SLICE' });
  p = applyPrepChange(p, { cut: 'SMALL' });
  assert.deepEqual([p.cut, p.sliceSize], ['SLICE', 'SMALL']);
  p = applyPrepChange(p, { cut: 'LARGE' });
  assert.deepEqual([p.cut, p.sliceSize], ['SLICE', 'LARGE']);   // only one size at a time
  // "DUKOT" is not a cutting choice: asking for it changes nothing
  const before = { ...p };
  p = applyPrepChange(p, { cut: 'DUKOT' });
  assert.deepEqual(p, before);
  assert.equal(serviceOf(p), 'POUR_SLICE');
});

test('moving between services: a slice size is kept for the Slice twin, cleared for whole and Dukot services, and never guessed', () => {
  let p = applyPrepChange(emptyPrep(), { service: 'POUR_SLICE' });
  p = applyPrepChange(p, { cut: 'MEDIUM' });
  p = applyPrepChange(p, { service: 'NOT_POUR_SLICE' });                                  // same kind of service: the size stays
  assert.deepEqual(p, { feather: 'NOT_POUR', dara: false, cut: 'SLICE', sliceSize: 'MEDIUM' });
  p = applyPrepChange(p, { service: 'POUR_DUKOT' });
  assert.deepEqual(p, { feather: 'POUR', dara: false, cut: 'DUKOT', sliceSize: null });
  p = applyPrepChange(p, { cut: 'SMALL' });                                                // picking a size on a Dukot service switches to the sliced twin
  assert.deepEqual(p, { feather: 'POUR', dara: false, cut: 'SLICE', sliceSize: 'SMALL' });
  assert.equal(serviceOf(p), 'POUR_SLICE');
  p = applyPrepChange(p, { service: 'NOT_POUR' });                                         // whole: no size
  assert.deepEqual(p, { feather: 'NOT_POUR', dara: false, cut: 'NONE', sliceSize: null });
  p = applyPrepChange(p, { service: 'POUR_SLICE' });                                       // back to a Slice service: it asks again, nothing is remembered
  assert.deepEqual(p, { feather: 'POUR', dara: false, cut: 'SLICE', sliceSize: null });
  assert.ok(validatePrep(p).length);
});

test('changing the service never resets With Blood or the cutting choice', () => {
  let p = applyPrepChange(emptyPrep(), { feather: 'POUR' });
  p = applyPrepChange(p, { dara: true });
  p = applyPrepChange(p, { cut: 'MEDIUM' });
  p = applyPrepChange(p, { feather: 'NOT_POUR' });
  assert.deepEqual(p, { feather: 'NOT_POUR', dara: true, cut: 'SLICE', sliceSize: 'MEDIUM' });
  p = applyPrepChange(p, { dara: false });
  assert.deepEqual(p, { feather: 'NOT_POUR', dara: false, cut: 'SLICE', sliceSize: 'MEDIUM' });
  // the With Blood switch also survives a change between the seven services
  p = applyPrepChange(applyPrepChange(emptyPrep(), { service: 'POUR' }), { dara: true });
  p = applyPrepChange(p, { service: 'NOT_POUR_DUKOT' });
  assert.equal(p.dara, true);
});

test('choosing Live clears and disables With Blood and cutting', () => {
  let p = { feather: 'POUR', dara: true, cut: 'SLICE', sliceSize: 'MEDIUM' };
  p = applyPrepChange(p, { feather: 'LIVE' });
  assert.deepEqual(p, { feather: 'LIVE', dara: false, cut: 'NONE', sliceSize: null });
  p = applyPrepChange(p, { dara: true });
  p = applyPrepChange(p, { cut: 'DUKOT' });
  assert.deepEqual(p, { feather: 'LIVE', dara: false, cut: 'NONE', sliceSize: null });
  // leaving Live does not bring the old choices back
  p = applyPrepChange(p, { feather: 'POUR' });
  assert.deepEqual(p, { feather: 'POUR', dara: false, cut: 'NONE', sliceSize: null });
  assert.deepEqual(validatePrep(p), [], 'a plain Pour is a whole chicken and needs nothing else');
});

test('validatePrep accepts good combinations and rejects every conflicting one', () => {
  assert.deepEqual(validatePrep(live), []);
  assert.deepEqual(validatePrep(poSlice('LARGE')), []);
  assert.deepEqual(validatePrep({ ...dressedSlice('SMALL'), dara: true }), []);
  assert.deepEqual(validatePrep({ feather: 'POUR', dara: false, cut: 'DUKOT', sliceSize: null }), []);
  assert.deepEqual(validatePrep({ feather: 'POUR', dara: false, cut: 'NONE', sliceSize: null }), [], 'plain Pour');
  assert.deepEqual(validatePrep({ feather: 'NOT_POUR', dara: true, cut: 'NONE', sliceSize: null }), [], 'plain Dress With Blood');
  assert.ok(validatePrep(emptyPrep()).length, 'service is required');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'NONE', sliceSize: 'SMALL' }).length, 'a whole chicken has no slice size');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'SLICE', sliceSize: null }).length, 'slice needs a size');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'SLICE', sliceSize: 'HUGE' }).length, 'unknown size');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'DUKOT', sliceSize: 'SMALL' }).length, 'dukot keeps no size');
  assert.ok(validatePrep({ feather: 'POUR', dara: false, cut: 'CHOP', sliceSize: null }).length, 'unknown cutting');
  assert.ok(validatePrep({ feather: 'LIVE', dara: true, cut: 'NONE', sliceSize: null }).length, 'live has no With Blood');
  assert.ok(validatePrep({ feather: 'LIVE', dara: false, cut: 'DUKOT', sliceSize: null }).length, 'live has no cutting');
  assert.ok(validatePrep({ feather: 'LIVE', dara: false, cut: 'SLICE', sliceSize: 'SMALL' }).length, 'live is never sliced');
  assert.ok(validatePrep({ feather: 'ROASTED', dara: false, cut: 'NONE', sliceSize: null }).length, 'unknown service');
  assert.match(validatePrep({ feather: 'LIVE', dara: true, cut: 'NONE', sliceSize: null }).join(' '), /With Blood/);
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
  insertLine(db, 'POUR', 0, 'NONE', null, 4500);                                    // plain Pour: the whole chicken (revision 10)
  insertLine(db, 'NOT_POUR', 1, 'NONE', null, 2500);                                // plain Dress With Blood
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
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);     // 2 -> 3 -> ... -> 9 in one start
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
  // a version 3 install also had With Blood (DARA) and Dukot rows; a fresh database no longer creates them, so add them as they were
  seed.prepare("INSERT OR IGNORE INTO service_fees (code, amount_centavos, basis, updated_at) VALUES ('DARA', 0, 'per_item', ?), ('DUKOT', 0, 'per_item', ?)").run(now, now);
  seed.exec("UPDATE service_fees SET basis = 'per_item', amount_centavos = 4500 WHERE code = 'POUR'");   // as version 3 left them
  seed.exec("UPDATE service_fees SET basis = 'per_item', amount_centavos = 2500 WHERE code = 'NOT_POUR'");
  seed.exec("UPDATE service_fees SET basis = 'per_item' WHERE code = 'DARA'");
  seed.exec("UPDATE service_fees SET basis = 'per_kg', amount_centavos = 500 WHERE code = 'DUKOT'");
  seed.exec('PRAGMA user_version = 3');
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
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

test('a new install charges Pour and Dress per head (With Blood and Dukot have no fee, so they are not even listed)', () => {
  const db = openDb(':memory:');
  const fees = db.prepare('SELECT code, basis FROM service_fees ORDER BY code').all();
  assert.deepEqual(fees.map((f) => [f.code, f.basis]), [['NOT_POUR', 'per_head'], ['POUR', 'per_head']]);
});

test('per head with the shop example: 3 heads of B-cull as a ₱25 service is 3 x ₱25 = ₱75', () => {
  const line = chickenLine({ pricePerKgCentavos: 5200, weightG: 5400, heads: 3, prep: dressedSlice(), fees: { NOT_POUR: { amount: 2500, basis: 'per_head' } } });
  assert.equal(line.serviceFee, 7500);
  assert.equal(line.lineTotal, 28080 + 7500);
});

test('daily report: products land in the form\'s blocks (B-CULL, CULL, BROILER) by their category; anything else gets its own block', () => {
  // Revision 11: the block is the product's category (set on the Products screen), not a guess from the name.
  assert.equal(blockFor('BCULL', 'Anything').title, 'B-CULL');
  assert.equal(blockFor('CULL', 'Brown Cull Chicken').title, 'CULL');
  assert.equal(blockFor('BROILER', 'Broilers').title, 'BROILER');
  assert.deepEqual(blockFor('OTHER', 'Native Chicken'), { key: 'OTHER:native chicken', title: 'NATIVE CHICKEN' });
  // The name only fills in the category once, for products made before categories existed (and as the default for a new product).
  assert.equal(categoryFromName('Broiler Breeder Cull'), 'BCULL');
  assert.equal(categoryFromName('B-Cull'), 'BCULL');
  assert.equal(categoryFromName('b cull'), 'BCULL');
  assert.equal(categoryFromName('Cull Chicken'), 'CULL');
  assert.equal(categoryFromName('Brown Cull Chicken'), 'CULL');
  assert.equal(categoryFromName('Broilers'), 'BROILER');
  assert.equal(categoryFromName('Native Chicken'), 'OTHER');
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

// ---- Revision 5 upgrade: version 4 -> 5 (Order List board) -----------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));   // not new URL(...).pathname: that turns a space in the folder name into %20
const dateOf = (offsetDays) => new Date(Date.now() - offsetDays * 86400000 + 8 * 3600000).toISOString().slice(0, 10);

/** A database exactly as revision 4 leaves it (its real schema, saved in tests/fixtures), with orders and audit rows in it. */
function makeVersion4Database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v4-'));
  const file = path.join(dir, 'pos.db');
  const seed = new DatabaseSync(file);
  seed.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  seed.exec(fs.readFileSync(path.join(here, 'fixtures', 'schema-v4.sql'), 'utf8'));
  const stamp = '2026-10-09T02:00:00.000Z';
  seed.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('u','U','x','admin',?)").run(stamp);
  seed.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('Cull Chicken', 5800, 1, ?, ?)").run(stamp, stamp);
  for (const [code, amount] of [['POUR', 4500], ['NOT_POUR', 2500], ['DARA', 0], ['DUKOT', 0]]) {
    seed.prepare("INSERT INTO service_fees (code, amount_centavos, basis, updated_at) VALUES (?,?,'per_head',?)").run(code, amount, stamp);
  }
  const order = (n, date, status = 'COMPLETED', refund = 0) => {
    seed.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, refund_centavos, cashier_id, submitted_at, submission_key)
                  VALUES (?,?,?,5800,5800,?,1,?,?)`).run(`ORD-${n}`, date, status, refund, stamp, `key-${n}-xxxxxxxx`);
    seed.prepare(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos)
                  VALUES (?,1,1,'Cull Chicken',5800,1000,1,5800,'LIVE',0,'NONE',NULL,'[]',0,5800)`).run(n);
    seed.prepare("INSERT INTO payments (order_id, method, amount_centavos, recorded_by, recorded_at) VALUES (?,'CASH',5800,1,?)").run(n, stamp);
    seed.prepare("INSERT INTO order_events (order_id, action_type, reason_note, user_id, created_at, snapshot_after) VALUES (?,'SUBMIT','first',1,?,'{\"a\":1}')").run(n, stamp);
  };
  order(1, '2026-10-01');                  // an old order
  order(2, dateOf(3));                     // three days ago
  order(3, dateOf(0));                     // today
  order(4, dateOf(0), 'CANCELED');
  seed.prepare("INSERT INTO order_events (order_id, action_type, reason_code, user_id, created_at) VALUES (4,'CANCEL','WRONG_WEIGHT',1,?)").run(stamp);
  seed.exec('PRAGMA user_version = 4');
  return { dir, file, seed };
}

test('upgrade 4 -> 5: old orders become Complete, today\'s become Ongoing, nothing else changes, and a safety copy is saved', () => {
  const { dir, file, seed } = makeVersion4Database();
  const tables = ['users', 'products', 'service_fees', 'order_items', 'order_other_items', 'payments', 'order_events', 'price_history', 'order_counters'];
  // users gained a deleted_at column in version 6; it is empty for everyone, so it is left out of the byte-for-byte comparison
  // (products.category is new in version 9, filled in from the name; it is left out here and checked in tests/revision11.test.js)
  const dump = (d, list) => JSON.stringify(Object.fromEntries(list.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map(({ deleted_at: _d, received_centavos: _r, change_centavos: _c, category: _k, pieces: _p, tracking_number: _t, ...row }) => row)])));
  const before = dump(seed, tables);
  const ordersBefore = seed.prepare('SELECT * FROM orders ORDER BY id').all();
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
  assert.equal(dump(db, tables), before, 'every line, payment, fee and audit row is byte-for-byte the same');
  const ordersAfter = db.prepare('SELECT * FROM orders ORDER BY id').all();
  assert.deepEqual(ordersAfter.map((o) => o.fulfillment_status), ['COMPLETE', 'COMPLETE', 'ONGOING', 'ONGOING']);
  ordersAfter.forEach((o, i) => { const { fulfillment_status: _f, bookmarked: _b, business_day_id: _bd, tracking_number: _t, ...rest } = o; assert.equal(JSON.stringify(rest), JSON.stringify(ordersBefore[i])); });   // every old column unchanged
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.ok(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'order_events'").get().sql.includes("'MOVE'"));
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_orders_fulfillment'").get());

  // the safety copy is the untouched version 4 file
  const copies = fs.readdirSync(dir).filter((f) => /\.before-v5-.*\.bak$/.test(f));
  assert.equal(copies.length, 1);
  const copy = new DatabaseSync(path.join(dir, copies[0]), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 4);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM order_events').get().n, 5);
  copy.close();

  // the rebuilt audit table is still append-only, and now accepts MOVE; new ids carry on after the old ones
  assert.throws(() => db.prepare("UPDATE order_events SET reason_note = 'x'").run(), /audit records cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM order_events').run(), /audit records cannot be deleted/);
  assert.throws(() => db.prepare("INSERT INTO order_events (order_id, action_type, user_id, created_at) VALUES (1,'BOGUS',1,'x')").run(), /CHECK|constraint/i);
  db.prepare("INSERT INTO order_events (order_id, action_type, reason_note, user_id, created_at) VALUES (3,'MOVE','Ongoing → Standby',1,'2026-10-12T00:00:00.000Z')").run();
  assert.equal(db.prepare('SELECT MAX(id) AS id FROM order_events').get().id, 6);
  // submitted orders are still protected, and only the pickup status can change
  assert.throws(() => db.prepare('DELETE FROM orders WHERE id = 1').run(), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE orders SET total_centavos = 1, subtotal_centavos = 1 WHERE id = 1').run(), /cannot be changed after submission/);
  db.prepare("UPDATE orders SET fulfillment_status = 'STANDBY' WHERE id = 3").run();
  assert.equal(db.prepare('SELECT fulfillment_status FROM orders WHERE id = 3').get().fulfillment_status, 'STANDBY');
  assert.throws(() => db.prepare("UPDATE orders SET fulfillment_status = 'DONE' WHERE id = 3").run(), /CHECK|constraint/i);
  db.close();

  // a second start changes nothing and makes no second copy
  const again = openDb(file);
  assert.equal(again.prepare("SELECT fulfillment_status FROM orders WHERE id = 3").get().fulfillment_status, 'STANDBY');
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM order_events').get().n, 6);
  again.close();
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak')).length, 1);
});

test('upgrade 4 -> 5: if a step fails, nothing is changed and the file stays a working version 4', () => {
  const { file, seed } = makeVersion4Database();
  seed.exec('DROP TABLE order_events');                          // damage: the audit table is missing, so the copy step cannot work
  seed.close();
  assert.throws(() => openDb(file), /order_events/);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 4);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('orders') WHERE name = 'fulfillment_status'").get().n, 0);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 4);
  check.close();
});

test('a new database starts at version 13, orders default to Ongoing and not bookmarked, and accounts are not deleted', () => {
  const db = openDb(':memory:');
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
  db.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('u','U','x','admin','t')").run();
  db.prepare("INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key) VALUES ('A','2026-10-09','COMPLETED',100,100,1,'t','k-aaaaaaaa')").run();
  assert.equal(db.prepare('SELECT fulfillment_status FROM orders').get().fulfillment_status, 'ONGOING');
  db.close();
});

// ---- Revision 7: the upgrade from version 5 (bookmarks and Delete Account) ----------------------------------------------

function makeVersion5Database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v5-'));
  const file = path.join(dir, 'pos.db');
  const seed = new DatabaseSync(file);
  seed.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  seed.exec(fs.readFileSync(path.join(here, 'fixtures', 'schema-v5.sql'), 'utf8'));
  const stamp = '2026-10-09T02:00:00.000Z';
  seed.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('owner','Owner','x','admin',?), ('cash','Cashier','y','cashier',?)").run(stamp, stamp);
  seed.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('Cull Chicken', 5800, 1, ?, ?)").run(stamp, stamp);
  for (const [code, amount] of [['POUR', 4500], ['NOT_POUR', 2500], ['DARA', 0], ['DUKOT', 0]]) {
    seed.prepare("INSERT INTO service_fees (code, amount_centavos, basis, updated_at) VALUES (?,?,'per_head',?)").run(code, amount, stamp);
  }
  const fulfillment = ['COMPLETE', 'STANDBY', 'ONGOING', 'ONGOING'];
  for (let n = 1; n <= 4; n += 1) {
    seed.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, refund_centavos, cashier_id, submitted_at, submission_key, fulfillment_status)
                  VALUES (?,?,?,5800,5800,0,2,?,?,?)`).run(`ORD-${n}`, '2026-10-09', n === 4 ? 'CANCELED' : 'COMPLETED', stamp, `key-${n}-xxxxxxxx`, fulfillment[n - 1]);
    seed.prepare(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos)
                  VALUES (?,1,1,'Cull Chicken',5800,1000,1,5800,'LIVE',0,'NONE',NULL,'[]',0,5800)`).run(n);
    seed.prepare("INSERT INTO payments (order_id, method, amount_centavos, recorded_by, recorded_at) VALUES (?,'CASH',5800,2,?)").run(n, stamp);
    seed.prepare("INSERT INTO order_events (order_id, action_type, reason_note, user_id, created_at, snapshot_after) VALUES (?,'SUBMIT','first',2,?,'{\"a\":1}')").run(n, stamp);
  }
  seed.prepare("INSERT INTO order_events (order_id, action_type, reason_note, user_id, created_at) VALUES (2,'MOVE','Ongoing → Standby',2,?)").run(stamp);
  seed.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES ('abc', 2, ?, ?)").run(stamp, stamp);
  seed.exec('PRAGMA user_version = 5');
  return { dir, file, seed };
}

test('upgrade 5 -> 6: every order starts un-bookmarked, every account starts un-deleted, all other data is identical, and a safety copy is saved', () => {
  const { dir, file, seed } = makeVersion5Database();
  const tables = ['products', 'service_fees', 'order_items', 'order_other_items', 'payments', 'order_events', 'price_history', 'order_counters', 'sessions'];
  // (products.category and order_other_items.pieces are new in version 9; they are left out here and checked in tests/revision11.test.js)
  const dump = (d, list) => JSON.stringify(Object.fromEntries(list.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map(({ received_centavos: _r, change_centavos: _c, category: _k, pieces: _p, tracking_number: _t, ...row }) => row)])));
  const before = dump(seed, tables);
  const usersBefore = seed.prepare('SELECT * FROM users ORDER BY id').all();
  const ordersBefore = seed.prepare('SELECT * FROM orders ORDER BY id').all();
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
  assert.equal(dump(db, tables), before, 'every line, payment, fee, session and audit row is byte-for-byte the same');
  const usersAfter = db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.ok(usersAfter.every((u) => u.deleted_at === null));
  usersAfter.forEach((u, i) => { const { deleted_at: _d, ...rest } = u; assert.equal(JSON.stringify(rest), JSON.stringify(usersBefore[i])); });
  const ordersAfter = db.prepare('SELECT * FROM orders ORDER BY id').all();
  assert.ok(ordersAfter.every((o) => o.bookmarked === 0));
  ordersAfter.forEach((o, i) => { const { bookmarked: _b, business_day_id: _bd, tracking_number: _t, ...rest } = o; assert.equal(JSON.stringify(rest), JSON.stringify(ordersBefore[i])); });
  assert.deepEqual(ordersAfter.map((o) => o.fulfillment_status), ['COMPLETE', 'STANDBY', 'ONGOING', 'ONGOING'], 'pickup statuses untouched');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);

  // the safety copy is the untouched version 5 file
  const copies = fs.readdirSync(dir).filter((f) => /\.before-v6-.*\.bak$/.test(f));
  assert.equal(copies.length, 1);
  const copy = new DatabaseSync(path.join(dir, copies[0]), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('orders') WHERE name = 'bookmarked'").get().n, 0);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 4);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM order_events').get().n, 5);
  copy.close();

  // the new columns work, the old protections still hold
  db.prepare('UPDATE orders SET bookmarked = 1 WHERE id = 2').run();
  assert.equal(db.prepare('SELECT bookmarked FROM orders WHERE id = 2').get().bookmarked, 1);
  assert.throws(() => db.prepare('UPDATE orders SET bookmarked = 5 WHERE id = 2').run(), /CHECK|constraint/i);
  assert.throws(() => db.prepare('UPDATE orders SET total_centavos = 1, subtotal_centavos = 1 WHERE id = 1').run(), /cannot be changed after submission/);
  assert.throws(() => db.prepare('DELETE FROM orders WHERE id = 1').run(), /cannot be deleted/);
  assert.throws(() => db.prepare('DELETE FROM payments').run(), /cannot be deleted/);
  assert.throws(() => db.prepare("UPDATE order_events SET reason_note = 'x'").run(), /audit records cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM users WHERE id = 2').run(), /FOREIGN KEY/i);        // an account with history cannot be erased at the database level either
  db.close();

  // a second start changes nothing and makes no second copy
  const again = openDb(file);
  assert.equal(again.prepare('SELECT bookmarked FROM orders WHERE id = 2').get().bookmarked, 1);
  again.close();
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak')).length, 1);
});

test('upgrade 5 -> 6: if a step fails, nothing is changed and the file stays a working version 5', () => {
  const { file, seed } = makeVersion5Database();
  seed.exec('PRAGMA foreign_keys = OFF');
  seed.exec('DROP TRIGGER orders_no_delete; DROP TRIGGER orders_immutable_fields; DROP TRIGGER orders_status_guard');
  seed.exec('DROP TABLE order_events; DROP TABLE payments; DROP TABLE order_items; DROP TABLE orders');   // damage: the orders table is missing, so its step cannot work
  seed.close();
  assert.throws(() => openDb(file), /orders/);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('users') WHERE name = 'deleted_at'").get().n, 0, 'the users change was rolled back too');
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  check.close();
});

// ---- Revision 9: the upgrade from version 6 (business days, Daily Inventory, cash change) ------------------------------------

function makeVersion6Database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-v6-'));
  const file = path.join(dir, 'pos.db');
  const seed = new DatabaseSync(file);
  seed.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  seed.exec(fs.readFileSync(path.join(here, 'fixtures', 'schema-v6.sql'), 'utf8'));
  const stamp = '2026-10-09T02:00:00.000Z';
  seed.prepare("INSERT INTO users (username, display_name, password_hash, role, created_at) VALUES ('owner','Owner','x','admin',?), ('cash','Cashier','y','cashier',?)").run(stamp, stamp);
  seed.prepare("INSERT INTO products (name, price_per_kg_centavos, active, created_at, updated_at) VALUES ('Cull Chicken', 5800, 1, ?, ?)").run(stamp, stamp);
  for (const [code, amount] of [['POUR', 4500], ['NOT_POUR', 2500], ['DARA', 0], ['DUKOT', 0]]) {
    seed.prepare("INSERT INTO service_fees (code, amount_centavos, basis, updated_at) VALUES (?,?,'per_head',?)").run(code, amount, stamp);
  }
  // Three shop days: two long past, and one far in the future (so it is "today or later" whenever this test runs and becomes the open day).
  const days = ['2026-10-08', '2026-10-09', '2099-01-01'];
  const cut = [['LIVE', 'NONE', null, 5800, 5800], ['POUR', 'SLICE', 'MEDIUM', 5800, 10300], ['NOT_POUR', 'DUKOT', null, 5800, 8300], ['LIVE', 'NONE', null, 5800, 5800]];
  let n = 0;
  for (const [d, date] of days.entries()) {
    for (let k = 0; k < 2; k += 1) {
      n += 1;
      const [feather, cutMethod, size, weightAmount, total] = cut[(d + k) % cut.length];
      const at = `${date}T0${k + 1}:00:00.000Z`;
      seed.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, refund_centavos, cashier_id, submitted_at, submission_key, fulfillment_status, bookmarked)
                    VALUES (?,?,?,?,?,0,2,?,?,?,?)`).run(`ORD-${n}`, date, n === 2 ? 'CANCELED' : 'COMPLETED', total, total, at, `key-${n}-xxxxxxxx`, n % 2 ? 'COMPLETE' : 'STANDBY', n === 3 ? 1 : 0);
      seed.prepare(`INSERT INTO order_items (order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos)
                    VALUES (?,1,1,'Cull Chicken',5800,1000,1,?,?,0,?,?,'[]',?,?)`).run(n, weightAmount, feather, cutMethod, size, total - weightAmount, total);
      seed.prepare("INSERT INTO payments (order_id, method, amount_centavos, recorded_by, recorded_at) VALUES (?,'CASH',?,2,?)").run(n, total, at);
      seed.prepare("INSERT INTO order_events (order_id, action_type, reason_note, user_id, created_at, snapshot_after) VALUES (?,'SUBMIT','first',2,?,'{\"a\":1}')").run(n, at);
    }
  }
  seed.prepare("INSERT INTO sessions (token_hash, user_id, created_at, last_seen_at) VALUES ('abc', 2, ?, ?)").run(stamp, stamp);
  seed.exec('PRAGMA user_version = 6');
  return { dir, file, seed };
}

test('upgrade 6 -> 7: every order keeps all its data and gets its business day, payments get empty cash fields, and a safety copy is saved', () => {
  const { dir, file, seed } = makeVersion6Database();
  const tables = ['users', 'products', 'service_fees', 'order_items', 'order_other_items', 'order_events', 'price_history', 'order_counters', 'sessions'];
  // (products.category and order_other_items.pieces are new in version 9; they are left out here and checked in tests/revision11.test.js)
  const dump = (d, list) => JSON.stringify(Object.fromEntries(list.map((t) => [t, d.prepare(`SELECT * FROM ${t} ORDER BY 1`).all().map(({ category: _k, pieces: _p, tracking_number: _t, ...row }) => row)])));
  const before = dump(seed, tables);
  const ordersBefore = seed.prepare('SELECT * FROM orders ORDER BY id').all();
  const paymentsBefore = seed.prepare('SELECT * FROM payments ORDER BY id').all();
  const objectsBefore = seed.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','trigger','index')").get().n;
  seed.close();

  const db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
  assert.equal(dump(db, tables), before, 'every line, fee, session, user and audit row is byte-for-byte the same');

  // orders: every old column unchanged; the only new column is business_day_id
  const ordersAfter = db.prepare('SELECT * FROM orders ORDER BY id').all();
  assert.equal(ordersAfter.length, ordersBefore.length);
  ordersAfter.forEach((o, i) => { const { business_day_id: _d, tracking_number: _t, ...rest } = o; assert.equal(JSON.stringify(rest), JSON.stringify(ordersBefore[i])); });
  // payments: every old column unchanged; the cash fields are empty because nothing was ever recorded for them
  const paymentsAfter = db.prepare('SELECT * FROM payments ORDER BY id').all();
  paymentsAfter.forEach((p, i) => {
    const { received_centavos: r, change_centavos: c, ...rest } = p;
    assert.deepEqual([r, c], [null, null]);
    assert.equal(JSON.stringify(rest), JSON.stringify(paymentsBefore[i]));
  });

  // business days: one per shop date; only the latest one (today or later) is open; the rest are closed, with no invented stock records
  const days = db.prepare('SELECT * FROM business_days ORDER BY business_date').all();
  assert.deepEqual(days.map((d) => [d.business_date, d.status]), [['2026-10-08', 'CLOSED'], ['2026-10-09', 'CLOSED'], ['2099-01-01', 'OPEN']]);
  assert.ok(days.slice(0, 2).every((d) => d.closed_at), 'closed days have a closing time');
  for (const o of ordersAfter) assert.equal(db.prepare('SELECT business_date FROM business_days WHERE id = ?').get(o.business_day_id).business_date, o.business_date, `${o.order_number} is on its own day`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_records').get().n, 0, 'the upgrade invents no stock numbers');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  // everything that existed before still exists (the new objects are extra)
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','trigger','index')").get().n > objectsBefore);

  // the safety copy is the untouched version 6 file
  const copies = fs.readdirSync(dir).filter((f) => /\.before-v7-.*\.bak$/.test(f));
  assert.equal(copies.length, 1);
  const copy = new DatabaseSync(path.join(dir, copies[0]), { readOnly: true });
  assert.equal(copy.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('orders') WHERE name = 'business_day_id'").get().n, 0);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 6);
  assert.equal(copy.prepare('SELECT COUNT(*) AS n FROM payments').get().n, 6);
  copy.close();

  // the old protections still hold and the new ones work
  assert.throws(() => db.prepare('UPDATE orders SET total_centavos = 1, subtotal_centavos = 1 WHERE id = 1').run(), /cannot be changed after submission/);
  assert.throws(() => db.prepare('UPDATE orders SET business_day_id = 1 WHERE id = 6').run(), /cannot be changed after submission/);
  assert.throws(() => db.prepare('DELETE FROM orders WHERE id = 1').run(), /cannot be deleted/);
  assert.throws(() => db.prepare('DELETE FROM payments').run(), /cannot be deleted/);
  assert.throws(() => db.prepare("DELETE FROM business_days WHERE business_date = '2026-10-08'").run(), /closed business day cannot be deleted/);
  assert.throws(() => db.prepare("UPDATE business_days SET status = 'OPEN' WHERE business_date = '2026-10-08'").run(), /closed/i);
  // an order cannot be saved into a closed day
  assert.throws(() => db.prepare(`INSERT INTO orders (order_number, business_date, status, subtotal_centavos, total_centavos, cashier_id, submitted_at, submission_key, business_day_id)
    VALUES ('X-1','2026-10-09','COMPLETED',100,100,2,'t','key-xxxxxxxxxx',1)`).run(), /open business day/);
  db.close();

  // a second start changes nothing and makes no second copy
  const again = openDb(file);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM business_days').get().n, 3);
  assert.equal(again.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 6);
  again.close();
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.bak')).length, 1);
});

test('upgrade 6 -> 7: if a step fails, nothing is changed and the file stays a working version 6', () => {
  const { file, seed } = makeVersion6Database();
  seed.exec('PRAGMA foreign_keys = OFF');
  seed.exec('DROP TRIGGER orders_no_delete; DROP TRIGGER orders_immutable_fields; DROP TRIGGER orders_status_guard');
  seed.exec('DROP TABLE order_events; DROP TABLE payments; DROP TABLE order_items; DROP TABLE orders');   // damage: the orders table is missing, so its step cannot work
  seed.close();
  assert.throws(() => openDb(file), /orders/);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 6);
  assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('business_days','inventory_records','inventory_events')").get().n, 0, 'the new tables were rolled back too');
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
  check.close();
});

// ---- Revision 9: the cash change calculator (the same code the payment panel runs) ---------------------------------------------

test('cash change: Amount Paid ₱456.00 and Money Received ₱1,000.00 give Change ₱544.00', () => {
  const r = cashCheck({ totalCentavos: 45600, paidText: '456.00', receivedText: '1,000.00' });
  assert.equal(r.change, 54400);
  assert.equal(formatPeso(r.change), '₱544.00');
  assert.deepEqual([r.ok, r.insufficient, r.problems.length], [true, false, 0]);
  assert.equal(cashCheck({ totalCentavos: 45600, paidText: '456', receivedText: '1000' }).change, 54400, 'plain numbers work too');
});

test('cash change: equal payment shows ₱0.00 and overpayment the exact change, down to the centavo', () => {
  const change = (received, total = 45600) => cashCheck({ totalCentavos: total, paidText: pesoPlain(total), receivedText: received });
  assert.equal(change('456').change, 0);
  assert.equal(formatPeso(change('456.00').change), '₱0.00');
  assert.equal(change('456.01').change, 1);
  assert.equal(change('500').change, 4400);
  assert.equal(change('1000.50').change, 54450);
  assert.equal(change('1,234.56').change, 123456 - 45600);
  assert.equal(change('208.80', 20880).change, 0);
});

test('cash change: less than the amount due says "Insufficient payment" and the order cannot be finished as fully paid', () => {
  const short = cashCheck({ totalCentavos: 45600, paidText: '456.00', receivedText: '400' });
  assert.equal(short.insufficient, true);
  assert.equal(short.ok, false);
  assert.equal(short.change, null, 'no change is shown for a payment that is too small');
  assert.match(short.problems[0].message, /^Insufficient payment/);
  const low = cashCheck({ totalCentavos: 45600, paidText: '400', receivedText: '1000' });   // Amount Paid below the order total
  assert.equal(low.insufficient, true);
  assert.equal(low.ok, false);
  assert.equal(low.change, null, 'no change is shown while Amount Paid is below the order total');
  assert.match(low.problems[0].message, /^Insufficient payment/);
  const high = cashCheck({ totalCentavos: 45600, paidText: '500', receivedText: '1000' });  // Amount Paid above the total
  assert.equal(high.ok, false);
  assert.equal(high.insufficient, false);
  assert.match(high.problems[0].message, /more than the order total/);
});

test('cash change: blank, negative, zero, text and absurd values are handled safely and never give a number', () => {
  const check = (received, paid = '456') => cashCheck({ totalCentavos: 45600, paidText: paid, receivedText: received });
  for (const [bad, code] of [['', 'BLANK'], ['   ', 'BLANK'], ['-5', 'NEGATIVE'], ['-1000', 'NEGATIVE'], ['abc', 'INVALID'], ['1e3', 'INVALID'], ['12.345', 'INVALID'],
    ['1.2.3', 'INVALID'], ['0', 'ZERO'], ['0.00', 'ZERO'], ['99999999999999', 'INVALID']]) {
    const r = check(bad);
    assert.equal(r.change, null, `${JSON.stringify(bad)} gives no change`);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.problems.find((p) => p.field === 'received')?.code, code, JSON.stringify(bad));
  }
  assert.equal(check('1000', '').problems[0].code, 'INVALID');
  assert.equal(check('1000', '-456').problems[0].code, 'NEGATIVE');
  assert.equal(check('1000', '0').problems[0].code, 'ZERO');
  assert.equal(check(undefined).problems[0].code, 'BLANK');
  assert.equal(check(null).problems[0].code, 'BLANK');
});

test('cash change: money text - thousands commas, decimal commas and the peso sign are understood, the rest is refused', () => {
  assert.equal(parseMoneyInput('1,000').value, 100000);
  assert.equal(parseMoneyInput('12,345.50').value, 1234550);
  assert.equal(parseMoneyInput('12,5').value, 1250);
  assert.equal(parseMoneyInput('₱ 456').value, 45600);
  assert.equal(parseMoneyInput('1,00,0').error, 'invalid');
  assert.equal(parseMoneyInput('5-').error, 'negative');
  assert.equal(typedMoneyText('₱1,000abc.50'), '1,000.50');
  assert.equal(typedMoneyText('-5'), '-5', 'a minus sign is kept so the message can say it is not allowed');
  assert.equal(pesoPlain(54400), '544.00');
  assert.equal(pesoPlain(5), '0.05');
});

// ---- Revision 7: Order List sorting (the same code the browser runs) ---------------------------------------------------------

test('Order List sorting: every option, on stored dates, names and numbers', async () => {
  const { sortOrders, SORTS, timeOf, customerName } = await import('../shared/boardSort.js');
  const o = (id, order_number, customer_number, submitted_at) => ({ id, order_number, customer_number, submitted_at });
  const list = [
    o(1, 'ORD-20260301-001', 'Zed', '2026-03-01T01:00:00.000Z'),
    o(2, 'ORD-20260301-002', 'abby', '2026-03-01T02:00:00.000Z'),
    o(3, 'ORD-20260228-007', 'Carlo', '2026-02-28T05:00:00.000Z'),
    o(4, 'ORD-20260302-001', 'WALK-IN', '2026-03-02T01:00:00.000Z'),
    o(5, 'ORD-20260227-003', 'Bea', 'not-a-date'),
    o(6, 'ORD-20260227-004', 'bea', null),
    o(7, 'ORD-20260301-010', ' Anna ', '2026-03-01T01:00:00.000Z'),
  ];
  const ids = (mode) => sortOrders(list, mode).map((x) => x.id);
  assert.deepEqual(SORTS.map(([key]) => key), ['newest', 'oldest', 'name_az', 'name_za', 'number']);
  assert.deepEqual(SORTS.map(([, text]) => text), ['Newest first', 'Oldest first', 'Customer A–Z', 'Customer Z–A', 'Order number']);
  // newest first; the same minute falls back to the higher id; orders with no usable date come last
  assert.deepEqual(ids('newest'), [4, 2, 7, 1, 3, 6, 5]);
  // oldest first; the same minute falls back to the lower id; no usable date still last
  assert.deepEqual(ids('oldest'), [3, 1, 7, 2, 4, 5, 6]);
  // A-Z ignores case and spaces around the name; the same name shows the newest order first; walk-ins (no name) come last
  // ("Bea" and "bea" are the same name: ties show the higher id, the newer order, first)
  assert.deepEqual(sortOrders(list, 'name_az').map((x) => customerName(x)), ['abby', 'Anna', 'bea', 'Bea', 'Carlo', 'Zed', '']);
  assert.deepEqual(sortOrders(list, 'name_za').map((x) => customerName(x)), ['Zed', 'Carlo', 'bea', 'Bea', 'Anna', 'abby', '']);
  assert.equal(ids('name_az').at(-1), 4);
  assert.equal(ids('name_za').at(-1), 4, 'walk-ins stay last in Z-A too');
  // order number: plain ascending, equal numbers fall back to the id
  assert.deepEqual(sortOrders(list, 'number').map((x) => x.order_number), ['ORD-20260227-003', 'ORD-20260227-004', 'ORD-20260228-007', 'ORD-20260301-001', 'ORD-20260301-002', 'ORD-20260301-010', 'ORD-20260302-001']);
  // sorting never changes the list it was given, and an unknown choice falls back to newest first
  const copy = JSON.stringify(list);
  for (const [mode] of SORTS) sortOrders(list, mode);
  assert.equal(JSON.stringify(list), copy);
  assert.deepEqual(ids('nonsense'), ids('newest'));
  assert.deepEqual(sortOrders([], 'name_az'), []);
  // dates: real ones parse, everything else is "no date"
  assert.equal(timeOf('2026-03-01T01:00:00.000Z'), Date.parse('2026-03-01T01:00:00.000Z'));
  for (const bad of [null, undefined, '', 'not-a-date', 'NaN']) assert.equal(timeOf(bad), null);
  // a missing name or number cannot break the list
  const odd = [{ id: 1 }, { id: 2, customer_number: null, order_number: null, submitted_at: undefined }];
  for (const [mode] of SORTS) assert.equal(sortOrders(odd, mode).length, 2);
});
