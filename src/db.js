// SQLite storage (Node's built-in node:sqlite, no packages needed).
//
// The database repeats the business rules as constraints, so even a bug in the app or a hand-written
// query cannot save a conflicting preparation, change a submitted line, or delete a transaction.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { toBusinessDate } from './time.js';
import { UNITS } from '../shared/constants.js';

// Business days and the Daily Inventory. These tables are created both for a new install (below) and by the upgrade to version 7.
//
//   business_days     one row per business day. At most ONE is OPEN: new orders belong to it. Closing a day is final.
//   inventory_records one row per product (chicken) or selling option (other products) per business day: the numbers that are
//                     typed in or carried forward. "Sold" is NOT typed in: it is counted from the day's saved orders while the day
//                     is open, and frozen into sold_milli when the day is closed. All stock figures are thousandths (77 heads = 77000).
//   inventory_events  who changed which number, from what to what. Append-only.
// Revision 11 (version 9) adds Katay (katay_milli), a chicken inventory loss between Reject and Dead.

// The inventory history table. A function because the upgrade to version 9 rebuilds it to allow the new "katay" field.
const inventoryEventsTable = (name, ifNotExists = false) => `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL REFERENCES inventory_records(id),
  field TEXT NOT NULL CHECK (field IN ('beginning','additional','reject','katay','dead','pull_out')),
  old_milli INTEGER NOT NULL,
  new_milli INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  note TEXT,
  -- Why a number was corrected (version 8). Required by the app when a Beginning Balance is changed; empty for the other events.
  reason_code TEXT,
  reason_note TEXT
)`;

const INVENTORY_TABLES = `
CREATE TABLE IF NOT EXISTS business_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL UNIQUE CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_at TEXT NOT NULL,
  opened_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_business_day ON business_days(status) WHERE status = 'OPEN';

CREATE TABLE IF NOT EXISTS inventory_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_day_id INTEGER NOT NULL REFERENCES business_days(id),
  kind TEXT NOT NULL CHECK (kind IN ('CHICKEN','OTHER')),
  product_id INTEGER REFERENCES products(id),               -- chicken (counted in heads)
  option_id INTEGER REFERENCES other_product_options(id),   -- other products: one row per way of selling (Eggs per piece, per dozen ...)
  beginning_milli INTEGER NOT NULL DEFAULT 0 CHECK (beginning_milli >= 0),
  additional_milli INTEGER NOT NULL DEFAULT 0 CHECK (additional_milli >= 0),
  reject_milli INTEGER NOT NULL DEFAULT 0 CHECK (reject_milli >= 0),
  dead_milli INTEGER NOT NULL DEFAULT 0 CHECK (dead_milli >= 0),
  pull_out_milli INTEGER NOT NULL DEFAULT 0 CHECK (pull_out_milli >= 0),
  sold_milli INTEGER CHECK (sold_milli IS NULL OR sold_milli >= 0),   -- empty while the day is open, frozen when it is closed
  beginning_carried INTEGER NOT NULL DEFAULT 0 CHECK (beginning_carried IN (0,1)),   -- 1: the Beginning Balance came from the previous day
  rev INTEGER NOT NULL DEFAULT 0,                            -- bumped on every change, so two people cannot overwrite each other unseen
  updated_at TEXT NOT NULL,
  -- Katay (version 9): chicken only, whole heads. Added last so the upgrade can add it as a column.
  katay_milli INTEGER NOT NULL DEFAULT 0 CHECK (katay_milli >= 0 AND katay_milli % 1000 = 0),
  CHECK ((kind = 'CHICKEN' AND product_id IS NOT NULL AND option_id IS NULL) OR (kind = 'OTHER' AND option_id IS NOT NULL AND product_id IS NULL)),
  CHECK (kind = 'OTHER' OR (beginning_milli % 1000 = 0 AND additional_milli % 1000 = 0 AND reject_milli % 1000 = 0 AND dead_milli % 1000 = 0 AND pull_out_milli % 1000 = 0 AND (sold_milli IS NULL OR sold_milli % 1000 = 0))),
  CHECK (kind = 'CHICKEN' OR (reject_milli = 0 AND dead_milli = 0 AND pull_out_milli = 0 AND katay_milli = 0)),   -- other products have no Reject, Katay, Dead or Pull Out
  UNIQUE (business_day_id, product_id),
  UNIQUE (business_day_id, option_id)
);

${inventoryEventsTable('inventory_events', true)};
CREATE INDEX IF NOT EXISTS idx_inventory_events_record ON inventory_events(record_id);

-- A closed business day is history: it cannot be reopened, edited or deleted, and neither can its numbers.
CREATE TRIGGER IF NOT EXISTS business_days_closed_final BEFORE UPDATE ON business_days
WHEN OLD.status = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'a closed business day cannot be changed or reopened'); END;
CREATE TRIGGER IF NOT EXISTS business_days_no_delete BEFORE DELETE ON business_days
WHEN OLD.status = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'a closed business day cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS business_days_date_fixed BEFORE UPDATE OF business_date ON business_days
BEGIN SELECT RAISE(ABORT, 'the date of a business day cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS inventory_records_closed_no_update BEFORE UPDATE ON inventory_records
WHEN (SELECT status FROM business_days WHERE id = OLD.business_day_id) = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'the inventory of a closed business day cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS inventory_records_closed_no_delete BEFORE DELETE ON inventory_records
WHEN (SELECT status FROM business_days WHERE id = OLD.business_day_id) = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'the inventory of a closed business day cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS inventory_records_identity BEFORE UPDATE OF business_day_id, kind, product_id, option_id ON inventory_records
BEGIN SELECT RAISE(ABORT, 'an inventory record cannot be moved to another day or product'); END;
CREATE TRIGGER IF NOT EXISTS inventory_records_open_day_only BEFORE INSERT ON inventory_records
WHEN (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'inventory can only be added to the open business day'); END;
CREATE TRIGGER IF NOT EXISTS inventory_events_no_update BEFORE UPDATE ON inventory_events
BEGIN SELECT RAISE(ABORT, 'inventory history cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS inventory_events_no_delete BEFORE DELETE ON inventory_events
BEGIN SELECT RAISE(ABORT, 'inventory history cannot be deleted'); END;
`;

// The chicken lines of an order. Written as a function because the same layout is used by a new install and by the upgrade to
// version 8, which rebuilds the table to relax one rule: a Pour or Dress line no longer has to be cut (plain Pour / Dress = whole chicken).
const orderItemsTable = (name, ifNotExists = false) => `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  product_id INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  price_per_kg_centavos INTEGER NOT NULL CHECK (price_per_kg_centavos > 0),
  weight_g INTEGER NOT NULL CHECK (weight_g > 0),                       -- the combined weight of all the heads on this line
  heads INTEGER NOT NULL DEFAULT 1 CHECK (heads >= 1 AND heads <= 999), -- number of chickens (heads) weighed together
  weight_amount_centavos INTEGER NOT NULL CHECK (weight_amount_centavos >= 0),
  feather_prep TEXT NOT NULL CHECK (feather_prep IN ('LIVE','POUR','NOT_POUR')),  -- Live, Pour (burned), Dress (dressed)
  dara INTEGER NOT NULL DEFAULT 0 CHECK (dara IN (0,1)),                -- "With Blood"
  cut_method TEXT NOT NULL DEFAULT 'NONE' CHECK (cut_method IN ('NONE','SLICE','DUKOT')),
  slice_size TEXT CHECK (slice_size IS NULL OR slice_size IN ('SMALL','MEDIUM','LARGE')),
  fee_detail TEXT NOT NULL DEFAULT '[]',
  service_fee_centavos INTEGER NOT NULL DEFAULT 0 CHECK (service_fee_centavos >= 0),
  line_total_centavos INTEGER NOT NULL CHECK (line_total_centavos >= 0),
  UNIQUE (order_id, line_no),
  -- A slice size exists if and only if the cutting method is Slice.
  CHECK ((cut_method = 'SLICE') = (slice_size IS NOT NULL)),
  -- A live chicken has no With Blood, no cutting and no fees. Pour and Dress may be whole (no cutting), sliced or Dukot.
  CHECK (feather_prep <> 'LIVE' OR (dara = 0 AND cut_method = 'NONE' AND service_fee_centavos = 0)),
  CHECK (line_total_centavos = weight_amount_centavos + service_fee_centavos)
)`;

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
  -- Which block of the paper Daily Sales Report the product is reported in (version 9). Set on the Products screen.
  category TEXT NOT NULL DEFAULT 'OTHER' CHECK (category IN ('BCULL','CULL','BROILER','OTHER')),
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
  updated_at TEXT NOT NULL,
  -- EGGS are counted in piece, carton and tray; every other product in piece, pack, sack and kg (version 8).
  kind TEXT NOT NULL DEFAULT 'OTHER' CHECK (kind IN ('EGGS','OTHER'))
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
  -- The business day (Daily Inventory) this order was sold on. Not the same as business_date, which is the calendar date used in the
  -- order number. Fixed when the order is saved.
  business_day_id INTEGER REFERENCES business_days(id),
  CHECK (total_centavos = subtotal_centavos - discount_centavos),
  CHECK ((discount_type = 'NONE') = (discount_centavos = 0))
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(business_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON orders(fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orders_day ON orders(business_day_id);

-- One row per chicken line. Preparation is saved on the line, not on the whole order.
${orderItemsTable('order_items', true)};
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
  -- Version 9: how many pieces were weighed on a per-kg line (the stock is counted in pieces). Empty for fixed-price lines and
  -- for per-kg lines saved before version 9.
  pieces INTEGER CHECK (pieces IS NULL OR (pieces >= 1 AND pieces <= 999)),
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
  recorded_at TEXT NOT NULL,
  -- Cash only: the money the customer handed over and the change given back (tendered - amount). Empty for the other methods.
  received_centavos INTEGER CHECK (received_centavos IS NULL OR received_centavos > 0),
  change_centavos INTEGER CHECK (change_centavos IS NULL OR change_centavos >= 0)
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
BEFORE UPDATE OF order_number, business_date, business_day_id, customer_number, subtotal_centavos, discount_type, discount_value, discount_centavos, discount_reason, discount_note, total_centavos, cashier_id, submitted_at, submission_key, replaces_order_id ON orders
BEGIN SELECT RAISE(ABORT, 'order details cannot be changed after submission'); END;
CREATE TRIGGER IF NOT EXISTS orders_status_guard BEFORE UPDATE OF status ON orders
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'COMPLETED' OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status = 'REFUNDED'))
BEGIN SELECT RAISE(ABORT, 'this order can no longer change status'); END;
-- A new order can only be placed on the open business day.
CREATE TRIGGER IF NOT EXISTS orders_open_day_only BEFORE INSERT ON orders
WHEN NEW.business_day_id IS NOT NULL AND (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'orders can only be placed on the open business day'); END;
-- Cash received and change must add up: change = received - amount paid, and only cash has them.
CREATE TRIGGER IF NOT EXISTS payments_cash_received_check BEFORE INSERT ON payments
WHEN (NEW.received_centavos IS NULL) <> (NEW.change_centavos IS NULL)
  OR (NEW.received_centavos IS NOT NULL AND (NEW.method <> 'CASH' OR NEW.received_centavos - NEW.amount_centavos <> NEW.change_centavos))
BEGIN SELECT RAISE(ABORT, 'cash received and change do not add up'); END;
` + INVENTORY_TABLES + `
-- Revision 11 (version 9) ------------------------------------------------------------------------------------------------

-- "Submit Inventory Today": every submitted inventory file, the numbers it holds and where it was saved. Closing a day needs a
-- submission whose numbers are still the day's numbers. Append-only, like the rest of the history.
CREATE TABLE IF NOT EXISTS inventory_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_day_id INTEGER NOT NULL REFERENCES business_days(id),
  submitted_at TEXT NOT NULL,
  submitted_by INTEGER NOT NULL REFERENCES users(id),
  file_name TEXT NOT NULL,                -- inside the inventory folder (backups/inventory by default)
  file_sha256 TEXT NOT NULL,              -- the saved file is checked against this before it is handed out or a day is closed
  fingerprint TEXT NOT NULL,              -- every number of the day at the moment of submission; closing compares it with the numbers now
  snapshot TEXT NOT NULL                  -- the submitted rows, as JSON
);
CREATE INDEX IF NOT EXISTS idx_inventory_submissions_day ON inventory_submissions(business_day_id);
CREATE TRIGGER IF NOT EXISTS inventory_submissions_no_update BEFORE UPDATE ON inventory_submissions
BEGIN SELECT RAISE(ABORT, 'a submitted inventory cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS inventory_submissions_no_delete BEFORE DELETE ON inventory_submissions
BEGIN SELECT RAISE(ABORT, 'a submitted inventory cannot be deleted'); END;

-- One picture per product for the New order cards. Kept in the database so a backup copies it too.
CREATE TABLE IF NOT EXISTS product_images (
  kind TEXT NOT NULL CHECK (kind IN ('CHICKEN','OTHER')),
  item_id INTEGER NOT NULL,
  mime TEXT NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  data BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);

-- Small one-time markers (for example: the Revision 11 products were added once).
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Revision 12 (version 10) ------------------------------------------------------------------------------------------------

-- Ref stock: Katay and Dead chickens kept in the ref (refrigerator). Every head put in (or taken back out by a correction) is one row;
-- heads sold are counted from the saved orders (order_ref_items), so a canceled sale puts them back by itself.
--   heads in the ref = SUM(ref_stock_entries.heads) - heads on order_ref_items of orders that count as a sale
--   source ADVANCED    put in from the New order screen (Advanced); it also added the heads to the chicken's Katay or Dead
--   source INVENTORY   Katay or Dead typed on the Daily Inventory, and the person said they went into the ref
--   source CORRECTION  Katay or Dead lowered on the Daily Inventory: heads that came into the ref from that row go back out (negative)
CREATE TABLE IF NOT EXISTS ref_stock_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('KATAY','DEAD')),
  heads INTEGER NOT NULL CHECK (heads <> 0 AND heads BETWEEN -999999 AND 999999),
  weight_g INTEGER CHECK (weight_g IS NULL OR weight_g > 0),
  source TEXT NOT NULL CHECK (source IN ('ADVANCED','INVENTORY','CORRECTION')),
  product_id INTEGER REFERENCES products(id),               -- the chicken product it came from
  record_id INTEGER REFERENCES inventory_records(id),       -- the Daily Inventory row whose Katay or Dead it is part of
  inventory_event_id INTEGER REFERENCES inventory_events(id),
  business_day_id INTEGER NOT NULL REFERENCES business_days(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_ref_entries_record ON ref_stock_entries(record_id);
CREATE TRIGGER IF NOT EXISTS ref_stock_entries_no_update BEFORE UPDATE ON ref_stock_entries
BEGIN SELECT RAISE(ABORT, 'ref stock history cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS ref_stock_entries_no_delete BEFORE DELETE ON ref_stock_entries
BEGIN SELECT RAISE(ABORT, 'ref stock history cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS ref_stock_entries_open_day_only BEFORE INSERT ON ref_stock_entries
WHEN (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'ref stock can only change on the open business day'); END;

-- A Katay or Dead chicken sold from the ref: heads, their combined weight and the price per kg the cashier typed. No service fee.
CREATE TABLE IF NOT EXISTS order_ref_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  line_no INTEGER NOT NULL CHECK (line_no >= 1),
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('KATAY','DEAD')),
  product_name TEXT NOT NULL,
  product_id INTEGER REFERENCES products(id),               -- Revision 13: the chicken it came from (B-Cull, Cull, Broiler ...); NULL on older sales
  heads INTEGER NOT NULL CHECK (heads >= 1 AND heads <= 999),
  weight_g INTEGER NOT NULL CHECK (weight_g > 0),
  price_per_kg_centavos INTEGER NOT NULL CHECK (price_per_kg_centavos > 0),
  line_total_centavos INTEGER NOT NULL CHECK (line_total_centavos >= 0),
  UNIQUE (order_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_ref_items_order ON order_ref_items(order_id);
CREATE TRIGGER IF NOT EXISTS order_ref_items_no_update BEFORE UPDATE ON order_ref_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS order_ref_items_no_delete BEFORE DELETE ON order_ref_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be deleted'); END;

-- Cash breakdown: the bills and coins counted for a business day. Saving again adds a new row; the latest one is the count.
CREATE TABLE IF NOT EXISTS cash_counts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_day_id INTEGER NOT NULL REFERENCES business_days(id),
  counts TEXT NOT NULL,                                       -- JSON: { "1000": 3, "500": 2, ..., "0.25": 8 } (pieces of each)
  total_centavos INTEGER NOT NULL CHECK (total_centavos >= 0),
  counted_by INTEGER NOT NULL REFERENCES users(id),
  counted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_counts_day ON cash_counts(business_day_id);
CREATE TRIGGER IF NOT EXISTS cash_counts_no_update BEFORE UPDATE ON cash_counts
BEGIN SELECT RAISE(ABORT, 'a saved cash count cannot be changed; save a new count'); END;
CREATE TRIGGER IF NOT EXISTS cash_counts_no_delete BEFORE DELETE ON cash_counts
BEGIN SELECT RAISE(ABORT, 'a saved cash count cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS cash_counts_open_day_only BEFORE INSERT ON cash_counts
WHEN (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'cash can only be counted on the open business day'); END;

-- Expenses paid during a business day (Coke 75, Bread 35 ...). A mistake is removed, not deleted: the row stays with who removed it and why.
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_day_id INTEGER NOT NULL REFERENCES business_days(id),
  item TEXT NOT NULL CHECK (length(item) BETWEEN 1 AND 80),
  amount_centavos INTEGER NOT NULL CHECK (amount_centavos > 0),
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  removed_at TEXT,
  removed_by INTEGER REFERENCES users(id),
  remove_note TEXT,
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_expenses_day ON expenses(business_day_id);
CREATE TRIGGER IF NOT EXISTS expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'an expense cannot be deleted; remove it instead'); END;
CREATE TRIGGER IF NOT EXISTS expenses_open_day_only BEFORE INSERT ON expenses
WHEN (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'expenses can only be added to the open business day'); END;
-- The only change ever allowed: marking an expense of the open day as removed, once.
CREATE TRIGGER IF NOT EXISTS expenses_remove_only BEFORE UPDATE ON expenses
WHEN OLD.removed_at IS NOT NULL OR NEW.removed_at IS NULL
  OR NEW.business_day_id <> OLD.business_day_id OR NEW.item <> OLD.item OR NEW.amount_centavos <> OLD.amount_centavos
  OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at
  OR (SELECT status FROM business_days WHERE id = OLD.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'an expense can only be removed, once, while its business day is open'); END;

-- Revision 13 (version 11) ------------------------------------------------------------------------------------------------

-- "Save" on the Daily Inventory: one row per business day with that day's numbers. Saving again replaces the row. At midnight the
-- day is saved one last time (how = 'AUTO_CLOSE', saved_by NULL) and closed; from then on the row is frozen with the day.
CREATE TABLE IF NOT EXISTS inventory_saves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_day_id INTEGER NOT NULL UNIQUE REFERENCES business_days(id),
  saved_at TEXT NOT NULL,
  saved_by INTEGER REFERENCES users(id),                    -- NULL: saved by the app itself when the day closed at midnight
  how TEXT NOT NULL CHECK (how IN ('MANUAL','AUTO_CLOSE')),
  fingerprint TEXT NOT NULL,                                -- every number of the day when it was saved
  snapshot TEXT NOT NULL                                    -- the saved rows and Beginning Balance edits, as JSON
);
CREATE TRIGGER IF NOT EXISTS inventory_saves_open_day_insert BEFORE INSERT ON inventory_saves
WHEN (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'only the open business day can be saved'); END;
CREATE TRIGGER IF NOT EXISTS inventory_saves_open_day_update BEFORE UPDATE ON inventory_saves
WHEN NEW.business_day_id <> OLD.business_day_id OR (SELECT status FROM business_days WHERE id = OLD.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'the saved inventory of a closed day cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS inventory_saves_no_delete BEFORE DELETE ON inventory_saves
WHEN (SELECT status FROM business_days WHERE id = OLD.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'the saved inventory of a closed day cannot be deleted'); END;
`;

const SCHEMA_VERSION = 11;

/** One safety copy of the file per start, taken just before the first upgrade step runs. */
function makeBackup(db, file) {
  let done = false;
  return (label) => {
    if (done || file === ':memory:') return;
    done = true;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    let copy = `${file}.before-${label}-${stamp}.bak`;
    for (let n = 2; fs.existsSync(copy); n += 1) copy = `${file}.before-${label}-${stamp}-${n}.bak`;   // never overwrite or trip over an earlier copy
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

/**
 * Version 6 -> 7 (Daily Inventory, business days and cash received). Nothing is deleted or rewritten except one new link on each order.
 *   * new tables: business_days, inventory_records, inventory_events
 *   * orders.business_day_id: the business day an order was sold on. Every existing order is attached to a business day made
 *     from its own calendar date. Dates before today become CLOSED days; today's date (if it has orders) becomes the OPEN day.
 *     No inventory numbers exist for those days: the shop enters its Beginning Balances once, on the Daily Inventory screen.
 *   * payments.received_centavos / change_centavos: empty for every existing payment (the money received was never recorded).
 * The trigger that protects order fields is dropped here and put back (now also protecting business_day_id) by the schema step
 * that runs right after, so the order link can be filled in once and is then fixed for good.
 */
function migrateTo7(db, backup) {
  backup('v7');
  upgrade(db, 7, () => {
    db.exec('DROP TRIGGER IF EXISTS orders_immutable_fields');
    db.exec(INVENTORY_TABLES);
    if (!hasColumn(db, 'orders', 'business_day_id')) {
      db.exec('ALTER TABLE orders ADD COLUMN business_day_id INTEGER REFERENCES business_days(id)');
      const today = toBusinessDate(new Date());
      const days = db.prepare('SELECT business_date AS date, MIN(submitted_at) AS first, MAX(submitted_at) AS last FROM orders GROUP BY business_date ORDER BY business_date').all();
      const insert = db.prepare('INSERT INTO business_days (business_date, status, opened_at, closed_at) VALUES (?,?,?,?)');
      days.forEach((d, i) => {
        const open = i === days.length - 1 && d.date >= today; // at most one open day: the latest, and only if it is today
        insert.run(d.date, open ? 'OPEN' : 'CLOSED', d.first, open ? null : d.last);
      });
      db.exec('UPDATE orders SET business_day_id = (SELECT id FROM business_days d WHERE d.business_date = orders.business_date)');
    }
    if (!hasColumn(db, 'payments', 'received_centavos')) {
      db.exec('ALTER TABLE payments ADD COLUMN received_centavos INTEGER CHECK (received_centavos IS NULL OR received_centavos > 0)');
      db.exec('ALTER TABLE payments ADD COLUMN change_centavos INTEGER CHECK (change_centavos IS NULL OR change_centavos >= 0)');
    }
  });
}

/** Does this name look like eggs? ("Eggs (Small)", "Egg" yes; "Eggplant" no.) Only used once, to sort the products already in the shop's catalog. */
export const looksLikeEggs = (name) => /\beggs?\b/i.test(String(name));

/**
 * Add the standard ways of selling to one other product, without touching any it already has: Eggs are counted in piece, carton and
 * tray; every other product in piece, pack, sack (fixed price) and kg (per kg). A way of selling the admin has not priced yet is
 * saved inactive at ₱0, so it stays off the cashier screen but has a row on the Daily Inventory. An existing option (same unit,
 * any capital letters) is left exactly as it is.
 */
export function addStandardOptions(db, productId, kind, now) {
  const insert = db.prepare(`INSERT OR IGNORE INTO other_product_options (product_id, unit, sold_by, price_centavos, active, created_at, updated_at)
                             VALUES (?, ?, ?, 0, 0, ?, ?)`);
  for (const unit of UNITS[kind] ?? UNITS.OTHER) insert.run(productId, unit, unit === 'kg' ? 'PER_KG' : 'FIXED', now, now);
}

/**
 * Version 7 -> 8 (Revision 10). Nothing is deleted. Saved orders, payments and history keep every value.
 *   * order_items is rebuilt with one rule relaxed: a Pour or Dress line may now be whole (no cutting). Every row is copied across
 *     with its own id and values (the tests compare the rows before and after).
 *   * inventory_events gets reason_code and reason_note (why a Beginning Balance was corrected). Empty for every existing event.
 *   * other_products gets kind (EGGS or OTHER). Products whose name says egg(s) become EGGS, all others OTHER.
 *   * every other product gets the standard ways of selling (see addStandardOptions). Existing options, prices and old units such
 *     as dozen or batch stay exactly as they are.
 */
function migrateTo8(db, backup) {
  backup('v8');
  upgrade(db, 8, () => {
    const itemsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'order_items'").get()?.sql ?? '';
    if (itemsSql.includes("cut_method <> 'NONE'")) {
      const cols = 'id, order_id, line_no, product_id, product_name, price_per_kg_centavos, weight_g, heads, weight_amount_centavos, feather_prep, dara, cut_method, slice_size, fee_detail, service_fee_centavos, line_total_centavos';
      db.exec(`${orderItemsTable('order_items_new')};
        INSERT INTO order_items_new (${cols}) SELECT ${cols} FROM order_items ORDER BY id;
        DROP TABLE order_items;
        ALTER TABLE order_items_new RENAME TO order_items;
        CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
        CREATE TRIGGER IF NOT EXISTS order_items_no_update BEFORE UPDATE ON order_items
        BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be changed'); END;
        CREATE TRIGGER IF NOT EXISTS order_items_no_delete BEFORE DELETE ON order_items
        BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be deleted'); END;`);
    }
    if (!hasColumn(db, 'inventory_events', 'reason_code')) {
      db.exec('ALTER TABLE inventory_events ADD COLUMN reason_code TEXT');
      db.exec('ALTER TABLE inventory_events ADD COLUMN reason_note TEXT');
    }
    if (!hasColumn(db, 'other_products', 'kind')) {
      db.exec("ALTER TABLE other_products ADD COLUMN kind TEXT NOT NULL DEFAULT 'OTHER' CHECK (kind IN ('EGGS','OTHER'))");
      for (const p of db.prepare('SELECT id, name FROM other_products').all()) {
        if (looksLikeEggs(p.name)) db.prepare("UPDATE other_products SET kind = 'EGGS' WHERE id = ?").run(p.id);
      }
    }
    const now = new Date().toISOString();
    for (const p of db.prepare('SELECT id, kind FROM other_products ORDER BY id').all()) addStandardOptions(db, p.id, p.kind, now);
  });
}

/** The paper-form block a chicken product's name points to. Used once, to fill in the category of products made before version 9. */
export function categoryFromName(name) {
  const n = String(name);
  if (/b[\s-]?cull|breeder/i.test(n)) return 'BCULL';
  if (/cull/i.test(n)) return 'CULL';
  if (/broiler/i.test(n)) return 'BROILER';
  return 'OTHER';
}

/**
 * Version 8 -> 9 (Revision 11). Nothing is deleted. Saved orders, payments, inventory and history keep every value.
 *   * products.category: the paper-form block (B-Cull, Cull, Broiler or other), filled in from each product's name once.
 *   * order_other_items.pieces: pieces weighed on a per-kg line. Empty for every existing line.
 *   * inventory_records.katay_milli: Katay, 0 for every existing record.
 *   * inventory_events is rebuilt only to allow the new "katay" field; every row is copied across with its own id and values.
 *   * new tables (submissions, product pictures, one-time markers) are created by the schema step that follows.
 */
function migrateTo9(db, backup) {
  backup('v9');
  upgrade(db, 9, () => {
    if (!hasColumn(db, 'products', 'category')) {
      db.exec("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'OTHER' CHECK (category IN ('BCULL','CULL','BROILER','OTHER'))");
      for (const p of db.prepare('SELECT id, name FROM products').all()) {
        db.prepare('UPDATE products SET category = ? WHERE id = ?').run(categoryFromName(p.name), p.id);
      }
    }
    if (!hasColumn(db, 'order_other_items', 'pieces')) {
      db.exec('ALTER TABLE order_other_items ADD COLUMN pieces INTEGER CHECK (pieces IS NULL OR (pieces >= 1 AND pieces <= 999))');
    }
    if (!hasColumn(db, 'inventory_records', 'katay_milli')) {
      db.exec('ALTER TABLE inventory_records ADD COLUMN katay_milli INTEGER NOT NULL DEFAULT 0 CHECK (katay_milli >= 0 AND katay_milli % 1000 = 0)');
    }
    const eventsSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inventory_events'").get()?.sql ?? '';
    if (!eventsSql.includes("'katay'")) {
      const cols = 'id, record_id, field, old_milli, new_milli, user_id, created_at, note, reason_code, reason_note';
      db.exec(`${inventoryEventsTable('inventory_events_new')};
        INSERT INTO inventory_events_new (${cols}) SELECT ${cols} FROM inventory_events ORDER BY id;
        DROP TABLE inventory_events;
        ALTER TABLE inventory_events_new RENAME TO inventory_events;`);
      // The index and the two "history cannot be changed or deleted" triggers went with the old table; the schema step puts them back.
    }
  });
}

/**
 * Version 9 -> 10 (Revision 12). Nothing is deleted or rewritten: four new tables only (ref stock, ref sale lines, cash counts and
 * expenses), created by the schema step that follows. A safety copy is still taken first, like every upgrade.
 */
function migrateTo10(db, backup) {
  backup('v10');
  upgrade(db, 10, () => {});
}

/**
 * Version 10 -> 11 (Revision 13). A new table for the Daily Inventory "Save" (made by the schema step) and the chicken a Katay or Dead
 * sale came from. Older ref sales get it only when every head of that kind ever put in the ref came from one product; otherwise it
 * stays empty and the Daily Sales Report shows "source not recorded".
 */
function migrateTo11(db, backup) {
  backup('v11');
  upgrade(db, 11, () => {
    const hasRef = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'order_ref_items'").get().n > 0;
    if (!hasRef) return;   // older than version 10: the schema step creates the table with the column
    if (!hasColumn(db, 'order_ref_items', 'product_id')) db.exec('ALTER TABLE order_ref_items ADD COLUMN product_id INTEGER REFERENCES products(id)');
    // order_ref_items refuses updates (submitted lines never change); this one-time fill-in is done with the guard lifted.
    db.exec('DROP TRIGGER IF EXISTS order_ref_items_no_update');
    for (const { ref_kind: kind } of db.prepare('SELECT DISTINCT ref_kind FROM order_ref_items WHERE product_id IS NULL').all()) {
      const sources = db.prepare('SELECT DISTINCT product_id FROM ref_stock_entries WHERE ref_kind = ? AND product_id IS NOT NULL').all(kind);
      if (sources.length === 1) db.prepare('UPDATE order_ref_items SET product_id = ? WHERE ref_kind = ? AND product_id IS NULL').run(sources[0].product_id, kind);
    }
    // The schema step that follows puts the guard back.
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
    if (version < 6) migrateTo6(db, backup);
    if (version < 7) migrateTo7(db, backup);
    if (version < 8) migrateTo8(db, backup);
    if (version < 9) migrateTo9(db, backup);
    if (version < 10) migrateTo10(db, backup);
    if (version < 11) migrateTo11(db, backup);
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  const now = new Date().toISOString();
  // New installs charge Pour and Dress per head (3 heads x the fee). The admin can change this per service.
  const seed = db.prepare('INSERT OR IGNORE INTO service_fees (code, amount_centavos, basis, updated_at) VALUES (?, 0, ?, ?)');
  for (const code of ['POUR', 'NOT_POUR']) seed.run(code, 'per_head', now);   // With Blood and Dukot have no fee any more
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
