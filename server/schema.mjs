// SQLite schema; existing tables are preserved by idempotent migrations.
export const SCHEMA_VERSION = 3;
export const SCHEMA_NAME = "customer_account";

const SQLITE = [
  `CREATE TABLE IF NOT EXISTS owner_auth (
    id INTEGER PRIMARY KEY CHECK(id=1),
    salt BLOB NOT NULL,
    hash BLOB NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS owner_settings (
    id INTEGER PRIMARY KEY CHECK(id=1),
    version INTEGER NOT NULL,
    nonce BLOB NOT NULL,
    tag BLOB NOT NULL,
    payload BLOB NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vip_members (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    consent_at TEXT NOT NULL,
    privacy_url TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    consent_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    withdrawn_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS shipping_quotes (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    order_id TEXT,
    expires INTEGER NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS shipping_quotes_expires ON shipping_quotes(expires)`,
  `CREATE TABLE IF NOT EXISTS shipping_jobs (
    order_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    payload TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    composition TEXT NOT NULL DEFAULT '',
    fabric_weight_gsm INTEGER,
    fit TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL CHECK(price_cents >= 0 AND price_cents <= 10000000),
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS product_images (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    src TEXT NOT NULL,
    alt TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS product_images_product ON product_images(product_id, position)`,
  `CREATE TABLE IF NOT EXISTS variants (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    size TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    position INTEGER NOT NULL DEFAULT 0,
    UNIQUE(product_id, size, color)
  )`,
  `CREATE INDEX IF NOT EXISTS variants_product ON variants(product_id, position)`,
  `CREATE TABLE IF NOT EXISTS inventory (
    variant_id TEXT PRIMARY KEY REFERENCES variants(id) ON DELETE RESTRICT,
    on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
    low_stock_threshold INTEGER NOT NULL DEFAULT 0 CHECK(low_stock_threshold >= 0),
    configured INTEGER NOT NULL DEFAULT 0 CHECK(configured IN (0,1)),
    updated_at TEXT NOT NULL,
    CHECK(reserved <= on_hand OR configured = 0)
  )`,
  `CREATE TABLE IF NOT EXISTS inventory_movements (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE RESTRICT,
    type TEXT NOT NULL CHECK(type IN ('entry','adjustment','correction','reserve','release','sale')),
    qty INTEGER NOT NULL,
    reserved_delta INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    order_id TEXT,
    actor TEXT NOT NULL DEFAULT 'owner',
    on_hand_after INTEGER NOT NULL,
    reserved_after INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS inventory_movements_variant ON inventory_movements(variant_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS order_reservations (
    order_id TEXT NOT NULL,
    variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE RESTRICT,
    qty INTEGER NOT NULL CHECK(qty > 0),
    state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','sold','released')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(order_id, variant_id)
  )`,
  `CREATE INDEX IF NOT EXISTS order_reservations_variant ON order_reservations(variant_id, state)`,
  `CREATE TABLE IF NOT EXISTS customers (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT,
    verified_at TEXT, name TEXT NOT NULL DEFAULT '', address TEXT, created_at TEXT NOT NULL
  )`,
  // Reserved legacy tables: preserve existing records, never consulted by email authentication.
  `CREATE TABLE IF NOT EXISTS customer_identities (
    provider TEXT NOT NULL, subject TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id),
    PRIMARY KEY(provider,subject), UNIQUE(provider,customer_id)
  )`,
  `CREATE TABLE IF NOT EXISTS customer_sessions (
    token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), expires INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS customer_sessions_expires ON customer_sessions(expires)`,
  `CREATE TABLE IF NOT EXISTS customer_tokens (
    token_hash TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id),
    purpose TEXT NOT NULL CHECK(purpose IN ('verify','reset')), expires INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS customer_oauth (
    state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, verifier TEXT NOT NULL,
    nonce TEXT NOT NULL, expires INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS customer_orders (
    order_id TEXT PRIMARY KEY REFERENCES orders(id), customer_id TEXT NOT NULL REFERENCES customers(id)
  )`,
  `CREATE INDEX IF NOT EXISTS customer_orders_customer ON customer_orders(customer_id)`,
  // Saved shipping addresses. A partial unique index keeps at most one default
  // per customer without relying on application discipline.
  `CREATE TABLE IF NOT EXISTS customer_addresses (
    id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    street TEXT NOT NULL,
    number TEXT NOT NULL DEFAULT '',
    neighborhood TEXT NOT NULL,
    city TEXT NOT NULL,
    state TEXT NOT NULL,
    postal_code TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS customer_addresses_customer ON customer_addresses(customer_id, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS customer_addresses_default ON customer_addresses(customer_id) WHERE is_default=1`,
  // Commercial email preference. Absence of a row means "no choice recorded",
  // which is never treated as consent.
  `CREATE TABLE IF NOT EXISTS customer_preferences (
    customer_id TEXT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
    marketing_consent TEXT NOT NULL CHECK(marketing_consent IN ('granted','withdrawn')),
    consent_version TEXT NOT NULL,
    consent_text TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // Pending email change. The link is sent to the NEW address only, and the
  // address on file is untouched until that link is consumed.
  `CREATE TABLE IF NOT EXISTS customer_email_changes (
    token_hash TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    new_email TEXT NOT NULL,
    expires INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS customer_email_changes_customer ON customer_email_changes(customer_id)`,
];

export function schemaStatements() { return SQLITE; }

export const TABLE_ORDER = Object.freeze([
  "owner_auth", "owner_settings", "orders", "vip_members", "shipping_quotes",
  "shipping_jobs", "products", "product_images", "variants", "inventory",
  "inventory_movements", "order_reservations", "customers", "customer_identities",
  "customer_sessions", "customer_tokens", "customer_oauth", "customer_orders",
  "customer_addresses", "customer_preferences", "customer_email_changes",
]);

export const movementOrder = () => "created_at DESC, rowid DESC";
