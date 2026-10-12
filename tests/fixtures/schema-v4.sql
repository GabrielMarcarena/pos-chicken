-- The database layout exactly as shipped in revision 4 (user_version 4). Used to prove the upgrade to version 5.

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('cashier','manager','admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL
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
  CHECK (total_centavos = subtotal_centavos - discount_centavos),
  CHECK ((discount_type = 'NONE') = (discount_centavos = 0))
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(business_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

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

-- Audit trail: every submit, cancel, change and refund.
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  action_type TEXT NOT NULL CHECK (action_type IN ('SUBMIT','CANCEL','CHANGE','REFUND')),
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
