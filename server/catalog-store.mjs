// Catalog, variants and inventory. Every write goes through the server:
// the browser never decides prices or stock. The database is the only source
// of truth; SQLite transactions serialize inventory and order writes.
import { randomUUID } from "node:crypto";
import { SIZES, PRODUCT as PRODUCT_FACTS } from "./catalog.mjs";
import { movementOrder } from "./schema.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, min, max, label) => {
  if (typeof value !== "string") throw fail(400, `Revisa ${label}.`);
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (clean.length < min || clean.length > max) throw fail(400, `Revisa ${label}.`);
  return clean;
};
const optionalText = (value, max, label) =>
  value === undefined || value === null || value === ""
    ? ""
    : text(value, 0, max, label);
const price = (value) => {
  if (!Number.isInteger(value) || value < 0 || value > 10000000)
    throw fail(400, "Indica un precio válido en centavos.");
  return value;
};
const sku = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/.test(value.trim()))
    throw fail(400, "El SKU debe tener de 3 a 40 caracteres: letras, números, punto, guion o guion bajo.");
  return value.trim().toUpperCase();
};
const sizeCode = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9]{1,6}$/.test(value.trim()))
    throw fail(400, "Revisa la talla de la variante.");
  return value.trim().toUpperCase();
};
const slugify = (value) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "producto";
const imagePath = (value) => {
  if (typeof value !== "string" || !/^assets\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|avif)$/i.test(value))
    throw fail(400, "Las fotografías deben ser archivos existentes dentro de assets/.");
  return value;
};

const STATUS = new Set(["draft", "published", "archived"]);
const TRANSITIONS = {
  draft: ["draft", "published", "archived"],
  published: ["draft", "published", "archived"],
  archived: ["archived", "draft"],
};

export function createCatalogStore(
  db,
  { now = () => new Date().toISOString(), randomId = randomUUID } = {},
) {
  const id = (prefix) => `${prefix}-${randomId().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  const tx = (fn) => db.tx(fn);

  const inventoryOf = async (variantId, exec = db) => {
    const sql = "SELECT * FROM inventory WHERE variant_id=?";
    return (
      (await exec.get(sql, [variantId])) ?? {
        variant_id: variantId,
        on_hand: 0,
        reserved: 0,
        low_stock_threshold: 0,
        configured: 0,
      }
    );
  };

  // `null` means stock control is not configured yet: the variant exists but the
  // owner has not counted it, so it is never treated as sellable.
  const freeStock = (inventory) =>
    inventory.configured
      ? Math.max(0, inventory.on_hand - inventory.reserved)
      : null;

  const available = (variant, product, inventory) => {
    if (!variant || variant.status !== "active") return 0;
    if (product.status !== "published") return 0;
    return freeStock(inventory); // number = counted, null = unknown
  };

  async function variantView(row, exec = db) {
    const inventory = await inventoryOf(row.id, exec);
    return {
      id: row.id,
      productId: row.product_id,
      size: row.size,
      color: row.color,
      sku: row.sku,
      status: row.status,
      onHand: inventory.on_hand,
      reserved: inventory.reserved,
      available: inventory.configured
        ? Math.max(0, inventory.on_hand - inventory.reserved)
        : null,
      lowStockThreshold: inventory.low_stock_threshold,
      configured: Boolean(inventory.configured),
    };
  }

  async function productView(row, exec = db) {
    const images = await exec.all(
      "SELECT id,src,alt,position FROM product_images WHERE product_id=? ORDER BY position",
      [row.id],
    );
    const variantRows = await exec.all(
      "SELECT * FROM variants WHERE product_id=? ORDER BY position, size",
      [row.id],
    );
    const variants = [];
    for (const variant of variantRows) variants.push(await variantView(variant, exec));
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      color: row.color,
      composition: row.composition,
      fabricWeightGsm: row.fabric_weight_gsm,
      fit: row.fit,
      priceCents: row.price_cents,
      status: row.status,
      position: row.position,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      images: images.map(({ src, alt }) => ({ src, alt })),
      variants,
    };
  }

  async function listProducts() {
    const rows = await db.all("SELECT * FROM products ORDER BY position, created_at");
    const products = [];
    for (const row of rows) products.push(await productView(row));
    return products;
  }

  const getProduct = async (productId, exec = db) => {
    const row = await exec.get("SELECT * FROM products WHERE id=?", [productId]);
    if (!row) throw fail(404, "Producto no encontrado.");
    return productView(row, exec);
  };

  // Public storefront: only published products with active variants.
  async function publicCatalog() {
    const rows = await db.all(
      "SELECT * FROM products WHERE status='published' ORDER BY position, created_at",
    );
    const products = [];
    for (const row of rows) {
      const variantRows = await db.all(
        "SELECT * FROM variants WHERE product_id=? AND status='active' ORDER BY position, size",
        [row.id],
      );
      const variants = [];
      for (const variant of variantRows) {
        const inventory = await inventoryOf(variant.id);
        variants.push({
          id: variant.id,
          size: variant.size,
          color: variant.color,
          sku: variant.sku,
          available: available(variant, row, inventory),
          stockConfigured: Boolean(inventory.configured),
        });
      }
      products.push({
        id: row.id,
        slug: row.slug,
        name: row.name,
        description: row.description,
        color: row.color,
        composition: row.composition,
        fabricWeightGsm: row.fabric_weight_gsm,
        fit: row.fit,
        priceCents: row.price_cents,
        images: await db.all(
          "SELECT src,alt FROM product_images WHERE product_id=? ORDER BY position",
          [row.id],
        ),
        variants,
      });
    }
    return products;
  }

  // Only variants with counted stock above zero are offered. A variant with
  // unknown stock (`available === null`) is never sellable.
  async function saleSizes() {
    const primary = (await publicCatalog())[0];
    if (!primary) return [];
    return primary.variants
      .filter((v) => typeof v.available === "number" && v.available > 0)
      .map((v) => v.size);
  }

  // Resolves the browser bag against the database. Price always comes from here.
  async function resolveItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > 12)
      throw fail(400, "La bolsa no es válida.");
    const sizes = await saleSizes();
    const seen = new Set();
    const resolved = [];
    for (const item of items) {
      if (!item || typeof item !== "object")
        throw fail(400, "Revisa tallas y cantidades (1–99 por talla).");
      const qty = item.qty;
      if (!Number.isInteger(qty) || qty < 1 || qty > 99)
        throw fail(400, "Revisa tallas y cantidades (1–99 por talla).");
      let row = null;
      if (typeof item.variantId === "string" && item.variantId)
        row = await db.get(
          `SELECT v.*, p.status AS product_status, p.name AS product_name, p.price_cents
           FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id=?`,
          [item.variantId],
        );
      else if (typeof item.productId === "string" && item.productId)
        row = await db.get(
          `SELECT v.*, p.status AS product_status, p.name AS product_name, p.price_cents
           FROM variants v JOIN products p ON p.id = v.product_id
           WHERE v.product_id=? AND v.size=? AND v.status='active'`,
          [item.productId, String(item.size ?? "")],
        );
      else
        // Legacy carts only send the size: resolve against the primary
        // published product. Current checkout sends productId/variantId.
        row = await db.get(
          `SELECT v.*, p.status AS product_status, p.name AS product_name, p.price_cents
           FROM variants v JOIN products p ON p.id = v.product_id
           WHERE v.size=? AND v.status='active' AND p.status='published'
           ORDER BY p.position LIMIT 1`,
          [String(item.size ?? "")],
        );
      if (!row || row.product_status !== "published" || row.status !== "active")
        throw fail(
          400,
          `Revisa tallas y cantidades (1–99 por talla). Tallas habilitadas: ${sizes.join(", ")}.`,
        );
      // Unknown stock is never assumed available: the variant must be counted
      // before it can be bought, even through a direct API call.
      const inventory = await inventoryOf(row.id);
      if (!inventory.configured)
        throw fail(
          400,
          `La talla ${row.size} todavía no tiene existencias confirmadas. No se puede comprar hasta que el inventario esté contado.`,
        );
      if (seen.has(row.id))
        throw fail(400, "Revisa tallas y cantidades (1–99 por talla). Cada talla aparece una vez.");
      seen.add(row.id);
      resolved.push({
        productId: row.product_id,
        variantId: row.id,
        sku: row.sku,
        name: row.product_name,
        size: row.size,
        color: row.color,
        qty,
        unitCents: row.price_cents,
      });
    }
    // Same business rule as before the catalog migration: 99 garments max.
    if (resolved.reduce((sum, item) => sum + item.qty, 0) > 99)
      throw fail(400, "Máximo 99 prendas por solicitud.");
    return resolved;
  }

  async function movement(
    variantId,
    type,
    { qty = 0, reservedDelta = 0, reason = "", orderId = null, actor = "owner" } = {},
    exec = db,
  ) {
    const inventory = await inventoryOf(variantId, exec);
    await exec.run(
      `INSERT INTO inventory_movements(id,variant_id,type,qty,reserved_delta,reason,order_id,actor,on_hand_after,reserved_after,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id("MOV"),
        variantId,
        type,
        qty,
        reservedDelta,
        reason,
        orderId,
        actor,
        inventory.on_hand,
        inventory.reserved,
        now(),
      ],
    );
  }

  // Must run inside tx(). Re-checks stock atomically to prevent overselling.
  async function reserve(orderId, items, exec = db) {
    for (const item of items) {
      const inventory = await inventoryOf(item.variantId, exec);
      // Defence in depth: the same rule as resolveItems, re-checked inside the
      // transaction. Unknown stock can never be reserved or sold.
      if (!inventory.configured)
        throw fail(
          409,
          `La talla ${item.size} todavía no tiene existencias confirmadas. Actualiza tu bolsa antes de enviar la solicitud.`,
        );
      const free = inventory.on_hand - inventory.reserved;
      if (item.qty > free)
        throw fail(
          409,
          `Sin stock suficiente para la talla ${item.size}. Actualiza tu bolsa antes de enviar la solicitud.`,
        );
      await exec.run(
        "UPDATE inventory SET reserved = reserved + ?, updated_at=? WHERE variant_id=?",
        [item.qty, now(), item.variantId],
      );
      await movement(item.variantId, "reserve", { reservedDelta: item.qty, orderId }, exec);
      await exec.run(
        `INSERT OR IGNORE INTO order_reservations(order_id,variant_id,qty,state,created_at,updated_at)
             VALUES(?,?,?,?,?,?)`,
        [orderId, item.variantId, item.qty, "reserved", now(), now()],
      );
    }
  }

  const pendingReservations = async (orderId, state, exec = db) =>
    exec.all("SELECT * FROM order_reservations WHERE order_id=? AND state=?", [orderId, state]);

  // Payment verified: reservation becomes a sale and on_hand drops once.
  async function sell(orderId, exec = db) {
    for (const row of await pendingReservations(orderId, "reserved", exec)) {
      const inventory = await inventoryOf(row.variant_id, exec);
      if (row.qty > inventory.on_hand)
        throw fail(
          409,
          "El inventario físico ya no cubre este pedido. Revisa las existencias antes de confirmar el pago.",
        );
      await exec.run(
        "UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at=? WHERE variant_id=?",
        [row.qty, row.qty, now(), row.variant_id],
      );
      await exec.run(
        "UPDATE order_reservations SET state='sold', updated_at=? WHERE order_id=? AND variant_id=?",
        [now(), orderId, row.variant_id],
      );
      await movement(row.variant_id, "sale", { qty: -row.qty, reservedDelta: -row.qty, orderId }, exec);
    }
  }

  // Cancellation releases only units still reserved; sold units stay sold.
  async function release(orderId, exec = db) {
    for (const row of await pendingReservations(orderId, "reserved", exec)) {
      await exec.run(
        `UPDATE inventory SET reserved = MAX(0, reserved - ?), updated_at=? WHERE variant_id=?`,
        [row.qty, now(), row.variant_id],
      );
      await exec.run(
        "UPDATE order_reservations SET state='released', updated_at=? WHERE order_id=? AND variant_id=?",
        [now(), orderId, row.variant_id],
      );
      await movement(row.variant_id, "release", { reservedDelta: -row.qty, orderId }, exec);
    }
  }

  function movementView(row) {
    return {
      id: row.id,
      variantId: row.variant_id,
      type: row.type,
      qty: row.qty,
      reservedDelta: row.reserved_delta,
      reason: row.reason,
      orderId: row.order_id,
      actor: row.actor,
      onHandAfter: row.on_hand_after,
      reservedAfter: row.reserved_after,
      createdAt: row.created_at,
    };
  }

  // Entry, manual adjustment or correction. Never silent, never negative.
  async function recordMovement(variantId, input = {}) {
    const variant = await db.get("SELECT * FROM variants WHERE id=?", [variantId]);
    if (!variant) throw fail(404, "Variante no encontrada.");
    const type = input.type;
    if (!["entry", "adjustment", "correction"].includes(type))
      throw fail(400, "Tipo de movimiento no válido.");
    const qty = input.qty;
    if (!Number.isInteger(qty) || qty === 0 || Math.abs(qty) > 100000)
      throw fail(400, "Indica una cantidad entera distinta de cero.");
    if (type === "entry" && qty < 0)
      throw fail(400, "Una entrada no puede ser negativa.");
    if (type === "adjustment" && qty > 0)
      throw fail(400, "Usa una entrada para sumar unidades.");
    const reason = text(input.reason ?? "", type === "entry" ? 0 : 3, 200, "el motivo");
    if (type !== "entry" && !reason)
      throw fail(400, "El motivo es obligatorio para ajustes y correcciones.");
    return tx(async (exec) => {
      const inventory = await inventoryOf(variantId, exec);
      const next = inventory.on_hand + qty;
      if (next < 0)
        throw fail(409, "El ajuste dejaría existencias negativas. Revisa el conteo real.");
      if (next < inventory.reserved)
        throw fail(
          409,
          "El ajuste dejaría menos existencias que unidades reservadas. Libera o cierra esas reservas primero.",
        );
      await exec.run("UPDATE inventory SET on_hand=?, configured=1, updated_at=? WHERE variant_id=?", [
        next,
        now(),
        variantId,
      ]);
      await movement(variantId, type, { qty, reason }, exec);
      return variantView(variant, exec);
    });
  }

  async function updateInventorySettings(variantId, input = {}) {
    const variant = await db.get("SELECT * FROM variants WHERE id=?", [variantId]);
    if (!variant) throw fail(404, "Variante no encontrada.");
    const threshold = input.lowStockThreshold;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100000)
      throw fail(400, "Indica un umbral de stock bajo válido.");
    return tx(async (exec) => {
      await exec.run("UPDATE inventory SET low_stock_threshold=?, updated_at=? WHERE variant_id=?", [
        threshold,
        now(),
        variantId,
      ]);
      return variantView(variant, exec);
    });
  }

  async function listInventory() {
    const rows = await db.all(
      `SELECT v.*, p.name AS product_name, p.status AS product_status
       FROM variants v JOIN products p ON p.id=v.product_id
       ORDER BY p.position, v.position, v.size`,
    );
    const variants = [];
    for (const row of rows)
      variants.push({
        ...(await variantView(row)),
        productName: row.product_name,
        productStatus: row.product_status,
      });
    return variants;
  }

  async function listMovements(variantId, limit = 50) {
    const size = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await db.all(
      `SELECT * FROM inventory_movements WHERE variant_id=? ORDER BY ${movementOrder()} LIMIT ${size}`,
      [variantId],
    );
    return rows.map(movementView);
  }

  async function summary() {
    const orders = (await db.all("SELECT payload FROM orders")).map((row) =>
      JSON.parse(row.payload),
    );
    const count = (status) => orders.filter((o) => o.status === status).length;
    const rows = await db.all(
      `SELECT i.on_hand, i.reserved, i.low_stock_threshold, i.configured, v.status, p.status AS product_status
       FROM inventory i JOIN variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id`,
    );
    let lowStockVariants = 0,
      lowStockUnits = 0,
      unconfiguredVariants = 0,
      reservedUnits = 0;
    for (const row of rows) {
      if (row.status !== "active" || row.product_status === "archived") continue;
      if (!row.configured) {
        unconfiguredVariants++;
        continue;
      }
      const free = Math.max(0, row.on_hand - row.reserved);
      reservedUnits += row.reserved;
      if (free <= row.low_stock_threshold) {
        lowStockVariants++;
        lowStockUnits += free;
      }
    }
    return {
      orders: {
        pending: count("requested"),
        awaitingPayment: count("awaiting_transfer"),
        toPrepare: count("paid"),
        pendingShipments: count("shipped"),
      },
      inventory: { lowStockVariants, lowStockUnits, unconfiguredVariants, reservedUnits },
    };
  }

  function validateProduct(input, { existing } = {}) {
    if (!input || typeof input !== "object") throw fail(400, "Datos del producto no válidos.");
    const name = text(input.name, 2, 120, "el nombre");
    const description = optionalText(input.description, 2000, "la descripción");
    const color = optionalText(input.color, 40, "el color");
    const composition = optionalText(input.composition, 120, "la composición");
    const fit = optionalText(input.fit, 60, "el corte");
    const fabricWeightGsm =
      input.fabricWeightGsm === undefined || input.fabricWeightGsm === null || input.fabricWeightGsm === ""
        ? null
        : Number(input.fabricWeightGsm);
    if (fabricWeightGsm !== null && (!Number.isInteger(fabricWeightGsm) || fabricWeightGsm < 0 || fabricWeightGsm > 2000))
      throw fail(400, "Revisa el gramaje en g/m².");
    const priceCents = price(input.priceCents);
    const status = input.status ?? existing?.status ?? "draft";
    if (!STATUS.has(status)) throw fail(400, "Estado de producto no válido.");
    if (existing && !TRANSITIONS[existing.status].includes(status))
      throw fail(409, "Cambio de estado del producto no permitido.");
    if (!Array.isArray(input.images)) throw fail(400, "Indica las fotografías del producto.");
    if (input.images.length > 8) throw fail(400, "Máximo 8 fotografías por producto.");
    const images = input.images.map((image) => ({
      src: imagePath(image?.src),
      alt: optionalText(image?.alt, 200, "el texto alternativo"),
    }));
    if (!Array.isArray(input.variants) || !input.variants.length)
      throw fail(400, "Añade al menos una variante.");
    if (input.variants.length > 40) throw fail(400, "Demasiadas variantes.");
    const seen = new Set();
    const variants = input.variants.map((variant) => {
      const size = sizeCode(variant?.size);
      const color2 = optionalText(variant?.color ?? color, 40, "el color de la variante");
      const key = size + "|" + color2.toLowerCase();
      if (seen.has(key)) throw fail(409, "Hay dos variantes con la misma talla y color.");
      seen.add(key);
      return {
        id: typeof variant?.id === "string" && variant.id ? variant.id : null,
        size,
        color: color2,
        sku: sku(variant?.sku),
        status: variant?.status === "archived" ? "archived" : "active",
      };
    });
    const active = variants.filter((v) => v.status === "active").length;
    if (status === "published" && !active)
      throw fail(400, "Un producto publicado necesita al menos una variante activa.");
    return { name, description, color, composition, fit, fabricWeightGsm, priceCents, status, images, variants };
  }

  async function uniqueSlug(base, exec = db) {
    let candidate = base,
      n = 1;
    while (await exec.get("SELECT 1 AS found FROM products WHERE slug=?", [candidate]))
      candidate = `${base}-${++n}`;
    return candidate;
  }

  async function assertSkusFree(variants, productId, exec = db) {
    const seen = new Set();
    for (const variant of variants) {
      if (seen.has(variant.sku))
        throw fail(409, `El SKU ${variant.sku} está repetido en este producto.`);
      seen.add(variant.sku);
      const row = await exec.get("SELECT product_id FROM variants WHERE sku=?", [variant.sku]);
      if (row && row.product_id !== productId)
        throw fail(409, `El SKU ${variant.sku} ya existe en otro producto.`);
      const duplicate = await exec.get("SELECT id FROM variants WHERE sku=? AND product_id=?", [
        variant.sku,
        productId ?? "",
      ]);
      if (duplicate && duplicate.id !== variant.id)
        throw fail(409, `El SKU ${variant.sku} está repetido en este producto.`);
    }
  }

  async function createProduct(input) {
    const data = validateProduct(input);
    await assertSkusFree(data.variants, null);
    return tx(async (exec) => {
      const productId = id("PRD");
      const at = now();
      const position = (await exec.get("SELECT COALESCE(MAX(position),-1)+1 AS n FROM products")).n ?? 0;
      await exec.run(
        `INSERT INTO products(id,slug,name,description,color,composition,fabric_weight_gsm,fit,price_cents,status,position,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          productId,
          await uniqueSlug(slugify(data.name), exec),
          data.name,
          data.description,
          data.color,
          data.composition,
          data.fabricWeightGsm,
          data.fit,
          data.priceCents,
          data.status,
          position,
          at,
          at,
        ],
      );
      await writeImages(productId, data.images, exec);
      for (const [index, variant] of data.variants.entries())
        await exec.run(
          "INSERT INTO variants(id,product_id,size,color,sku,status,position) VALUES(?,?,?,?,?,?,?)",
          [id("VAR"), productId, variant.size, variant.color, variant.sku, variant.status, index],
        );
      const created = await exec.all("SELECT id FROM variants WHERE product_id=?", [productId]);
      for (const row of created)
        await exec.run(
          "INSERT INTO inventory(variant_id,on_hand,reserved,low_stock_threshold,configured,updated_at) VALUES(?,0,0,0,0,?)",
          [row.id, at],
        );
      // Same transaction and same connection: the row was just inserted.
      return getProduct(productId, exec);
    });
  }

  async function writeImages(productId, images, exec = db) {
    await exec.run("DELETE FROM product_images WHERE product_id=?", [productId]);
    for (const [index, image] of images.entries())
      await exec.run("INSERT INTO product_images(id,product_id,src,alt,position) VALUES(?,?,?,?,?)", [
        id("IMG"),
        productId,
        image.src,
        image.alt,
        index,
      ]);
  }

  async function updateProduct(productId, input) {
    const existing = await getProduct(productId);
    const data = validateProduct(input, { existing });
    const keptIds = new Set(data.variants.map((v) => v.id).filter(Boolean));
    for (const variant of existing.variants)
      if (!keptIds.has(variant.id) && variant.status === "active")
        data.variants.push({ ...variant, status: "archived", id: variant.id });
    await assertSkusFree(data.variants, productId);
    return tx(async (exec) => {
      const at = now();
      await exec.run(
        `UPDATE products SET name=?,description=?,color=?,composition=?,fabric_weight_gsm=?,fit=?,price_cents=?,status=?,updated_at=? WHERE id=?`,
        [
          data.name,
          data.description,
          data.color,
          data.composition,
          data.fabricWeightGsm,
          data.fit,
          data.priceCents,
          data.status,
          at,
          productId,
        ],
      );
      await writeImages(productId, data.images, exec);
      for (const [index, variant] of data.variants.entries()) {
        const owned = await exec.get("SELECT 1 AS found FROM variants WHERE id=? AND product_id=?", [
          variant.id ?? "",
          productId,
        ]);
        if (variant.id && owned)
          await exec.run("UPDATE variants SET size=?,color=?,sku=?,status=?,position=? WHERE id=?", [
            variant.size,
            variant.color,
            variant.sku,
            variant.status,
            index,
            variant.id,
          ]);
        else {
          const variantId = id("VAR");
          await exec.run(
            "INSERT INTO variants(id,product_id,size,color,sku,status,position) VALUES(?,?,?,?,?,?,?)",
            [variantId, productId, variant.size, variant.color, variant.sku, variant.status, index],
          );
          await exec.run(
            "INSERT INTO inventory(variant_id,on_hand,reserved,low_stock_threshold,configured,updated_at) VALUES(?,0,0,0,0,?)",
            [variantId, at],
          );
        }
      }
      return getProduct(productId, exec);
    });
  }

  // Publish / unpublish / archive without resending the whole product.
  async function setProductStatus(productId, status) {
    const existing = await getProduct(productId);
    if (!STATUS.has(status)) throw fail(400, "Estado de producto no válido.");
    if (!TRANSITIONS[existing.status].includes(status))
      throw fail(409, "Cambio de estado del producto no permitido.");
    if (status === "published" && !existing.variants.some((v) => v.status === "active"))
      throw fail(400, "Un producto publicado necesita al menos una variante activa.");
    await db.run("UPDATE products SET status=?, updated_at=? WHERE id=?", [status, now(), productId]);
    return getProduct(productId);
  }

  // /api/config.product keeps its previous shape so the storefront keeps
  // working, but sizes now come from the managed catalog.
  async function productPayload() {
    const primary = (await publicCatalog())[0] ?? null;
    if (!primary)
      return {
        name: PRODUCT_FACTS.name,
        line: PRODUCT_FACTS.line,
        season: PRODUCT_FACTS.season,
        color: PRODUCT_FACTS.color,
        composition: PRODUCT_FACTS.composition,
        fabricWeightGsm: PRODUCT_FACTS.fabricWeightGsm,
        fit: PRODUCT_FACTS.fit,
        sizes: SIZES.map((code) => ({
          code,
          available: false,
          sellable: false,
          variantId: null,
          soldOut: false,
          stockConfigured: false,
        })),
        saleSizes: [],
      };
    const bySize = new Map(primary.variants.map((v) => [v.size, v]));
    // A variant is only offered when its stock is counted and above zero.
    // `available === null` (stock unknown) is neither sellable nor "sold out",
    // so it is hidden rather than shown as sold out.
    const sizes = [...new Set([...SIZES, ...bySize.keys()])].map((code) => {
      const variant = bySize.get(code);
      const counted = Boolean(variant) && typeof variant.available === "number";
      const sellable = counted && variant.available > 0;
      return {
        code,
        available: sellable,
        sellable,
        variantId: variant ? variant.id : null,
        soldOut: counted && variant.available === 0,
        stockConfigured: Boolean(variant && variant.stockConfigured),
      };
    });
    return {
      id: primary.id,
      name: primary.name,
      line: PRODUCT_FACTS.line,
      season: PRODUCT_FACTS.season,
      color: primary.color,
      composition: primary.composition,
      fabricWeightGsm: primary.fabricWeightGsm,
      fit: primary.fit,
      priceCents: primary.priceCents,
      images: primary.images,
      sizes,
      saleSizes: primary.variants
        .filter((v) => typeof v.available === "number" && v.available > 0)
        .map((v) => v.size),
    };
  }

  return {
    tx,
    listProducts,
    getProduct,
    createProduct,
    updateProduct,
    setProductStatus,
    publicCatalog,
    productPayload,
    resolveItems,
    reserve,
    sell,
    release,
    recordMovement,
    updateInventorySettings,
    listInventory,
    listMovements,
    summary,
  };
}
