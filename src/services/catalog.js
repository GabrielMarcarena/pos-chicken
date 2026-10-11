// Chicken products, other products and service fees.
//
// Who may do what:
//   manager: add/edit/deactivate products and other products (including other-product prices)
//   admin:   everything a manager can, plus chicken prices per kg and service fees
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { parsePesosToCentavos } from '../../shared/money.js';
import { SERVICE_CODES, FEE_BASIS, SOLD_BY } from '../../shared/constants.js';
import { ROLE_RANK } from './users.js';

const MAX_PRICE = 10_000_000; // ₱100,000 per kg or unit keeps every calculation exact

export const productCode = (id) => `CH-${String(id).padStart(3, '0')}`;
export const otherCode = (id) => `OP-${String(id).padStart(3, '0')}`;

const shapeProduct = (p) => ({
  id: p.id, code: productCode(p.id), name: p.name, description: p.description,
  price_per_kg_centavos: p.price_per_kg_centavos, active: !!p.active, updated_at: p.updated_at,
});
const isAdmin = (user) => ROLE_RANK[user.role] >= ROLE_RANK.admin;
const clean = (value, max) => String(value ?? '').trim().slice(0, max);

function duplicateGuard(fn, what) {
  try { return fn(); } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, `A ${what} with this name already exists.`, 'DUPLICATE');
    throw err;
  }
}

function logPrice(db, { kind, subject, name, oldValue, newValue, oldBasis = null, newBasis = null, userId, now }) {
  db.prepare(`INSERT INTO price_history (kind, subject, subject_name, old_value, new_value, old_basis, new_basis, changed_by, changed_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(kind, subject, name, oldValue, newValue, oldBasis, newBasis, userId, now.toISOString());
}

// ---- Chicken products -------------------------------------------------------------------------

export function listProducts(db, { includeInactive = false } = {}) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return db.prepare(`SELECT * FROM products ${where} ORDER BY active DESC, name COLLATE NOCASE`).all().map(shapeProduct);
}

export function createProduct(db, user, body, now = new Date()) {
  const name = clean(body.name, 80);
  if (!name) throw new HttpError(400, 'Enter a product name.', 'VALIDATION');
  const hasPrice = body.price !== undefined && body.price !== null && String(body.price).trim() !== '';
  let price = 0;
  if (hasPrice) {
    if (!isAdmin(user)) throw new HttpError(403, 'Only the admin can set the price per kg.', 'FORBIDDEN');
    price = parsePesosToCentavos(body.price, MAX_PRICE);
    if (price === null || price <= 0) throw new HttpError(400, 'Enter a price per kg above ₱0.00.', 'VALIDATION');
  }
  // Without a price the product waits, inactive, until the admin sets one.
  const active = price > 0 && body.active !== false ? 1 : 0;
  return tx(db, () => duplicateGuard(() => {
    const r = db.prepare('INSERT INTO products (name, description, price_per_kg_centavos, active, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(name, clean(body.description, 200), price, active, now.toISOString(), now.toISOString());
    const id = Number(r.lastInsertRowid);
    if (price > 0) logPrice(db, { kind: 'CHICKEN_PRICE', subject: productCode(id), name, oldValue: null, newValue: price, userId: user.id, now });
    return shapeProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  }, 'product'));
}

export function updateProduct(db, user, id, body, now = new Date()) {
  return tx(db, () => duplicateGuard(() => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Product not found.', 'NOT_FOUND');
    const next = { name: p.name, description: p.description, price: p.price_per_kg_centavos, active: p.active };
    if (body.name !== undefined) next.name = clean(body.name, 80) || p.name;
    if (body.description !== undefined) next.description = clean(body.description, 200);
    if (body.price !== undefined && body.price !== '') {
      const price = parsePesosToCentavos(body.price, MAX_PRICE);
      if (price === null || price <= 0) throw new HttpError(400, 'Enter a price per kg above ₱0.00.', 'VALIDATION');
      if (price !== p.price_per_kg_centavos) {
        if (!isAdmin(user)) throw new HttpError(403, 'Only the admin can change the price per kg.', 'FORBIDDEN');
        next.price = price;
      }
    }
    if (body.active !== undefined) next.active = body.active ? 1 : 0;
    if (next.active && next.price <= 0) throw new HttpError(400, 'Set a price per kg before activating this product. Ask the admin.', 'NO_PRICE');

    db.prepare('UPDATE products SET name=?, description=?, price_per_kg_centavos=?, active=?, updated_at=? WHERE id=?')
      .run(next.name, next.description, next.price, next.active, now.toISOString(), id);
    if (next.price !== p.price_per_kg_centavos) {
      logPrice(db, { kind: 'CHICKEN_PRICE', subject: productCode(id), name: next.name, oldValue: p.price_per_kg_centavos, newValue: next.price, userId: user.id, now });
    }
    return shapeProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
  }, 'product'));
}

// ---- Other products -----------------------------------------------------------------------------
// A product (Eggs (Small), Garlic ...) can be sold in several ways. Each way is an "option":
//   FIXED  - a fixed price per piece, dozen, pack or batch (whole quantities)
//   PER_KG - a price per kg (weight with up to 3 decimals)
// Managers add products and options. Only the admin sets prices. An option without a price stays inactive.

const shapeOption = (o) => ({ id: o.id, unit: o.unit, sold_by: o.sold_by, price_centavos: o.price_centavos, active: !!o.active });
const shapeOther = (p, options) => ({
  id: p.id, code: otherCode(p.id), name: p.name, active: !!p.active, updated_at: p.updated_at, options: options.map(shapeOption),
});

/** For the cashier screen (default): active products that have at least one active, priced option. */
export function listOtherProducts(db, { includeInactive = false } = {}) {
  const products = db.prepare(`SELECT * FROM other_products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY active DESC, name COLLATE NOCASE`).all();
  const options = db.prepare('SELECT * FROM other_product_options ORDER BY id').all();
  const shaped = products.map((p) => shapeOther(p, options.filter((o) => o.product_id === p.id && (includeInactive || o.active))));
  return includeInactive ? shaped : shaped.filter((p) => p.options.length > 0);
}

function readPrice(user, input, current) {
  if (input === undefined || input === null || String(input).trim() === '') return current;
  const price = parsePesosToCentavos(input, MAX_PRICE);
  if (price === null || price <= 0) throw new HttpError(400, 'Enter a price above ₱0.00.', 'VALIDATION');
  if (price !== current && !isAdmin(user)) throw new HttpError(403, 'Only the admin can set or change prices.', 'FORBIDDEN');
  return price;
}

function insertOption(db, user, productId, body, now) {
  const product = db.prepare('SELECT * FROM other_products WHERE id = ?').get(productId);
  if (!product) throw new HttpError(404, 'Product not found.', 'NOT_FOUND');
  if (!SOLD_BY[body.sold_by]) throw new HttpError(400, 'Choose fixed price or per kg.', 'VALIDATION');
  const unit = body.sold_by === 'PER_KG' ? 'kg' : clean(body.unit, 20).toLowerCase();
  if (!unit) throw new HttpError(400, 'Enter a unit such as piece, dozen, pack or batch.', 'VALIDATION');
  const price = readPrice(user, body.price, 0);
  const active = price > 0 && body.active !== false ? 1 : 0; // without a price it waits for the admin
  try {
    const r = db.prepare('INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(productId, unit, body.sold_by, price, active, now.toISOString(), now.toISOString());
    const id = Number(r.lastInsertRowid);
    if (price > 0) logPrice(db, { kind: 'OTHER_PRICE', subject: `${otherCode(productId)}/${unit}`, name: `${product.name} (${unit})`, oldValue: null, newValue: price, userId: user.id, now });
    return id;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, `${product.name} already has a "${unit}" option.`, 'DUPLICATE');
    throw err;
  }
}

export function createOtherProduct(db, user, body, now = new Date()) {
  const name = clean(body.name, 80);
  if (!name) throw new HttpError(400, 'Enter a product name.', 'VALIDATION');
  return tx(db, () => duplicateGuard(() => {
    const r = db.prepare('INSERT INTO other_products (name, active, created_at, updated_at) VALUES (?,1,?,?)').run(name, now.toISOString(), now.toISOString());
    const id = Number(r.lastInsertRowid);
    for (const option of Array.isArray(body.options) ? body.options : []) insertOption(db, user, id, option, now);
    return listOtherProducts(db, { includeInactive: true }).find((p) => p.id === id);
  }, 'product'));
}

export function updateOtherProduct(db, user, id, body, now = new Date()) {
  return tx(db, () => duplicateGuard(() => {
    const p = db.prepare('SELECT * FROM other_products WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Product not found.', 'NOT_FOUND');
    const name = body.name !== undefined ? clean(body.name, 80) || p.name : p.name;
    const active = body.active !== undefined ? (body.active ? 1 : 0) : p.active;
    db.prepare('UPDATE other_products SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(name, active, now.toISOString(), id);
    return listOtherProducts(db, { includeInactive: true }).find((x) => x.id === id);
  }, 'product'));
}

export function createOption(db, user, productId, body, now = new Date()) {
  return tx(db, () => {
    insertOption(db, user, productId, body, now);
    return listOtherProducts(db, { includeInactive: true }).find((x) => x.id === productId);
  });
}

export function updateOption(db, user, optionId, body, now = new Date()) {
  return tx(db, () => {
    const o = db.prepare('SELECT o.*, p.name AS product_name FROM other_product_options o JOIN other_products p ON p.id = o.product_id WHERE o.id = ?').get(optionId);
    if (!o) throw new HttpError(404, 'Option not found.', 'NOT_FOUND');
    const soldBy = body.sold_by !== undefined ? body.sold_by : o.sold_by;
    if (!SOLD_BY[soldBy]) throw new HttpError(400, 'Choose fixed price or per kg.', 'VALIDATION');
    const unit = soldBy === 'PER_KG' ? 'kg' : clean(body.unit ?? o.unit, 20).toLowerCase() || o.unit;
    const price = readPrice(user, body.price, o.price_centavos);
    const active = body.active !== undefined ? (body.active ? 1 : 0) : o.active;
    if (active && price <= 0) throw new HttpError(400, 'Set a price before activating this option. Ask the admin.', 'NO_PRICE');
    try {
      db.prepare('UPDATE other_product_options SET unit = ?, sold_by = ?, price_centavos = ?, active = ?, updated_at = ? WHERE id = ?')
        .run(unit, soldBy, price, active, now.toISOString(), optionId);
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) throw new HttpError(409, `${o.product_name} already has a "${unit}" option.`, 'DUPLICATE');
      throw err;
    }
    if (price !== o.price_centavos) {
      logPrice(db, { kind: 'OTHER_PRICE', subject: `${otherCode(o.product_id)}/${unit}`, name: `${o.product_name} (${unit})`, oldValue: o.price_centavos, newValue: price, userId: user.id, now });
    }
    return listOtherProducts(db, { includeInactive: true }).find((x) => x.id === o.product_id);
  });
}

/**
 * First-run starter data for a real install: the service prices the shop gave (Po-ur & Slice 45, Dressed & Slice 25,
 * Live no fee) and the other products the shop named. Their prices are NOT known, so they start without a price
 * and stay hidden from cashiers until the admin sets them. Does nothing if the shop already has other products.
 */
export function seedStarterCatalog(db, now = new Date()) {
  if (db.prepare('SELECT COUNT(*) AS n FROM other_products').get().n > 0) return false;
  db.prepare("UPDATE service_fees SET amount_centavos = 4500, updated_at = ? WHERE code = 'POUR' AND amount_centavos = 0").run(now.toISOString());
  db.prepare("UPDATE service_fees SET amount_centavos = 2500, updated_at = ? WHERE code = 'NOT_POUR' AND amount_centavos = 0").run(now.toISOString());
  const eggs = ['piece', 'dozen', 'batch'].map((unit) => ({ unit, sold_by: 'FIXED' }));
  const perKg = [{ unit: 'kg', sold_by: 'PER_KG' }];
  const starter = [
    ['Eggs (Small)', eggs], ['Eggs (Medium)', eggs], ['Eggs (Large)', eggs],
    ['Etag (Sun-Dried)', perKg], ['Etag (Smoked)', perKg], ['Garlic', perKg], ['Onions', perKg], ['Laya', perKg],
  ];
  const system = { id: db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id ?? 0, role: 'admin' };
  tx(db, () => {
    for (const [name, options] of starter) {
      const id = Number(db.prepare('INSERT INTO other_products (name, active, created_at, updated_at) VALUES (?,1,?,?)').run(name, now.toISOString(), now.toISOString()).lastInsertRowid);
      for (const o of options) insertOption(db, system, id, o, now);
    }
  });
  return true;
}

// ---- Service fees (admin only) ----------------------------------------------------------------

export function getFeeConfig(db) {
  const fees = {};
  for (const f of db.prepare('SELECT * FROM service_fees').all()) fees[f.code] = { amount: f.amount_centavos, basis: f.basis };
  return fees;
}

export function updateFee(db, user, code, body, now = new Date()) {
  if (!SERVICE_CODES.includes(code)) throw new HttpError(404, 'Unknown service.', 'NOT_FOUND');
  const amount = parsePesosToCentavos(body.amount, 1_000_000);
  if (amount === null) throw new HttpError(400, 'Enter the fee in pesos, for example 15 or 15.50.', 'VALIDATION');
  if (!FEE_BASIS.includes(body.basis)) throw new HttpError(400, 'Choose per item or per kg.', 'VALIDATION');
  return tx(db, () => {
    const old = db.prepare('SELECT * FROM service_fees WHERE code = ?').get(code);
    db.prepare('UPDATE service_fees SET amount_centavos = ?, basis = ?, updated_at = ? WHERE code = ?').run(amount, body.basis, now.toISOString(), code);
    if (old.amount_centavos !== amount || old.basis !== body.basis) {
      logPrice(db, { kind: 'SERVICE_FEE', subject: code, name: code, oldValue: old.amount_centavos, newValue: amount, oldBasis: old.basis, newBasis: body.basis, userId: user.id, now });
    }
    return getFeeConfig(db);
  });
}

export function listPriceHistory(db, limit = 200) {
  return db.prepare(`SELECT h.*, u.display_name AS changed_by_name FROM price_history h JOIN users u ON u.id = h.changed_by ORDER BY h.id DESC LIMIT ?`).all(limit);
}
