// Versioned SQLite migrations: atomic, idempotent and non-destructive.
import { PRODUCT, SALE_SIZES } from "./catalog.mjs";
import { SCHEMA_VERSION, schemaStatements } from "./schema.mjs";

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
async function seedHoodie(db, at) {
  const existing = (await db.get("SELECT COUNT(*) AS n FROM products")).n;
  if (existing) return;
  const productId = "PRD-HOODIE-0001";
  const slug = slugify(PRODUCT.name);
  await db.run(
    `INSERT INTO products(id,slug,name,description,color,composition,fabric_weight_gsm,fit,price_cents,status,position,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
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
    ],
  );
  const images = [
    ["assets/product-front.jpg", "Frente de la sudadera LA AFRO × OFFCODE"],
    ["assets/product-back.jpg", "Espalda de la sudadera LA AFRO × OFFCODE"],
    ["assets/product-detail.jpg", "Detalle de los gráficos y capucha de la sudadera"],
  ];
  for (const [index, [src, alt]] of images.entries())
    await db.run(
      "INSERT INTO product_images(id,product_id,src,alt,position) VALUES(?,?,?,?,?)",
      [`IMG-HOODIE-${index + 1}`, productId, src, alt, index],
    );
  for (const [index, size] of SALE_SIZES.entries()) {
    const variantId = `VAR-HOODIE-${size}`;
    await db.run(
      "INSERT INTO variants(id,product_id,size,color,sku,status,position) VALUES(?,?,?,?,?,?,?)",
      [variantId, productId, size, PRODUCT.color, `OF-HOODIE-BLK-${size}`, "active", index],
    );
    await db.run(
      "INSERT INTO inventory(variant_id,on_hand,reserved,low_stock_threshold,configured,updated_at) VALUES(?,0,0,0,0,?)",
      [variantId, at],
    );
  }
}

// Current schema version, without creating or changing anything the caller
// did not ask for. 0 means "brand new database".
export async function readSchemaVersion(db) {
  const row = await db.get("PRAGMA user_version");
  return Number(row?.user_version ?? 0);
}

export async function migrate(db, { now = () => new Date().toISOString(), seed = true } = {}) {
  return db.tx(async (tx) => {
    const current = await readSchemaVersion(tx);
    if (current > SCHEMA_VERSION) throw Error("El esquema SQLite es más reciente que esta aplicación. Revisa la versión antes de iniciar.");
    for (const statement of schemaStatements()) await tx.exec(statement);
    if (current < SCHEMA_VERSION) {
      if (seed) await seedHoodie(tx, now());
      await tx.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    return SCHEMA_VERSION;
  });
}

export { SCHEMA_VERSION };
