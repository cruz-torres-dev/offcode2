import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApp } from "../server/server.mjs";
import { PRODUCT, SALE_SIZES, publicProduct } from "../server/catalog.mjs";

const origin = "http://localhost:8000",
  password = "synthetic-product-admin-password";
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
const emailEnv = {
  EMAIL_ENABLED: "true",
  RESEND_API_KEY: "synthetic-email-secret-do-not-expose",
  EMAIL_FROM: "store@example.test",
  ORDER_NOTIFICATION_EMAIL: "owner@example.test",
};
const order = (size, qty = 1) => ({
  requestKey: randomUUID(),
  customer,
  consent: true,
  items: [{ size, qty }],
});
const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");

async function start(email = {}) {
  const logs = [];
  const app = await createApp({
    origin,
    password,
    databasePath: ":memory:",
    enabled: true,
    bank: { name: "Banco privado", beneficiary: "Titular privado", clabe: "000000000000000000" },
    whatsapp: "520000000000",
    privacyUrl: "https://example.test/privacy",
    termsUrl: "https://example.test/terms",
    // No Envia/shipping option: the provider is unavailable, as in production before setup.
    email: {
      env: emailEnv,
      autoStart: false,
      logger: (value) => logs.push(value),
      fetcher: async () => {
        throw Error(emailEnv.RESEND_API_KEY);
      },
      ...email,
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  const call = async (route, method = "GET", data) => {
    const r = await fetch(base + route, {
      method,
      headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, data: await r.json() };
  };
  return { ...app, call, logs };
}

test("Ficha pública: datos confirmados, seis tallas contempladas y cuatro habilitadas", async () => {
  const app = await start();
  try {
    const { status, data } = await app.call("/api/config");
    assert.equal(status, 200);
    const product = data.product;
    assert.equal(product.name, "Hoodie Oversize");
    assert.equal(product.color, "Negro");
    assert.equal(product.composition, "100% algodón");
    assert.equal(product.fabricWeightGsm, 420);
    assert.equal(product.fit, "Oversize");
    assert.deepEqual(
      product.sizes.map((s) => s.code),
      ["XS", "S", "M", "L", "XL", "XXL"],
    );
    assert.deepEqual(
      product.sizes.filter((s) => s.available).map((s) => s.code),
      ["S", "M", "L", "XL"],
    );
    assert.deepEqual(product.saleSizes, ["S", "M", "L", "XL"]);
    // The tech pack has no measurement table: nothing may be invented here.
    assert.deepEqual(product.measurements.rows, {});
    assert.equal(product.measurements.unit, "cm");
    assert.equal(product.preparation.businessDays, null);
    assert.ok(!JSON.stringify(data).includes(emailEnv.RESEND_API_KEY));
    assert.ok(!JSON.stringify(data).includes("synthetic-envia-token"));
    // Only commercial fields are published; no supplier, cost or print details.
    assert.deepEqual(Object.keys(product).sort(), [
      "color", "composition", "fabricWeightGsm", "fit", "id", "line", "measurements",
      "name", "preparation", "priceCents", "saleSizes", "season", "sizes",
    ]);
    // Sizes now come from the managed catalog; the static facts stay as reference.
    assert.match(product.id, /^PRD-/);
    assert.equal(product.priceCents, 165000);
    assert.deepEqual(
      product.sizes.map((s) => s.code),
      publicProduct().sizes.map((s) => s.code),
    );
  } finally {
    await app.close();
  }
});

test("Catálogo: tallas del TECH PACK no habilitadas se rechazan y no crean pedido", async () => {
  const app = await start();
  try {
    for (const size of ["XS", "XXL", "xs", "m", "XXXL", "", null]) {
      const result = await app.call("/api/orders", "POST", order(size));
      assert.equal(result.status, 400, String(size));
      assert.match(result.data.error, /Tallas habilitadas: S, M, L, XL/);
    }
    assert.equal((await app.call("/api/orders", "POST", order("S", 0))).status, 400);
    assert.equal((await app.call("/api/orders", "POST", order("S", 100))).status, 400);
    await app.call("/api/session", "POST", { password });
    assert.equal((await app.call("/api/admin/orders")).data.orders.length, 0);
    assert.deepEqual(SALE_SIZES, ["S", "M", "L", "XL"]);
    assert.deepEqual(
      PRODUCT.sizes.map((s) => s.code),
      ["XS", "S", "M", "L", "XL", "XXL"],
    );
  } finally {
    await app.close();
  }
});

test("Fallo del correo y proveedor de envío no disponible conservan el pedido", async () => {
  const app = await start();
  try {
    const created = await app.call("/api/orders", "POST", order("M", 2));
    assert.equal(created.status, 201);
    await app.email.drain();
    const job = app.email.list(created.data.id).find((j) => j.audience === "owner");
    assert.equal(job.state, "uncertain");
    assert.ok(job.canRetry);
    await app.call("/api/session", "POST", { password });
    const list = await app.call("/api/admin/orders");
    assert.equal(list.data.orders.length, 1);
    const saved = list.data.orders[0];
    assert.equal(saved.id, created.data.id);
    assert.equal(saved.shippingCents, null);
    assert.equal(saved.totalCents, null);
    assert.equal(saved.shipping, null);
    assert.equal(saved.items[0].size, "M");
    assert.equal(saved.items[0].qty, 2);
    assert.ok(!JSON.stringify(list).includes(emailEnv.RESEND_API_KEY));
    assert.ok(!JSON.stringify(app.logs).includes(emailEnv.RESEND_API_KEY));
  } finally {
    await app.close();
  }
});

test("FedEx sin configurar: la cotización se bloquea y el pedido no guarda datos de envío", async () => {
  const app = await start();
  try {
    const config = await app.call("/api/config");
    assert.equal(config.data.shipping.enabled, false);
    assert.equal(config.data.shipping.carrier, "FedEx");
    const rates = await app.call("/api/shipping/rates", "POST", {
      items: [{ size: "M", qty: 1 }],
      customer,
      consent: true,
    });
    assert.equal(rates.status, 503);
    assert.match(rates.data.error, /todavía no habilitados/i);
    assert.equal((await app.call("/api/shipping/states")).status, 503);
    assert.ok(!JSON.stringify(config).includes("synthetic-envia-token"));
  } finally {
    await app.close();
  }
});

test("Guía de tallas accesible, sin medidas inventadas y con el selector limitado a la venta", async () => {
  const selectable = [...html.matchAll(/data-size="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(selectable, ["S", "M", "L", "XL"]);
  assert.match(html, /id="size-guide"/);
  assert.match(html, /aria-labelledby="size-guide-title"/);
  assert.match(html, /id="size-guide-open"[\s\S]{0,120}aria-haspopup="dialog"/);
  assert.match(html, /aria-controls="size-guide"/);
  const guide = html.slice(html.indexOf('id="size-guide"'));
  const rows = [...guide.matchAll(/data-guide-size="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(rows, ["XS", "S", "M", "L", "XL", "XXL"]);
  const statuses = [...guide.matchAll(/data-guide-status[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  assert.deepEqual(statuses, [
    "Por confirmar",
    "Disponible",
    "Disponible",
    "Disponible",
    "Disponible",
    "Por confirmar",
  ]);
  // No centimetre table is published while the brand has not confirmed measurements.
  assert.match(guide, /id="guide-measures-table" hidden/);
  assert.doesNotMatch(guide, /\d+\s?(cm|centímetros)\b/i);
  assert.match(guide, /no mostramos cifras\s+estimadas/i);
});
