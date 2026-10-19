// Chicken products, other products and service fees.
//
// Who may do what:
//   manager: add/edit/deactivate products and other products (including other-product prices)
//   admin:   everything a manager can, plus chicken prices per kg and service fees
import { tx, addStandardOptions, categoryFromName } from '../db.js';
import { HttpError } from '../http.js';
import { parsePesosToCentavos } from '../../shared/money.js';
import { SERVICE_CODES, FEE_BASIS, PRODUCT_KINDS, UNITS, unitRank, CHICKEN_CATEGORIES } from '../../shared/constants.js';
import { ROLE_RANK } from './users.js';

const MAX_PRICE = 10_000_000; // ₱100,000 per kg or unit keeps every calculation exact

export const productCode = (id) => `CH-${String(id).padStart(3, '0')}`;
export const otherCode = (id) => `OP-${String(id).padStart(3, '0')}`;

/** When each product's picture was last changed (null = no picture), so the screens can show it and refresh it when it changes. */
const imageVersions = (db, kind) => new Map(db.prepare('SELECT item_id, updated_at FROM product_images WHERE kind = ?').all(kind).map((r) => [r.item_id, r.updated_at]));

const shapeProduct = (p, images = new Map()) => ({
  id: p.id, code: productCode(p.id), name: p.name, description: p.description,
  price_per_kg_centavos: p.price_per_kg_centavos, active: !!p.active, updated_at: p.updated_at,
  category: p.category ?? 'OTHER', category_label: CHICKEN_CATEGORIES[p.category] ?? CHICKEN_CATEGORIES.OTHER,
  image_version: images.get(p.id) ?? null,
});
const oneProduct = (db, id) => shapeProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id), imageVersions(db, 'CHICKEN'));

/** The paper-form block chosen on the Products screen; when none is given, the one the name points to. */
function readCategory(input, name) {
  if (input === undefined || input === null || input === '') return categoryFromName(name);
  if (!CHICKEN_CATEGORIES[input]) throw new HttpError(400, 'Choose the report category: B-Cull, Cull, Broiler or Other chicken.', 'VALIDATION');
  return input;
}
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
  const images = imageVersions(db, 'CHICKEN');
  return db.prepare(`SELECT * FROM products ${where} ORDER BY active DESC, name COLLATE NOCASE`).all().map((p) => shapeProduct(p, images));
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
  const category = readCategory(body.category, name);
  return tx(db, () => duplicateGuard(() => {
    const r = db.prepare('INSERT INTO products (name, description, price_per_kg_centavos, active, created_at, updated_at, category) VALUES (?,?,?,?,?,?,?)')
      .run(name, clean(body.description, 200), price, active, now.toISOString(), now.toISOString(), category);
    const id = Number(r.lastInsertRowid);
    if (price > 0) logPrice(db, { kind: 'CHICKEN_PRICE', subject: productCode(id), name, oldValue: null, newValue: price, userId: user.id, now });
    return oneProduct(db, id);
  }, 'product'));
}

export function updateProduct(db, user, id, body, now = new Date()) {
  return tx(db, () => duplicateGuard(() => {
    const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!p) throw new HttpError(404, 'Product not found.', 'NOT_FOUND');
    const next = { name: p.name, description: p.description, price: p.price_per_kg_centavos, active: p.active, category: p.category ?? 'OTHER' };
    if (body.name !== undefined) next.name = clean(body.name, 80) || p.name;
    if (body.description !== undefined) next.description = clean(body.description, 200);
    if (body.category !== undefined) next.category = readCategory(body.category, next.name);
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

    db.prepare('UPDATE products SET name=?, description=?, price_per_kg_centavos=?, active=?, category=?, updated_at=? WHERE id=?')
      .run(next.name, next.description, next.price, next.active, next.category, now.toISOString(), id);
    if (next.price !== p.price_per_kg_centavos) {
      logPrice(db, { kind: 'CHICKEN_PRICE', subject: productCode(id), name: next.name, oldValue: p.price_per_kg_centavos, newValue: next.price, userId: user.id, now });
    }
    return oneProduct(db, id);
  }, 'product'));
}

// ---- Other products -----------------------------------------------------------------------------
// A product (Eggs (Small), Garlic ...) is sold in a fixed set of ways. Each way is an "option" with its own price:
//   Eggs            piece, carton, tray              (fixed price each, whole quantities)
//   Other products  piece, pack, sack (fixed price each) and kg (a price per kg, weight with up to 3 decimals)
// Every new product gets all of its options straight away, so its Daily Inventory rows exist from the first day. An option without a
// price stays inactive (hidden from the cashier) until the admin sets one. Managers add products; only the admin sets prices.
// Products made before revision 10 keep any other option they already had (dozen, batch ...) and gain the standard ones.

const soldByUnit = (unit) => (unit === 'kg' ? 'PER_KG' : 'FIXED');
const shapeOption = (o) => ({ id: o.id, unit: o.unit, sold_by: o.sold_by, price_centavos: o.price_centavos, active: !!o.active });
const shapeOther = (p, options, images = new Map()) => ({
  id: p.id, code: otherCode(p.id), name: p.name, kind: p.kind, kind_label: PRODUCT_KINDS[p.kind], active: !!p.active, updated_at: p.updated_at,
  units: UNITS[p.kind], options: options.slice().sort((a, b) => unitRank(a.unit) - unitRank(b.unit) || a.id - b.id).map(shapeOption),
  image_version: images.get(p.id) ?? null,
});

/** For the cashier screen (default): active products that have at least one active, priced option. */
export function listOtherProducts(db, { includeInactive = false } = {}) {
  const products = db.prepare(`SELECT * FROM other_products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY active DESC, name COLLATE NOCASE`).all();
  const options = db.prepare('SELECT * FROM other_product_options ORDER BY id').all();
  const images = imageVersions(db, 'OTHER');
  const shaped = products.map((p) => shapeOther(p, options.filter((o) => o.product_id === p.id && (includeInactive || o.active)), images));
  return includeInactive ? shaped : shaped.filter((p) => p.options.length > 0);
}

function readPrice(user, input, current) {
  if (input === undefined || input === null || String(input).trim() === '') return current;
  const price = parsePesosToCentavos(input, MAX_PRICE);
  if (price === null || price <= 0) throw new HttpError(400, 'Enter a price above ₱0.00.', 'VALIDATION');
  if (price !== current && !isAdmin(user)) throw new HttpError(403, 'Only the admin can set or change prices.', 'FORBIDDEN');
  return price;
}

function setOptionPrice(db, user, product, option, input, now) {
  const price = readPrice(user, input, option.price_centavos);
  if (price === option.price_centavos) return;
  // A first price makes the option usable; changing a price leaves it as it was.
  const active = option.price_centavos === 0 ? 1 : option.active;
  db.prepare('UPDATE other_product_options SET price_centavos = ?, active = ?, updated_at = ? WHERE id = ?').run(price, active, now.toISOString(), option.id);
  logPrice(db, { kind: 'OTHER_PRICE', subject: `${otherCode(product.id)}/${option.unit}`, name: `${product.name} (${option.unit})`, oldValue: option.price_centavos || null, newValue: price, userId: user.id, now });
}

export function createOtherProduct(db, user, body, now = new Date()) {
  const name = clean(body.name, 80);
  if (!name) throw new HttpError(400, 'Enter a product name.', 'VALIDATION');
  const kind = body.kind === undefined || body.kind === '' ? 'OTHER' : body.kind;
  if (!PRODUCT_KINDS[kind]) throw new HttpError(400, 'Choose Eggs or Other product.', 'VALIDATION');
  const prices = body.prices && typeof body.prices === 'object' ? body.prices : {};
  for (const unit of Object.keys(prices)) {
    if (!UNITS[kind].includes(unit)) throw new HttpError(400, `${PRODUCT_KINDS[kind]} are sold by ${UNITS[kind].join(', ')}, not "${unit}".`, 'VALIDATION');
  }
  return tx(db, () => duplicateGuard(() => {
    const id = Number(db.prepare('INSERT INTO other_products (name, kind, active, created_at, updated_at) VALUES (?,?,1,?,?)').run(name, kind, now.toISOString(), now.toISOString()).lastInsertRowid);
    addStandardOptions(db, id, kind, now.toISOString());
    const product = db.prepare('SELECT * FROM other_products WHERE id = ?').get(id);
    for (const option of db.prepare('SELECT * FROM other_product_options WHERE product_id = ?').all(id)) {
      setOptionPrice(db, user, product, option, prices[option.unit], now);
    }
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

/** Add a way of selling that the product is missing. The unit must be one of the product's standard units. */
export function createOption(db, user, productId, body, now = new Date()) {
  return tx(db, () => {
    const product = db.prepare('SELECT * FROM other_products WHERE id = ?').get(productId);
    if (!product) throw new HttpError(404, 'Product not found.', 'NOT_FOUND');
    const unit = clean(body.unit, 20).toLowerCase();
    if (!UNITS[product.kind].includes(unit)) {
      throw new HttpError(400, `${product.name} (${PRODUCT_KINDS[product.kind].toLowerCase()}) is sold by ${UNITS[product.kind].join(', ')}.`, 'VALIDATION');
    }
    if (db.prepare('SELECT 1 FROM other_product_options WHERE product_id = ? AND unit = ?').get(productId, unit)) {
      throw new HttpError(409, `${product.name} already has a "${unit}" option.`, 'DUPLICATE');
    }
    const nowIso = now.toISOString();
    const id = Number(db.prepare('INSERT INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at) VALUES (?,?,?,0,0,?,?)')
      .run(productId, unit, soldByUnit(unit), nowIso, nowIso).lastInsertRowid);
    setOptionPrice(db, user, product, db.prepare('SELECT * FROM other_product_options WHERE id = ?').get(id), body.price, now);
    return listOtherProducts(db, { includeInactive: true }).find((x) => x.id === productId);
  });
}

/** Change an option's price (admin) or switch it on or off. Its unit never changes: it is what the stock and the saved orders are counted in. */
export function updateOption(db, user, optionId, body, now = new Date()) {
  return tx(db, () => {
    const o = db.prepare('SELECT o.*, p.name AS product_name FROM other_product_options o JOIN other_products p ON p.id = o.product_id WHERE o.id = ?').get(optionId);
    if (!o) throw new HttpError(404, 'Option not found.', 'NOT_FOUND');
    if ((body.unit !== undefined && clean(body.unit, 20).toLowerCase() !== o.unit) || (body.sold_by !== undefined && body.sold_by !== o.sold_by)) {
      throw new HttpError(400, 'The unit of a selling option cannot be changed. Switch this one off and use the right unit instead.', 'VALIDATION');
    }
    const price = readPrice(user, body.price, o.price_centavos);
    // A first price switches the option on, unless the person said otherwise.
    const active = body.active !== undefined ? (body.active ? 1 : 0) : (o.price_centavos === 0 && price > 0 ? 1 : o.active);
    if (active && price <= 0) throw new HttpError(400, 'Set a price before activating this option. Ask the admin.', 'NO_PRICE');
    db.prepare('UPDATE other_product_options SET price_centavos = ?, active = ?, updated_at = ? WHERE id = ?').run(price, active, now.toISOString(), optionId);
    if (price !== o.price_centavos) {
      logPrice(db, { kind: 'OTHER_PRICE', subject: `${otherCode(o.product_id)}/${o.unit}`, name: `${o.product_name} (${o.unit})`, oldValue: o.price_centavos, newValue: price, userId: user.id, now });
    }
    return listOtherProducts(db, { includeInactive: true }).find((x) => x.id === o.product_id);
  });
}

/**
 * First-run starter data for a real install: the service prices the shop gave (Pour 45, Dress 25, Live no fee) and the other
 * products the shop named. Their prices are NOT known, so they start without a price and stay hidden from cashiers until the
 * admin sets them. Does nothing if the shop already has other products.
 */
export function seedStarterCatalog(db, now = new Date()) {
  if (db.prepare('SELECT COUNT(*) AS n FROM other_products').get().n > 0) return false;
  db.prepare("UPDATE service_fees SET amount_centavos = 4500, updated_at = ? WHERE code = 'POUR' AND amount_centavos = 0").run(now.toISOString());
  db.prepare("UPDATE service_fees SET amount_centavos = 2500, updated_at = ? WHERE code = 'NOT_POUR' AND amount_centavos = 0").run(now.toISOString());
  const starter = [
    ['Eggs (Small)', 'EGGS'], ['Eggs (Medium)', 'EGGS'], ['Eggs (Large)', 'EGGS'],
    ['Etag (Sun-Dried)', 'OTHER'], ['Etag (Smoked)', 'OTHER'], ['Garlic', 'OTHER'], ['Onions', 'OTHER'], ['Laya', 'OTHER'],
  ];
  tx(db, () => {
    for (const [name, kind] of starter) {
      const id = Number(db.prepare('INSERT INTO other_products (name, kind, active, created_at, updated_at) VALUES (?,?,1,?,?)').run(name, kind, now.toISOString(), now.toISOString()).lastInsertRowid);
      addStandardOptions(db, id, kind, now.toISOString());
    }
  });
  return true;
}

/**
 * Revision 11 products, added once: Brown Cull Chicken (a chicken product in the CULL block of the report), Ducks and Catfish (other
 * products). No price is invented: they wait without a price (hidden from the cashier) until the admin sets one in Products. A product
 * that already exists by that name is left exactly as it is. Runs once per database (it is not repeated if a product is renamed later).
 */
export function seedRevision11Products(db, now = new Date()) {
  if (db.prepare("SELECT 1 FROM app_meta WHERE key = 'r11_products'").get()) return [];
  const added = [];
  const iso = now.toISOString();
  tx(db, () => {
    if (!db.prepare('SELECT 1 FROM products WHERE name = ?').get('Brown Cull Chicken')) {
      db.prepare("INSERT INTO products (name, description, price_per_kg_centavos, active, created_at, updated_at, category) VALUES (?, '', 0, 0, ?, ?, 'CULL')")
        .run('Brown Cull Chicken', iso, iso);
      added.push('Brown Cull Chicken');
    }
    for (const name of ['Ducks', 'Catfish']) {
      if (db.prepare('SELECT 1 FROM other_products WHERE name = ?').get(name)) continue;
      const id = Number(db.prepare("INSERT INTO other_products (name, kind, active, created_at, updated_at) VALUES (?, 'OTHER', 1, ?, ?)").run(name, iso, iso).lastInsertRowid);
      addStandardOptions(db, id, 'OTHER', iso);
      added.push(name);
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('r11_products', ?)").run(iso);
  });
  return added;
}

// ---- Product pictures (Revision 11) -----------------------------------------------------------------
// One picture per product, shown on the New order cards. The screen shrinks a photo before sending it; the server checks it really is a
// JPEG, PNG or WebP picture and keeps it in the database (so a backup copies it). No picture: the card shows an icon instead.

const MAX_IMAGE_BYTES = 400_000;
const IMAGE_KINDS = { chicken: 'CHICKEN', other: 'OTHER' };
const looksLike = {
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP',
};

function imageTarget(db, kindParam, id) {
  const kind = IMAGE_KINDS[kindParam];
  if (!kind) throw new HttpError(404, 'Not found.', 'NOT_FOUND');
  const found = db.prepare(`SELECT id, name FROM ${kind === 'CHICKEN' ? 'products' : 'other_products'} WHERE id = ?`).get(id);
  if (!found) throw new HttpError(404, 'Product not found.', 'NOT_FOUND');
  return { kind, product: found };
}

/** body.data_url: "data:image/jpeg;base64,...". Managers and the admin (the people who edit products). */
export function setProductImage(db, user, kindParam, id, body, now = new Date()) {
  const { kind, product } = imageTarget(db, kindParam, id);
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.data_url ?? ''));
  if (!m) throw new HttpError(400, 'Choose a JPEG, PNG or WebP picture.', 'VALIDATION');
  const data = Buffer.from(m[2], 'base64');
  if (!looksLike[m[1]](data)) throw new HttpError(400, 'That file is not a picture the app can show. Choose a JPEG, PNG or WebP photo.', 'VALIDATION');
  if (data.length > MAX_IMAGE_BYTES) throw new HttpError(400, `The picture is too large (${Math.ceil(data.length / 1000)} KB). Use one under ${MAX_IMAGE_BYTES / 1000} KB.`, 'TOO_LARGE');
  db.prepare(`INSERT INTO product_images (kind, item_id, mime, data, updated_at) VALUES (?,?,?,?,?)
              ON CONFLICT(kind, item_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`).run(kind, id, m[1], data, now.toISOString());
  return { name: product.name, image_version: now.toISOString() };
}

export function removeProductImage(db, user, kindParam, id) {
  const { kind, product } = imageTarget(db, kindParam, id);
  db.prepare('DELETE FROM product_images WHERE kind = ? AND item_id = ?').run(kind, id);
  return { name: product.name, image_version: null };
}

export function getProductImage(db, kindParam, id) {
  const { kind } = imageTarget(db, kindParam, id);
  const img = db.prepare('SELECT mime, data FROM product_images WHERE kind = ? AND item_id = ?').get(kind, id);
  if (!img) throw new HttpError(404, 'This product has no picture.', 'NOT_FOUND');
  return { mime: img.mime, body: Buffer.from(img.data) };
}

// ---- Service fees (admin only) ----------------------------------------------------------------

/**
 * The fee of every service that can be charged, by service code (Revision 19: each service has its own, e.g. POUR_SLICE). Live has none.
 * { POUR: { amount, basis, name: 'Pour' }, POUR_SLICE: {...}, ... }  name is what the receipt's fee line calls it.
 */
export function getFeeConfig(db) {
  const fees = {};
  for (const f of db.prepare("SELECT * FROM services WHERE kind <> 'LIVE'").all()) fees[f.code] = { amount: f.fee_centavos, basis: f.fee_basis, name: f.fee_name || f.label };
  return fees;
}

/**
 * Old shortcut, kept on purpose: set the fee of a whole family at once. 'POUR' sets Pour, Po-ur & Slice and Pour & Dukot; 'NOT_POUR' sets the
 * three Dress services. It is one price change in the history. The Products screen sets one service at a time (updateService).
 */
export function updateFee(db, user, code, body, now = new Date()) {
  if (!SERVICE_CODES.includes(code)) throw new HttpError(404, 'Unknown service.', 'NOT_FOUND');
  const amount = parsePesosToCentavos(body.amount, 1_000_000);
  if (amount === null) throw new HttpError(400, 'Enter the fee in pesos, for example 15 or 15.50.', 'VALIDATION');
  if (!FEE_BASIS.includes(body.basis)) throw new HttpError(400, 'Choose per item or per kg.', 'VALIDATION');
  return tx(db, () => {
    const old = db.prepare('SELECT fee_centavos, fee_basis FROM services WHERE code = ?').get(code);
    db.prepare('UPDATE services SET fee_centavos = ?, fee_basis = ?, updated_at = ? WHERE builtin = 1 AND kind = ?').run(amount, body.basis, now.toISOString(), code);
    db.prepare('UPDATE service_fees SET amount_centavos = ?, basis = ?, updated_at = ? WHERE code = ?').run(amount, body.basis, now.toISOString(), code);
    if (old.fee_centavos !== amount || old.fee_basis !== body.basis) {
      logPrice(db, { kind: 'SERVICE_FEE', subject: code, name: code, oldValue: old.fee_centavos, newValue: amount, oldBasis: old.fee_basis, newBasis: body.basis, userId: user.id, now });
    }
    return getFeeConfig(db);
  });
}

// ---- Services (Revision 19) ---------------------------------------------------------------------

const shapeService = (s) => ({
  code: s.code, label: s.label, note: s.note, kind: s.kind, cut: s.cut, builtin: !!s.builtin, active: !!s.active,
  fee_centavos: s.fee_centavos, fee_basis: s.fee_basis, fee_name: s.fee_name || s.label, asks_size: s.cut === 'SLICE',
});

/** Every service in button order. The cashier gets only the active ones (includeInactive for the Products screen). */
export function listServices(db, { includeInactive = false } = {}) {
  return db.prepare(`SELECT * FROM services ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, code`).all().map(shapeService);
}

const readFee = (body, current) => {
  const hasAmount = body.fee !== undefined && body.fee !== null && String(body.fee).trim() !== '';
  const amount = hasAmount ? parsePesosToCentavos(body.fee, 1_000_000) : current.fee_centavos;
  if (amount === null) throw new HttpError(400, 'Enter the fee in pesos, for example 15 or 15.50.', 'VALIDATION');
  const basis = body.basis === undefined ? current.fee_basis : body.basis;
  if (!FEE_BASIS.includes(basis)) throw new HttpError(400, 'Choose how the fee is charged: per line, per head or per kg.', 'VALIDATION');
  return { amount, basis };
};

/** Add a service the cashier can pick (admin). body: { label, note, kind: 'POUR'|'NOT_POUR', cut: 'NONE'|'SLICE'|'DUKOT', fee, basis, fee_name }. */
export function createService(db, user, body, now = new Date()) {
  if (!isAdmin(user)) throw new HttpError(403, 'Only the admin can add a service.', 'FORBIDDEN');
  const label = clean(body.label, 40);
  if (!label) throw new HttpError(400, 'Enter a name for the service.', 'VALIDATION');
  if (!['POUR', 'NOT_POUR'].includes(body.kind)) throw new HttpError(400, 'Choose whether it is a Pour or a Dress service (the butcher needs to know).', 'VALIDATION');
  if (!['NONE', 'SLICE', 'DUKOT'].includes(body.cut ?? 'NONE')) throw new HttpError(400, 'Choose whole, sliced or Dukot.', 'VALIDATION');
  const fee = readFee(body, { fee_centavos: 0, fee_basis: 'per_head' });
  return tx(db, () => duplicateGuard(() => {
    const next = db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(code, 5) AS INTEGER)), 0) + 1 AS n FROM services WHERE code GLOB 'SVC_[0-9]*'").get();
    const sortNo = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS sort FROM services').get().sort;
    const code = `SVC_${next.n}`;
    const iso = now.toISOString();
    db.prepare(`INSERT INTO services (code, label, note, kind, cut, fee_centavos, fee_basis, fee_name, active, sort, builtin, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,1,?,0,?,?)`).run(code, label, clean(body.note, 80), body.kind, body.cut ?? 'NONE', fee.amount, fee.basis, clean(body.fee_name, 40) || label, sortNo, iso, iso);
    if (fee.amount > 0) logPrice(db, { kind: 'SERVICE_FEE', subject: code, name: label, oldValue: null, newValue: fee.amount, newBasis: fee.basis, userId: user.id, now });
    return shapeService(db.prepare('SELECT * FROM services WHERE code = ?').get(code));
  }, 'service'));
}

/**
 * Change a service (admin): its name, note, receipt fee name, fee, how the fee is charged, or show/hide it. What it IS (Pour or Dress kind,
 * whole / sliced / Dukot) never changes: saved orders and the butcher depend on it. Live never has a fee.
 */
export function updateService(db, user, code, body, now = new Date()) {
  if (!isAdmin(user)) throw new HttpError(403, 'Only the admin can change a service.', 'FORBIDDEN');
  return tx(db, () => duplicateGuard(() => {
    const s = db.prepare('SELECT * FROM services WHERE code = ?').get(code);
    if (!s) throw new HttpError(404, 'Service not found.', 'NOT_FOUND');
    if ((body.kind !== undefined && body.kind !== s.kind) || (body.cut !== undefined && body.cut !== s.cut)) {
      throw new HttpError(400, 'What a service is (Pour or Dress, whole, sliced or Dukot) cannot be changed. Hide it and add a new one instead.', 'VALIDATION');
    }
    const label = body.label !== undefined ? clean(body.label, 40) : s.label;
    if (!label) throw new HttpError(400, 'Enter a name for the service.', 'VALIDATION');
    const fee = readFee(body, s);
    if (s.kind === 'LIVE' && fee.amount > 0) throw new HttpError(400, 'A live chicken never has a fee.', 'VALIDATION');
    const active = body.active !== undefined ? (body.active ? 1 : 0) : s.active;
    const feeName = body.fee_name !== undefined ? clean(body.fee_name, 40) : s.fee_name;
    db.prepare('UPDATE services SET label = ?, note = ?, fee_centavos = ?, fee_basis = ?, fee_name = ?, active = ?, updated_at = ? WHERE code = ?')
      .run(label, body.note !== undefined ? clean(body.note, 80) : s.note, fee.amount, fee.basis, feeName, active, now.toISOString(), code);
    if (fee.amount !== s.fee_centavos || fee.basis !== s.fee_basis) {
      logPrice(db, { kind: 'SERVICE_FEE', subject: code, name: label, oldValue: s.fee_centavos, newValue: fee.amount, oldBasis: s.fee_basis, newBasis: fee.basis, userId: user.id, now });
    }
    return shapeService(db.prepare('SELECT * FROM services WHERE code = ?').get(code));
  }, 'service'));
}

export function listPriceHistory(db, limit = 200) {
  return db.prepare(`SELECT h.*, u.display_name AS changed_by_name FROM price_history h JOIN users u ON u.id = h.changed_by ORDER BY h.id DESC LIMIT ?`).all(limit);
}
