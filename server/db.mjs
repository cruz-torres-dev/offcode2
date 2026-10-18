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
    ["assets/product-packaging.jpg", "Sudadera y empaque original LA AFRO × OFFCODE"],
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

// Version 3 moves the single address blob stored in customers.address into the
// normalized table. The blob is only cleared after the row is written, inside
// the same transaction, so a failure leaves the original data intact.
async function migrateLegacyAddresses(tx, at) {
  const rows = await tx.all(
    "SELECT id,address FROM customers WHERE address IS NOT NULL AND TRIM(address)<>''",
  );
  for (const row of rows) {
    const existing = await tx.get(
      "SELECT id FROM customer_addresses WHERE customer_id=? LIMIT 1",
      [row.id],
    );
    if (existing) continue;
    let value;
    try {
      value = JSON.parse(row.address);
    } catch {
      continue; // Unreadable legacy value: keep it untouched for manual review.
    }
    if (!value || typeof value !== "object") continue;
    const field = (key) => (typeof value[key] === "string" ? value[key].trim() : "");
    if (!field("street")) continue;
    await tx.run(
      `INSERT INTO customer_addresses(id,customer_id,label,name,phone,street,number,neighborhood,city,state,postal_code,notes,is_default,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
      [
        `ADR-${row.id.slice(0, 8)}-LEGACY`,
        row.id,
        "",
        field("name") || "Titular",
        field("phone"),
        field("street"),
        field("number"),
        field("neighborhood"),
        field("city"),
        field("state"),
        field("postalCode"),
        field("notes"),
        at,
        at,
      ],
    );
    await tx.run("UPDATE customers SET address=NULL WHERE id=?", [row.id]);
  }
}

export async function migrate(db, { now = () => new Date().toISOString(), seed = true } = {}) {
  return db.tx(async (tx) => {
    const current = await readSchemaVersion(tx);
    if (current > SCHEMA_VERSION) throw Error("El esquema SQLite es más reciente que esta aplicación. Revisa la versión antes de iniciar.");
    for (const statement of schemaStatements()) await tx.exec(statement);
    if (current < SCHEMA_VERSION) {
      if (current < 1 && seed) await seedHoodie(tx, now());
      if (current < 3) await migrateLegacyAddresses(tx, now());
      await tx.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    return SCHEMA_VERSION;
  });
}

export { SCHEMA_VERSION };
