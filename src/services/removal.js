// Remove (Revision 21): take an other product, or a service someone added, off every list. Deactivating (hide, turn back on any time) is
// the existing active switch; Remove goes further and is meant for things the shop will never use again.
//
//   * Only a manager or the admin can remove; only the admin can restore.
//   * Chicken products and egg products are main products: they can be deactivated, never removed.
//   * The seven built-in services can be deactivated, never removed.
//   * An other product can be removed only while its Daily Inventory is empty (every unit at 0).
//   * A removed item is hidden everywhere and the admin can restore it for 7 days. After that it is gone for good: deleted when nothing
//     ever referred to it, otherwise kept out of sight for the old orders and renamed, so its name can be used again.
//   * Orders already sold are never touched: each line keeps its own name and price.
import { tx } from '../db.js';
import { HttpError } from '../http.js';
import { ROLE_RANK } from './users.js';
import { getInventory, prepareOpenDay } from './inventory.js';

export const RESTORE_DAYS = 7;
const DAY_MS = 86_400_000;

const TABLES = {
  other: { table: 'other_products', nameCol: 'name', label: 'Other product', key: 'id' },
  service: { table: 'services', nameCol: 'label', label: 'Service', key: 'code' },
  chicken: { table: 'products', nameCol: 'name', label: 'Chicken product', key: 'id' },
};
const isManager = (user) => ROLE_RANK[user.role] >= ROLE_RANK.manager;
const isAdmin = (user) => ROLE_RANK[user.role] >= ROLE_RANK.admin;
const spec = (kind) => {
  if (!TABLES[kind]) throw new HttpError(404, 'Unknown kind of item.', 'NOT_FOUND');
  return TABLES[kind];
};
const find = (db, kind, key) => {
  const t = spec(kind);
  const row = db.prepare(`SELECT * FROM ${t.table} WHERE ${t.key} = ?`).get(t.key === 'id' ? Number(key) : String(key));
  if (!row) throw new HttpError(404, 'Not found.', 'NOT_FOUND');
  return row;
};
const nameOf = (kind, row) => row[spec(kind).nameCol];

/** Why this item cannot be removed right now, or null when it can. */
export function whyNotRemovable(db, user, kind, row, now = new Date()) {
  if (kind === 'chicken') return 'Chicken products are main products. They can be deactivated, but not removed.';
  if (kind === 'service') return row.builtin ? 'Built-in services can be deactivated, but not removed.' : null;
  if (row.kind === 'EGGS') return 'Egg products are main products. They can be deactivated, but not removed.';
  const stock = getInventory(db, user, {}, now).other.filter((r) => r.product_name === row.name && r.new_total !== 0);
  if (stock.length) {
    const parts = stock.map((r) => `${r.new_total / 1000} ${r.unit}`).join(', ');
    return `${row.name} still has stock today (${parts}). Pull it out or sell it first, then try again.`;
  }
  return null;
}

/** What the Products screens need to know about an item before they offer Remove. */
export function removableInfo(db, user, kind, key, now = new Date()) {
  const row = find(db, kind, key);
  return { removable: whyNotRemovable(db, user, kind, row, now) === null, reason: whyNotRemovable(db, user, kind, row, now) };
}

export function removeItem(db, user, kind, key, now = new Date()) {
  if (!isManager(user)) throw new HttpError(403, 'Only a manager or the admin can remove items.', 'FORBIDDEN');
  prepareOpenDay(db, now, user);   // the stock check reads today's Daily Inventory; make sure it exists before the transaction starts
  return tx(db, () => {
    const row = find(db, kind, key);
    if (row.removed_at) throw new HttpError(409, `${nameOf(kind, row)} is already removed.`, 'BAD_STATUS');
    const why = whyNotRemovable(db, user, kind, row, now);
    if (why) throw new HttpError(409, why, 'NOT_REMOVABLE');
    const t = spec(kind);
    db.prepare(`UPDATE ${t.table} SET active = 0, removed_at = ?, removed_by = ?, updated_at = ? WHERE ${t.key} = ?`).run(now.toISOString(), user.id, now.toISOString(), row[t.key]);
    return { removed: nameOf(kind, row), restorable_until: new Date(now.getTime() + RESTORE_DAYS * DAY_MS).toISOString() };
  });
}

export function restoreItem(db, user, kind, key, now = new Date()) {
  if (!isAdmin(user)) throw new HttpError(403, 'Only the admin can restore a removed item.', 'FORBIDDEN');
  return tx(db, () => {
    const row = find(db, kind, key);
    const t = spec(kind);
    if (!row.removed_at) throw new HttpError(409, `${nameOf(kind, row)} is not removed.`, 'BAD_STATUS');
    if (row.purged || now.getTime() - new Date(row.removed_at).getTime() >= RESTORE_DAYS * DAY_MS) {
      throw new HttpError(409, `${nameOf(kind, row)} was removed more than ${RESTORE_DAYS} days ago and cannot be restored. Add it again instead.`, 'EXPIRED');
    }
    // It comes back switched off; Reactivate puts it on New order again.
    db.prepare(`UPDATE ${t.table} SET removed_at = NULL, removed_by = NULL, updated_at = ? WHERE ${t.key} = ?`).run(now.toISOString(), row[t.key]);
    return { restored: nameOf(kind, row) };
  });
}

/** The Removed list (admin): what can still be restored. */
export function listRemoved(db, now = new Date()) {
  const out = [];
  for (const kind of ['other', 'service']) {
    const t = TABLES[kind];
    for (const r of db.prepare(`SELECT x.*, u.display_name AS by_name FROM ${t.table} x LEFT JOIN users u ON u.id = x.removed_by WHERE x.removed_at IS NOT NULL AND x.purged = 0 ORDER BY x.removed_at DESC`).all()) {
      const left = RESTORE_DAYS * DAY_MS - (now.getTime() - new Date(r.removed_at).getTime());
      if (left <= 0) continue;   // waiting for the next clean-up
      out.push({ kind, key: r[t.key], name: r[t.nameCol], what: t.label, removed_at: r.removed_at, removed_by: r.by_name ?? null, days_left: Math.max(1, Math.ceil(left / DAY_MS)) });
    }
  }
  return out;
}

/**
 * Is anything in the records pointing at this item? Then it is only hidden for good, never deleted. An order line, a record on a closed day,
 * a record with any number on it, or an edit of one all count; an open-day record that only holds zeros does not (it is deleted with the item).
 */
function inUse(db, row) {
  if (db.prepare('SELECT 1 FROM order_other_items WHERE other_product_id = ? LIMIT 1').get(row.id)) return true;
  const options = db.prepare('SELECT id FROM other_product_options WHERE product_id = ?').all(row.id).map((o) => o.id);
  if (!options.length) return false;
  const marks = options.map(() => '?').join(',');
  const records = db.prepare(`SELECT r.*, d.status AS day_status FROM inventory_records r JOIN business_days d ON d.id = r.business_day_id WHERE r.option_id IN (${marks})`).all(...options);
  return records.some((r) => r.day_status !== 'OPEN' || r.beginning_milli || r.additional_milli || r.reject_milli || r.katay_milli || r.dead_milli || r.pull_out_milli || r.sold_milli
    || db.prepare('SELECT 1 FROM inventory_events WHERE record_id = ? LIMIT 1').get(r.id));
}

/**
 * Gone for good, for everything removed more than 7 days ago: deleted when nothing ever referred to it, otherwise marked purged and renamed
 * "(removed YYYY-MM-DD)" so the name is free again. Called when the app starts and every hour. Returns how many were handled.
 */
export function purgeExpired(db, now = new Date()) {
  const cutoff = new Date(now.getTime() - RESTORE_DAYS * DAY_MS).toISOString();
  let handled = 0;
  tx(db, () => {
    for (const kind of ['other', 'service']) {
      const t = TABLES[kind];
      for (const row of db.prepare(`SELECT * FROM ${t.table} WHERE removed_at IS NOT NULL AND purged = 0 AND removed_at <= ?`).all(cutoff)) {
        // A service is only ever hidden for good (a tiny row, and the app never deletes services); an other product is deleted when nothing used it.
        if (kind === 'service' || inUse(db, row)) {
          const base = `${row[t.nameCol]} (removed ${row.removed_at.slice(0, 10)})`;
          let name = base;
          for (let n = 2; db.prepare(`SELECT 1 FROM ${t.table} WHERE ${t.nameCol} = ?`).get(name); n += 1) name = `${base} ${n}`;
          db.prepare(`UPDATE ${t.table} SET ${t.nameCol} = ?, purged = 1 WHERE ${t.key} = ?`).run(name, row[t.key]);
        } else {
          const options = db.prepare('SELECT id FROM other_product_options WHERE product_id = ?').all(row.id).map((o) => o.id);
          for (const id of options) db.prepare('DELETE FROM inventory_records WHERE option_id = ?').run(id);   // only zero records of the open day are left (inUse said so)
          db.prepare('DELETE FROM other_product_options WHERE product_id = ?').run(row.id);
          db.prepare("DELETE FROM product_images WHERE kind = 'OTHER' AND item_id = ?").run(row.id);
          db.prepare('DELETE FROM other_products WHERE id = ?').run(row.id);
        }
        handled += 1;
      }
    }
  });
  return handled;
}
