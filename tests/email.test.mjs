import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { createEmailTransport, renderEmailV1, validEmail } from "../server/email.mjs";
import { createEmailOutbox } from "../server/email-outbox.mjs";

const origin = "http://localhost:8000", password = "synthetic-email-admin-password";
const env = { EMAIL_ENABLED: "true", RESEND_API_KEY: "synthetic-email-secret-do-not-expose",
  EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test" };
const customer = { name: "Persona Sintetica", email: "buyer@example.test", phone: "520000000000",
  street: "Domicilio privado 123", neighborhood: "Colonia privada", city: "Ciudad", state: "Estado", postalCode: "00000", notes: "Dato privado" };
const bank = { name: "Banco privado", beneficiary: "Titular privado", clabe: "000000000000000000" };
const request = () => ({ requestKey: randomUUID(), customer, consent: true, items: [{ size: "M", qty: 2 }] });
const accepted = () => new Response(JSON.stringify({ id: "12345678-1234-4234-8234-123456789abc" }), { status: 200 });
async function start(email = {}, databasePath = ":memory:") {
  const logs = [], calls = [];
  const app = await createApp({ origin, password, databasePath, enabled: true, bank,
    whatsapp: "520000000000", privacyUrl: "https://example.test/privacy", termsUrl: "https://example.test/terms",
    email: { env, autoStart: false, logger: (value) => logs.push(value),
      fetcher: async (url, options) => { calls.push({ url, ...options, body: JSON.parse(options.body) }); return accepted(); }, ...email },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  async function call(route, method = "GET", data, headers = {}) {
    const r = await fetch(base + route, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, data: await r.json(), cache: r.headers.get("cache-control") };
  }
  return { ...app, call, logs, calls };
}
const forbidden = [env.RESEND_API_KEY, customer.street, customer.name, customer.phone, customer.notes, bank.name, bank.beneficiary, bank.clabe];
function noSensitive(value) { for (const secret of forbidden) assert.ok(!JSON.stringify(value).includes(secret), secret); }

test("Correo desactivado por defecto, configuración incompleta e inyección de cabeceras", async () => {
  for (const config of [{}, { ...env, EMAIL_ENABLED: "false" }, { ...env, EMAIL_FROM: "" }, { ...env, ORDER_NOTIFICATION_EMAIL: "" }]) {
    const t = createEmailTransport({ env: config, fetcher: () => { throw Error("Must not call"); } });
    assert.equal(t.enabled, false);
    assert.equal((await t.send({}, "unused")).state, "disabled");
  }
  assert.equal(validEmail("buyer@example.test\r\nBcc: evil@example.test"), false);
  const app = await start({ env: {} });
  try {
    const r = await app.call("/api/orders", "POST", request());
    assert.equal(r.status, 201);
    await app.email.drain();
    assert.equal(app.calls.length, 0);
    assert.ok(app.email.list(r.data.id).every((j) => j.state === "skipped"));
    assert.ok(app.logs.some((s) => s.includes('"code":"disabled"')));
    noSensitive(app.logs);
  } finally { await app.close(); }
});

test("Pedido único: propietario y comprador; transiciones confirmadas; API privada y sin filtraciones", async () => {
  const app = await start();
  try {
    assert.equal((await app.call("/api/admin/email-notifications?orderId=missing")).status, 401);
    const input = request();
    const created = await app.call("/api/orders", "POST", input);
    assert.equal(created.status, 201);
    assert.equal((await app.call("/api/orders", "POST", input)).data.id, created.data.id);
    noSensitive(created);
    await Promise.all([app.email.drain(), app.email.drain()]);
    await app.email.drain();
    assert.equal(app.calls.length, 2);
    assert.notEqual(app.calls[0].headers["Idempotency-Key"], app.calls[1].headers["Idempotency-Key"]);
    assert.deepEqual(app.calls.map((c) => c.body.to[0]), [env.ORDER_NOTIFICATION_EMAIL, customer.email]);
    for (const c of app.calls) {
      noSensitive(c.body);
      assert.match(c.body.text, /no confirma disponibilidad, pago ni envío/);
      assert.match(c.body.html, /lang="es"/);
    }
    await app.call("/api/session", "POST", { password });
    const route = "/api/admin/orders/" + created.data.id;
    assert.equal((await app.call(route, "PATCH", { version: 1, status: "shipped" })).status, 409);
    await app.email.drain();
    assert.equal(app.calls.length, 2);
    let version = 1;
    for (const change of [
      { status: "awaiting_transfer", stockConfirmed: true, shippingCents: 10000 },
      { status: "paid", paymentVerified: true },
      { status: "shipped", handedToCarrier: true, carrier: "FedEx", tracking: "SYNTHETIC-TRACKING-123" },
      { status: "delivered" },
    ]) {
      assert.equal((await app.call(route, "PATCH", { version, ...change })).status, 200);
      assert.equal((await app.call(route, "PATCH", { version, ...change })).status, 409);
      version++;
      await app.email.drain();
    }
    assert.equal(app.calls.length, 6);
    assert.match(app.calls[2].body.text, /3400.00 MXN/);
    assert.match(app.calls[4].body.text, /SYNTHETIC-TRACKING-123/);
    for (const c of app.calls) noSensitive(c.body);
    const status = await app.call("/api/admin/email-notifications?orderId=" + created.data.id);
    assert.equal(status.cache, "no-store");
    assert.ok(status.data.notifications.every((j) => j.state === "accepted" && !j.canRetry));
    noSensitive(status);
    assert.ok(!JSON.stringify(status).includes(customer.email));
    noSensitive(app.logs);
    assert.equal((await app.call("/api/config")).data.RESEND_API_KEY, undefined);
    const cancelled = await app.call("/api/orders", "POST", request());
    await app.call("/api/admin/orders/" + cancelled.data.id, "PATCH", { version: 1, status: "cancelled" });
    for (let i = 0; i < 3; i++) await app.email.drain();
    assert.match(app.calls.at(-1).body.text, /no confirma ni realiza un reembolso/);
  } finally { await app.close(); }
});

test("Error del proveedor no pierde ni duplica pedidos; reintento privado usa idéntica clave y cuerpo", async () => {
  let failing = true;
  const sent = [];
  const app = await start({ fetcher: async (_, opts) => {
    sent.push({ key: opts.headers["Idempotency-Key"], body: opts.body });
    return failing ? new Response(JSON.stringify({ error: env.RESEND_API_KEY + customer.street }), { status: 503 }) : accepted();
  } });
  try {
    const input = request();
    const created = await app.call("/api/orders", "POST", input);
    await app.email.drain();
    const job = app.email.list(created.data.id)[0];
    assert.equal(job.state, "uncertain");
    assert.equal((await app.call("/api/orders", "POST", input)).data.id, created.data.id);
    const retry = `/api/admin/email-notifications/${job.id}/retry`;
    assert.equal((await app.call(retry, "POST", {})).status, 401);
    await app.call("/api/session", "POST", { password });
    assert.equal((await app.call(retry, "POST", {}, { Origin: "https://other.test" })).status, 403);
    failing = false;
    assert.equal((await app.call(retry, "POST", {})).status, 202);
    await app.email.drain();
    assert.deepEqual(sent[0], sent[1]);
    assert.equal(app.email.list(created.data.id)[0].state, "accepted");
    assert.equal((await app.call("/api/admin/orders")).data.orders.length, 1);
    noSensitive(app.logs);
  } finally { await app.close(); }
});

test("Timeout y respuestas malformadas nunca se marcan aceptadas; errores no filtran proveedor", async () => {
  for (const fetcher of [
    () => new Promise(() => {}),
    async () => { throw Error(env.RESEND_API_KEY); },
    async () => new Response('{"error":"bad"}', { status: 200 }),
    async () => new Response("bad json", { status: 200 }),
  ]) {
    const transport = createEmailTransport({ env, fetcher, timeoutMs: 10 });
    const result = await transport.send({ from: env.EMAIL_FROM, to: [customer.email] }, "test-key");
    assert.equal(result.state, "uncertain");
    noSensitive(result);
  }
  const rejected = createEmailTransport({ env, fetcher: async () => new Response("secret", { status: 401 }) });
  assert.deepEqual(await rejected.send({ from: env.EMAIL_FROM, to: [customer.email] }, "key"), { state: "failed", code: "http_401" });
});

test("Journal durable: reinicio no duplica, reanuda incertidumbre y bloquea reintento después de 23 horas", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-email-"));
  const dbPath = path.join(folder, "orders.sqlite");
  let timestamp = Date.now();
  const sent = [];
  let app;
  const options = { now: () => timestamp, fetcher: async (_, opts) => {
    sent.push({ key: opts.headers["Idempotency-Key"], body: opts.body }); return accepted();
  } };
  try {
    app = await start(options, dbPath);
    const created = await app.call("/api/orders", "POST", request());
    await app.email.drain();
    await app.email.drain();
    await app.close();
    app = await start(options, dbPath);
    await app.email.drain();
    assert.equal(sent.length, 2);
    const rows = app.email.list(created.data.id);
    await app.close();
    // Simulate process loss after provider acceptance but before local completion.
    const file = path.join(dbPath + ".email-outbox", rows.find((j) => j.audience === "owner").id + ".json");
    const stored = JSON.parse(await readFile(file, "utf8"));
    const body = JSON.parse(sent[0].body);
    stored.data = { template: 1, from: body.from, to: body.to[0], orderId: created.data.id,
      event: "requested", audience: "owner", items: [{ size: "M", qty: 2 }], totalCents: null, tracking: "" };
    stored.state = "sending";
    await writeFile(file, JSON.stringify(stored));
    app = await start(options, dbPath);
    await app.email.drain();
    assert.deepEqual(sent[0], sent[2]);
    await app.close();
    stored.state = "uncertain";
    await writeFile(file, JSON.stringify(stored));
    timestamp += 24 * 60 * 60 * 1000;
    app = await start(options, dbPath);
    await app.email.drain();
    assert.equal(sent.length, 3);
    assert.equal(app.email.list(created.data.id).find((j) => j.id === stored.id).state, "review");
    assert.equal(app.email.retry(stored.id), false);
    for (const f of await readdir(dbPath + ".email-outbox")) {
      const saved = await readFile(path.join(dbPath + ".email-outbox", f), "utf8");
      noSensitive(saved);
      assert.ok(!saved.includes('"html"') && !saved.includes('"text"'));
    }
  } finally { if (app) await app.close(); await rm(folder, { recursive: true, force: true }); }
});

test("Arranque inicial omite histórico; direcciones inválidas y estados superados no se envían", async () => {
  const order = { id: "OF-111111111111", customer, items: [{ size: "M", qty: 1 }], status: "requested", history: [{ status: "requested" }] };
  const calls = [];
  const box = await createEmailOutbox({ databasePath: ":memory:", listOrders: () => [order], env,
    fetcher: async (...args) => { calls.push(args); return accepted(); }, logger: () => {}, autoStart: false });
  await box.drain();
  assert.equal(calls.length, 0);
  order.history.push({ status: "awaiting_transfer" }); order.status = "awaiting_transfer"; order.totalCents = 165000;
  box.capture(order);
  order.history.push({ status: "paid" }); order.status = "paid"; order.customer = { ...customer, email: "not-an-email" };
  box.capture(order);
  await box.drain();
  assert.equal(calls.length, 0);
  assert.ok(box.list(order.id).some((j) => j.state === "superseded"));
  assert.ok(box.list(order.id).some((j) => j.code === "invalid_data"));
  await box.close();
});

test("El pedido responde sin esperar al proveedor y las plantillas escapan el HTML", async () => {
  let release;
  const app = await start({ fetcher: () => new Promise((resolve) => { release = () => resolve(accepted()); }) });
  try {
    const created = await app.call("/api/orders", "POST", request());
    const sending = app.email.drain();
    assert.equal(app.email.list(created.data.id)[0].state, "sending");
    const second = await app.call("/api/orders", "POST", request());
    assert.equal(second.status, 201);
    release(); await sending;
    const rendered = renderEmailV1({ event: "shipped", audience: "buyer", orderId: "OF-TEST",
      from: env.EMAIL_FROM, to: customer.email, tracking: '<img src=x onerror="bad()">' });
    assert.ok(!rendered.html.includes('<img src=x'));
    assert.match(rendered.html, /&lt;img/);
  } finally { release?.(); await app.close(); }
});
