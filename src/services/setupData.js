// Copy the shop's SETUP (chicken products, other products with their ways of selling, prices, service fees) between databases,
// without any users, passwords or orders. Used to start a hosted copy with the same products:
//   npm run export-setup   writes deploy/setup.json from this database
//   SETUP_FILE=deploy/setup.json   makes a fresh database load it once at start (server.js)
// Everything goes through the normal catalog services, so the usual checks apply and the price history records it.
import { listOtherProducts, listProducts, listServices, createOption, createOtherProduct, createProduct, createService, updateFee, updateOption, updateProduct, updateService } from './catalog.js';

const pesos = (centavos) => (centavos / 100).toFixed(2);

/** The setup of a database as plain data. */
export function exportSetup(db) {
  return {
    version: 1,
    chicken: listProducts(db, { includeInactive: true }).map((p) => ({
      name: p.name, category: p.category, price: p.price_per_kg_centavos > 0 ? pesos(p.price_per_kg_centavos) : null, active: p.active,
    })),
    other: listOtherProducts(db, { includeInactive: true }).map((p) => ({
      name: p.name, kind: p.kind, active: p.active,
      options: p.options.map((o) => ({ unit: o.unit, price: o.price_centavos > 0 ? pesos(o.price_centavos) : null, active: o.active })),
    })),
    // Revision 19: every service with its own price (the built-in seven by code, the ones the admin added by name).
    services: listServices(db, { includeInactive: true }).map((x) => ({
      code: x.code, builtin: x.builtin, label: x.label, note: x.note, kind: x.kind, cut: x.cut, fee_name: x.fee_name, active: x.active,
      fee: x.kind === 'LIVE' ? null : pesos(x.fee_centavos), basis: x.fee_basis,
    })),
  };
}

const ONCE = 'setup_imported';

/**
 * Load a setup into this database, once. Products that already exist (by name) are updated, the rest are created. `admin` is the
 * signed-in-style user the changes are recorded under (the price history names them). Returns a short summary, or null if it was
 * already done on this database (so a restart never overwrites what the admin changed since).
 */
export function importSetup(db, admin, data, now = new Date()) {
  if (db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get(ONCE)) return null;
  if (!data || data.version !== 1) throw new Error('This is not a setup file this version understands.');
  const count = { chicken: 0, other: 0, fees: 0, services: 0 };

  for (const c of data.chicken ?? []) {
    const have = db.prepare('SELECT id FROM products WHERE name = ?').get(c.name);
    if (have) {
      updateProduct(db, admin, have.id, { category: c.category, ...(c.price ? { price: c.price } : {}), ...(c.price ? { active: c.active } : {}) }, now);
    } else {
      const made = createProduct(db, admin, { name: c.name, category: c.category, price: c.price ?? undefined }, now);
      if (c.price && !c.active) updateProduct(db, admin, made.id, { active: false }, now);
    }
    count.chicken++;
  }

  for (const o of data.other ?? []) {
    let product = db.prepare('SELECT id FROM other_products WHERE name = ?').get(o.name);
    if (!product) product = createOtherProduct(db, admin, { name: o.name, kind: o.kind }, now);
    for (const opt of o.options ?? []) {
      let row = db.prepare('SELECT id FROM other_product_options WHERE product_id = ? AND unit = ?').get(product.id, opt.unit);
      if (!row) {
        createOption(db, admin, product.id, { unit: opt.unit }, now);
        row = db.prepare('SELECT id FROM other_product_options WHERE product_id = ? AND unit = ?').get(product.id, opt.unit);
      }
      if (opt.price) updateOption(db, admin, row.id, { price: opt.price, active: opt.active }, now);
    }
    if (o.active === false) db.prepare('UPDATE other_products SET active = 0 WHERE id = ?').run(product.id);
    count.other++;
  }

  // Setup files made before revision 19 carry the two family fees (Pour and Dress); they set the three services of each family.
  for (const f of data.fees ?? []) {
    updateFee(db, admin, f.code, { amount: f.amount, basis: f.basis }, now);
    count.fees++;
  }
  for (const x of data.services ?? []) {
    const have = db.prepare('SELECT code FROM services WHERE code = ?').get(x.code) ?? db.prepare('SELECT code FROM services WHERE label = ?').get(x.label);
    const fields = { label: x.label, note: x.note, fee_name: x.fee_name, active: x.active, ...(x.fee ? { fee: x.fee } : {}), basis: x.basis };
    if (have) updateService(db, admin, have.code, fields, now);
    else {
      const made = createService(db, admin, { label: x.label, note: x.note, kind: x.kind, cut: x.cut, fee: x.fee ?? '0', basis: x.basis, fee_name: x.fee_name }, now);
      if (x.active === false) updateService(db, admin, made.code, { active: false }, now);
    }
    count.services++;
  }

  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(ONCE, now.toISOString());
  return count;
}
