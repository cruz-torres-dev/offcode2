// Versioned, transactional and idempotent SQLite migrations.
//
// `PRAGMA user_version` is the source of truth: every migration runs once, in
// order, inside BEGIN IMMEDIATE. Re-running the server never drops or recreates
// tables, and existing orders are never touched.
import { PRODUCT, SALE_SIZES } from "./catalog.mjs";

const migrations = [
  {
    version: 1,
    name: "catalog_and_inventory",
    up(db, { now, seed }) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS products (
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
        );
        CREATE TABLE IF NOT EXISTS product_images (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          src TEXT NOT NULL,
          alt TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS product_images_product ON product_images(product_id, position);
        CREATE TABLE IF NOT EXISTS variants (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
          size TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '',
          sku TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
          position INTEGER NOT NULL DEFAULT 0,
          UNIQUE(product_id, size, color)
        );
        CREATE INDEX IF NOT EXISTS variants_product ON variants(product_id, position);
        CREATE TABLE IF NOT EXISTS inventory (
          variant_id TEXT PRIMARY KEY REFERENCES variants(id) ON DELETE RESTRICT,
          on_hand INTEGER NOT NULL DEFAULT 0 CHECK(on_hand >= 0),
          reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved >= 0),
          low_stock_threshold INTEGER NOT NULL DEFAULT 0 CHECK(low_stock_threshold >= 0),
          configured INTEGER NOT NULL DEFAULT 0 CHECK(configured IN (0,1)),
          updated_at TEXT NOT NULL,
          CHECK(reserved <= on_hand OR configured = 0)
        );
        CREATE TABLE IF NOT EXISTS inventory_movements (
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
        );
        CREATE INDEX IF NOT EXISTS inventory_movements_variant ON inventory_movements(variant_id, created_at);
        CREATE TABLE IF NOT EXISTS order_reservations (
          order_id TEXT NOT NULL,
          variant_id TEXT NOT NULL REFERENCES variants(id) ON DELETE RESTRICT,
          qty INTEGER NOT NULL CHECK(qty > 0),
          state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','sold','released')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(order_id, variant_id)
        );
        CREATE INDEX IF NOT EXISTS order_reservations_variant ON order_reservations(variant_id, state);
      `);
      if (seed) seedHoodie(db, now());
    },
  },
];

const slugify = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "producto";

// The current hoodie keeps working exactly as before: same price, same four
// sale sizes, same photographs. Stock is deliberately left unconfigured.
function seedHoodie(db, at) {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
  if (existing) return;
  const productId = "PRD-HOODIE-0001";
  const slug = slugify(PRODUCT.name);
  db.prepare(
    `INSERT INTO products(id,slug,name,description,color,composition,fabric_weight_gsm,fit,price_cents,status,position,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    productId,
    slug,
    PRODUCT.name,
    "Hoodie oversize negra de 420 g/m², confeccionada en 100% algodón.",
    PRODUCT.color,
    PRODUCT.composition,
    PRODUCT.fabricWeightGsm,
    PRODUCT.fit,
    165000,
    "published",
    0,
    at,
    at,
  );
  const images = [
    ["assets/product-front.jpg", "Frente de la sudadera LA AFRO × OFFCODE"],
    ["assets/product-back.jpg", "Espalda de la sudadera LA AFRO × OFFCODE"],
    ["assets/product-detail.jpg", "Detalle de los gráficos y capucha de la sudadera"],
  ];
  images.forEach(([src, alt], index) =>
    db.prepare(
      "INSERT INTO product_images(id,product_id,src,alt,position) VALUES(?,?,?,?,?)",
    ).run(`IMG-HOODIE-${index + 1}`, productId, src, alt, index),
  );
  SALE_SIZES.forEach((size, index) => {
    const variantId = `VAR-HOODIE-${size}`;
    db.prepare(
      "INSERT INTO variants(id,product_id,size,color,sku,status,position) VALUES(?,?,?,?,?,?,?)",
    ).run(
      variantId,
      productId,
      size,
      PRODUCT.color,
      `OF-HOODIE-BLK-${size}`,
      "active",
      index,
    );
    db.prepare(
      "INSERT INTO inventory(variant_id,on_hand,reserved,low_stock_threshold,configured,updated_at) VALUES(?,0,0,0,0,?)",
    ).run(variantId, at);
  });
}

export const SCHEMA_VERSION = migrations.at(-1).version;

export function migrate(db, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const seed = options.seed !== false;
  // Referential integrity is enforced by SQLite only when this is on.
  db.exec("PRAGMA foreign_keys = ON");
  let version = db.prepare("PRAGMA user_version").get().user_version;
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.up(db, { now, seed });
      // Version comes from code, never from user input.
      db.exec(`PRAGMA user_version = ${Number(migration.version)}`);
      db.exec("COMMIT");
      version = migration.version;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }
  return version;
}
