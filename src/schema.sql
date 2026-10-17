-- StationDesk schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS stations (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  logo_url TEXT,
  brand_color TEXT NOT NULL DEFAULT '#F2A900',
  address TEXT,
  phone TEXT,
  email TEXT,
  currency TEXT NOT NULL DEFAULT 'NGN',
  timezone TEXT NOT NULL DEFAULT 'Africa/Lagos',
  ordering_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  public_prices BOOLEAN NOT NULL DEFAULT FALSE,
  signup_open BOOLEAN NOT NULL DEFAULT TRUE,
  customer_approval BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  delivery_note TEXT,
  shift_alert_hours INT NOT NULL DEFAULT 24,
  cash_tolerance_pct NUMERIC NOT NULL DEFAULT 0.5,
  litre_tolerance_pct NUMERIC NOT NULL DEFAULT 0.5,
  summary_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  summary_hour INT NOT NULL DEFAULT 21,
  summary_email TEXT,
  loyalty_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  loyalty_points_per_1000 INT NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  pending BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT REFERENCES stations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('platform_owner','admin','staff','customer')),
  name TEXT NOT NULL,
  username TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  password_hash TEXT NOT NULL,
  pin_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending','blocked')),
  loyalty_points INT NOT NULL DEFAULT 0,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_station_username ON users (COALESCE(station_id, 0), username);

CREATE TABLE IF NOT EXISTS admin_station_links (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, station_id)
);

CREATE TABLE IF NOT EXISTS categories (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sale_type TEXT NOT NULL CHECK (sale_type IN ('metered','bulk','packaged','item','service')),
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (station_id, name)
);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  category_id BIGINT REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  variant TEXT,
  sale_type TEXT NOT NULL CHECK (sale_type IN ('metered','bulk','packaged','item','service')),
  unit TEXT NOT NULL DEFAULT 'piece',
  selling_price NUMERIC NOT NULL DEFAULT 0,
  cost_price NUMERIC,
  reorder_level NUMERIC NOT NULL DEFAULT 0,
  stock_qty NUMERIC NOT NULL DEFAULT 0,
  low_notified BOOLEAN NOT NULL DEFAULT FALSE,
  sku TEXT,
  image_url TEXT,
  orderable BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_station ON products (station_id);

CREATE TABLE IF NOT EXISTS price_history (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  price NUMERIC NOT NULL,
  old_price NUMERIC,
  kind TEXT NOT NULL DEFAULT 'change' CHECK (kind IN ('initial','change')),
  effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS price_history_product ON price_history (product_id, effective_at);

CREATE TABLE IF NOT EXISTS tanks (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  capacity_litres NUMERIC NOT NULL DEFAULT 0,
  current_litres NUMERIC NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS pumps (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  current_reading NUMERIC NOT NULL DEFAULT 0,
  meter_max NUMERIC NOT NULL DEFAULT 99999999,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS shifts (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  closed_by BIGINT REFERENCES users(id),
  admin_closed BOOLEAN NOT NULL DEFAULT FALSE,
  close_note TEXT,
  cash_declared NUMERIC NOT NULL DEFAULT 0,
  transfer_declared NUMERIC NOT NULL DEFAULT 0,
  pos_declared NUMERIC NOT NULL DEFAULT 0,
  pump_sales NUMERIC NOT NULL DEFAULT 0,
  manual_sales NUMERIC NOT NULL DEFAULT 0,
  credit_sales NUMERIC NOT NULL DEFAULT 0,
  credit_payments NUMERIC NOT NULL DEFAULT 0,
  till_expenses NUMERIC NOT NULL DEFAULT 0,
  expected_amount NUMERIC NOT NULL DEFAULT 0,
  variance_amount NUMERIC NOT NULL DEFAULT 0,
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  alerted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS shifts_station ON shifts (station_id, status);

CREATE TABLE IF NOT EXISTS shift_pumps (
  id BIGSERIAL PRIMARY KEY,
  shift_id BIGINT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  pump_id BIGINT NOT NULL REFERENCES pumps(id),
  expected_opening NUMERIC NOT NULL,
  opening_reading NUMERIC NOT NULL,
  gap_litres NUMERIC NOT NULL DEFAULT 0,
  closing_reading NUMERIC,
  rollover BOOLEAN NOT NULL DEFAULT FALSE,
  litres NUMERIC NOT NULL DEFAULT 0,
  amount NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pump_price_readings (
  id BIGSERIAL PRIMARY KEY,
  shift_pump_id BIGINT NOT NULL REFERENCES shift_pumps(id) ON DELETE CASCADE,
  price_history_id BIGINT NOT NULL REFERENCES price_history(id) ON DELETE CASCADE,
  reading NUMERIC NOT NULL,
  recorded_by BIGINT REFERENCES users(id),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shift_pump_id, price_history_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  customer_id BIGINT REFERENCES users(id),
  customer_name TEXT,
  customer_phone TEXT,
  customer_email TEXT,
  tracking_token TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','ready','completed','cancelled')),
  fulfilment TEXT NOT NULL DEFAULT 'pickup' CHECK (fulfilment IN ('pickup','delivery')),
  delivery_address TEXT,
  preferred_at TIMESTAMPTZ,
  note TEXT,
  vehicle TEXT,
  total NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'pay_on_pickup',
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid')),
  proof_url TEXT,
  handled_by BIGINT REFERENCES users(id),
  points_awarded INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_station ON orders (station_id, status);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  qty NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL,
  amount NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  pump_id BIGINT REFERENCES pumps(id),
  qty NUMERIC NOT NULL,
  unit_price NUMERIC NOT NULL,
  amount NUMERIC NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','pump','order')),
  payment TEXT NOT NULL DEFAULT 'cash' CHECK (payment IN ('cash','transfer','pos','credit')),
  order_id BIGINT REFERENCES orders(id),
  client_id TEXT,
  note TEXT,
  entered_by BIGINT REFERENCES users(id),
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason TEXT,
  voided_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_station_date ON sales (station_id, created_at);
CREATE INDEX IF NOT EXISTS sales_shift ON sales (shift_id);
CREATE UNIQUE INDEX IF NOT EXISTS sales_client_id ON sales (station_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS stock_movements (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  product_id BIGINT REFERENCES products(id) ON DELETE CASCADE,
  tank_id BIGINT REFERENCES tanks(id) ON DELETE SET NULL,
  type TEXT NOT NULL,
  qty NUMERIC NOT NULL,
  balance_after NUMERIC,
  ref_type TEXT,
  ref_id BIGINT,
  note TEXT,
  user_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_movements_product ON stock_movements (station_id, product_id, created_at);

CREATE TABLE IF NOT EXISTS restocks (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES products(id),
  tank_id BIGINT REFERENCES tanks(id),
  supplier_name TEXT,
  qty NUMERIC NOT NULL,
  cost_price NUMERIC,
  waybill TEXT,
  dip_before NUMERIC,
  dip_after NUMERIC,
  short_delivery NUMERIC,
  note TEXT,
  photo_url TEXT,
  received_by BIGINT REFERENCES users(id),
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dip_readings (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  tank_id BIGINT NOT NULL REFERENCES tanks(id) ON DELETE CASCADE,
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  litres NUMERIC NOT NULL,
  book_litres NUMERIC NOT NULL,
  variance NUMERIC NOT NULL,
  flagged BOOLEAN NOT NULL DEFAULT FALSE,
  user_id BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  shift_id BIGINT REFERENCES shifts(id) ON DELETE SET NULL,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  spent_at DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT,
  receipt_url TEXT,
  from_till BOOLEAN NOT NULL DEFAULT FALSE,
  client_id TEXT,
  user_id BIGINT REFERENCES users(id),
  voided BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS expenses_client_id ON expenses (station_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS edit_requests (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  shift_id BIGINT REFERENCES shifts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('void_sale','edit_sale_qty','edit_shift_cash')),
  entity_id BIGINT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by BIGINT REFERENCES users(id),
  decided_by BIGINT REFERENCES users(id),
  decision_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT REFERENCES stations(id) ON DELETE CASCADE,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  user_name TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id BIGINT,
  before JSONB,
  after JSONB,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_station ON audit_logs (station_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT REFERENCES stations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id, read, created_at DESC);

CREATE TABLE IF NOT EXISTS monthly_recaps (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  data JSONB NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (station_id, month)
);

CREATE TABLE IF NOT EXISTS help_articles (
  id BIGSERIAL PRIMARY KEY,
  audience TEXT NOT NULL CHECK (audience IN ('customer','staff','admin')),
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  video_url TEXT,
  sort INT NOT NULL DEFAULT 0,
  published BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS job_runs (
  key TEXT PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Help guides each station can edit. New stations start with a copy of the platform's default guides (help_articles).
CREATE TABLE IF NOT EXISTS station_help (
  id BIGSERIAL PRIMARY KEY,
  station_id BIGINT NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
  audience TEXT NOT NULL CHECK (audience IN ('customer','staff','admin')),
  source_slug TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  video_url TEXT,
  sort INT NOT NULL DEFAULT 0,
  published BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS station_help_station ON station_help (station_id, audience);

-- ---------------------------------------------------------------
-- Upgrades for databases created by the first version. Safe to run every time.
-- ---------------------------------------------------------------
ALTER TABLE stations ADD COLUMN IF NOT EXISTS pending BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ALTER COLUMN customer_id DROP NOT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_email TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_token TEXT DEFAULT replace(gen_random_uuid()::text, '-', '');
UPDATE orders SET tracking_token = replace(gen_random_uuid()::text, '-', '') WHERE tracking_token IS NULL;
ALTER TABLE orders ALTER COLUMN tracking_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_tracking_token ON orders (tracking_token);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'users') THEN
    UPDATE orders o SET customer_name = u.name, customer_phone = u.phone, customer_email = u.email
      FROM users u WHERE o.customer_id = u.id AND o.customer_name IS NULL;
  END IF;
END $$;
-- Admins log in with their email, so an email can belong to only one admin account
CREATE UNIQUE INDEX IF NOT EXISTS users_admin_email ON users (lower(email)) WHERE role = 'admin' AND email IS NOT NULL;

-- Removed features: credit customers, suppliers and purchase orders, customer vehicles
ALTER TABLE sales DROP COLUMN IF EXISTS credit_customer_id;
ALTER TABLE restocks DROP COLUMN IF EXISTS supplier_id;
ALTER TABLE restocks DROP COLUMN IF EXISTS purchase_order_id;
DROP TABLE IF EXISTS credit_entries CASCADE;
DROP TABLE IF EXISTS credit_customers CASCADE;
DROP TABLE IF EXISTS purchase_order_items CASCADE;
DROP TABLE IF EXISTS purchase_orders CASCADE;
DROP TABLE IF EXISTS suppliers CASCADE;
DROP TABLE IF EXISTS fleet_vehicles CASCADE;
