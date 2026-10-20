import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { checkoutApp, bag, customer, syntheticBank } from "./helpers/checkout-app.mjs";
import { checkoutDom } from "./helpers/checkout-dom.mjs";
import { bankSnapshot, transferConcept, transferInstructions, TRANSFER_CONCEPT } from "../server/bank-transfer.mjs";

const emailEnv = { EMAIL_ENABLED: "true", RESEND_API_KEY: "synthetic-transfer-email-secret", EMAIL_FROM: "store@example.test",
  ORDER_NOTIFICATION_EMAIL: "owner@example.test" };
const accepted = () => new Response(JSON.stringify({ id: "12345678-1234-4234-8234-123456789abc" }), { status: 200 });
const bankPattern = /BANCO SINTÉTICO QA|PERSONA SINTÉTICA QA|000000000000000000/;
const reportedMessage = "Recibimos tu aviso. Revisaremos el depósito directamente en el banco. Este aviso no confirma que el pago haya sido recibido.";
const repeatedMessage = "Ya recibimos tu aviso de transferencia. Estamos verificando el depósito.";
const money = (cents) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
const buyer = (n) => ({ ...customer, email: `buyer${n}@example.test` });

// Email transport and customer verification are captured in memory: no message
// leaves the process and every delivery attempt is visible to the assertions.
async function flowApp(options = {}) {
  const sent = [], logs = [], verifications = [];
  let clock = Date.now();
  const app = await checkoutApp({ ...options,
    email: { env: emailEnv, autoStart: false, logger: (value) => logs.push(value),
      fetcher: async (_, request) => { sent.push(JSON.parse(request.body)); return accepted(); } },
    customers: { env: emailEnv, logger: (value) => logs.push(value), now: () => clock,
      fetcher: async (_, request) => { verifications.push(JSON.parse(request.body)); return accepted(); } } });
  const raw = async (route, data, { origin = app.origin, cookie = "", method = "POST" } = {}) => {
    const response = await fetch(app.origin + route, { method, headers: { Origin: origin, "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
  };
  const drain = async () => { for (let i = 0; i < 12; i++) await app.email.drain(); };
  const order = async (destination = customer, extra = {}) => {
    const rate = (await app.quote(bag, destination)).data.rates[0];
    const created = await app.call("/api/orders", app.request(rate, { customer: destination, ...extra }));
    return { rate, created };
  };
  const row = async (id) => {
    const value = await app.db.get("SELECT payload,version FROM orders WHERE id=?", [id]);
    return { ...JSON.parse(value.payload), version: value.version };
  };
  // Registers, verifies and logs in a synthetic account; returns its cookie.
  const account = async (email) => {
    const password = "synthetic-buyer-password-123";
    assert.equal((await raw("/api/customer/register", { email, password })).status, 200);
    const token = verifications.filter((m) => m.to[0] === email).at(-1).text.match(/#verify=([A-Za-z0-9_-]{43})/)[1];
    assert.equal((await raw("/api/customer/verify", { token })).status, 200);
    const login = await raw("/api/customer/login", { email, password });
    assert.equal(login.status, 200);
    return login.cookie;
  };
  return Object.assign(app, { sent, logs, raw, drain, order, row, account, advance: (ms) => { clock += ms; } });
}
const transferRoute = (id) => `/api/orders/${id}/transfer`, reportRoute = (id) => `/api/orders/${id}/transfer-report`;

test("Datos de transferencia: concepto SPEI estable y solo con cuenta completa", () => {
  assert.equal(transferConcept("OF-ADEEA41449B0"), "OFFCODE OFADEEA41449B0");
  assert.match(transferConcept("OF-ADEEA41449B0"), TRANSFER_CONCEPT);
  assert.ok(transferConcept("OF-FFFFFFFFFFFF").length <= 40);
  for (const id of ["OF-abc", "of-ADEEA41449B0", "OF-ADEEA41449B0 ", "", null]) assert.throws(() => transferConcept(id));
  assert.equal(bankSnapshot({ ...syntheticBank, clabe: "123" }), null);
  assert.equal(bankSnapshot({ ...syntheticBank, beneficiary: " " }), null);
  assert.equal(bankSnapshot(undefined), null);
  const order = { id: "OF-ADEEA41449B0", status: "awaiting_transfer", totalCents: 183520, transferAccount: syntheticBank,
    transferConcept: "OFFCODE OFADEEA41449B0" };
  assert.deepEqual(transferInstructions(order), { reference: order.id, concept: order.transferConcept, totalCents: 183520,
    currency: "MXN", bank: syntheticBank.name, beneficiary: syntheticBank.beneficiary, clabe: syntheticBank.clabe });
  for (const change of [{ status: "requested" }, { status: "paid" }, { status: "cancelled" }, { transferAccount: null },
    { transferConcept: "OFFCODE ñ" }, { transferConcept: "X".repeat(41) }, { totalCents: null }])
    assert.equal(transferInstructions({ ...order, ...change }), null);
});

test("Recorrido completo: pedido, datos, aviso confirmado e idempotente, verificación manual con una sola venta", async () => {
  const app = await flowApp();
  try {
    const { rate, created } = await app.order();
    assert.equal(created.status, 201);
    const id = created.data.id, accessToken = created.data.accessToken;
    assert.equal(created.data.status, "awaiting_transfer");
    assert.equal(created.data.transfer.concept, "OFFCODE " + id.replace("-", ""));
    assert.equal(created.data.transfer.totalCents, rate.totalCents);
    const afterCreate = await app.snapshot();
    assert.equal(afterCreate.order_reservations.length, 1);
    await app.drain();

    const view = await app.call(transferRoute(id), { accessToken });
    assert.equal(view.status, 200);
    assert.deepEqual(view.data.order.transfer, created.data.transfer);
    assert.equal(view.data.order.transferReport, null);
    assert.equal(view.data.order.status, "awaiting_transfer");
    assert.doesNotMatch(JSON.stringify(view.data), /Calle Ficticia|520000000000|history|transferAccount|requestKey|synthetic-qa-only/);

    for (const confirmed of [undefined, false, "true", 1]) {
      const unconfirmed = await app.call(reportRoute(id), { accessToken, confirmed });
      assert.equal(unconfirmed.status, 400);
    }
    assert.deepEqual(await app.snapshot(), afterCreate, "sin confirmación explícita no cambia nada");

    const report = await app.call(reportRoute(id), { accessToken, confirmed: true });
    assert.equal(report.status, 201);
    assert.equal(report.data.message, reportedMessage);
    assert.equal(report.data.alreadyReported, false);
    assert.equal(report.data.order.status, "awaiting_transfer");
    assert.match(report.data.order.transferReport.at, /^\d{4}-\d{2}-\d{2}T/);
    const saved = await app.row(id);
    assert.deepEqual(saved.transferReport, { at: report.data.order.transferReport.at, channel: "order_link" });
    assert.equal(saved.status, "awaiting_transfer");
    assert.equal(saved.totalCents, rate.totalCents);
    assert.equal(saved.paymentVerified, undefined);
    assert.deepEqual(saved.history.map((e) => [e.status, e.event ?? null]), [["awaiting_transfer", null], ["awaiting_transfer", "transfer_reported"]]);
    assert.match(saved.history[1].note, /no confirma el pago/);
    const afterReport = await app.snapshot();
    for (const table of ["order_reservations", "inventory", "inventory_movements", "shipping_jobs"])
      assert.deepEqual(afterReport[table], afterCreate[table], table + " no cambia con el aviso");
    assert.equal(app.provider.generateCalls, 0);

    const repeated = await app.call(reportRoute(id), { accessToken, confirmed: true });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.message, repeatedMessage);
    assert.equal(repeated.data.alreadyReported, true);
    assert.deepEqual(await app.snapshot(), afterReport, "el aviso repetido no escribe nada");

    const reportedList = await app.ownerCall("/api/admin/orders?status=transfer_reported");
    assert.equal(reportedList.status, 200);
    assert.deepEqual(reportedList.data.orders.map((o) => o.id), [id]);
    assert.equal(reportedList.data.orders[0].transferConcept, created.data.transfer.concept);
    assert.deepEqual(reportedList.data.orders[0].transferAccount, syntheticBank);
    assert.equal((await app.ownerCall("/api/admin/overview")).data.transferReported, 1);
    assert.equal((await app.ownerCall("/api/admin/summary")).data.orders.transferReported, 1);

    const paid = await app.ownerCall("/api/admin/orders/" + id, { version: saved.version, status: "paid", paymentVerified: true }, "PATCH");
    assert.equal(paid.status, 200);
    assert.equal(paid.data.order.status, "paid");
    assert.equal((await app.ownerCall("/api/admin/orders/" + id, { version: saved.version, status: "paid", paymentVerified: true }, "PATCH")).status, 409);
    const afterPaid = await app.snapshot();
    const variant = (snapshot) => snapshot.inventory.find((v) => v.variant_id === "VAR-HOODIE-M");
    assert.equal(variant(afterPaid).on_hand, variant(afterCreate).on_hand - 1, "se descuenta una sola unidad vendida");
    assert.equal(variant(afterPaid).reserved, variant(afterCreate).reserved - 1);
    assert.deepEqual(afterPaid.order_reservations.map((r) => [r.state, r.qty]), [["sold", 1]]);
    assert.equal(afterPaid.shipping_jobs.length, 0);
    assert.equal((await app.ownerCall("/api/admin/overview")).data.transferReported, 0);

    const late = await app.call(reportRoute(id), { accessToken, confirmed: true });
    assert.equal(late.status, 409);
    assert.match(late.data.error, /ya fue verificado/);
    const paidView = (await app.call(transferRoute(id), { accessToken })).data.order;
    assert.equal(paidView.status, "paid");
    assert.equal(paidView.transfer, null, "los datos bancarios dejan de mostrarse cuando ya no hay pago pendiente");

    await app.drain();
    const events = app.email.list(id).map((job) => `${job.event}/${job.audience}/${job.state}`).sort();
    assert.deepEqual(events, ["awaiting_transfer/buyer/accepted", "awaiting_transfer/owner/accepted", "paid/buyer/accepted",
      "transfer_reported/owner/accepted"]);
    const owner = app.sent.filter((m) => m.to[0] === emailEnv.ORDER_NOTIFICATION_EMAIL);
    const reported = owner.filter((m) => /Transferencia reportada: verifica en tu banco/.test(m.subject));
    assert.equal(reported.length, 1, "un solo aviso al propietario");
    assert.ok(reported[0].text.includes("Total esperado: $" + (rate.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }) + " MXN"));
    assert.ok(reported[0].text.includes(created.data.transfer.concept));
    assert.match(reported[0].text, /Este aviso no confirma el pago/);
    assert.equal(app.sent.filter((m) => /Pago verificado/.test(m.subject)).length, 1, "un solo correo de pago verificado");
    for (const message of owner) assert.doesNotMatch(JSON.stringify(message), /Calle Ficticia|520000000000|Persona Sintética QA/);
    assert.doesNotMatch(JSON.stringify(app.logs), bankPattern, "los registros no contienen datos bancarios");
    assert.doesNotMatch(JSON.stringify(app.logs), /synthetic-transfer-email-secret/);
  } finally { await app.close(); }
});

test("Correo al comprador: total exacto, cuenta guardada y concepto del pedido", async () => {
  const app = await flowApp();
  try {
    const { rate, created } = await app.order();
    await app.drain();
    const instructions = app.sent.filter((m) => m.to[0] === customer.email);
    assert.equal(instructions.length, 1);
    assert.match(instructions[0].subject, /Realiza tu transferencia bancaria/);
    for (const line of [`CLABE: ${syntheticBank.clabe}`, `Banco: ${syntheticBank.name}`, `Titular: ${syntheticBank.beneficiary}`,
      `Concepto: ${created.data.transfer.concept}`, `Referencia del pedido: ${created.data.id}`])
      assert.ok(instructions[0].text.includes(line), line);
    assert.ok(instructions[0].text.includes((rate.totalCents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }) + " MXN"));
    assert.match(instructions[0].text, /El aviso no confirma el pago/);
    assert.doesNotMatch(JSON.stringify(instructions[0]), /Calle Ficticia|520000000000/);
    const ownerNew = app.sent.filter((m) => m.to[0] === emailEnv.ORDER_NOTIFICATION_EMAIL);
    assert.equal(ownerNew.length, 1);
    assert.match(ownerNew[0].subject, /Nuevo pedido pendiente de transferencia/);
    assert.doesNotMatch(JSON.stringify(ownerNew[0]), bankPattern);
  } finally { await app.close(); }
});

test("Concurrencia y reintentos: un solo pedido, una reserva y un solo aviso registrado", async () => {
  const app = await flowApp();
  try {
    const rate = (await app.quote()).data.rates[0], request = app.request(rate);
    const creations = await Promise.all(Array.from({ length: 6 }, () => app.call("/api/orders", request)));
    assert.deepEqual(creations.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201]);
    for (const response of creations) assert.deepEqual(response.data, creations.find((r) => r.status === 201).data);
    const snapshot = await app.snapshot();
    assert.equal(snapshot.orders.length, 1);
    assert.equal(snapshot.order_reservations.length, 1);
    const { id, accessToken } = creations[0].data;

    const reports = await Promise.all(Array.from({ length: 10 }, () => app.call(reportRoute(id), { accessToken, confirmed: true })));
    assert.deepEqual(reports.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 200, 200, 200, 200, 201]);
    for (const response of reports) assert.equal(response.data.order.transferReport.at, reports.find((r) => r.status === 201).data.order.transferReport.at);
    const saved = await app.row(id);
    assert.equal(saved.history.filter((e) => e.event === "transfer_reported").length, 1);
    assert.equal(saved.version, 2, "solo el primer aviso cambia la versión");
    assert.deepEqual((await app.snapshot()).order_reservations, snapshot.order_reservations);
    assert.deepEqual((await app.snapshot()).inventory, snapshot.inventory);
    await app.drain();
    assert.equal(app.email.list(id).filter((job) => job.event === "transfer_reported").length, 1);
    assert.equal(app.sent.filter((m) => /Transferencia reportada/.test(m.subject)).length, 1);

    // A retried creation after the notice still returns the same order, never a second one.
    const retry = await app.call("/api/orders", request);
    assert.equal(retry.status, 200); assert.equal(retry.data.id, id); assert.equal(retry.data.accessToken, accessToken);
    assert.equal((await app.snapshot()).orders.length, 1);
  } finally { await app.close(); }
});

test("Acceso protegido: referencias inválidas, llaves ajenas o alteradas, sin autorización y otro origen", async () => {
  const app = await flowApp();
  try {
    const first = (await app.order(buyer(1))).created.data, second = (await app.order(buyer(2))).created.data;
    const before = await app.snapshot();
    const tampered = first.accessToken.slice(0, -1) + (first.accessToken.endsWith("A") ? "B" : "A");
    const denied = [
      [transferRoute("OF-000000000000"), { accessToken: first.accessToken }],
      [reportRoute("OF-000000000000"), { accessToken: first.accessToken, confirmed: true }],
      [transferRoute(first.id), { accessToken: second.accessToken }],
      [reportRoute(first.id), { accessToken: second.accessToken, confirmed: true }],
      [reportRoute(first.id), { accessToken: tampered, confirmed: true }],
      [reportRoute(first.id), { accessToken: "x", confirmed: true }],
      [reportRoute(first.id), { accessToken: 12345, confirmed: true }],
      [reportRoute(first.id), { accessToken: { value: first.accessToken }, confirmed: true }],
      [transferRoute(first.id), { accessToken: "A".repeat(43) }],
    ];
    for (const [route, data] of denied) {
      const response = await app.call(route, data);
      assert.equal(response.status, 404, route + " " + JSON.stringify(data).slice(0, 40));
      assert.doesNotMatch(JSON.stringify(response.data), bankPattern);
      assert.equal(response.data.order, undefined);
    }
    for (const route of [transferRoute("OF-123"), transferRoute(first.id.toLowerCase()), reportRoute(first.id + "0"), "/api/orders/" + first.id + "/transfer/extra"]) {
      const response = await app.raw(route, { accessToken: first.accessToken, confirmed: true });
      assert.ok([400, 404].includes(response.status), route + " → " + response.status);
      assert.doesNotMatch(JSON.stringify(response.data), bankPattern);
    }
    for (const route of [transferRoute(first.id), reportRoute(first.id)]) {
      const anonymous = await app.call(route, { confirmed: true });
      assert.equal(anonymous.status, 401);
      assert.doesNotMatch(JSON.stringify(anonymous.data), bankPattern);
    }
    const foreignOrigin = await app.raw(reportRoute(first.id), { accessToken: first.accessToken, confirmed: true }, { origin: "https://evil.example" });
    assert.equal(foreignOrigin.status, 403);
    const getAttempt = await app.raw(transferRoute(first.id), undefined, { method: "GET" });
    assert.ok([404, 405].includes(getAttempt.status));
    assert.deepEqual(await app.snapshot(), before, "ningún intento rechazado cambia pedidos ni existencias");
    await app.drain();
    assert.equal(app.sent.filter((m) => /Transferencia reportada/.test(m.subject)).length, 0);
  } finally { await app.close(); }
});

test("Cuenta verificada: abre y avisa su propio pedido; otra cuenta, sesión vencida o pedido de invitado no", async () => {
  const app = await flowApp();
  try {
    const ownerCookie = await app.account("cliente-uno@example.test");
    const otherCookie = await app.account("cliente-dos@example.test");
    const mine = { ...customer, email: "cliente-uno@example.test" };
    const rate = (await app.quote(bag, mine)).data.rates[0];
    const created = await app.raw("/api/orders", app.request(rate, { customer: mine }), { cookie: ownerCookie });
    assert.equal(created.status, 201);
    const guest = (await app.order(buyer(3))).created.data;

    const view = await app.raw(transferRoute(created.data.id), {}, { cookie: ownerCookie });
    assert.equal(view.status, 200);
    assert.equal(view.data.order.transfer.clabe, syntheticBank.clabe);
    for (const [route, cookie] of [[transferRoute(created.data.id), otherCookie], [reportRoute(created.data.id), otherCookie],
      [transferRoute(guest.id), ownerCookie], [reportRoute(guest.id), ownerCookie]]) {
      const response = await app.raw(route, { confirmed: true }, { cookie });
      assert.equal(response.status, 404, route);
      assert.doesNotMatch(JSON.stringify(response.data), bankPattern);
    }
    const report = await app.raw(reportRoute(created.data.id), { confirmed: true }, { cookie: ownerCookie });
    assert.equal(report.status, 201);
    assert.equal((await app.row(created.data.id)).transferReport.channel, "customer_account");
    const history = await app.raw("/api/customer/orders/" + created.data.id, undefined, { cookie: ownerCookie, method: "GET" });
    assert.equal(history.data.order.payment.label, "Transferencia reportada · en verificación");
    assert.ok(history.data.order.history.some((entry) => entry.label === "Aviso de transferencia enviado · pendiente de verificar"));

    app.advance(7 * 86400e3);
    for (const route of [transferRoute(created.data.id), reportRoute(created.data.id)]) {
      const expired = await app.raw(route, { confirmed: true }, { cookie: ownerCookie });
      assert.equal(expired.status, 401, "sesión vencida");
      assert.doesNotMatch(JSON.stringify(expired.data), bankPattern);
    }
  } finally { await app.close(); }
});

test("Estados sin pago pendiente y cuenta incompleta: el aviso se rechaza y no se crea ni reserva nada", async () => {
  const app = await flowApp();
  try {
    const { created } = await app.order(buyer(4));
    const saved = await app.row(created.data.id);
    const cancelled = await app.ownerCall("/api/admin/orders/" + created.data.id, { version: saved.version, status: "cancelled" }, "PATCH");
    assert.equal(cancelled.status, 200);
    const report = await app.call(reportRoute(created.data.id), { accessToken: created.data.accessToken, confirmed: true });
    assert.equal(report.status, 409);
    assert.match(report.data.error, /cancelado/);
    assert.equal((await app.row(created.data.id)).transferReport, undefined);
    assert.equal((await app.call(transferRoute(created.data.id), { accessToken: created.data.accessToken })).data.order.transfer, null);
  } finally { await app.close(); }

  // A missing account already blocks opening sales; blank-looking values that
  // slip past that check are still refused when the order would be created.
  for (const bank of [{ ...syntheticBank, clabe: "" }, { ...syntheticBank, clabe: "12345" }, { ...syntheticBank, name: "" }, { ...syntheticBank, beneficiary: "" }])
    await assert.rejects(checkoutApp({ bank }), /Completa contraseña, banco, beneficiario, CLABE/);
  for (const bank of [{ ...syntheticBank, name: "   " }, { ...syntheticBank, beneficiary: "  " }]) {
    const incomplete = await flowApp({ bank });
    try {
      const before = await incomplete.snapshot();
      const rate = (await incomplete.quote()).data.rates[0];
      const rejected = await incomplete.call("/api/orders", incomplete.request(rate));
      assert.equal(rejected.status, 503);
      assert.match(rejected.data.error, /No se guardó tu pedido ni se reservó inventario/);
      assert.deepEqual(await incomplete.snapshot(), before);
      await incomplete.drain();
      assert.equal(incomplete.sent.length, 0);
    } finally { await incomplete.close(); }
  }
});

test("Pedido sin cotización automática: no muestra datos hasta que el propietario confirma el total; luego admite el aviso", async () => {
  const app = await flowApp({ shippingEnabled: false });
  try {
    const created = await app.call("/api/orders", { requestKey: randomUUID(), customer: buyer(5), items: bag, consent: true });
    assert.equal(created.status, 201);
    assert.equal(created.data.status, "requested");
    assert.equal(created.data.transfer, null);
    const early = await app.call(reportRoute(created.data.id), { accessToken: created.data.accessToken, confirmed: true });
    assert.equal(early.status, 409);
    assert.match(early.data.error, /todavía no tiene datos de transferencia/);
    const confirmed = await app.ownerCall("/api/admin/orders/" + created.data.id,
      { version: 1, status: "awaiting_transfer", shippingCents: 18520, stockConfirmed: true }, "PATCH");
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.data.order.transferConcept, "OFFCODE " + created.data.id.replace("-", ""));
    const view = await app.call(transferRoute(created.data.id), { accessToken: created.data.accessToken });
    assert.equal(view.data.order.transfer.totalCents, confirmed.data.order.totalCents);
    assert.equal((await app.call(reportRoute(created.data.id), { accessToken: created.data.accessToken, confirmed: true })).status, 201);
  } finally { await app.close(); }
});

test("Cuenta del propietario modificada después: el pedido conserva los datos mostrados al comprador", async () => {
  const app = await flowApp({ settingsKey: "cd".repeat(32) });
  try {
    const { created } = await app.order(buyer(6));
    const current = await app.ownerCall("/api/admin/settings");
    assert.equal(current.status, 200);
    const draft = { ...current.data.settings, bank: { name: "OTRO BANCO QA", beneficiary: "OTRA PERSONA QA", clabe: "111111111111111111" } };
    const saved = await app.ownerCall("/api/admin/settings", { settings: draft, version: current.data.version, currentPassword: app.password }, "PATCH");
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const view = await app.call(transferRoute(created.data.id), { accessToken: created.data.accessToken });
    assert.deepEqual(view.data.order.transfer, created.data.transfer);
    const next = (await app.order(buyer(7))).created;
    assert.equal(next.status, 201);
    assert.equal(next.data.transfer.clabe, "111111111111111111");
  } finally { await app.close(); }
});

test("Confirmación visible: datos del servidor, recarga en la misma pestaña y aviso con confirmación explícita", async () => {
  const app = await flowApp();
  try {
    const config = (await app.call("/api/config")).data;
    const fetcher = (route, options) => fetch(app.origin + route, { ...options, headers: { ...options?.headers, Origin: app.origin } });
    const page = await checkoutDom(config, { bag, fetcher });
    for (const [key, value] of Object.entries(customer)) page.fields[key].value = value;
    page.fields.consent.checked = true;
    await page.nodes.get("#quote-shipping").onclick();
    page.nodes.get("#shipping-rates").children[0].children[0].onchange();
    page.nodes.get("#accept-total").checked = true; page.nodes.get("#accept-total").onchange();
    assert.equal(page.nodes.get("#order-success").hidden, true, "los datos bancarios no aparecen antes de crear el pedido");
    assert.equal(page.nodes.get("#transfer-clabe").textContent, "");
    page.nodes.get("#order-form").emit("submit", page.nodes.get("#order-form"));
    await page.flush();
    const [saved] = (await app.snapshot()).orders, order = JSON.parse(saved.payload);
    assert.equal(page.nodes.get("#order-success").hidden, false);
    assert.equal(page.nodes.get("#order-form").hidden, true);
    assert.equal(page.nodes.get("#transfer-heading").textContent, "Realiza tu transferencia bancaria");
    assert.equal(page.nodes.get("#transfer-beneficiary").textContent, syntheticBank.beneficiary);
    assert.equal(page.nodes.get("#transfer-bank").textContent, syntheticBank.name);
    assert.equal(page.nodes.get("#transfer-clabe").textContent, syntheticBank.clabe);
    assert.equal(page.nodes.get("#transfer-total").textContent, money(order.totalCents) + " MXN");
    assert.equal(page.nodes.get("#transfer-concept").textContent, order.transferConcept);
    assert.equal(page.nodes.get("#transfer-reference").textContent, order.id);
    assert.equal(page.nodes.get("#transfer-report").hidden, false);
    assert.ok(page.bodyClasses.has("is-confirmed"));
    assert.deepEqual(page.history, ["checkout.html?pedido=" + order.id]);
    const access = JSON.parse(page.storage.get("offcode-order-access"));
    assert.match(access[order.id], /^[A-Za-z0-9_-]{43}$/);
    assert.equal(page.storage.has("offcode-bag"), false);

    await page.nodes.get("#copy-clabe").onclick(); await page.nodes.get("#copy-concept").onclick();
    assert.deepEqual(page.copied, [syntheticBank.clabe, order.transferConcept]);

    // Same tab after a reload: only the tab's stored key reopens the order.
    const reloaded = await checkoutDom(config, { bag: [], fetcher, search: "?pedido=" + order.id,
      session: { "offcode-order-access": page.storage.get("offcode-order-access") } });
    assert.equal(reloaded.nodes.get("#order-success").hidden, false);
    assert.equal(reloaded.nodes.get("#transfer-clabe").textContent, syntheticBank.clabe);
    assert.equal(reloaded.nodes.get("#transfer-total").textContent, money(order.totalCents) + " MXN");
    const requestsBefore = reloaded.requests.length;
    reloaded.nodes.get("#report-transfer").onclick();
    assert.equal(reloaded.nodes.get("#report-confirm").hidden, false);
    const prompt = reloaded.nodes.get("#report-confirm-text").textContent;
    for (const value of [money(order.totalCents), syntheticBank.clabe, order.transferConcept]) assert.ok(prompt.includes(value), value);
    reloaded.nodes.get("#report-cancel").onclick();
    assert.equal(reloaded.nodes.get("#report-confirm").hidden, true);
    assert.equal(reloaded.requests.length, requestsBefore, "abrir o cancelar la confirmación no envía nada");
    assert.equal((await app.row(order.id)).transferReport, undefined);

    reloaded.nodes.get("#report-transfer").onclick();
    await reloaded.nodes.get("#report-confirm-yes").onclick();
    assert.equal(reloaded.nodes.get("#report-status").textContent, reportedMessage);
    assert.equal(reloaded.nodes.get("#report-status").focused, true);
    assert.equal(reloaded.nodes.get("#transfer-report").hidden, true);
    assert.equal(reloaded.nodes.get("#transfer-heading").textContent, "Estamos verificando tu transferencia");
    assert.match(reloaded.nodes.get("#transfer-state").textContent, /Ya recibimos tu aviso de transferencia/);
    assert.equal((await app.row(order.id)).history.filter((e) => e.event === "transfer_reported").length, 1);

    // Another tab without the key, or with a foreign key, sees no bank details.
    for (const session of [{}, { "offcode-order-access": JSON.stringify({ [order.id]: "A".repeat(43) }) }]) {
      const stranger = await checkoutDom(config, { bag: [], fetcher, search: "?pedido=" + order.id, session });
      assert.equal(stranger.nodes.get("#order-success").hidden, true);
      assert.equal(stranger.nodes.get("#transfer-clabe").textContent, "");
      assert.match(stranger.nodes.get("#availability").textContent, new RegExp(order.id));
    }
  } finally { await app.close(); }
});
