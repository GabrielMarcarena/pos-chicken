// Ref stock (Revision 12): Katay and Dead chickens kept in the ref (refrigerator) for preservation, counted in heads.
//
//   heads in the ref = every head put in (ref_stock_entries, which a correction can take back out)
//                      - the heads on Katay / Dead lines of orders that count as a sale
//
// Heads sold are counted from the saved orders, like the Daily Inventory's Sold, so a canceled or replaced order puts its heads back by
// itself and a sale can never be counted twice. The ref is not a business day thing: what is in it stays in it when the day is closed.
//
// How heads get in (see inventory.js, which also changes the Daily Inventory in the same step):
//   * the Advanced button on the New order screen: "Store in the ref". The heads are also added to the chicken's Katay or Dead.
//   * the Daily Inventory: Katay or Dead is typed higher and the person says the chicken went into the ref. When the person says it did
//     not, only the Daily Inventory changes.
// Katay or Dead typed LOWER on the Daily Inventory takes back out of the ref the heads that came in from that row (never more).
import { COUNTS_AS_SALE, REF_KINDS, REF_LABELS } from '../../shared/constants.js';
import { toPhtDateTime } from '../time.js';

const MARKS = COUNTS_AS_SALE.map(() => '?').join(',');
const zero = () => Object.fromEntries(REF_KINDS.map((k) => [k, 0]));

/** Heads in the ref now, per kind: { KATAY: 3, DEAD: 1 }. */
export function refBalance(db) {
  const out = zero();
  for (const r of db.prepare('SELECT ref_kind AS k, SUM(heads) AS n FROM ref_stock_entries GROUP BY ref_kind').all()) out[r.k] += r.n;
  for (const r of db.prepare(`SELECT x.ref_kind AS k, SUM(x.heads) AS n FROM order_ref_items x JOIN orders o ON o.id = x.order_id
                              WHERE o.status IN (${MARKS}) GROUP BY x.ref_kind`).all(...COUNTS_AS_SALE)) out[r.k] -= r.n;
  return out;
}

/**
 * Revision 13: heads in the ref per kind AND per chicken product: { KATAY: { 1: 3, 3: 1 }, DEAD: { 2: 1 } } (product id -> heads). A sale
 * made before Revision 13 has no product; its heads come off the product with the most heads of that kind. Products with 0 are left out.
 */
export function refByProduct(db) {
  const out = Object.fromEntries(REF_KINDS.map((k) => [k, {}]));
  const add = (k, id, n) => { out[k][id] = (out[k][id] ?? 0) + n; };
  for (const r of db.prepare('SELECT ref_kind AS k, product_id AS id, SUM(heads) AS n FROM ref_stock_entries WHERE product_id IS NOT NULL GROUP BY 1, 2').all()) add(r.k, r.id, r.n);
  const unknown = Object.fromEntries(REF_KINDS.map((k) => [k, 0]));
  for (const r of db.prepare(`SELECT x.ref_kind AS k, x.product_id AS id, SUM(x.heads) AS n FROM order_ref_items x JOIN orders o ON o.id = x.order_id
                              WHERE o.status IN (${MARKS}) GROUP BY 1, 2`).all(...COUNTS_AS_SALE)) {
    if (r.id === null) unknown[r.k] += r.n; else add(r.k, r.id, -r.n);
  }
  for (const k of REF_KINDS) {
    for (let left = unknown[k]; left > 0;) {
      const [id, n] = Object.entries(out[k]).sort((a, b) => b[1] - a[1])[0] ?? [];
      if (!id || n <= 0) break;
      const take = Math.min(n, left);
      out[k][id] -= take;
      left -= take;
    }
    for (const id of Object.keys(out[k])) if (out[k][id] <= 0) delete out[k][id];
  }
  return out;
}

/** The key of one part of the ref: kind and chicken product ("KATAY:3"). A sale made before Revision 13 has "KATAY:null". */
export const refKey = (kind, productId) => `${kind}:${productId ?? null}`;

/** Heads an existing order holds from the ref, per kind and product (a Map keyed by refKey): free again for the order that replaces it. */
export function refHeldBy(db, orderId) {
  return new Map(db.prepare('SELECT ref_kind AS k, product_id AS id, SUM(heads) AS n FROM order_ref_items WHERE order_id = ? GROUP BY 1, 2').all(orderId)
    .map((r) => [refKey(r.k, r.id), r.n]));
}

/** Heads that came into the ref from one Daily Inventory row's Katay or Dead (after any corrections). */
export function refFromRecord(db, recordId, kind) {
  return db.prepare('SELECT COALESCE(SUM(heads), 0) AS n FROM ref_stock_entries WHERE record_id = ? AND ref_kind = ?').get(recordId, kind).n;
}

/** Write one ref entry. Call inside tx(). */
export function addRefEntry(db, e) {
  return Number(db.prepare(`INSERT INTO ref_stock_entries (ref_kind, heads, weight_g, source, product_id, record_id, inventory_event_id, business_day_id, user_id, created_at, note)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(e.kind, e.heads, e.weightG ?? null, e.source, e.productId ?? null, e.recordId ?? null,
    e.eventId ?? null, e.dayId, e.userId, e.now.toISOString(), e.note ?? null).lastInsertRowid);
}

const SOURCE_TEXT = { ADVANCED: 'Stored from New order (Advanced)', INVENTORY: 'Typed on the Daily Inventory', CORRECTION: 'Daily Inventory corrected' };

/** What the Advanced screen shows: the heads in each part of the ref, and the latest movements (in and out), newest first. */
export function refSummary(db, limit = 100) {
  const balance = refBalance(db);
  const ins = db.prepare(`SELECT e.created_at AS at, e.ref_kind AS kind, e.heads, e.weight_g, e.source, e.note, p.name AS product, u.display_name AS by_name
                          FROM ref_stock_entries e JOIN users u ON u.id = e.user_id LEFT JOIN products p ON p.id = e.product_id
                          ORDER BY e.id DESC LIMIT ?`).all(limit).map((r) => ({
    at: r.at, at_pht: toPhtDateTime(r.at), date: toPhtDateTime(r.at).slice(0, 10), kind: r.kind, heads: r.heads, weight_g: r.weight_g, what: SOURCE_TEXT[r.source], from: r.product ?? '', by: r.by_name, note: r.note ?? '',
  }));
  const outs = db.prepare(`SELECT o.submitted_at AS at, o.order_number, o.status, x.ref_kind AS kind, x.heads, x.weight_g, u.display_name AS by_name, p.name AS product
                           FROM order_ref_items x JOIN orders o ON o.id = x.order_id JOIN users u ON u.id = o.cashier_id LEFT JOIN products p ON p.id = x.product_id
                           ORDER BY x.id DESC LIMIT ?`).all(limit).map((r) => ({
    at: r.at, at_pht: toPhtDateTime(r.at), date: toPhtDateTime(r.at).slice(0, 10), kind: r.kind, heads: COUNTS_AS_SALE.includes(r.status) ? -r.heads : 0, weight_g: r.weight_g,
    what: COUNTS_AS_SALE.includes(r.status) ? `Sold on ${r.order_number}` : `${r.order_number} (${r.status.toLowerCase()}: back in the ref)`, from: r.product ?? '', by: r.by_name, note: '',
  }));
  const moves = [...ins, ...outs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
  const byProduct = refByProduct(db);
  const names = new Map(db.prepare('SELECT id, name FROM products').all().map((p) => [String(p.id), p.name]));
  return {
    kinds: REF_KINDS.map((k) => ({
      kind: k, name: REF_LABELS[k], heads: balance[k],
      // Revision 13: which chickens they are, e.g. [{ product_id: 1, product: 'B-Cull', heads: 2 }]
      products: Object.entries(byProduct[k]).map(([id, heads]) => ({ product_id: Number(id), product: names.get(id) ?? '', heads })),
    })),
    moves,
  };
}
