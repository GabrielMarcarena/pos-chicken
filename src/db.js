// SQLite storage (Node's built-in node:sqlite, no packages needed).
//
// The database repeats the business rules as constraints, so even a bug in the app or a hand-written
// query cannot save a conflicting preparation, change a submitted line, or delete a transaction.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toBusinessDate } from './time.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cashier','manager','admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  -- Set when an admin deletes an account that already appears in orders, payments or the audit trail. The row stays so
  -- that history keeps its names; the account can no longer sign in and is hidden from the Users list.
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Chicken products. A product is deactivated, never deleted, once it appears in a sale.
-- A manager can add a product without a price; it stays inactive until the admin sets one.
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  price_per_kg_centavos INTEGER NOT NULL DEFAULT 0 CHECK (price_per_kg_centavos >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (active = 0 OR price_per_kg_centavos > 0)
);

-- Other things the store sells (eggs, etag, garlic ...). A product can be sold in several ways, each with its own
-- price: a fixed price per piece, dozen, pack or batch, or a price per kg. Managers add products and options;
-- only the admin sets prices. An option without a price stays inactive.
CREATE TABLE IF NOT EXISTS other_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS other_product_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES other_products(id),
  unit TEXT NOT NULL COLLATE NOCASE,
  sold_by TEXT NOT NULL CHECK (sold_by IN ('FIXED','PER_KG')),
  price_centavos INTEGER NOT NULL DEFAULT 0 CHECK (price_centavos >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (product_id, unit),
  CHECK (sold_by <> 'PER_KG' OR unit = 'kg'),
  CHECK (active = 0 OR price_centavos > 0)
);

-- Paid preparation services (amounts are set by the admin; they start at 0).
CREATE TABLE IF NOT EXISTS service_fees (
  code TEXT PRIMARY KEY CHECK (code IN ('POUR','NOT_POUR','DARA','DUKOT')),
  amount_centavos INTEGER NOT NULL DEFAULT 0 CHECK (amount_centavos >= 0),
  basis TEXT NOT NULL DEFAULT 'per_item' CHECK (basis IN ('per_item','per_head','per_kg')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('CHICKEN_PRICE','SERVICE_FEE','OTHER_PRICE')),
  subject TEXT NOT NULL,
  subject_name TEXT NOT NULL,
  old_value INTEGER,
  new_value INTEGER NOT NULL,
  old_basis TEXT,
  new_basis TEXT,
  changed_by INTEGER NOT NULL REFERENCES users(id),
  changed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_counters (
  business_date TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT NOT NULL UNIQUE,
  business_date TEXT NOT NULL,
  customer_number TEXT NOT NULL DEFAULT 'WALK-IN',
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','CANCELED','REFUNDED','PARTIALLY_REFUNDED','REPLACED')),
  -- total_centavos is what the customer pays: the subtotal of all lines minus any discount.
  subtotal_centavos INTEGER NOT NULL CHECK (subtotal_centavos >= 0),
  discount_type TEXT NOT NULL DEFAULT 'NONE' CHECK (discount_type IN ('NONE','FIXED','PERCENT')),
  discount_value INTEGER NOT NULL DEFAULT 0 CHECK (discount_value >= 0),   -- centavos for FIXED, basis points for PERCENT
  discount_centavos INTEGER NOT NULL DEFAULT 0 CHECK (discount_centavos >= 0),
  discount_reason TEXT,
  discount_note TEXT,
  total_centavos INTEGER NOT NULL CHECK (total_centavos >= 0),
  refund_centavos INTEGER NOT NULL DEFAULT 0 CHECK (refund_centavos >= 0 AND refund_centavos <= total_centavos),
  cashier_id INTEGER NOT NULL REFERENCES users(id),
  submitted_at TEXT NOT NULL,
  submission_key TEXT NOT NULL UNIQUE,
  replaces_order_id INTEGER REFERENCES orders(id),
  replaced_by_order_id INTEGER REFERENCES orders(id),
  -- Order List (Kanban): where the order is on its way to the customer. New orders start as ONGOING.
  fulfillment_status TEXT NOT NULL DEFAULT 'ONGOING' CHECK (fulfillment_status IN ('ONGOING','STANDBY','COMPLETE')),
  -- Order List: a flag staff set to find an order again. Not part of the sale, so it may change after submission.
  bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0,1)),
  CHECK (total_centavos = subtotal_centavos - discount_centavos),
  CHECK ((discount_type = 'NONE') = (discount_centavos = 0))
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(business_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON orders(fulfillment_status);

-- One row per chicken line. Preparation is saved on the line, not on the whole order.
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  price_per_kg_centavos INTEGER NOT NULL CHECK (price_per_kg_centavos > 0),
  weight_g INTEGER NOT NULL CHECK (weight_g > 0),                       -- the combined weight of all the heads on this line
  heads INTEGER NOT NULL DEFAULT 1 CHECK (heads >= 1 AND heads <= 999), -- number of chickens (heads) weighed together
  weight_amount_centavos INTEGER NOT NULL CHECK (weight_amount_centavos >= 0),
  feather_prep TEXT NOT NULL CHECK (feather_prep IN ('LIVE','POUR','NOT_POUR')),  -- LIVE, Po-ur & Slice, Dressed & Slice
  dara INTEGER NOT NULL DEFAULT 0 CHECK (dara IN (0,1)),
  cut_method TEXT NOT NULL DEFAULT 'NONE' CHECK (cut_method IN ('NONE','SLICE','DUKOT')),
  slice_size TEXT CHECK (slice_size IS NULL OR slice_size IN ('SMALL','MEDIUM','LARGE')),
  fee_detail TEXT NOT NULL DEFAULT '[]',
  service_fee_centavos INTEGER NOT NULL DEFAULT 0 CHECK (service_fee_centavos >= 0),
  line_total_centavos INTEGER NOT NULL CHECK (line_total_centavos >= 0),
  UNIQUE (order_id, line_no),
  -- A slice size exists if and only if the cutting method is Slice.
  CHECK ((cut_method = 'SLICE') = (slice_size IS NOT NULL)),
  -- A live chicken has no Dara, no cutting and no fees. Po-ur and Dressed always have a cutting choice (a slice size or Dukot).
  CHECK ((feather_prep = 'LIVE' AND dara = 0 AND cut_method = 'NONE' AND service_fee_centavos = 0)
      OR (feather_prep <> 'LIVE' AND cut_method <> 'NONE')),
  CHECK (line_total_centavos = weight_amount_centavos + service_fee_centavos)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_other_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  other_product_id INTEGER NOT NULL REFERENCES other_products(id),
  option_id INTEGER NOT NULL REFERENCES other_product_options(id),
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  sold_by TEXT NOT NULL CHECK (sold_by IN ('FIXED','PER_KG')),
  unit_price_centavos INTEGER NOT NULL CHECK (unit_price_centavos > 0),
  quantity_milli INTEGER NOT NULL CHECK (quantity_milli > 0),
  line_total_centavos INTEGER NOT NULL CHECK (line_total_centavos >= 0),
  UNIQUE (order_id, line_no),
  CHECK (sold_by = 'PER_KG' OR quantity_milli % 1000 = 0)  -- pieces, dozens, packs and batches are whole numbers
);
CREATE INDEX IF NOT EXISTS idx_other_items_order ON order_other_items(order_id);

-- Payment details are typed in by the cashier. The app never talks to GCash, Maya or a bank.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL CHECK (method IN ('CASH','GCASH','MAYA','BANK','OTHER')),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  paid_at TEXT,
  account_name TEXT,
  account_number TEXT,
  reference TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);

-- Audit trail: every submit, cancel, change, refund and Order List move.
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  action_type TEXT NOT NULL CHECK (action_type IN ('SUBMIT','CANCEL','CHANGE','REFUND','MOVE')),
  reason_code TEXT,
  reason_note TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  refund_centavos INTEGER,
  stock_returnable INTEGER CHECK (stock_returnable IS NULL OR stock_returnable IN (0,1)),
  related_order_id INTEGER REFERENCES orders(id),
  snapshot_before TEXT,
  snapshot_after TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);

-- Submitted records are append-only.
CREATE TRIGGER IF NOT EXISTS order_items_no_update BEFORE UPDATE ON order_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS order_items_no_delete BEFORE DELETE ON order_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS order_other_items_no_update BEFORE UPDATE ON order_other_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS order_other_items_no_delete BEFORE DELETE ON order_other_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'payment records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payment records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON order_events
BEGIN SELECT RAISE(ABORT, 'audit records cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON order_events
BEGIN SELECT RAISE(ABORT, 'audit records cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted'); END;
-- Only status, refund amount and the replaced-by link may ever change on an order.
CREATE TRIGGER IF NOT EXISTS orders_immutable_fields
BEFORE UPDATE OF order_number, business_date, customer_number, subtotal_centavos, discount_type, discount_value, discount_centavos, discount_reason, discount_note, total_centavos, cashier_id, submitted_at, submission_key, replaces_order_id ON orders
BEGIN SELECT RAISE(ABORT, 'order details cannot be changed after submission'); END;
CREATE TRIGGER IF NOT EXISTS orders_status_guard BEFORE UPDATE OF status ON orders
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'COMPLETED' OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status = 'REFUNDED'))
BEGIN SELECT RAISE(ABORT, 'this order can no longer change status'); END;
`;

const SCHEMA_VERSION = 6;

/** One safety copy of the file per start, taken just before the first upgrade step runs. */
function makeBackup(db, file) {
  let done = false;
  return (label) => {
    if (done || file === ':memory:') return;
    done = true;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
    const copy = `${file}.before-${label}-${stamp}.bak`;
    db.prepare('VACUUM INTO ?').run(path.resolve(copy));
    console.log(`Upgrading the database. A safety copy was saved as ${copy}`);
  };
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

/** Run the steps of one upgrade in a single transaction and stamp the new version; on any error nothing changes. */
function upgrade(db, version, steps) {
  db.exec('BEGIN');
  try {
    steps();
    db.exec(`PRAGMA user_version = ${version}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Version 2 -> 3 (Number of Heads): add the heads column to chicken lines (existing lines count as 1 head) and let a
 * service fee be charged "per head". Nothing is deleted or rewritten.
 */
function migrateTo3(db, backup) {
  backup('v3');
  upgrade(db, 3, () => {
    if (!hasColumn(db, 'order_items', 'heads')) {
      db.exec('ALTER TABLE order_items ADD COLUMN heads INTEGER NOT NULL DEFAULT 1 CHECK (heads >= 1 AND heads <= 999)');
    }
    db.exec(`
      CREATE TABLE service_fees_new (
        code TEXT PRIMARY KEY CHECK (code IN ('POUR','NOT_POUR','DARA','DUKOT')),
        amount_centavos INTEGER NOT NULL DEFAULT 0 CHECK (amount_centavos >= 0),
        basis TEXT NOT NULL DEFAULT 'per_item' CHECK (basis IN ('per_item','per_head','per_kg')),
        updated_at TEXT NOT NULL
      );
      INSERT INTO service_fees_new (code, amount_centavos, basis, updated_at) SELECT code, amount_centavos, basis, updated_at FROM service_fees;
      DROP TABLE service_fees;
      ALTER TABLE service_fees_new RENAME TO service_fees;`);
  });
}

/**
 * Version 3 -> 4: service fees are charged per head. Any fee still set to "per line (flat)" is switched to "per head"
 * (3 heads at ₱25 = ₱75). Amounts are not touched, saved orders are not touched, and each switch is written to the
 * price history. The admin can change a fee back in Products > Service fees.
 */
function migrateTo4(db, backup) {
  backup('v4');
  upgrade(db, 4, () => {
    const now = new Date().toISOString();
    const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
    for (const fee of db.prepare("SELECT code, amount_centavos FROM service_fees WHERE basis = 'per_item'").all()) {
      db.prepare("UPDATE service_fees SET basis = 'per_head', updated_at = ? WHERE code = ?").run(now, fee.code);
      if (admin) {
        db.prepare(`INSERT INTO price_history (kind, subject, subject_name, old_value, new_value, old_basis, new_basis, changed_by, changed_at)
                    VALUES ('SERVICE_FEE', ?, ?, ?, ?, 'per_item', 'per_head', ?, ?)`).run(fee.code, fee.code, fee.amount_centavos, fee.amount_centavos, admin.id, now);
      }
    }
  });
}

/**
 * Version 4 -> 5 (Order List board): every order gets a pickup status (fulfillment_status). One new column on the
 * existing orders table, no new table. Orders from before today are the shop's history, so they are marked COMPLETE
 * (already claimed); today's orders start as ONGOING. The audit table is rebuilt only to allow the new MOVE action
 * type, and every audit row is copied across unchanged (the rebuild never fires the "no delete" trigger because
 * SQLite does not run triggers for the implicit delete inside DROP TABLE; the tests prove the rows are identical).
 */
function migrateTo5(db, backup) {
  backup('v5');
  upgrade(db, 5, () => {
    if (!hasColumn(db, 'orders', 'fulfillment_status')) {
      db.exec("ALTER TABLE orders ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'ONGOING' CHECK (fulfillment_status IN ('ONGOING','STANDBY','COMPLETE'))");
      db.prepare("UPDATE orders SET fulfillment_status = 'COMPLETE' WHERE business_date < ?").run(toBusinessDate(new Date()));
    }
    const events = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_events'").get()?.sql ?? '';
    if (!events.includes("'MOVE'")) {
      db.exec(`
        CREATE TABLE order_events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL REFERENCES orders(id),
          action_type TEXT NOT NULL CHECK (action_type IN ('SUBMIT','CANCEL','CHANGE','REFUND','MOVE')),
          reason_code TEXT,
          reason_note TEXT,
          user_id INTEGER NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          refund_centavos INTEGER,
          stock_returnable INTEGER CHECK (stock_returnable IS NULL OR stock_returnable IN (0,1)),
          related_order_id INTEGER REFERENCES orders(id),
          snapshot_before TEXT,
          snapshot_after TEXT
        );
        INSERT INTO order_events_new (id, order_id, action_type, reason_code, reason_note, user_id, created_at, refund_centavos, stock_returnable, related_order_id, snapshot_before, snapshot_after)
          SELECT id, order_id, action_type, reason_code, reason_note, user_id, created_at, refund_centavos, stock_returnable, related_order_id, snapshot_before, snapshot_after FROM order_events;
        DROP TABLE order_events;
        ALTER TABLE order_events_new RENAME TO order_events;`);
    }
  });
}

/**
 * Version 5 -> 6 (bookmarks and Delete Account): two small nullable/defaulted columns, nothing rewritten or removed.
 *   orders.bookmarked  0 for every existing order (a flag staff can switch on from the Order List)
 *   users.deleted_at   empty for every existing account (set only when an admin deletes an account that has history)
 * Neither column is part of the protected order fields, so the "orders cannot be changed" safeguards are untouched.
 */
function migrateTo6(db, backup) {
  backup('v6');
  upgrade(db, 6, () => {
    if (!hasColumn(db, 'users', 'deleted_at')) db.exec('ALTER TABLE users ADD COLUMN deleted_at TEXT');
    if (!hasColumn(db, 'orders', 'bookmarked')) {
      db.exec('ALTER TABLE orders ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0 CHECK (bookmarked IN (0,1))');
    }
  });
}

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const hasTables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().n > 0;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (hasTables && version < 2) {
    // Version 1 had a different services layout that cannot be carried over automatically.
    db.close();
    throw new Error(`The database file "${file}" was made by the first version of this app and cannot be opened by this one. `
      + 'If it only holds test orders, move it away and start again. If it holds real orders, ask for a migration first; do not delete it.');
  }
  if (hasTables && version < SCHEMA_VERSION) {
    const backup = makeBackup(db, file);
    if (version === 2) migrateTo3(db, backup);
    if (version < 4) migrateTo4(db, backup);
    if (version < 5) migrateTo5(db, backup);
    migrateTo6(db, backup);
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  const now = new Date().toISOString();
  // New installs charge every service per head (3 heads x the fee). The admin can change this per service.
  const seed = db.prepare('INSERT OR IGNORE INTO service_fees (code, amount_centavos, basis, updated_at) VALUES (?, 0, ?, ?)');
  for (const code of ['POUR', 'NOT_POUR', 'DARA', 'DUKOT']) seed.run(code, 'per_head', now);
  return db;
}

/** Run fn inside one write transaction: everything is saved, or nothing is. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}
