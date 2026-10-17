import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { migrate, SCHEMA_VERSION } from "../server/db.mjs";
import { openDatabase } from "../server/database.mjs";

const origin = "http://localhost:8000",
  password = "synthetic-catalog-admin-password";
const customer = {
  name: "Persona Sintetica",
  email: "buyer@example.test",
  phone: "520000000000",
  street: "Domicilio privado 123",
  neighborhood: "Colonia privada",
  city: "Ciudad",
  state: "Estado",
  postalCode: "00000",
  notes: "",
};
const bank = { name: "Banco privado", beneficiary: "Titular privado", clabe: "000000000000000000" };
const request = (items, key = randomUUID()) => ({
  requestKey: key,
  customer,
  consent: true,
  items,
});

async function start(options = {}) {
  const app = await createApp({
    origin,
    password,
    databasePath: ":memory:",
    enabled: true,
    bank,
    whatsapp: "520000000000",
    privacyUrl: "https://example.test/privacy",
    termsUrl: "https://example.test/terms",
    email: { env: {}, autoStart: false, logger: () => {} },
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  const call = async (route, method = "GET", data, headers = {}) => {
    const r = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, data: await r.json() };
  };
  return { ...app, call, base };
}

const productInput = (overrides = {}) => ({
  name: "Prenda de prueba",
  description: "Descripción sintética",
  color: "Negro",
  composition: "100% algodón",
  fabricWeightGsm: 420,
  fit: "Oversize",
  priceCents: 120000,
  status: "draft",
  images: [{ src: "assets/product-front.jpg", alt: "Frente" }],
  variants: [
    { size: "S", color: "Negro", sku: "QA-PRUEBA-NEG-S" },
    { size: "M", color: "Negro", sku: "QA-PRUEBA-NEG-M" },
  ],
  ...overrides,
});

async function login(app) {
  assert.equal((await app.call("/api/session", "POST", { password })).status, 200);
}
async function variantId(app, productId, size) {
  const list = await app.call("/api/admin/products");
  const product = list.data.products.find((p) => p.id === productId);
  const variant = product.variants.find((v) => v.size === size);
  assert.ok(variant, `variant ${size}`);
  return variant.id;
}
async function stock(app, id, qty) {
  const result = await app.call(`/api/admin/inventory/${id}/movements`, "POST", {
    type: "entry",
    qty,
    reason: "Conteo sintético",
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.variant;
}

test("Migraciones versionadas e idempotentes conservan productos y pedidos", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-migrate-"));
  const databasePath = path.join(folder, "orders.sqlite");
  let app;
  try {
    app = await start({ databasePath });
    await login(app);
    const created = await app.call("/api/admin/products", "POST", productInput());
    assert.equal(created.status, 201);
    // Size-only request resolves to the seeded hoodie (legacy carts still work).
    const order = await app.call("/api/orders", "POST", request([{ size: "S", qty: 1 }]));
    assert.equal(order.status, 201);
    await app.close();
    app = null;

    const db = await openDatabase({ driver: "sqlite", path: databasePath });
    try {
      const before = {
        version: (await db.get("PRAGMA user_version")).user_version,
        products: (await db.get("SELECT COUNT(*) AS n FROM products")).n,
        variants: (await db.get("SELECT COUNT(*) AS n FROM variants")).n,
        orders: (await db.get("SELECT COUNT(*) AS n FROM orders")).n,
      };
      assert.equal(before.version, SCHEMA_VERSION);
      assert.equal(before.products, 2);
      // Running the same migrations again must change nothing.
      assert.equal(await migrate(db), SCHEMA_VERSION);
      assert.equal(await migrate(db), SCHEMA_VERSION);
      assert.equal(
        (await db.get("SELECT COUNT(*) AS n FROM products")).n,
        before.products,
      );
      assert.equal(
        (await db.get("SELECT COUNT(*) AS n FROM variants")).n,
        before.variants,
      );
      assert.equal(
        (await db.get("SELECT COUNT(*) AS n FROM orders")).n,
        before.orders,
      );
    } finally {
      await db.close();
    }

    app = await start({ databasePath });
    await login(app);
    const list = await app.call("/api/admin/products");
    assert.equal(list.data.products.length, 2);
    const orders = await app.call("/api/admin/orders");
    assert.equal(orders.data.orders.length, 1);
  } finally {
    if (app) await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Productos: crear, editar, publicar, despublicar y archivar sin perder referencias", async () => {
  const app = await start();
  try {
    await login(app);
    const created = await app.call("/api/admin/products", "POST", productInput());
    assert.equal(created.status, 201);
    const product = created.data.product;
    assert.equal(product.status, "draft");
    assert.equal(product.priceCents, 120000);
    assert.equal(product.variants.length, 2);
    // Draft products are not on the storefront.
    assert.equal((await app.call("/api/config")).data.catalog.length, 1);

    const published = await app.call(`/api/admin/products/${product.id}/status`, "POST", {
      status: "published",
    });
    assert.equal(published.status, 200);
    const catalog = (await app.call("/api/config")).data.catalog;
    assert.equal(catalog.length, 2);
    assert.ok(catalog.some((p) => p.id === product.id));

    const edited = await app.call(`/api/admin/products/${product.id}`, "PATCH", {
      ...productInput({ name: "Prenda editada", priceCents: 130000, status: "published" }),
      variants: product.variants.map((v) => ({ id: v.id, size: v.size, color: v.color, sku: v.sku })),
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.product.name, "Prenda editada");
    assert.equal(edited.data.product.priceCents, 130000);

    const hidden = await app.call(`/api/admin/products/${product.id}/status`, "POST", {
      status: "draft",
    });
    assert.equal(hidden.status, 200);
    assert.equal((await app.call("/api/config")).data.catalog.length, 1);

    const archived = await app.call(`/api/admin/products/${product.id}/status`, "POST", {
      status: "archived",
    });
    assert.equal(archived.status, 200);
    assert.equal(archived.data.product.status, "archived");
    // Archived products keep their variants and SKUs (historical references).
    assert.equal(archived.data.product.variants.length, 2);
    // Archived cannot be published again without review.
    assert.equal(
      (await app.call(`/api/admin/products/${product.id}/status`, "POST", { status: "published" })).status,
      409,
    );
  } finally {
    await app.close();
  }
});

test("SKU duplicado se rechaza al crear y al editar", async () => {
  const app = await start();
  try {
    await login(app);
    assert.equal((await app.call("/api/admin/products", "POST", productInput())).status, 201);
    const duplicate = await app.call(
      "/api/admin/products",
      "POST",
      productInput({ name: "Otra prenda", variants: [{ size: "L", color: "Negro", sku: "QA-PRUEBA-NEG-S" }] }),
    );
    assert.equal(duplicate.status, 409);
    assert.match(duplicate.data.error, /SKU/);
    const second = await app.call(
      "/api/admin/products",
      "POST",
      productInput({ name: "Tercera prenda", variants: [{ size: "L", color: "Negro", sku: "QA-TERCERA-L" }] }),
    );
    assert.equal(second.status, 201);
    const clash = await app.call(`/api/admin/products/${second.data.product.id}`, "PATCH", {
      ...productInput({ name: "Tercera prenda" }),
      variants: [{ id: second.data.product.variants[0].id, size: "L", color: "Negro", sku: "QA-PRUEBA-NEG-M" }],
    });
    assert.equal(clash.status, 409);
  } finally {
    await app.close();
  }
});

test("Inventario por talla y color: entradas, ajustes con motivo y sin negativos", async () => {
  const app = await start();
  try {
    await login(app);
    const created = await app.call(
      "/api/admin/products",
      "POST",
      productInput({
        status: "published",
        variants: [
          { size: "S", color: "Negro", sku: "QA-COLOR-NEG-S" },
          { size: "S", color: "Blanco", sku: "QA-COLOR-BLA-S" },
        ],
      }),
    );
    assert.equal(created.status, 201);
    const [negro, blanco] = created.data.product.variants;
    await stock(app, negro.id, 5);
    await stock(app, blanco.id, 2);
    const inventory = (await app.call("/api/admin/inventory")).data.variants;
    const neg = inventory.find((v) => v.id === negro.id);
    const bla = inventory.find((v) => v.id === blanco.id);
    assert.equal(neg.onHand, 5);
    assert.equal(neg.available, 5);
    assert.equal(bla.onHand, 2);
    assert.equal(neg.configured, true);

    // Manual adjustment needs a reason and can never go negative.
    assert.equal(
      (await app.call(`/api/admin/inventory/${negro.id}/movements`, "POST", { type: "adjustment", qty: -2 })).status,
      400,
    );
    assert.equal(
      (await app.call(`/api/admin/inventory/${negro.id}/movements`, "POST", { type: "adjustment", qty: -9, reason: "Conteo" })).status,
      409,
    );
    const adjusted = await app.call(`/api/admin/inventory/${negro.id}/movements`, "POST", {
      type: "adjustment",
      qty: -1,
      reason: "Conteo físico",
    });
    assert.equal(adjusted.status, 201);
    assert.equal(adjusted.data.variant.onHand, 4);
    const movements = (await app.call(`/api/admin/inventory/${negro.id}/movements`)).data.movements;
    assert.equal(movements.length, 2);
    assert.equal(movements[0].reason, "Conteo físico");
    assert.equal(movements[0].actor, "owner");
    assert.ok(movements[0].createdAt);
    assert.equal(
      (await app.call(`/api/admin/inventory/${negro.id}`, "PATCH", { lowStockThreshold: 5 })).status,
      200,
    );
  } finally {
    await app.close();
  }
});

test("Reserva, pago y cancelación mueven el stock una sola vez", async () => {
  const app = await start();
  try {
    await login(app);
    const product = (await app.call("/api/admin/products", "POST", productInput({ status: "published" }))).data.product;
    const variant = product.variants.find((v) => v.size === "M");
    await stock(app, variant.id, 3);

    const created = await app.call("/api/orders", "POST", request([{ productId: product.id, size: "M", qty: 2 }]));
    assert.equal(created.status, 201);
    let row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.onHand, 3);
    assert.equal(row.reserved, 2);
    assert.equal(row.available, 1);
    // The order keeps a commercial snapshot.
    const order = (await app.call("/api/admin/orders")).data.orders.find((o) => o.id === created.data.id);
    assert.deepEqual(
      { name: order.items[0].name, sku: order.items[0].sku, size: order.items[0].size, unitCents: order.items[0].unitCents, qty: order.items[0].qty },
      { name: "Prenda de prueba", sku: "QA-PRUEBA-NEG-M", size: "M", unitCents: 120000, qty: 2 },
    );

    const route = `/api/admin/orders/${created.data.id}`;
    assert.equal((await app.call(route, "PATCH", { version: 1, status: "awaiting_transfer", stockConfirmed: true, shippingCents: 0 })).status, 200);
    const paid = await app.call(route, "PATCH", { version: 2, status: "paid", paymentVerified: true });
    assert.equal(paid.status, 200);
    row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.onHand, 1);
    assert.equal(row.reserved, 0);
    // A repeated confirmation cannot discount twice.
    assert.equal((await app.call(route, "PATCH", { version: 2, status: "paid", paymentVerified: true })).status, 409);
    row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.onHand, 1);

    // Cancelling a paid order does not invent stock back.
    const cancelled = await app.call(route, "PATCH", { version: 3, status: "cancelled" });
    assert.equal(cancelled.status, 200);
    row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.onHand, 1);
    assert.equal(row.reserved, 0);
  } finally {
    await app.close();
  }
});

test("Cancelar antes del pago libera la reserva", async () => {
  const app = await start();
  try {
    await login(app);
    const product = (await app.call("/api/admin/products", "POST", productInput({ status: "published" }))).data.product;
    const variant = product.variants.find((v) => v.size === "S");
    await stock(app, variant.id, 2);
    const created = await app.call("/api/orders", "POST", request([{ productId: product.id, size: "S", qty: 1 }]));
    assert.equal(created.status, 201);
    let row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.reserved, 1);
    assert.equal(
      (await app.call(`/api/admin/orders/${created.data.id}`, "PATCH", { version: 1, status: "cancelled" })).status,
      200,
    );
    row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.reserved, 0);
    assert.equal(row.onHand, 2);
  } finally {
    await app.close();
  }
});

test("Dos solicitudes concurrentes por la última unidad: una gana y la otra se rechaza", async () => {
  const app = await start();
  try {
    await login(app);
    const product = (await app.call("/api/admin/products", "POST", productInput({ status: "published" }))).data.product;
    const variant = product.variants.find((v) => v.size === "S");
    await stock(app, variant.id, 1);
    const results = await Promise.all([
      app.call("/api/orders", "POST", request([{ productId: product.id, size: "S", qty: 1 }])),
      app.call("/api/orders", "POST", request([{ productId: product.id, size: "S", qty: 1 }])),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    const row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.reserved, 1);
    assert.equal(row.available, 0);
    assert.equal((await app.call("/api/admin/orders")).data.orders.length, 1);
  } finally {
    await app.close();
  }
});

test("Stock agotado y variante archivada bloquean la venta; sin configurar no se inventa stock", async () => {
  const app = await start();
  try {
    await login(app);
    const product = (await app.call("/api/admin/products", "POST", productInput({ status: "published" }))).data.product;
    const small = product.variants.find((v) => v.size === "S");
    const medium = product.variants.find((v) => v.size === "M");
    // Stock configured and counted down to zero: the size exists but cannot be sold.
    await stock(app, small.id, 1);
    assert.equal(
      (await app.call(`/api/admin/inventory/${small.id}/movements`, "POST", { type: "adjustment", qty: -1, reason: "Conteo" })).status,
      201,
    );
    assert.equal(
      (await app.call(`/api/admin/inventory/${small.id}/movements`, "POST", { type: "entry", qty: 0 })).status,
      400,
    );
    const blocked = await app.call("/api/orders", "POST", request([{ productId: product.id, size: "S", qty: 1 }]));
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /Sin stock suficiente/);

    // Unconfigured stock keeps today's behaviour: the order is accepted, nothing reserved.
    const accepted = await app.call("/api/orders", "POST", request([{ productId: product.id, size: "M", qty: 1 }]));
    assert.equal(accepted.status, 201);
    const row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === medium.id);
    assert.equal(row.configured, false);
    assert.equal(row.reserved, 0);

    // Archiving the variant removes it from the storefront and from new orders.
    const edited = await app.call(`/api/admin/products/${product.id}`, "PATCH", {
      ...productInput({ status: "published" }),
      variants: [
        { id: small.id, size: "S", color: "Negro", sku: "QA-PRUEBA-NEG-S", status: "archived" },
        { id: medium.id, size: "M", color: "Negro", sku: "QA-PRUEBA-NEG-M" },
      ],
    });
    assert.equal(edited.status, 200);
    const catalog = (await app.call("/api/config")).data.catalog.find((p) => p.id === product.id);
    assert.deepEqual(catalog.variants.map((v) => v.size), ["M"]);
    assert.equal((await app.call("/api/orders", "POST", request([{ productId: product.id, size: "S", qty: 1 }]))).status, 400);
  } finally {
    await app.close();
  }
});

test("La tienda solo ofrece variantes vendibles y marca las agotadas como deshabilitadas", async () => {
  const app = await start();
  try {
    await login(app);
    // The storefront page shows the first published product, so the seeded
    // hoodie is archived to make this synthetic product the visible one.
    const seeded = (await app.call("/api/admin/products")).data.products.find(
      (p) => p.name === "Hoodie Oversize",
    );
    assert.ok(seeded, "seeded hoodie");
    assert.equal(
      (await app.call(`/api/admin/products/${seeded.id}/status`, "POST", { status: "archived" })).status,
      200,
    );
    const product = (
      await app.call("/api/admin/products", "POST", productInput({ status: "published" }))
    ).data.product;
    const small = product.variants.find((v) => v.size === "S");
    await stock(app, small.id, 1);
    await app.call(`/api/admin/inventory/${small.id}/movements`, "POST", {
      type: "adjustment",
      qty: -1,
      reason: "Conteo sintético",
    });

    const config = (await app.call("/api/config")).data;
    const sizes = new Map(config.product.sizes.map((item) => [item.code, item]));
    // Sold out: visible, disabled, and excluded from the saleable list.
    assert.equal(sizes.get("S").soldOut, true);
    assert.equal(sizes.get("S").available, false);
    assert.equal(sizes.get("S").variantId, small.id);
    assert.equal(sizes.get("S").stockConfigured, true);
    assert.ok(!config.product.saleSizes.includes("S"));
    // Unconfigured stock stays sellable: no invented stock.
    assert.equal(sizes.get("M").soldOut, false);
    assert.equal(sizes.get("M").available, true);
    assert.ok(config.product.saleSizes.includes("M"));
    // Sizes without a variant are not offered at all.
    assert.equal(sizes.get("XXL").variantId, null);
    assert.equal(sizes.get("XXL").available, false);
    // The storefront price comes from the managed catalog, not the markup.
    assert.equal(config.unitCents, product.priceCents);
    assert.equal(config.product.priceCents, product.priceCents);

    // A bag that still carries the sold-out size is rejected with a clear reason.
    const rejected = await app.call(
      "/api/orders",
      "POST",
      request([{ productId: product.id, variantId: small.id, size: "S", qty: 1 }]),
    );
    assert.equal(rejected.status, 409);
    assert.match(rejected.data.error, /Sin stock suficiente para la talla S/);

    // The static storefront keeps the hooks the disabled state needs.
    const [html, script] = await Promise.all([
      readFile(new URL("../dist/index.html", import.meta.url), "utf8"),
      readFile(new URL("../dist/app.js", import.meta.url), "utf8"),
    ]);
    assert.match(html, /id="sold-out-note"/);
    assert.match(html, /id="product-price"/);
    assert.match(script, /is-sold-out/);
    assert.match(script, /variantId/);
  } finally {
    await app.close();
  }
});

test("La bolsa rechaza más de 99 prendas en total, aunque cada talla esté dentro del rango", async () => {
  const app = await start();
  try {
    await login(app);
    const tooMany = await app.call(
      "/api/orders",
      "POST",
      request([
        { productId: "PRD-HOODIE-0001", size: "S", qty: 60 },
        { productId: "PRD-HOODIE-0001", size: "M", qty: 60 },
      ]),
    );
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /Máximo 99 prendas/);
    const orders = (await app.call("/api/admin/orders")).data;
    assert.equal(orders.total, 0);
  } finally {
    await app.close();
  }
});

test("Un pedido histórico no cambia al editar o archivar el producto", async () => {  const app = await start();
  try {
    await login(app);
    const product = (await app.call("/api/admin/products", "POST", productInput({ status: "published" }))).data.product;
    const created = await app.call("/api/orders", "POST", request([{ productId: product.id, size: "M", qty: 1 }]));
    assert.equal(created.status, 201);
    const before = (await app.call("/api/admin/orders")).data.orders.find((o) => o.id === created.data.id);

    const edited = await app.call(`/api/admin/products/${product.id}`, "PATCH", {
      ...productInput({ name: "Nombre nuevo", priceCents: 999000, status: "published" }),
      variants: product.variants.map((v) => ({ id: v.id, size: v.size, color: v.color, sku: v.sku })),
    });
    assert.equal(edited.status, 200);
    await app.call(`/api/admin/products/${product.id}/status`, "POST", { status: "archived" });
    const after = (await app.call("/api/admin/orders")).data.orders.find((o) => o.id === created.data.id);
    assert.deepEqual(after.items, before.items);
    assert.equal(after.items[0].name, "Prenda de prueba");
    assert.equal(after.items[0].unitCents, 120000);
    assert.equal(after.subtotalCents, 120000);
  } finally {
    await app.close();
  }
});

test("Sin sesión o desde otro origen no se puede administrar catálogo ni inventario", async () => {
  const app = await start();
  try {
    for (const [route, method, data] of [
      ["/api/admin/summary", "GET", undefined],
      ["/api/admin/products", "GET", undefined],
      ["/api/admin/products", "POST", productInput()],
      ["/api/admin/inventory", "GET", undefined],
      ["/api/admin/inventory/VAR-HOODIE-M/movements", "POST", { type: "entry", qty: 5 }],
    ]) {
      assert.equal((await app.call(route, method, data)).status, 401, route);
    }
    await login(app);
    assert.equal(
      (await app.call("/api/admin/products", "POST", productInput(), { Origin: "https://other.test" })).status,
      403,
    );
    assert.equal(
      (await app.call("/api/admin/products", "POST", productInput({ priceCents: -1 }))).status,
      400,
    );
    assert.equal(
      (await app.call("/api/admin/products", "POST", productInput({ images: [{ src: "../../etc/passwd" }] }))).status,
      400,
    );
    const summary = await app.call("/api/admin/summary");
    assert.equal(summary.status, 200);
    assert.deepEqual(Object.keys(summary.data.orders).sort(), ["awaitingPayment", "pending", "pendingShipments", "toPrepare"]);
    assert.ok(!JSON.stringify(summary).includes(password));
  } finally {
    await app.close();
  }
});

test("Solicitud duplicada y fallo de correo no reservan dos veces", async () => {
  const app = await start({
    email: {
      env: {
        EMAIL_ENABLED: "true",
        RESEND_API_KEY: "synthetic-catalog-email-secret",
        EMAIL_FROM: "store@example.test",
        ORDER_NOTIFICATION_EMAIL: "owner@example.test",
      },
      autoStart: false,
      logger: () => {},
      fetcher: async () => {
        throw Error("provider down");
      },
    },
  });
  try {
    await login(app);
    const product = (await app.call("/api/admin/products", "POST", productInput({ status: "published" }))).data.product;
    const variant = product.variants.find((v) => v.size === "S");
    await stock(app, variant.id, 2);
    const key = randomUUID();
    const first = await app.call("/api/orders", "POST", request([{ productId: product.id, size: "S", qty: 1 }], key));
    assert.equal(first.status, 201);
    const second = await app.call("/api/orders", "POST", request([{ productId: product.id, size: "S", qty: 1 }], key));
    assert.equal(second.status, 200);
    assert.equal(second.data.id, first.data.id);
    await app.email.drain();
    const row = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === variant.id);
    assert.equal(row.reserved, 1);
    assert.equal((await app.call("/api/admin/orders")).data.orders.length, 1);
    // The failed email never blocks the order or duplicates the reservation.
    const job = app.email.list(first.data.id).find((j) => j.audience === "owner");
    assert.equal(job.state, "uncertain");
    assert.ok(!JSON.stringify(app.email.list(first.data.id)).includes("synthetic-catalog-email-secret"));
  } finally {
    await app.close();
  }
});

test("Reintentos concurrentes idénticos crean un solo pedido y una sola reserva", async () => {
  const app = await start();
  try {
    await login(app);
    await stock(app, "VAR-HOODIE-M", 1);
    const input = request([{ variantId: "VAR-HOODIE-M", qty: 1 }]);
    const responses = await Promise.all(Array.from({ length: 8 }, () => app.call("/api/orders", "POST", input)));
    assert.equal(responses.filter((r) => r.status === 201).length, 1);
    assert.ok(responses.every((r) => [200, 201].includes(r.status)), JSON.stringify(responses));
    assert.equal(new Set(responses.map((r) => r.data.id)).size, 1);
    const inventory = (await app.call("/api/admin/inventory")).data.variants.find((v) => v.id === "VAR-HOODIE-M");
    assert.equal(inventory.reserved, 1);
    assert.equal((await app.call("/api/admin/orders")).data.total, 1);
    const movements = (await app.call("/api/admin/inventory/VAR-HOODIE-M/movements")).data.movements;
    assert.equal(movements.filter((m) => m.type === "reserve").length, 1);
  } finally { await app.close(); }
});
