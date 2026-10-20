import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkoutApp, bag, customer } from "./helpers/checkout-app.mjs";
import { checkoutDom } from "./helpers/checkout-dom.mjs";
import { buyerMessage } from "../dist/order-support.js";
import { privacyPage } from "../scripts/build-privacy.mjs";

test("Transferencia: método obligatorio y permitido, una solicitud sin pago automático ni exposición bancaria", async () => {
  const app = await checkoutApp();
  try {
    const before = await app.snapshot(), rate = (await app.quote()).data.rates[0];
    assert.deepEqual(await app.snapshot(), before);
    for (const paymentMethod of [undefined, null, false, "card", "stripe", "paypal", { type: "bank_transfer" }]) {
      const rejected = await app.call("/api/orders", app.request(rate, { paymentMethod }));
      assert.equal(rejected.status, 400); assert.deepEqual(await app.snapshot(), before);
    }
    const request = app.request(rate, { status: "paid", paymentVerified: true, transferAccount: { name: "ATTACKER" } });
    const created = await app.call("/api/orders", request);
    assert.equal(created.status, 201); assert.equal(created.data.paymentMethod, "bank_transfer");
    assert.equal((await app.call("/api/orders", request)).data.id, created.data.id);
    const snapshot = await app.snapshot(), saved = JSON.parse(snapshot.orders[0].payload);
    assert.equal(snapshot.orders.length, 1); assert.equal(snapshot.order_reservations.length, 1);
    assert.equal(saved.status, "requested"); assert.equal(saved.paymentMethod, "bank_transfer");
    assert.equal(saved.totalCents, rate.totalCents); assert.equal(saved.totalAcceptance.quoteId, rate.id);
    assert.equal(saved.shipping.service, rate.service); assert.equal(saved.transferAccount, undefined);
    assert.equal(saved.paymentVerified, undefined); assert.equal(app.provider.generateCalls, 0);
    for (const response of [created.data, (await app.call("/api/config")).data]) {
      assert.doesNotMatch(JSON.stringify(response), /BANCO SINTÉTICO QA|000000000000000000|synthetic-qa-only|transferAccount|clabe/);
    }
    assert.doesNotMatch(buyerMessage(saved).body, /CLABE|Banco:/);
  } finally { await app.close(); }
});

test("Transferencia: aprobación y verificación siguen privadas; no se permiten guías antes del pago", async () => {
  const app = await checkoutApp();
  try {
    const rate = (await app.quote()).data.rates[0];
    const created = await app.call("/api/orders", app.request(rate)), route = "/api/admin/orders/" + created.data.id;
    assert.equal((await app.call(route, { version: 1, status: "paid", paymentVerified: true }, "PATCH")).status, 401);
    assert.equal((await app.ownerCall(route, { version: 1, status: "paid", paymentVerified: true }, "PATCH")).status, 409);
    assert.equal((await app.ownerCall(route + "/label", { version: 1, confirmPurchase: true })).status, 409);
    assert.equal((await app.ownerCall(route, { version: 1, status: "awaiting_transfer" }, "PATCH")).status, 400);
    const approved = await app.ownerCall(route, { version: 1, status: "awaiting_transfer", stockConfirmed: true }, "PATCH");
    assert.equal(approved.status, 200); assert.equal(approved.data.order.paymentMethod, "bank_transfer");
    assert.equal(approved.data.order.transferAccount.name, "BANCO SINTÉTICO QA");
    assert.match(buyerMessage(approved.data.order).body, /CLABE: 000000000000000000/);
    assert.equal((await app.ownerCall(route, { version: 2, status: "paid" }, "PATCH")).status, 400);
    assert.equal((await app.call(route, { version: 2, status: "paid", paymentVerified: true }, "PATCH")).status, 401);
    const paid = await app.ownerCall(route, { version: 2, status: "paid", paymentVerified: true }, "PATCH");
    assert.equal(paid.status, 200); assert.equal(paid.data.order.status, "paid");
    assert.equal((await app.ownerCall("/api/admin/orders")).data.orders[0].paymentMethod, "bank_transfer");
    assert.equal(app.provider.generateCalls, 0);
    assert.equal((await app.snapshot()).shipping_jobs.length, 0);
  } finally { await app.close(); }
});

test("Transferencia visible: aparece tras elegir tarifa y desaparece al invalidarla", async () => {
  const app = await checkoutApp();
  try {
    const quote = (await app.quote()).data;
    const page = await checkoutDom((await app.call("/api/config")).data, { bag,
      fetcher: async () => ({ ok: true, json: async () => quote }) });
    assert.equal(page.nodes.get("#payment-section").hidden, true);
    for (const [key, value] of Object.entries(customer)) page.fields[key].value = value;
    page.fields.consent.checked = true;
    await page.nodes.get("#quote-shipping").onclick();
    page.nodes.get("#shipping-rates").children[0].children[0].onchange();
    assert.equal(page.nodes.get("#payment-section").hidden, false);
    assert.equal(page.nodes.get("#payment-transfer").checked, true);
    assert.equal(page.nodes.get("#submit-order").disabled, true);
    page.nodes.get("#accept-total").checked = true; page.nodes.get("#accept-total").onchange();
    assert.equal(page.nodes.get("#submit-order").disabled, false);
    page.nodes.get("#payment-transfer").checked = false; page.nodes.get("#payment-transfer").onchange();
    assert.equal(page.nodes.get("#submit-order").disabled, true);
    page.fields.postalCode.value = "37001"; page.nodes.get("#order-form").emit("input", page.fields.postalCode);
    assert.equal(page.nodes.get("#payment-section").hidden, true);
    assert.equal(page.nodes.get("#payment-transfer").disabled, true);
    assert.equal(page.nodes.get("#accept-total").checked, false);
  } finally { await app.close(); }
});

test("Privacidad: HTML completo generado desde la fuente canónica, fecha vigente y sin plataformas ajenas", async () => {
  const source = await readFile(new URL("../docs/politica-privacidad.md", import.meta.url), "utf8");
  const expected = privacyPage(source), saved = await readFile(new URL("../dist/privacidad.html", import.meta.url), "utf8");
  assert.equal(saved, expected, "Ejecuta node scripts/build-privacy.mjs al cambiar la fuente");
  assert.equal((saved.match(/<h2>/g) || []).length, 17);
  assert.match(saved, /Última actualización: 20 de octubre de 2026/);
  assert.doesNotMatch(saved, /shopify|shop pay/i);
  assert.doesNotMatch(saved, /Documento original pendiente de revisión/);
  assert.match(saved, /Flor de Azar 101, 37667 Leon GTO, México/);
  for (const href of ["mailto:brandoffcode@gmail.com", "tel:+524771610537"])
    assert.ok(saved.includes(`href="${href}"`));
  assert.doesNotMatch(saved, /<script\b|<iframe\b/);
  const app = await checkoutApp();
  try {
    const response = await fetch(app.origin + "/privacidad.html");
    assert.equal(response.status, 200); assert.equal(await response.text(), saved);
    assert.equal((await fetch(app.origin + "/privacidad.html", { method: "HEAD" })).status, 200);
    for (const route of ["/index.html", "/checkout.html"]) {
      const html = await (await fetch(app.origin + route)).text();
      assert.match(html, /href="privacidad.html" data-privacy-link>Política de privacidad/);
      assert.match(html, /src="privacy.js"/);
    }
  } finally { await app.close(); }
});
