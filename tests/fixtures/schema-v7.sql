-- The database layout exactly as shipped in revision 9 (user_version 7). Used to prove the upgrade to version 8.

CREATE TABLE users (
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

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  price_per_kg_centavos INTEGER NOT NULL DEFAULT 0 CHECK (price_per_kg_centavos >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (active = 0 OR price_per_kg_centavos > 0)
);

CREATE TABLE other_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE other_product_options (
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

CREATE TABLE service_fees (
  code TEXT PRIMARY KEY CHECK (code IN ('POUR','NOT_POUR','DARA','DUKOT')),
  amount_centavos INTEGER NOT NULL DEFAULT 0 CHECK (amount_centavos >= 0),
  basis TEXT NOT NULL DEFAULT 'per_item' CHECK (basis IN ('per_item','per_head','per_kg')),
  updated_at TEXT NOT NULL
);

CREATE TABLE price_history (
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

CREATE TABLE order_counters (
  business_date TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

CREATE TABLE orders (
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

CREATE TABLE order_items (
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

CREATE TABLE order_other_items (
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

CREATE TABLE payments (
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

CREATE TABLE order_events (
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

CREATE TABLE business_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_date TEXT NOT NULL UNIQUE CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  status TEXT NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  opened_at TEXT NOT NULL,
  opened_by INTEGER REFERENCES users(id),
  closed_at TEXT,
  closed_by INTEGER REFERENCES users(id),
  CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL))
);

CREATE TABLE inventory_records (
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
  CHECK ((kind = 'CHICKEN' AND product_id IS NOT NULL AND option_id IS NULL) OR (kind = 'OTHER' AND option_id IS NOT NULL AND product_id IS NULL)),
  CHECK (kind = 'OTHER' OR (beginning_milli % 1000 = 0 AND additional_milli % 1000 = 0 AND reject_milli % 1000 = 0 AND dead_milli % 1000 = 0 AND pull_out_milli % 1000 = 0 AND (sold_milli IS NULL OR sold_milli % 1000 = 0))),
  CHECK (kind = 'CHICKEN' OR (reject_milli = 0 AND dead_milli = 0 AND pull_out_milli = 0)),   -- other products have no Reject, Dead or Pull Out
  UNIQUE (business_day_id, product_id),
  UNIQUE (business_day_id, option_id)
);

CREATE TABLE inventory_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL REFERENCES inventory_records(id),
  field TEXT NOT NULL CHECK (field IN ('beginning','additional','reject','dead','pull_out')),
  old_milli INTEGER NOT NULL,
  new_milli INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  note TEXT
);

CREATE INDEX idx_orders_date ON orders(business_date);

CREATE INDEX idx_orders_status ON orders(status);

CREATE INDEX idx_orders_fulfillment ON orders(fulfillment_status);

CREATE INDEX idx_orders_day ON orders(business_day_id);

CREATE INDEX idx_items_order ON order_items(order_id);

CREATE INDEX idx_other_items_order ON order_other_items(order_id);

CREATE INDEX idx_payments_order ON payments(order_id);

CREATE INDEX idx_events_order ON order_events(order_id);

CREATE UNIQUE INDEX one_open_business_day ON business_days(status) WHERE status = 'OPEN';

CREATE INDEX idx_inventory_events_record ON inventory_events(record_id);

CREATE TRIGGER order_items_no_update BEFORE UPDATE ON order_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be changed'); END;

CREATE TRIGGER order_items_no_delete BEFORE DELETE ON order_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be deleted'); END;

CREATE TRIGGER order_other_items_no_update BEFORE UPDATE ON order_other_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be changed'); END;

CREATE TRIGGER order_other_items_no_delete BEFORE DELETE ON order_other_items
BEGIN SELECT RAISE(ABORT, 'submitted order lines cannot be deleted'); END;

CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments
BEGIN SELECT RAISE(ABORT, 'payment records cannot be changed'); END;

CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
BEGIN SELECT RAISE(ABORT, 'payment records cannot be deleted'); END;

CREATE TRIGGER events_no_update BEFORE UPDATE ON order_events
BEGIN SELECT RAISE(ABORT, 'audit records cannot be changed'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON order_events
BEGIN SELECT RAISE(ABORT, 'audit records cannot be deleted'); END;

CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'orders cannot be deleted'); END;

CREATE TRIGGER orders_immutable_fields
BEFORE UPDATE OF order_number, business_date, business_day_id, customer_number, subtotal_centavos, discount_type, discount_value, discount_centavos, discount_reason, discount_note, total_centavos, cashier_id, submitted_at, submission_key, replaces_order_id ON orders
BEGIN SELECT RAISE(ABORT, 'order details cannot be changed after submission'); END;

CREATE TRIGGER orders_status_guard BEFORE UPDATE OF status ON orders
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'COMPLETED' OR (OLD.status = 'PARTIALLY_REFUNDED' AND NEW.status = 'REFUNDED'))
BEGIN SELECT RAISE(ABORT, 'this order can no longer change status'); END;

CREATE TRIGGER orders_open_day_only BEFORE INSERT ON orders
WHEN NEW.business_day_id IS NOT NULL AND (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'orders can only be placed on the open business day'); END;

CREATE TRIGGER payments_cash_received_check BEFORE INSERT ON payments
WHEN (NEW.received_centavos IS NULL) <> (NEW.change_centavos IS NULL)
  OR (NEW.received_centavos IS NOT NULL AND (NEW.method <> 'CASH' OR NEW.received_centavos - NEW.amount_centavos <> NEW.change_centavos))
BEGIN SELECT RAISE(ABORT, 'cash received and change do not add up'); END;

CREATE TRIGGER business_days_closed_final BEFORE UPDATE ON business_days
WHEN OLD.status = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'a closed business day cannot be changed or reopened'); END;

CREATE TRIGGER business_days_no_delete BEFORE DELETE ON business_days
WHEN OLD.status = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'a closed business day cannot be deleted'); END;

CREATE TRIGGER business_days_date_fixed BEFORE UPDATE OF business_date ON business_days
BEGIN SELECT RAISE(ABORT, 'the date of a business day cannot be changed'); END;

CREATE TRIGGER inventory_records_closed_no_update BEFORE UPDATE ON inventory_records
WHEN (SELECT status FROM business_days WHERE id = OLD.business_day_id) = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'the inventory of a closed business day cannot be changed'); END;

CREATE TRIGGER inventory_records_closed_no_delete BEFORE DELETE ON inventory_records
WHEN (SELECT status FROM business_days WHERE id = OLD.business_day_id) = 'CLOSED'
BEGIN SELECT RAISE(ABORT, 'the inventory of a closed business day cannot be deleted'); END;

CREATE TRIGGER inventory_records_identity BEFORE UPDATE OF business_day_id, kind, product_id, option_id ON inventory_records
BEGIN SELECT RAISE(ABORT, 'an inventory record cannot be moved to another day or product'); END;

CREATE TRIGGER inventory_records_open_day_only BEFORE INSERT ON inventory_records
WHEN (SELECT status FROM business_days WHERE id = NEW.business_day_id) <> 'OPEN'
BEGIN SELECT RAISE(ABORT, 'inventory can only be added to the open business day'); END;

CREATE TRIGGER inventory_events_no_update BEFORE UPDATE ON inventory_events
BEGIN SELECT RAISE(ABORT, 'inventory history cannot be changed'); END;

CREATE TRIGGER inventory_events_no_delete BEFORE DELETE ON inventory_events
BEGIN SELECT RAISE(ABORT, 'inventory history cannot be deleted'); END;
