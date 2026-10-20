import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { checkoutApp, bag, customer } from "./helpers/checkout-app.mjs";
import { checkoutDom } from "./helpers/checkout-dom.mjs";
import { orderDurations } from "../server/order-access.mjs";

const accepted = () => Response.json({ id: "12345678-1234-4234-8234-123456789abc" });
const mailEnv = { EMAIL_ENABLED: "true", RESEND_API_KEY: "synthetic-recovery-mail", EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test" };
async function fixture(options = {}) {
  const sent = [], logs = [];
  let clock = Date.now(), failing = false, n = 0;
  const app = await checkoutApp({ ...options, orderLifecycle: { now: () => clock, autoStart: false, logger: (value) => logs.push(value), ...options.orderLifecycle },
    email: { env: mailEnv, autoStart: false, logger: (value) => logs.push(value), ...options.email,
      fetcher: async (_, request) => { sent.push(JSON.parse(request.body)); return failing ? Response.json({}, { status: 503 }) : accepted(); } } });
  const create = async (extra = {}) => {
    const destination = { ...customer, email: `recovery-${++n}@example.test` };
    const quote = (await app.quote(bag, destination)).data.rates[0];
    const input = app.request(quote, { customer: destination, ...extra });
    const response = await app.call("/api/orders", input);
    assert.equal(response.status, 201);
    return { ...response.data, input };
  };
  const raw = async (route, data = {}, cookie = "") => {
    const response = await fetch(app.origin + route, { method: "POST", headers: { Origin: app.origin, "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie") ?? "",
      referrer: response.headers.get("referrer-policy") };
  };
  const order = async (id) => { const row = await app.db.get("SELECT payload,version FROM orders WHERE id=?", [id]); return { ...JSON.parse(row.payload), version: row.version }; };
  const edit = async (id, change) => { const value = await order(id); const { version, ...payload } = change(value) ?? value;
    await app.db.run("UPDATE orders SET payload=? WHERE id=?", [JSON.stringify(payload), id]); };
  const drain = async () => { for (let i = 0; i < 12; i++) await app.email.drain(); };
  return Object.assign(app, { create, raw, order, edit, drain, sent, logs, now: () => clock,
    advance: (ms) => { clock += ms; }, failMail: (value) => { failing = value; } });
}
const endpoint = (order, action = "transfer") => `/api/orders/${order.id}/${action}`;
const cookieOnly = (header) => header.split(";")[0];
// `requested` is only reachable through a direct API call with Envia disabled:
// the storefront blocks submit unless a rate is accepted, so the real checkout
// always creates `awaiting_transfer`.
async function requestedApp(options = {}) {
  const app = await fixture({ ...options, shippingEnabled: false });
  const request = async (extra = {}) => {
    const input = { requestKey: randomUUID(), items: bag, consent: true,
      customer: { ...customer, email: `request-${randomBytes(4).toString("hex")}@example.test` }, ...extra };
    const response = await app.call("/api/orders", input);
    assert.equal(response.status, 201);
    return { ...response.data, input };
  };
  return Object.assign(app, { request });
}
function recoveryMessage(app, id) { return app.sent.find((mail) => mail.to[0] !== mailEnv.ORDER_NOTIFICATION_EMAIL && mail.text.includes(id)); }
function tokenFrom(mail) { return mail.text.match(/#access=([A-Za-z0-9_-]{43})/)[1]; }
async function temporary(work) {
  const folder = await mkdtemp(path.join(tmpdir(), "offcode-recovery-"));
  try { return await work(folder); }
  finally { const relative = path.relative(tmpdir(), path.resolve(folder)); assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative)); await rm(folder, { recursive: true, force: true }); }
}

test("Recuperación: duraciones estrictas, reserva 48 h y acceso 30 días por defecto", () => {
  assert.deepEqual(orderDurations({ env: {} }), { reservationMs: 48 * 3600e3, accessMs: 720 * 3600e3 });
  for (const value of ["", " 48 ", "48.5", "48h", 0, -1, 1.5, NaN, Infinity, {}, 169])
    assert.throws(() => orderDurations({ env: {}, reservationHours: value }));
  for (const accessHours of [0, 23, 2161, "30d", false]) assert.throws(() => orderDurations({ env: {}, accessHours }));
  assert.throws(() => orderDurations({ env: {}, accessHours: 24, reservationHours: 48 }));
  assert.equal(orderDurations({ env: { ORDER_RESERVATION_TTL_HOURS: "1", ORDER_ACCESS_TTL_HOURS: "24" } }).reservationMs, 3600e3);
});

test("Recuperación: correo, nueva sesión y cookie limitada permiten volver al mismo pedido sin otra creación", async () => {
  const app = await fixture();
  try {
    const created = await app.create({ requestKey: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }); await app.drain();
    const message = recoveryMessage(app, created.id), token = tokenFrom(message);
    assert.ok(token === created.accessToken, "el correo reutiliza la credencial del pedido");
    const oldDerived = createHash("sha256").update(`offcode-order-access-v1\n${created.id}\n${created.input.requestKey}`).digest("base64url");
    assert.ok(token !== oldDerived, "la nueva llave no se deriva de un valor elegido por el navegador");
    assert.ok(message.html.includes("Consultar mi pedido"));
    assert.ok(!app.sent.find((mail) => mail.to[0] === mailEnv.ORDER_NOTIFICATION_EMAIL).text.includes(token), "el propietario no recibe el acceso invitado");
    const firstBrowser = await app.raw(endpoint(created, "access"), { accessToken: token });
    assert.equal(firstBrowser.status, 200); assert.equal(firstBrowser.data.order.id, created.id);
    assert.equal(firstBrowser.data.order.totalCents, created.totalCents);
    assert.match(firstBrowser.cookie, /HttpOnly; SameSite=Lax/); assert.ok(firstBrowser.cookie.includes(`Path=/api/orders/${created.id}/`));
    assert.equal(firstBrowser.referrer, "no-referrer");
    const cookieView = await app.raw(endpoint(created), {}, cookieOnly(firstBrowser.cookie));
    assert.equal(cookieView.status, 200); assert.equal(cookieView.data.order.id, created.id);
    // Represents another browser with no storage and no cookies from the first.
    const reopened = await app.raw(endpoint(created, "access"), { accessToken: token });
    assert.equal(reopened.status, 200);
    const reported = await app.raw(endpoint(created, "transfer-report"), { confirmed: true }, cookieOnly(reopened.cookie));
    assert.equal(reported.status, 201); assert.equal(reported.data.order.status, "awaiting_transfer");
    assert.equal((await app.raw(endpoint(created, "transfer-report"), { confirmed: true }, cookieOnly(reopened.cookie))).status, 200);
    const retry = await app.call("/api/orders", created.input);
    assert.equal(retry.status, 200); assert.equal(retry.data.id, created.id);
    assert.equal((await app.snapshot()).orders.length, 1); assert.equal((await app.snapshot()).order_reservations.length, 1);
    assert.ok(!app.logs.join("\n").includes(token));
    assert.ok(!app.logs.join("\n").includes(app.password));
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});

test("Recuperación: referencia sola, llave inválida/alterada/vencida, otro pedido y administración se rechazan", async () => {
  const app = await fixture({ orderLifecycle: { reservationHours: 1, accessHours: 24 } });
  try {
    const a = await app.create(), b = await app.create();
    assert.equal((await app.call(endpoint(a), {})).status, 401);
    const changed = a.accessToken.slice(0, -1) + (a.accessToken.endsWith("A") ? "B" : "A");
    const before = await app.snapshot();
    for (const accessToken of ["invalid", randomBytes(32).toString("base64url"), changed, b.accessToken])
      assert.equal((await app.raw(endpoint(a, "access"), { accessToken })).status, 404);
    assert.equal((await app.call(`/api/admin/orders/${a.id}`, { accessToken: a.accessToken, status: "paid", paymentVerified: true }, "PATCH")).status, 401);
    assert.deepEqual(await app.snapshot(), before);
    app.advance(24 * 3600e3);
    assert.equal((await app.raw(endpoint(a, "access"), { accessToken: a.accessToken })).status, 404);
    assert.ok(!app.logs.join("\n").includes(a.accessToken));
  } finally { await app.close(); }
});

test("Caducidad: reserva activa vencida se cancela y libera una sola vez con motivo y correo idempotentes", async () => {
  const app = await fixture({ orderLifecycle: { reservationHours: 1 } });
  try {
    const created = await app.create(), initial = await app.snapshot();
    assert.equal(Date.parse(created.reservationExpiresAt) - Date.parse((await app.order(created.id)).createdAt), 3600e3);
    app.advance(3599e3); assert.equal(await app.expiration.sweep(), 0);
    app.advance(1000); assert.equal(await app.expiration.sweep(), 1);
    const expired = await app.order(created.id);
    assert.equal(expired.status, "cancelled"); assert.equal(expired.cancellation.reason, "unpaid_transfer_expired");
    assert.equal(expired.history.at(-1).event, "reservation_expired"); assert.equal(expired.version, 2);
    const after = await app.snapshot();
    assert.equal(after.inventory.find((row) => row.variant_id === bag[0].variantId).on_hand, initial.inventory.find((row) => row.variant_id === bag[0].variantId).on_hand);
    assert.equal(after.order_reservations[0].state, "released");
    const releases = after.inventory_movements.filter((row) => row.type === "release");
    assert.equal(releases.length, 1); assert.equal(releases[0].actor, "system"); assert.equal(releases[0].reason, "unpaid_transfer_expired");
    await Promise.all(Array.from({ length: 8 }, () => app.expiration.expireOne(created.id)));
    assert.equal(await app.expiration.sweep(), 0); assert.deepEqual(await app.snapshot(), after);
    const view = await app.call(endpoint(created), { accessToken: created.accessToken });
    assert.equal(view.status, 200); assert.equal(view.data.order.cancellationReason, "unpaid_transfer_expired"); assert.equal(view.data.order.transfer, null);
    assert.equal((await app.call(endpoint(created, "transfer-report"), { accessToken: created.accessToken, confirmed: true })).status, 409);
    const retry = await app.call('/api/orders', created.input);
    assert.equal(retry.status, 200); assert.equal(retry.data.cancellationReason, 'unpaid_transfer_expired');
    assert.equal((await app.snapshot()).orders.length, 1);
    await app.drain();
    assert.equal(app.email.list(created.id).filter((job) => job.event === "cancelled").length, 1);
    assert.equal(app.sent.filter((mail) => mail.subject.includes("Tu solicitud venció")).length, 1);
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});

test("Caducidad: históricos sin fecha, avisos, pagados/enviados/entregados y reservas ya cerradas se conservan", async () => {
  const app = await fixture();
  try {
    const historical = await app.create(); await app.edit(historical.id, (order) => { delete order.reservationExpiresAt; return order; });
    const reported = await app.create();
    assert.equal((await app.call(endpoint(reported, "transfer-report"), { accessToken: reported.accessToken, confirmed: true })).status, 201);
    const paid = await app.create();
    assert.equal((await app.ownerCall(`/api/admin/orders/${paid.id}`, { version: 1, status: "paid", paymentVerified: true }, "PATCH")).status, 200);
    const shipped = await app.create(); await app.edit(shipped.id, (order) => ({ ...order, status: "shipped" }));
    const delivered = await app.create(); await app.edit(delivered.id, (order) => ({ ...order, status: "delivered" }));
    const cancelled = await app.create();
    assert.equal((await app.ownerCall(`/api/admin/orders/${cancelled.id}`, { version: 1, status: "cancelled" }, "PATCH")).status, 200);
    const released = await app.create();
    await app.db.run("UPDATE order_reservations SET state='released' WHERE order_id=?", [released.id]);
    const before = await app.snapshot(); app.advance(49 * 3600e3);
    assert.equal(await app.expiration.sweep(), 0); assert.deepEqual(await app.snapshot(), before);
    assert.equal((await app.order(historical.id)).reservationExpiresAt, undefined);
    assert.equal((await app.order(reported.id)).status, "awaiting_transfer");
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});

test("Caducidad: un fallo después de liberar revierte pedido, reserva y movimientos completos", async () => {
  const app = await fixture();
  try {
    const created = await app.create(); app.advance(49 * 3600e3);
    await app.db.exec(`CREATE TEMP TRIGGER block_expiry BEFORE UPDATE OF payload ON orders
      WHEN json_extract(NEW.payload,'$.cancellation.reason')='unpaid_transfer_expired'
      BEGIN SELECT RAISE(ABORT,'synthetic_expiry_failure'); END`);
    const before = await app.snapshot();
    await assert.rejects(app.expiration.expireOne(created.id), /synthetic_expiry_failure/);
    assert.deepEqual(await app.snapshot(), before);
    assert.equal(app.email.list(created.id).filter((job) => job.event === "cancelled").length, 0);
    await app.db.exec("DROP TRIGGER block_expiry");
    assert.equal(await app.expiration.expireOne(created.id), true);
  } finally { await app.close(); }
});

test("Concurrencia: aviso o pago contra caducidad tienen un único resultado coherente", async () => {
  const app = await fixture({ orderLifecycle: { reservationHours: 1 } });
  try {
    const reported = await app.create();
    await Promise.all([app.expiration.expireOne(reported.id), app.call(endpoint(reported, "transfer-report"), { accessToken: reported.accessToken, confirmed: true })]);
    app.advance(3600e3); assert.equal(await app.expiration.expireOne(reported.id), false);
    assert.ok((await app.order(reported.id)).transferReport);
    const expired = await app.create(); app.advance(3600e3);
    const [, notice] = await Promise.all([app.expiration.expireOne(expired.id), app.call(endpoint(expired, "transfer-report"), { accessToken: expired.accessToken, confirmed: true })]);
    assert.equal(notice.status, 409); assert.equal((await app.order(expired.id)).status, "cancelled");
    assert.equal((await app.order(expired.id)).transferReport, undefined);
    const paid = await app.create();
    const payment = await app.ownerCall(`/api/admin/orders/${paid.id}`, { version: 1, status: "paid", paymentVerified: true }, "PATCH");
    assert.equal(payment.status, 200); app.advance(3600e3);
    assert.equal(await app.expiration.expireOne(paid.id), false);
    const late = await app.create(); app.advance(3600e3);
    const [, rejected] = await Promise.all([app.expiration.expireOne(late.id), app.ownerCall(`/api/admin/orders/${late.id}`, { version: 1, status: "paid", paymentVerified: true }, "PATCH")]);
    assert.equal(rejected.status, 409); assert.equal((await app.order(late.id)).status, "cancelled");
    const rows = (await app.snapshot()).order_reservations;
    assert.equal(rows.find((row) => row.order_id === paid.id).state, "sold");
    assert.equal(rows.find((row) => row.order_id === late.id).state, "released");
  } finally { await app.close(); }
});

test("Reinicio: cola cifrada reintenta el mismo enlace; reserva vencida se resuelve al arrancar", async () => temporary(async (folder) => {
  const databasePath = path.join(folder, "orders.sqlite"), settingsKey = randomBytes(32).toString("hex");
  let app = await fixture({ databasePath, settingsKey });
  try {
    const created = await app.create(); app.failMail(true); await app.drain();
    const mail = recoveryMessage(app, created.id), token = tokenFrom(mail), payload = JSON.stringify(mail);
    const credential = await app.db.get("SELECT * FROM order_access WHERE order_id=?", [created.id]);
    assert.ok(Buffer.from(credential.token_hash).equals(createHash("sha256").update(token).digest()));
    assert.ok(!JSON.stringify(credential).includes(token));
    const directory = databasePath + ".email-outbox";
    for (const file of await readdir(directory)) assert.ok(!(await readFile(path.join(directory, file), "utf8")).includes(token), "el journal no guarda el acceso en texto plano");
    await app.close();
    app = await fixture({ databasePath, settingsKey, seedInventory: false });
    const pending = app.email.list(created.id).find((job) => job.audience === "buyer");
    assert.ok(app.email.retry(pending.id)); await app.drain();
    assert.ok(JSON.stringify(recoveryMessage(app, created.id)) === payload, "el reintento mantiene el cuerpo completo aunque cambie la URL local de la instancia");
    const reopened = await app.raw(endpoint(created, "access"), { accessToken: token }); assert.equal(reopened.status, 200);
    await app.edit(created.id, (order) => ({ ...order, reservationExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    await app.close();
    app = await fixture({ databasePath, settingsKey, seedInventory: false });
    assert.equal((await app.order(created.id)).status, "cancelled");
    await app.close(); app = await fixture({ databasePath, settingsKey, seedInventory: false });
    assert.equal((await app.snapshot()).inventory_movements.filter((row) => row.type === "release").length, 1);
    assert.equal((await app.raw(endpoint(created, "access"), { accessToken: token })).data.order.cancellationReason, "unpaid_transfer_expired");
    assert.equal(app.email.list(created.id).filter((job) => job.event === "cancelled").length, 1);
  } finally { await app.close(); }
}));

test("Dos procesos SQLite expiran la misma reserva: una cancelación y una liberación", async () => temporary(async (folder) => {
  const databasePath = path.join(folder, "orders.sqlite");
  const app = await fixture({ databasePath }); let children = [];
  try {
    const created = await app.create();
    await app.edit(created.id, (order) => ({ ...order, reservationExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    const worker = fileURLToPath(new URL("./helpers/expire-worker.mjs", import.meta.url));
    children = [0, 1].map(() => fork(worker, [databasePath, created.id], { execArgv: [], env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH }, stdio: ["ignore", "ignore", "ignore", "ipc"] }));
    await Promise.all(children.map((child) => once(child, "message")));
    const results = children.map((child) => once(child, "message")); children.forEach((child) => child.send("expire"));
    const responses = (await Promise.all(results)).map(([result]) => result);
    assert.ok(responses.every((result) => !result.failed), "los dos procesos completaron la comprobación sin errores");
    const changed = responses.map((result) => result.changed);
    assert.equal(changed.filter(Boolean).length, 1);
    assert.equal((await app.snapshot()).inventory_movements.filter((row) => row.type === "release").length, 1);
    assert.equal((await app.order(created.id)).history.filter((entry) => entry.event === "reservation_expired").length, 1);
  } finally { children.forEach((child) => child.kill()); await app.close(); }
}));

test("Compatibilidad: llave histórica se actualiza una vez sin cambiar el pedido ni asignar vencimiento retroactivo", async () => {
  const app = await fixture();
  try {
    const created = await app.create(); await app.db.run("DELETE FROM order_access WHERE order_id=?", [created.id]);
    await app.edit(created.id, (order) => { delete order.reservationExpiresAt; return order; });
    const before = await app.snapshot();
    const old = createHash("sha256").update(`offcode-order-access-v1\n${created.id}\n${created.input.requestKey}`).digest("base64url");
    const upgraded = await app.call(endpoint(created), { accessToken: old });
    assert.equal(upgraded.status, 200); assert.ok(upgraded.data.accessToken && upgraded.data.accessToken !== old);
    assert.deepEqual(await app.snapshot(), before);
    assert.equal((await app.call(endpoint(created), { accessToken: old })).status, 404);
    assert.equal((await app.call(endpoint(created), { accessToken: upgraded.data.accessToken })).status, 200);
  } finally { await app.close(); }
});

test("Interfaz: fragmento se retira, se intercambia por cookie y vencido muestra el estado confirmado", async () => {
  const app = await fixture();
  try {
    const created = await app.create(); app.advance(49 * 3600e3); await app.expiration.sweep();
    const view = (await app.call(endpoint(created), { accessToken: created.accessToken })).data;
    const config = (await app.call("/api/config")).data;
    const page = await checkoutDom(config, { bag: [], search: "?pedido=" + created.id, hash: "#access=" + created.accessToken,
      fetcher: async (route, options) => { assert.ok(route.endsWith("/access")); assert.ok(JSON.parse(options.body).accessToken === created.accessToken); return { ok: true, json: async () => view }; } });
    assert.ok(page.history[0] === "/checkout.html?pedido=" + created.id);
    assert.ok(!page.history.some((url) => url.includes(created.accessToken)));
    assert.equal(page.nodes.get("#transfer-heading").textContent, "Tu solicitud venció");
    assert.equal(page.nodes.get("#transfer-instructions").hidden, true);
    assert.equal(page.nodes.get("#transfer-report").hidden, true);
    assert.match(page.nodes.get("#transfer-state").textContent, /Inicia una nueva solicitud/);
    assert.equal(page.nodes.get("#summary-total").textContent, new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(created.totalCents / 100));
  } finally { await app.close(); }
});

test("Caducidad por lotes: un ciclo limita el trabajo a 25 pedidos y continúa con el resto", async () => {
  const app = await fixture();
  try {
    assert.equal((await app.ownerCall('/api/admin/inventory/VAR-HOODIE-M/movements', { type: 'entry', qty: 50, reason: 'Conteo sintético para lotes' })).status, 201);
    for (let i = 0; i < 26; i++) await app.create();
    app.advance(49 * 3600e3);
    assert.equal(await app.expiration.sweep(), 25);
    assert.equal((await app.snapshot()).orders.filter((row) => JSON.parse(row.payload).status === 'awaiting_transfer').length, 1);
    assert.equal(await app.expiration.sweep(), 1);
    assert.equal(await app.expiration.sweep(), 0);
    assert.equal((await app.snapshot()).inventory_movements.filter((row) => row.type === 'release').length, 26);
  } finally { await app.close(); }
});

test("Migración y reinicio: un pedido histórico sin fecha conserva payload, versión y reserva", async () => temporary(async (folder) => {
  const databasePath = path.join(folder, 'historical.sqlite'), settingsKey = randomBytes(32).toString('hex');
  let app = await fixture({ databasePath, settingsKey });
  try {
    const created = await app.create();
    await app.edit(created.id, (order) => { delete order.reservationExpiresAt; order.createdAt = new Date(Date.now() - 90 * 86400e3).toISOString(); return order; });
    await app.db.run('DELETE FROM order_access WHERE order_id=?', [created.id]);
    await app.db.exec('DROP TABLE order_access');
    await app.db.exec('PRAGMA user_version=3');
    const before = await app.snapshot(); await app.close();
    app = await fixture({ databasePath, settingsKey, seedInventory: false });
    assert.deepEqual(await app.snapshot(), before);
    assert.equal((await app.db.get('PRAGMA user_version')).user_version, 4);
    assert.equal((await app.db.get('SELECT COUNT(*) AS n FROM order_access')).n, 0);
  } finally { await app.close(); }
}));

// --- Auditoría de estados iniciales y de la reserva en `requested` ----------

test("Estado inicial: el checkout cotizado crea awaiting_transfer con banco; sin cotización no hay solicitud con banco", async () => {
  const app = await fixture();
  try {
    const quoted = await app.create();
    assert.equal(quoted.status, "awaiting_transfer");
    assert.ok(quoted.transfer && quoted.transfer.clabe, "un pedido cotizado muestra datos bancarios desde el inicio");
    assert.ok(Number.isSafeInteger(quoted.totalCents), "un pedido cotizado nace con total aceptado");
    // Envia habilitado y sin cotización: el servidor rechaza, no crea `requested` con banco.
    const bare = await app.call("/api/orders", { requestKey: randomUUID(), items: bag, consent: true,
      customer: { ...customer, email: "sin-cotizacion@example.test" } });
    assert.equal(bare.status, 409);
    assert.equal((await app.snapshot()).orders.length, 1);
    // La tienda tampoco puede enviar el formulario sin una tarifa aceptada.
    const source = await readFile(new URL("../dist/checkout.js", import.meta.url), "utf8");
    assert.match(source, /!config\.shipping\?\.enabled/, "el checkout exige Envia habilitado para enviar");
    assert.match(source, /if \(!selectedRate \|\| Date\.parse\(selectedRate\.expiresAt\) <= Date\.now\(\)\)/, "el checkout exige una tarifa vigente");
  } finally { await app.close(); }
});

test("Caducidad: una solicitud en requested sin datos bancarios vence y libera su reserva una sola vez", async () => {
  const app = await requestedApp({ orderLifecycle: { reservationHours: 1 } });
  try {
    const created = await app.request(), initial = await app.snapshot(), variant = bag[0].variantId;
    assert.equal(created.status, "requested");
    assert.equal(created.transfer, null, "requested nunca muestra datos bancarios");
    assert.equal(created.totalCents, null, "requested no tiene total aceptado");
    assert.ok(Date.parse(created.reservationExpiresAt) > app.now());
    assert.ok(initial.order_reservations[0].state === "reserved");
    // Separación real: sin banco no se puede reportar una transferencia.
    const view = await app.call(endpoint(created), { accessToken: created.accessToken });
    assert.equal(view.status, 200); assert.equal(view.data.order.transfer, null);
    assert.equal((await app.call(endpoint(created, "transfer-report"), { accessToken: created.accessToken, confirmed: true })).status, 409);
    app.advance(3599e3); assert.equal(await app.expiration.sweep(), 0);
    app.advance(1000); assert.equal(await app.expiration.sweep(), 1);
    const expired = await app.order(created.id);
    assert.equal(expired.status, "cancelled");
    assert.equal(expired.cancellation.reason, "unpaid_transfer_expired");
    assert.equal(expired.cancellation.previousStatus, "requested");
    assert.equal(expired.history.at(-1).event, "reservation_expired");
    assert.equal(expired.version, 2);
    const after = await app.snapshot();
    assert.equal(after.inventory.find((row) => row.variant_id === variant).reserved, 0);
    assert.equal(after.inventory.find((row) => row.variant_id === variant).on_hand, initial.inventory.find((row) => row.variant_id === variant).on_hand);
    assert.equal(after.order_reservations[0].state, "released");
    const releases = after.inventory_movements.filter((row) => row.type === "release");
    assert.equal(releases.length, 1);
    assert.equal(releases[0].actor, "system"); assert.equal(releases[0].reason, "unpaid_transfer_expired");
    // Idempotente: repetir la ejecución no toca inventario, historial ni versión.
    await Promise.all(Array.from({ length: 6 }, () => app.expiration.expireOne(created.id)));
    assert.equal(await app.expiration.sweep(), 0);
    assert.deepEqual(await app.snapshot(), after);
    assert.equal((await app.order(created.id)).history.length, expired.history.length);
    const closed = await app.call(endpoint(created), { accessToken: created.accessToken });
    assert.equal(closed.data.order.cancellationReason, "unpaid_transfer_expired");
    assert.equal(closed.data.order.transfer, null);
    await app.drain();
    assert.equal(app.email.list(created.id).filter((job) => job.event === "cancelled").length, 1);
    assert.equal(app.sent.filter((mail) => mail.subject.includes("Tu solicitud venció")).length, 1);
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});

test("Caducidad: un requested con guía, aviso, pago, reserva cerrada o sin fecha no se cancela", async () => {
  const app = await requestedApp();
  try {
    const labelled = await app.request();
    await app.db.run("INSERT INTO shipping_jobs(order_id,state,payload) VALUES(?,?,?)",
      [labelled.id, "pending", JSON.stringify({ environment: "sandbox" })]);
    const reported = await app.request();
    await app.edit(reported.id, (order) => ({ ...order, transferReport: { at: new Date().toISOString(), channel: "order_link" } }));
    const paid = await app.request();
    await app.edit(paid.id, (order) => ({ ...order, status: "paid", history: [...order.history, { at: new Date().toISOString(), status: "paid" }] }));
    const released = await app.request();
    await app.db.run("UPDATE order_reservations SET state='released' WHERE order_id=?", [released.id]);
    const historical = await app.request();
    await app.edit(historical.id, (order) => { delete order.reservationExpiresAt; return order; });
    const before = await app.snapshot();
    app.advance(49 * 3600e3);
    assert.equal(await app.expiration.sweep(), 0);
    assert.deepEqual(await app.snapshot(), before);
    assert.equal((await app.order(labelled.id)).status, "requested");
    assert.equal((await app.order(reported.id)).status, "requested");
    assert.equal((await app.order(paid.id)).status, "paid");
    assert.equal((await app.order(historical.id)).reservationExpiresAt, undefined);
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});
