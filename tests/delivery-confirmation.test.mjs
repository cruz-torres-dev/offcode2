import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../server/server.mjs";

const origin = "http://127.0.0.1:9876";
const id = "OF-000000000001";
const route = "/api/admin/orders/" + id;

async function fixture(status = "shipped") {
  const password = randomBytes(24).toString("hex");
  const messages = [], providerCalls = [];
  const app = await createApp({ origin, production: false, env: {}, databasePath: ":memory:",
    enabled: false, ordersEnabledEnv: "false", waitlistEnabled: false, settingsKey: "", password,
    bank: { name: "", beneficiary: "", clabe: "" }, whatsapp: "", privacyUrl: "", termsUrl: "",
    envia: { enabled: false, environment: "sandbox", token: "", sender: {}, profiles: {},
      fetch: async () => { providerCalls.push("envia"); throw Error("Unexpected provider call"); } },
    email: { env: {}, autoStart: false, logger: () => {},
      fetcher: async () => { providerCalls.push("email"); throw Error("Unexpected provider call"); } },
    customers: { env: { EMAIL_ENABLED: "true", EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test", RESEND_API_KEY: "synthetic-only" },
      logger: () => {}, fetcher: async (_, options) => {
        messages.push(JSON.parse(options.body));
        return Response.json({ id: randomUUID() });
      } },
  });
  const at = "2026-10-19T12:00:00.000Z";
  const order = { id, createdAt: at, updatedAt: at, customer: { name: "FIXTURE SINTÉTICO", email: "fixture@example.test" },
    items: [], subtotalCents: 0, shippingCents: 0, totalCents: 0, status, carrier: "FedEx", tracking: "QA-NO-VALIDO",
    shipping: { carrier: "fedex", service: "ground", environment: "sandbox", description: "Fixture sin envío real" },
    history: [{ at, status }] };
  await app.db.run("INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)", [id, randomUUID(), at, JSON.stringify(order)]);
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const request = async (path, method, data, cookie = "", requestOrigin = origin) => {
    const response = await fetch(base + path, { method, headers: { Origin: requestOrigin, Cookie: cookie, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  };
  const login = await request("/api/session", "POST", { password });
  assert.equal(login.status, 200);
  const snapshot = () => app.db.get("SELECT version,payload FROM orders WHERE id=?", [id]);
  const patch = (data, cookie = login.cookie, requestOrigin = origin) => request(route, "PATCH", data, cookie, requestOrigin);
  const assertUnchanged = async (before) => {
    assert.deepEqual(await snapshot(), before, "un rechazo conserva estado, versión, fechas, historial y datos de envío");
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM shipping_jobs")).n, 0);
    assert.deepEqual(providerCalls, []);
    assert.equal(app.email.list(id).length, 0, "un rechazo no crea avisos de entrega");
  };
  return { ...app, request, patch, snapshot, assertUnchanged, messages, providerCalls };
}

test("Entrega: sin declaración explícita se rechaza y el pedido queda intacto", async () => {
  const app = await fixture();
  try {
    const before = await app.snapshot();
    const response = await app.patch({ version: 1, status: "delivered" });
    assert.equal(response.status, 400); assert.match(response.data.error, /Confirma.*entrega/);
    await app.assertUnchanged(before);
  } finally { await app.close(); }
});

test("Entrega: deliveryConfirmed false se rechaza sin modificar el pedido", async () => {
  const app = await fixture();
  try {
    const before = await app.snapshot();
    assert.equal((await app.patch({ version: 1, status: "delivered", deliveryConfirmed: false })).status, 400);
    await app.assertUnchanged(before);
  } finally { await app.close(); }
});

test("Entrega: valores de tipo incorrecto no sustituyen al booleano true", async () => {
  const app = await fixture();
  try {
    const before = await app.snapshot();
    for (const value of ["true", "false", "", 1, 0, null, {}, [], [true]]) {
      const response = await app.patch({ version: 1, status: "delivered", deliveryConfirmed: value });
      assert.equal(response.status, 400, `rechazo de ${JSON.stringify(value)}`);
      await app.assertUnchanged(before);
    }
  } finally { await app.close(); }
});

test("Entrega: true acepta shipped → delivered una vez y conserva los datos del envío", async () => {
  const app = await fixture();
  try {
    const before = JSON.parse((await app.snapshot()).payload);
    const response = await app.patch({ version: 1, status: "delivered", deliveryConfirmed: true });
    assert.equal(response.status, 200);
    const after = await app.snapshot(), saved = JSON.parse(after.payload);
    assert.equal(response.data.order.status, "delivered"); assert.equal(response.data.order.version, 2);
    assert.equal(after.version, 2); assert.equal(saved.status, "delivered");
    assert.deepEqual(saved.shipping, before.shipping); assert.equal(saved.carrier, before.carrier); assert.equal(saved.tracking, before.tracking);
    assert.deepEqual(saved.history.slice(0, -1), before.history);
    assert.deepEqual(saved.history.at(-1), { at: saved.updatedAt, status: "delivered" });
    assert.equal(saved.history.length, 2); assert.deepEqual(app.providerCalls, []);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM shipping_jobs")).n, 0);
  } finally { await app.close(); }
});

test("Entrega: sin sesión, cookie inválida o sesión de cliente no hay permisos de propietario", async () => {
  const app = await fixture();
  try {
    const before = await app.snapshot(), change = { version: 1, status: "delivered", deliveryConfirmed: true };
    for (const cookie of ["", "offcode_session=invalid"]) {
      assert.equal((await app.patch(change, cookie)).status, 401);
      await app.assertUnchanged(before);
    }
    const registered = await app.request("/api/customer/register", "POST", { email: "customer@example.test", password: "synthetic-customer-password" });
    assert.equal(registered.status, 200);
    const token = app.messages.at(-1).text.match(/#verify=([A-Za-z0-9_-]{43})/)[1];
    assert.equal((await app.request("/api/customer/verify", "POST", { token })).status, 200);
    const customer = await app.request("/api/customer/login", "POST", { email: "customer@example.test", password: "synthetic-customer-password" });
    assert.equal(customer.status, 200); assert.match(customer.cookie, /^offcode_customer=/);
    assert.equal((await app.patch(change, customer.cookie)).status, 401);
    await app.assertUnchanged(before);
  } finally { await app.close(); }
});

test("Entrega: otro origen sigue rechazado incluso con sesión y confirmación válidas", async () => {
  const app = await fixture();
  try {
    const before = await app.snapshot();
    const response = await app.patch({ version: 1, status: "delivered", deliveryConfirmed: true }, undefined, "https://other.example.test");
    assert.equal(response.status, 403); await app.assertUnchanged(before);
  } finally { await app.close(); }
});

test("Entrega: la declaración no permite saltar estados ni reabrir pedidos terminados", async () => {
  for (const status of ["requested", "awaiting_transfer", "paid", "cancelled", "delivered"]) {
    const app = await fixture(status);
    try {
      const before = await app.snapshot();
      const response = await app.patch({ version: 1, status: "delivered", deliveryConfirmed: true });
      assert.equal(response.status, 409, `estado de origen ${status}`);
      await app.assertUnchanged(before);
    } finally { await app.close(); }
  }
});

test("Entrega: versión obsoleta y reintentos no duplican la transición ni su historial", async () => {
  const app = await fixture();
  try {
    const before = await app.snapshot();
    assert.equal((await app.patch({ version: 0, status: "delivered", deliveryConfirmed: true })).status, 409);
    await app.assertUnchanged(before);
    const change = { version: 1, status: "delivered", deliveryConfirmed: true };
    const responses = await Promise.all([app.patch(change), app.patch(change)]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const after = await app.snapshot();
    assert.equal((await app.patch(change)).status, 409);
    assert.equal((await app.patch({ ...change, version: 2 })).status, 409);
    assert.deepEqual(await app.snapshot(), after);
    assert.equal(after.version, 2); assert.equal(JSON.parse(after.payload).history.length, 2);
  } finally { await app.close(); }
});
