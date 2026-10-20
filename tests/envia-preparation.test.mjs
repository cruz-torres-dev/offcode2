import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../server/server.mjs";
import { readiness } from "../server/owner-settings.mjs";

const origin = "http://127.0.0.1:9876", password = "synthetic-envia-preparation-password";
const token = "synthetic-saved-envia-token";
const sender = { name: "Remitente de prueba", phone: "520000000000", email: "origen@example.test",
  street: "Calle Ficticia", number: "1", district: "Colonia Ficticia", city: "Ciudad Ficticia",
  state: "GT", country: "MX", postalCode: "37000" };
const customer = { name: "Destino de prueba", phone: "520000000000", email: "destino@example.test",
  street: "Calle Ficticia 2", neighborhood: "Colonia Ficticia", city: "Ciudad Ficticia", state: "GT", postalCode: "37000" };
const profiles = { 1: { weight: 0.75, dimensions: { length: 30, width: 20, height: 10 } } };
const sales = { whatsapp: "520000000000", bank: { name: "FICTICIO", beneficiary: "FICTICIO", clabe: "000000000000000000" } };
function mockEnvia(calls, respond) {
  return async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    if (url.endsWith("/state?country_code=MX"))
      return Response.json({ data: [{ name: "Guanajuato", code_2_digits: "GT" }] });
    assert.ok(url.endsWith("/ship/rate/"), "ninguna operación puede generar una guía");
    if (respond) return respond(url, options);
    return Response.json({ meta: "rate", data: [{ carrier: "fedex", currency: "MXN", service: "ground", serviceDescription: "FedEx terrestre", totalPrice: 185.2 }] });
  };
}
async function start({ fetcher, envia = {}, ...options } = {}) {
  const app = await createApp({ origin, production: false, password, settingsKey: "ab".repeat(32),
    databasePath: ":memory:", enabled: false, ordersEnabledEnv: "false", privacyUrl: "", termsUrl: "", whatsapp: "",
    bank: { name: "", beneficiary: "", clabe: "" },
    email: { env: {}, autoStart: false, logger: () => {} }, customers: { env: {}, logger: () => {} },
    ...options, envia: { enabled: false, environment: "production", token, sender, profiles, fetch: fetcher, ...envia } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const requestOrigin = options.origin ?? origin;
  let cookie = "";
  async function call(route, data, method = data ? "POST" : "GET", extra = {}) {
    const response = await fetch(base + route, { method, headers: { Origin: requestOrigin, Cookie: cookie, "Content-Type": "application/json", ...extra },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, data: await response.json() };
  }
  const login = () => call("/api/session", { password });
  const settings = async () => (await call("/api/admin/settings")).data;
  const quote = (data = {}, extra) => call("/api/admin/envia/rates", { version: 0, variantId: "VAR-HOODIE-M", qty: 1, customer, ...data }, "POST", extra);
  return { ...app, call, login, settings, quote };
}
async function snapshot(db) {
  const tables = ["orders", "order_reservations", "shipping_jobs", "shipping_quotes", "inventory", "inventory_movements", "owner_settings", "customers"];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await db.all(`SELECT * FROM ${table}`)])));
}

test("Preparación: datos comerciales, páginas legales, Envia y pedidos tienen estados independientes", async () => {
  const app = await start();
  try {
    await app.login();
    const data = await app.settings(), checks = Object.fromEntries(data.checks.map((c) => [c.id, c]));
    assert.equal(checks.shipping.ok, true); assert.equal(checks.mode.ok, true);
    assert.equal(checks.sales.ok, false); assert.equal(checks.legal.ok, false); assert.equal(checks.orders.ok, false);
    assert.equal(data.ordersLockedByEnv, true);
    assert.equal(checks.legal.optional, true);
    assert.match(checks.legal.detail, /no bloquea/);
    const sales = { ...data.settings, envia: { ...data.settings.envia, token }, whatsapp: "520000000000", bank: { name: "FICTICIO", beneficiary: "FICTICIO", clabe: "000000000000000000" } };
    const next = Object.fromEntries(readiness(sales, { production: true, keyConfigured: true, passwordConfigured: true, lockedByEnv: true }).map((c) => [c.id, c]));
    assert.equal(next.sales.ok, true); assert.equal(next.legal.ok, false); assert.equal(next.shipping.ok, true); assert.equal(next.orders.ok, false);
  } finally { await app.close(); }
});

test("Guardar y validar Envia sin URLs legales conserva el token, el origen y el bloqueo de pedidos", async () => {
  const calls = [], app = await start({ fetcher: mockEnvia(calls) });
  try {
    await app.login();
    const before = await app.settings(), settings = before.settings;
    settings.envia.enabled = true; settings.envia.token = "";
    const save = await app.call("/api/admin/settings", { version: 0, settings, currentPassword: password }, "PATCH");
    assert.equal(save.status, 200);
    const saved = await app.settings();
    assert.equal(saved.settings.envia.tokenConfigured, true); assert.equal(saved.settings.envia.token, undefined);
    for (const [key, value] of Object.entries(sender)) assert.equal(saved.settings.envia.sender[key], value);
    assert.deepEqual(saved.settings.bank, before.settings.bank);
    assert.equal(saved.settings.privacyUrl, ""); assert.equal(saved.settings.termsUrl, "");
    assert.equal(saved.settings.enabled, false);
    assert.equal((await app.call("/api/admin/envia/check", {})).status, 200);
    assert.equal((await app.quote({ version: 1 })).status, 200);
    assert.equal((await app.call("/api/orders", {})).status, 503);
    assert.equal((await app.call("/api/config")).data.enabled, false);
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(token));
    assert.equal(calls.length, 3); // catalogue, then catalogue + rate for the isolated probe
  } finally { await app.close(); }
});

test("Cotización privada: autorización, origen y versión; no llama Envia al rechazar la solicitud", async () => {
  const calls = [], app = await start({ fetcher: mockEnvia(calls) });
  try {
    assert.equal((await app.quote()).status, 401);
    await app.login();
    assert.equal((await app.quote({}, { Origin: "https://other.test" })).status, 403);
    assert.equal((await app.quote({ version: 9 })).status, 409);
    assert.equal((await app.quote({ qty: 0 })).status, 400);
    assert.equal((await app.quote({ variantId: "unknown" })).status, 400);
    assert.equal((await app.quote({ customer: { ...customer, postalCode: "bad" } })).status, 400);
    assert.equal((await app.quote({ qty: 2 })).status, 422);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test("Tarifas de producción con Envia desactivado y pedidos cerrados: precio del catálogo, sin guías ni escrituras", async () => {
  const calls = [], app = await start({ fetcher: mockEnvia(calls) });
  try {
    await app.login();
    const before = await snapshot(app.db);
    const result = await app.quote({ unitCents: 1, sender: { street: "No debe usarse" }, token: "No debe usarse" });
    assert.equal(result.status, 200); assert.equal(result.data.environment, "production");
    assert.equal(result.data.rates[0].shippingCents, 18520);
    assert.match(result.data.message, /No se creó pedido, reserva ni guía/);
    assert.deepEqual(calls.map((c) => c.url), ["https://queries.envia.com/state?country_code=MX", "https://api.envia.com/ship/rate/"]);
    const payload = JSON.parse(calls[1].options.body);
    assert.deepEqual(payload.origin, sender); assert.deepEqual(payload.packages[0].dimensions, profiles[1].dimensions);
    assert.equal(payload.packages[0].weight, profiles[1].weight); assert.equal(payload.packages[0].declaredValue, 1650);
    assert.equal(payload.shipment.carrier, "fedex");
    assert.deepEqual(await snapshot(app.db), before);
    assert.equal((await app.settings()).settings.envia.enabled, false);
    assert.equal((await app.call("/api/shipping/rates", {})).status, 503);
    assert.equal((await app.call("/api/orders", {})).status, 503);
  } finally { await app.close(); }
});

test("Origen o empaque incompletos impiden cotizar, no el guardado de preparación ni el catálogo", async () => {
  for (const envia of [{ sender: {} }, { profiles: {} }]) {
    const calls = [], app = await start({ fetcher: mockEnvia(calls), envia });
    try {
      await app.login();
      const before = await app.settings();
      assert.equal((await app.call("/api/admin/settings", { settings: before.settings, version: 0, currentPassword: password }, "PATCH")).status, 200);
      assert.equal((await app.quote({ version: 1 })).status, 400);
      assert.equal(calls.length, 0);
      assert.equal((await app.call("/api/admin/envia/check", {})).status, 200);
      assert.equal((await app.call("/api/config")).data.enabled, false);
    } finally { await app.close(); }
  }
});

test("No se reutiliza silenciosamente un token de otro entorno y las URLs legales son opcionales al abrir pedidos", async () => {
  const app = await start({ ordersEnabledEnv: "unset" });
  try {
    await app.login();
    const before = await app.settings(), settings = before.settings;
    settings.envia.environment = "sandbox";
    assert.equal((await app.call("/api/admin/settings", { settings, version: 0, currentPassword: password }, "PATCH")).status, 400);
    settings.envia.environment = "production";
    Object.assign(settings, { enabled: true, ...sales });
    const result = await app.call("/api/admin/settings", { settings, version: 0, currentPassword: password }, "PATCH");
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const saved = await app.settings();
    assert.equal(saved.settings.enabled, true);
    assert.equal(saved.settings.privacyUrl, ""); assert.equal(saved.settings.termsUrl, "");
    assert.equal((await app.call("/api/config")).data.enabled, true);
  } finally { await app.close(); }
});

test("Activar pedidos y FedEx sin URLs legales permite cotizar y guardar una solicitud con consentimiento y stock contado", async () => {
  const calls = [], app = await start({ ordersEnabledEnv: "true", origin: "https://offcode.mx", production: true, fetcher: mockEnvia(calls) });
  const items = [{ size: "M", qty: 1 }];
  try {
    assert.equal((await app.login()).status, 200);
    const before = await app.settings(), settings = { ...before.settings, ...sales, enabled: true,
      envia: { ...before.settings.envia, enabled: true } };
    const saved = await app.call("/api/admin/settings", { settings, version: before.version, currentPassword: password }, "PATCH");
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const after = await app.settings();
    assert.equal(after.settings.enabled, true); assert.equal(after.settings.envia.enabled, true);
    assert.equal(after.settings.privacyUrl, ""); assert.equal(after.settings.termsUrl, "");
    const legal = after.checks.find((check) => check.id === "legal");
    assert.equal(legal.optional, true); assert.equal(legal.ok, false);
    const config = (await app.call("/api/config")).data;
    assert.equal(config.enabled, true); assert.equal(config.shipping.enabled, true);
    assert.equal(config.shipping.environment, "production");
    assert.equal(config.privacyUrl, ""); assert.equal(config.termsUrl, "");
    assert.equal((await app.call("/api/shipping/rates", { items, customer, consent: false })).status, 400);
    assert.equal((await app.call("/api/shipping/rates", { items, customer, consent: true })).status, 400,
      "la ausencia de documentos no permite vender inventario sin contar");
    assert.equal(calls.length, 0);
    assert.equal((await app.call("/api/admin/inventory/VAR-HOODIE-M/movements", { type: "entry", qty: 2, reason: "Conteo sintético" })).status, 201);
    const quoted = await app.call("/api/shipping/rates", { items, customer, consent: true });
    assert.equal(quoted.status, 200, JSON.stringify(quoted.data));
    assert.equal(quoted.data.rates[0].shippingCents, 18520);
    assert.deepEqual(calls.map((call) => call.url), ["https://queries.envia.com/state?country_code=MX", "https://api.envia.com/ship/rate/"]);
    const request = { requestKey: randomUUID(), items, customer, consent: true, shippingQuoteId: quoted.data.rates[0].id,
      totalAccepted: true, acceptedTotalCents: quoted.data.rates[0].totalCents, paymentMethod: "bank_transfer" };
    assert.equal((await app.call("/api/orders", { ...request, consent: false })).status, 400);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
    const created = await app.call("/api/orders", request);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    assert.equal((await app.call("/api/orders", request)).status, 200, "un reintento no duplica el pedido");
    const row = await app.db.get("SELECT payload FROM orders WHERE id=?", [created.data.id]), order = JSON.parse(row.payload);
    assert.equal(order.status, "awaiting_transfer");
    assert.equal(order.shipping.carrier, "fedex"); assert.equal(order.shipping.environment, "production");
    assert.equal(order.shippingCents, 18520); assert.equal(order.totalCents, 183520);
    assert.ok(Number.isFinite(Date.parse(order.consent.at)));
    assert.equal(order.consent.privacyUrl, ""); assert.equal(order.consent.termsUrl, "");
    const stock = await app.db.get("SELECT on_hand,reserved FROM inventory WHERE variant_id=?", ["VAR-HOODIE-M"]);
    assert.deepEqual([stock.on_hand, stock.reserved], [2, 1]);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 1);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM shipping_jobs")).n, 0, "cotizar y pedir no compra una guía");
    assert.equal(calls.length, 2, "todos los contactos externos usan el proveedor simulado");
  } finally { await app.close(); }
});

test("Las URLs opcionales no omiten el cierre por entorno ni la validación de contraseña, banco o Sandbox", async () => {
  const calls = [], locked = await start({ fetcher: mockEnvia(calls) });
  try {
    await locked.login();
    const before = await locked.settings();
    const blocked = await locked.call("/api/admin/settings", { version: before.version, currentPassword: password,
      settings: { ...before.settings, ...sales, enabled: true, envia: { ...before.settings.envia, enabled: true } } }, "PATCH");
    assert.equal(blocked.status, 409); assert.match(blocked.data.error, /ORDERS_ENABLED=false/);
    assert.equal((await locked.call("/api/config")).data.enabled, false);
    assert.equal((await locked.call("/api/orders", {})).status, 503);
    assert.equal((await locked.call("/api/shipping/rates", {})).status, 503);
    assert.equal(calls.length, 0);
  } finally { await locked.close(); }
  const app = await start({ ordersEnabledEnv: "true", origin: "https://offcode.mx", production: true, fetcher: mockEnvia(calls) });
  try {
    await app.login();
    const before = await app.settings(), settings = { ...before.settings, ...sales, enabled: true };
    const wrongPassword = await app.call("/api/admin/settings", { settings, version: before.version, currentPassword: "wrong-password" }, "PATCH");
    assert.equal(wrongPassword.status, 401);
    for (const bank of [{ ...sales.bank, name: "" }, { ...sales.bank, beneficiary: "" }, { ...sales.bank, clabe: "123" }]) {
      const rejected = await app.call("/api/admin/settings", { settings: { ...settings, bank }, version: before.version, currentPassword: password }, "PATCH");
      assert.equal(rejected.status, 400);
    }
    const sandbox = await app.call("/api/admin/settings", { settings: { ...settings,
      envia: { ...settings.envia, enabled: true, environment: "sandbox", token: "synthetic-sandbox-token" } },
      version: before.version, currentPassword: password }, "PATCH");
    assert.equal(sandbox.status, 400); assert.match(sandbox.data.error, /Sandbox/);
    assert.equal((await app.call("/api/config")).data.enabled, false);
    assert.equal((await app.settings()).version, before.version);
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
  await assert.rejects(() => start({ ordersEnabledEnv: "true", enabled: true, password: "", ...sales }), /contraseña/i);
});

test("Errores de Envia no exponen credenciales ni domicilios, tampoco habilitan pedidos", async () => {
  const calls = [], app = await start({ envia: { environment: "sandbox" }, fetcher: mockEnvia(calls,
    () => Response.json({ meta: "error", error: `${token} ${sender.street}` })) });
  try {
    await app.login();
    const result = await app.quote();
    assert.equal(result.status, 502);
    assert.doesNotMatch(JSON.stringify(result.data), new RegExp(`${token}|${sender.street}`));
    assert.equal(calls[1].url, "https://api-test.envia.com/ship/rate/");
    assert.equal((await app.call("/api/config")).data.enabled, false);
  } finally { await app.close(); }
});

test("Un cambio concurrente de configuración invalida el resultado de la prueba privada", async () => {
  let finish, reached;
  const pending = new Promise((r) => { finish = r; }), started = new Promise((r) => { reached = r; });
  const calls = [], app = await start({ fetcher: mockEnvia(calls, async () => {
    reached(); await pending;
    return Response.json({ meta: "rate", data: [{ carrier: "fedex", currency: "MXN", service: "ground", totalPrice: 185.2 }] });
  }) });
  try {
    await app.login();
    const request = app.quote();
    await started;
    const before = await app.settings();
    assert.equal((await app.call("/api/admin/settings", { settings: before.settings, version: 0, currentPassword: password }, "PATCH")).status, 200);
    finish();
    assert.equal((await request).status, 409);
    assert.equal((await app.call("/api/config")).data.enabled, false);
  } finally { finish(); await app.close(); }
});
