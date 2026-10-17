// Catalog, variants and inventory. Every write goes through the server:
// the browser never decides prices or stock. SQLite is the only source of truth.
import { randomUUID } from "node:crypto";
import { SIZES, PRODUCT as PRODUCT_FACTS } from "./catalog.mjs";

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

  function tx(fn) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  const inventoryOf = (variantId) =>
    db.prepare("SELECT * FROM inventory WHERE variant_id=?").get(variantId) ?? {
      variant_id: variantId,
      on_hand: 0,
      reserved: 0,
      low_stock_threshold: 0,
      configured: 0,
    };

  const available = (variant, product, inventory) => {
    if (!variant || variant.status !== "active") return 0;
    if (product.status !== "published") return 0;
    return inventory.configured
      ? Math.max(0, inventory.on_hand - inventory.reserved)
      : null; // null = stock control not configured yet
  };

  function variantView(row) {
    const inventory = inventoryOf(row.id);
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

  function productView(row) {
    const images = db
      .prepare("SELECT id,src,alt,position FROM product_images WHERE product_id=? ORDER BY position")
      .all(row.id);
    const variants = db
      .prepare("SELECT * FROM variants WHERE product_id=? ORDER BY position, size")
      .all(row.id)
      .map(variantView);
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

  const listProducts = () =>
    db
      .prepare("SELECT * FROM products ORDER BY position, created_at")
      .all()
      .map(productView);

  const getProduct = (productId) => {
    const row = db.prepare("SELECT * FROM products WHERE id=?").get(productId);
    if (!row) throw fail(404, "Producto no encontrado.");
    return productView(row);
  };

  // Public storefront: only published products with active variants.
  function publicCatalog() {
    return db
      .prepare("SELECT * FROM products WHERE status='published' ORDER BY position, created_at")
      .all()
      .map((row) => {
        const variants = db
          .prepare("SELECT * FROM variants WHERE product_id=? AND status='active' ORDER BY position, size")
          .all(row.id)
          .map((variant) => {
            const inventory = inventoryOf(variant.id);
            return {
              id: variant.id,
              size: variant.size,
              color: variant.color,
              sku: variant.sku,
              available: available(variant, row, inventory),
              stockConfigured: Boolean(inventory.configured),
            };
          });
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
          images: db
            .prepare("SELECT src,alt FROM product_images WHERE product_id=? ORDER BY position")
            .all(row.id),
          variants,
        };
      });
  }

  const saleSizes = () => {
    const primary = publicCatalog()[0];
    if (!primary) return [];
    return primary.variants.filter((v) => v.available === null || v.available > 0).map((v) => v.size);
  };

  // Resolves the browser bag against the database. Price always comes from here.
  function resolveItems(items) {
    if (!Array.isArray(items) || !items.length || items.length > 12)
      throw fail(400, "La bolsa no es válida.");
    const sizes = saleSizes();
    const seen = new Set();
    const resolved = items.map((item) => {
      if (!item || typeof item !== "object")
        throw fail(400, "Revisa tallas y cantidades (1–99 por talla).");
      const qty = item.qty;
      if (!Number.isInteger(qty) || qty < 1 || qty > 99)
        throw fail(400, "Revisa tallas y cantidades (1–99 por talla).");
      let row = null;
      if (typeof item.variantId === "string" && item.variantId)
        row = db
          .prepare(
            `SELECT v.*, p.status AS product_status, p.name AS product_name, p.price_cents
             FROM variants v JOIN products p ON p.id = v.product_id WHERE v.id=?`,
          )
          .get(item.variantId);
      else if (typeof item.productId === "string" && item.productId)
        row = db
          .prepare(
            `SELECT v.*, p.status AS product_status, p.name AS product_name, p.price_cents
             FROM variants v JOIN products p ON p.id = v.product_id
             WHERE v.product_id=? AND v.size=? AND v.status='active'`,
          )
          .get(item.productId, String(item.size ?? ""));
      else
        // Legacy carts only send the size: resolve against the primary
        // published product. Current checkout sends productId/variantId.
        row = db
          .prepare(
            `SELECT v.*, p.status AS product_status, p.name AS product_name, p.price_cents
             FROM variants v JOIN products p ON p.id = v.product_id
             WHERE v.size=? AND v.status='active' AND p.status='published'
             ORDER BY p.position LIMIT 1`,
          )
          .get(String(item.size ?? ""));
      if (!row || row.product_status !== "published" || row.status !== "active")
        throw fail(
          400,
          `Revisa tallas y cantidades (1–99 por talla). Tallas habilitadas: ${sizes.join(", ")}.`,
        );
      if (seen.has(row.id))
        throw fail(400, "Revisa tallas y cantidades (1–99 por talla). Cada talla aparece una vez.");
      seen.add(row.id);
      return {
        productId: row.product_id,
        variantId: row.id,
        sku: row.sku,
        name: row.product_name,
        size: row.size,
        color: row.color,
        qty,
        unitCents: row.price_cents,
      };
    });
    // Same business rule as before the catalog migration: 99 garments max.
    if (resolved.reduce((sum, item) => sum + item.qty, 0) > 99)
      throw fail(400, "Máximo 99 prendas por solicitud.");
    return resolved;
  }

  function movement(variantId, type, { qty = 0, reservedDelta = 0, reason = "", orderId = null, actor = "owner" } = {}) {
    const inventory = inventoryOf(variantId);
    db.prepare(
      `INSERT INTO inventory_movements(id,variant_id,type,qty,reserved_delta,reason,order_id,actor,on_hand_after,reserved_after,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
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
    );
  }

  // Must run inside tx(). Re-checks stock atomically to prevent overselling.
  function reserve(orderId, items) {
    for (const item of items) {
      const inventory = inventoryOf(item.variantId);
      if (inventory.configured) {
        const free = inventory.on_hand - inventory.reserved;
        if (item.qty > free)
          throw fail(
            409,
            `Sin stock suficiente para la talla ${item.size}. Actualiza tu bolsa antes de enviar la solicitud.`,
          );
        db.prepare(
          "UPDATE inventory SET reserved = reserved + ?, updated_at=? WHERE variant_id=?",
        ).run(item.qty, now(), item.variantId);
        movement(item.variantId, "reserve", { reservedDelta: item.qty, orderId });
      }
      // Unconfigured stock: the order is recorded but nothing is reserved, so
      // activating inventory later never invents a past reservation.
      db.prepare(
        `INSERT OR IGNORE INTO order_reservations(order_id,variant_id,qty,state,created_at,updated_at)
         VALUES(?,?,?,?,?,?)`,
      ).run(
        orderId,
        item.variantId,
        item.qty,
        inventory.configured ? "reserved" : "released",
        now(),
        now(),
      );
    }
  }

  const pendingReservations = (orderId, state) =>
    db.prepare("SELECT * FROM order_reservations WHERE order_id=? AND state=?").all(orderId, state);

  // Payment verified: reservation becomes a sale and on_hand drops once.
  function sell(orderId) {
    for (const row of pendingReservations(orderId, "reserved")) {
      const inventory = inventoryOf(row.variant_id);
      if (row.qty > inventory.on_hand)
        throw fail(
          409,
          "El inventario físico ya no cubre este pedido. Revisa las existencias antes de confirmar el pago.",
        );
      db.prepare(
        "UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at=? WHERE variant_id=?",
      ).run(row.qty, row.qty, now(), row.variant_id);
      db.prepare(
        "UPDATE order_reservations SET state='sold', updated_at=? WHERE order_id=? AND variant_id=?",
      ).run(now(), orderId, row.variant_id);
      movement(row.variant_id, "sale", { qty: -row.qty, reservedDelta: -row.qty, orderId });
    }
  }

  // Cancellation releases only units still reserved; sold units stay sold.
  function release(orderId) {
    for (const row of pendingReservations(orderId, "reserved")) {
      db.prepare(
        "UPDATE inventory SET reserved = MAX(0, reserved - ?), updated_at=? WHERE variant_id=?",
      ).run(row.qty, now(), row.variant_id);
      db.prepare(
        "UPDATE order_reservations SET state='released', updated_at=? WHERE order_id=? AND variant_id=?",
      ).run(now(), orderId, row.variant_id);
      movement(row.variant_id, "release", { reservedDelta: -row.qty, orderId });
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
  function recordMovement(variantId, input = {}) {
    const variant = db.prepare("SELECT * FROM variants WHERE id=?").get(variantId);
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
    return tx(() => {
      const inventory = inventoryOf(variantId);
      const next = inventory.on_hand + qty;
      if (next < 0)
        throw fail(409, "El ajuste dejaría existencias negativas. Revisa el conteo real.");
      if (next < inventory.reserved)
        throw fail(
          409,
          "El ajuste dejaría menos existencias que unidades reservadas. Libera o cierra esas reservas primero.",
        );
      db.prepare(
        "UPDATE inventory SET on_hand=?, configured=1, updated_at=? WHERE variant_id=?",
      ).run(next, now(), variantId);
      movement(variantId, type, { qty, reason });
      return variantView(variant);
    });
  }

  function updateInventorySettings(variantId, input = {}) {
    const variant = db.prepare("SELECT * FROM variants WHERE id=?").get(variantId);
    if (!variant) throw fail(404, "Variante no encontrada.");
    const threshold = input.lowStockThreshold;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100000)
      throw fail(400, "Indica un umbral de stock bajo válido.");
    return tx(() => {
      db.prepare(
        "UPDATE inventory SET low_stock_threshold=?, updated_at=? WHERE variant_id=?",
      ).run(threshold, now(), variantId);
      return variantView(variant);
    });
  }

  const listInventory = () =>
    db
      .prepare(
        `SELECT v.*, p.name AS product_name, p.status AS product_status
         FROM variants v JOIN products p ON p.id=v.product_id
         ORDER BY p.position, v.position, v.size`,
      )
      .all()
      .map((row) => ({
        ...variantView(row),
        productName: row.product_name,
        productStatus: row.product_status,
      }));

  const listMovements = (variantId, limit = 50) =>
    db
      .prepare(
        "SELECT * FROM inventory_movements WHERE variant_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?",
      )
      .all(variantId, Math.min(Math.max(Number(limit) || 50, 1), 200))
      .map(movementView);

  function summary() {
    const orders = db
      .prepare("SELECT payload FROM orders")
      .all()
      .map((row) => JSON.parse(row.payload));
    const count = (status) => orders.filter((o) => o.status === status).length;
    const rows = db
      .prepare(
        `SELECT i.on_hand, i.reserved, i.low_stock_threshold, i.configured, v.status, p.status AS product_status
         FROM inventory i JOIN variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id`,
      )
      .all();
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

  function uniqueSlug(base) {
    let candidate = base,
      n = 1;
    while (db.prepare("SELECT 1 FROM products WHERE slug=?").get(candidate))
      candidate = `${base}-${++n}`;
    return candidate;
  }

  function assertSkusFree(variants, productId) {
    const seen = new Set();
    for (const variant of variants) {
      if (seen.has(variant.sku))
        throw fail(409, `El SKU ${variant.sku} está repetido en este producto.`);
      seen.add(variant.sku);
      const row = db.prepare("SELECT product_id FROM variants WHERE sku=?").get(variant.sku);
      if (row && row.product_id !== productId)
        throw fail(409, `El SKU ${variant.sku} ya existe en otro producto.`);
      const duplicate = db
        .prepare("SELECT id FROM variants WHERE sku=? AND product_id=?")
        .get(variant.sku, productId ?? "");
      if (duplicate && duplicate.id !== variant.id)
        throw fail(409, `El SKU ${variant.sku} está repetido en este producto.`);
    }
  }

  function createProduct(input) {
    const data = validateProduct(input);
    assertSkusFree(data.variants, null);
    return tx(() => {
      const productId = id("PRD");
      const at = now();
      const position =
        (db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS n FROM products").get().n ?? 0);
      db.prepare(
        `INSERT INTO products(id,slug,name,description,color,composition,fabric_weight_gsm,fit,price_cents,status,position,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        productId,
        uniqueSlug(slugify(data.name)),
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
      );
      writeImages(productId, data.images);
      data.variants.forEach((variant, index) => {
        db.prepare(
          "INSERT INTO variants(id,product_id,size,color,sku,status,position) VALUES(?,?,?,?,?,?,?)",
        ).run(id("VAR"), productId, variant.size, variant.color, variant.sku, variant.status, index);
      });
      for (const row of db.prepare("SELECT id FROM variants WHERE product_id=?").all(productId))
        db.prepare(
          "INSERT INTO inventory(variant_id,on_hand,reserved,low_stock_threshold,configured,updated_at) VALUES(?,0,0,0,0,?)",
        ).run(row.id, at);
      return getProduct(productId);
    });
  }

  function writeImages(productId, images) {
    db.prepare("DELETE FROM product_images WHERE product_id=?").run(productId);
    images.forEach((image, index) =>
      db.prepare(
        "INSERT INTO product_images(id,product_id,src,alt,position) VALUES(?,?,?,?,?)",
      ).run(id("IMG"), productId, image.src, image.alt, index),
    );
  }

  function updateProduct(productId, input) {
    const existing = getProduct(productId);
    const data = validateProduct(input, { existing });
    const keptIds = new Set(data.variants.map((v) => v.id).filter(Boolean));
    for (const variant of existing.variants)
      if (!keptIds.has(variant.id) && variant.status === "active")
        data.variants.push({ ...variant, status: "archived", id: variant.id });
    assertSkusFree(data.variants, productId);
    return tx(() => {
      const at = now();
      db.prepare(
        `UPDATE products SET name=?,description=?,color=?,composition=?,fabric_weight_gsm=?,fit=?,price_cents=?,status=?,updated_at=? WHERE id=?`,
      ).run(
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
      );
      writeImages(productId, data.images);
      data.variants.forEach((variant, index) => {
        if (variant.id && db.prepare("SELECT 1 FROM variants WHERE id=? AND product_id=?").get(variant.id, productId))
          db.prepare(
            "UPDATE variants SET size=?,color=?,sku=?,status=?,position=? WHERE id=?",
          ).run(variant.size, variant.color, variant.sku, variant.status, index, variant.id);
        else {
          const variantId = id("VAR");
          db.prepare(
            "INSERT INTO variants(id,product_id,size,color,sku,status,position) VALUES(?,?,?,?,?,?,?)",
          ).run(variantId, productId, variant.size, variant.color, variant.sku, variant.status, index);
          db.prepare(
            "INSERT INTO inventory(variant_id,on_hand,reserved,low_stock_threshold,configured,updated_at) VALUES(?,0,0,0,0,?)",
          ).run(variantId, at);
        }
      });
      return getProduct(productId);
    });
  }

  // Publish / unpublish / archive without resending the whole product.
  function setProductStatus(productId, status) {
    const existing = getProduct(productId);
    if (!STATUS.has(status)) throw fail(400, "Estado de producto no válido.");
    if (!TRANSITIONS[existing.status].includes(status))
      throw fail(409, "Cambio de estado del producto no permitido.");
    if (status === "published" && !existing.variants.some((v) => v.status === "active"))
      throw fail(400, "Un producto publicado necesita al menos una variante activa.");
    db.prepare("UPDATE products SET status=?, updated_at=? WHERE id=?").run(status, now(), productId);
    return getProduct(productId);
  }

  // /api/config.product keeps its previous shape so the storefront and the
  // size guide keep working, but sizes now come from the managed catalog.
  function productPayload() {
    const primary = publicCatalog()[0] ?? null;
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
          variantId: null,
          soldOut: false,
          stockConfigured: false,
        })),
        saleSizes: [],
        measurements: PRODUCT_FACTS.measurements,
        preparation: { businessDays: PRODUCT_FACTS.preparation.businessDays },
      };
    const bySize = new Map(primary.variants.map((v) => [v.size, v]));
    // `available === null` means the variant exists but stock control is not
    // configured yet: it is still sellable, exactly as before this migration.
    const sizes = [...new Set([...SIZES, ...bySize.keys()])].map((code) => {
      const variant = bySize.get(code);
      return {
        code,
        available: Boolean(variant) && variant.available !== 0,
        variantId: variant ? variant.id : null,
        soldOut: Boolean(variant) && variant.available === 0,
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
      sizes,
      saleSizes: primary.variants.filter((v) => v.available === null || v.available > 0).map((v) => v.size),
      measurements: PRODUCT_FACTS.measurements,
      preparation: { businessDays: PRODUCT_FACTS.preparation.businessDays },
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
