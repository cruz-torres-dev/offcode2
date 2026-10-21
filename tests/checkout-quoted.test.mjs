import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { checkoutApp, customer, bag } from "./helpers/checkout-app.mjs";
import { checkoutDom } from "./helpers/checkout-dom.mjs";

test("Checkout: cotizar devuelve importes del servidor sin pedidos, reservas, guías ni movimientos", async () => {
  const app = await checkoutApp();
  try {
    const before = await app.snapshot(), response = await app.quote();
    assert.equal(response.status, 200); assert.equal(response.data.rates.length, 2);
    assert.equal(response.data.items[0].unitCents, 165000);
    const [ground, express] = response.data.rates;
    assert.equal(ground.subtotalCents, 165000); assert.equal(ground.shippingCents, 18520); assert.equal(ground.totalCents, 183520);
    assert.equal(express.totalCents, 191000); assert.equal(ground.currency, "MXN");
    assert.match(ground.deliveryEstimate, /simulación/); assert.equal(express.deliveryEstimate, "");
    assert.deepEqual(await app.snapshot(), before);
    assert.equal(app.provider.generateCalls, 0);
    assert.ok(app.provider.calls.every((call) => ["/state", "/ship/rate/"].includes(call.path)));
  } finally { await app.close(); }
});

test("Checkout: exige aceptación booleana del total completo e impide imponer otro importe", async () => {
  const app = await checkoutApp();
  try {
    const rate = (await app.quote()).data.rates[0], before = await app.snapshot();
    for (const totalAccepted of [undefined, false, "true", 1]) {
      const response = await app.call("/api/orders", app.request(rate, { totalAccepted }));
      assert.equal(response.status, 400); assert.deepEqual(await app.snapshot(), before);
    }
    for (const acceptedTotalCents of [undefined, "183520", 1, 191000]) {
      assert.equal((await app.call("/api/orders", app.request(rate, { acceptedTotalCents }))).status, 409);
      assert.deepEqual(await app.snapshot(), before);
    }
    const created = await app.call("/api/orders", app.request(rate, { unitCents: 1, subtotalCents: 1, shippingCents: 1, totalCents: 2 }));
    assert.equal(created.status, 201); assert.equal(created.data.totalCents, 183520);
    const saved = JSON.parse((await app.db.get("SELECT payload FROM orders WHERE id=?", [created.data.id])).payload);
    assert.equal(saved.totalCents, 183520); assert.equal(saved.shippingCents, 18520); assert.equal(saved.status, "awaiting_transfer");
    assert.deepEqual(saved.totalAcceptance, { at: saved.createdAt, quoteId: rate.id, totalCents: 183520, currency: "MXN" });
    assert.equal(saved.tracking, ""); assert.equal((await app.db.get("SELECT reserved FROM inventory WHERE variant_id='VAR-HOODIE-M'")).reserved, 1);
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});

test("Checkout: tarifa falsa, vencida o para otra dirección, cantidad o talla se rechaza sin reservas", async () => {
  const app = await checkoutApp();
  try {
    const rate = (await app.quote()).data.rates[0], before = await app.snapshot();
    for (const extra of [
      { shippingQuoteId: randomUUID() }, { customer: { ...customer, postalCode: "37001" } },
      { customer: { ...customer, state: "CX" } }, { customer: { ...customer, street: "Otra calle sintética 456" } },
      { items: [{ ...bag[0], qty: 2 }] }, { items: [{ ...bag[0], size: "L", variantId: "VAR-HOODIE-L" }] },
    ]) {
      assert.equal((await app.call("/api/orders", app.request(rate, extra))).status, 409);
      assert.deepEqual(await app.snapshot(), before);
    }
    await app.db.run("UPDATE shipping_quotes SET expires=0 WHERE id=?", [rate.id]);
    assert.equal((await app.call("/api/orders", app.request(rate))).status, 409);
    assert.deepEqual(await app.snapshot(), before);
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});

test("Checkout: un cambio de precio requiere una nueva tarifa y una nueva aceptación", async () => {
  const app = await checkoutApp();
  try {
    const old = (await app.quote()).data.rates[0];
    await app.db.run("UPDATE products SET price_cents=180000 WHERE id=?", [bag[0].productId]);
    assert.equal((await app.call("/api/orders", app.request(old))).status, 409);
    const latest = (await app.quote()).data.rates[0];
    assert.equal(latest.totalCents, 198520);
    assert.equal((await app.call("/api/orders", app.request(latest, { acceptedTotalCents: old.totalCents }))).status, 409);
    const created = await app.call("/api/orders", app.request(latest));
    assert.equal(created.status, 201); assert.equal(created.data.totalCents, 198520);
  } finally { await app.close(); }
});

test("Checkout: revalida caducidad dentro de la transacción antes de guardar", async () => {
  const app = await checkoutApp();
  try {
    const rate = (await app.quote()).data.rates[0], before = await app.snapshot();
    const original = app.db.tx;
    app.db.tx = async (work) => {
      await app.db.run("UPDATE shipping_quotes SET expires=0 WHERE id=?", [rate.id]);
      return original(work);
    };
    assert.equal((await app.call("/api/orders", app.request(rate))).status, 409);
    assert.deepEqual(await app.snapshot(), before);
  } finally { await app.close(); }
});

test("Checkout: reintentos concurrentes y después de caducar no duplican el pedido aceptado", async () => {
  const app = await checkoutApp();
  try {
    const rate = (await app.quote()).data.rates[1], input = app.request(rate);
    const results = await Promise.all([app.call("/api/orders", input), app.call("/api/orders", input)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
    assert.equal(results[0].data.id, results[1].data.id);
    await app.db.run("UPDATE shipping_quotes SET expires=0");
    assert.equal((await app.call("/api/orders", input)).status, 200);
    assert.equal((await app.call("/api/orders", { ...input, customer: { ...customer, street: "Otra dirección 123" } })).status, 409);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 1);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM order_reservations")).n, 1);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM shipping_jobs")).n, 0);
  } finally { await app.close(); }
});

test("Checkout: sin integración pública no se muestran tarifas ficticias ni se habilita solicitar", async () => {
  const app = await checkoutApp({ shippingEnabled: false });
  try {
    const config = (await app.call("/api/config")).data, page = await checkoutDom(config, { bag });
    assert.equal((await app.quote()).status, 503);
    assert.equal(page.nodes.get("#quote-shipping").disabled, true);
    assert.equal(page.nodes.get("#submit-order").disabled, true);
    assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
    assert.match(page.nodes.get("#availability").textContent, /todavía no está habilitada/);
    assert.equal(app.provider.calls.length, 0);
    const before = await app.snapshot();
    const rejected = await app.call("/api/orders", app.request({ id: randomUUID(), totalCents: 183520 }));
    assert.equal(rejected.status, 409);
    assert.deepEqual(await app.snapshot(), before, "un checkout cotizado no debe convertirse en un pedido sin envío al desactivar la integración");
  } finally { await app.close(); }
});

async function pageWithRates({ rateDelay, quoteExpiry = 60000, onOrder, onQuote } = {}) {
  const app = await checkoutApp(), config = (await app.call("/api/config")).data;
  const quoted = (await app.quote()).data;
  const now = Date.now();
  for (const rate of quoted.rates) rate.expiresAt = new Date(now + quoteExpiry).toISOString();
  const page = await checkoutDom(config, { bag, now, fetcher: async (route, options) => {
    if (route === "/api/orders") return onOrder?.(JSON.parse(options.body)) ?? { ok: false, status: 409, json: async () => ({ error: "La cotización venció." }) };
    assert.equal(route, "/api/shipping/rates");
    if (rateDelay) await rateDelay;
    if (onQuote) return onQuote(quoted, JSON.parse(options.body));
    return { ok: true, json: async () => quoted };
  } });
  Object.assign(page.fields.consent, { checked: true });
  for (const [name, value] of Object.entries(customer)) page.fields[name].value = value;
  return { app, page, quoted };
}

test("Checkout visible: dos servicios actualizan el total del servidor y exigen volver a aceptarlo", async () => {
  const { app, page, quoted } = await pageWithRates();
  try {
    await page.nodes.get("#quote-shipping").onclick();
    const radios = page.nodes.get("#shipping-rates").children.map((row) => row.children[0]);
    assert.equal(radios.length, 2); radios[0].onchange();
    assert.match(page.nodes.get("#summary-total").textContent, /1,835\.20/);
    assert.equal(page.nodes.get("#submit-order").disabled, true);
    page.nodes.get("#accept-total").checked = true; page.nodes.get("#accept-total").onchange();
    assert.equal(page.nodes.get("#submit-order").disabled, false);
    for (const index of [1, 0, 1, 0, 1, 0]) {
      radios[index].onchange();
      assert.equal(page.nodes.get("#shipping-rates").children.length, 2, "alternar no borra los servicios vigentes");
      assert.equal(page.nodes.get("#summary-shipping").textContent, index ? "$260.00" : "$185.20");
      assert.equal(page.nodes.get("#review-total").textContent, index ? "$1,910.00" : "$1,835.20");
      assert.equal(page.nodes.get("#accept-total").checked, false, "el total del otro servicio no sigue aceptado");
      assert.equal(page.nodes.get("#submit-order").disabled, true);
      page.nodes.get("#accept-total").checked = true; page.nodes.get("#accept-total").onchange();
      assert.equal(page.nodes.get("#submit-order").disabled, false);
    }
    assert.equal(page.requests.filter(request => request.route === "/api/shipping/rates").length, 1);
    assert.equal(quoted.rates[1].deliveryEstimate, "");
    page.advance(61000);
    assert.match(page.nodes.get("#shipping-message").textContent, /venció/);
    assert.equal(page.nodes.get("#summary-total").textContent, "Por calcular");
  } finally { await app.close(); }
});

test("Checkout visible: caducidad impide enviar aunque se reactive el checkbox o un radio retirado", async () => {
  const { app, page } = await pageWithRates();
  try {
    await page.nodes.get("#quote-shipping").onclick();
    const radio = page.nodes.get("#shipping-rates").children[0].children[0];
    radio.onchange();
    page.nodes.get("#accept-total").checked = true; page.nodes.get("#accept-total").onchange();
    page.advance(61000);
    radio.onchange();
    assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
    assert.equal(page.nodes.get("#summary-total").textContent, "Por calcular");
    page.nodes.get("#accept-total").checked = true;
    page.nodes.get("#order-form").emit("submit"); await page.flush();
    assert.equal(page.requests.filter(request => request.route === "/api/orders").length, 0);
    assert.equal(page.nodes.get("#submit-order").disabled, true);
    assert.deepEqual((await app.snapshot()).orders, []);
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});

test("Checkout visible: error HTTP, red, JSON inválido o sin cobertura permiten recalcular sin tarifas residuales", async () => {
  const errors = [
    () => ({ ok: false, status: 503, json: async () => ({ error: "Envia no disponible. Reintenta." }) }),
    () => { throw Error("Fallo de red simulado"); },
    () => ({ ok: true, json: async () => { throw Error("JSON inválido simulado"); } }),
    () => ({ ok: true, json: async () => ({ rates: [] }) }),
  ];
  let attempt = 0;
  const { app, page } = await pageWithRates({ onQuote: quoted => attempt < errors.length ? errors[attempt++]()
    : { ok: true, json: async () => quoted } });
  try {
    for (const message of [/Envia no disponible/, /Fallo de red/, /JSON inválido/, /no devolvió servicios/]) {
      await page.nodes.get("#quote-shipping").onclick();
      assert.match(page.nodes.get("#shipping-message").textContent, message);
      assert.equal(page.nodes.get("#quote-shipping").disabled, false);
      assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
      assert.equal(page.nodes.get("#accept-total").checked, false);
      assert.equal(page.nodes.get("#summary-total").textContent, "Por calcular");
      assert.equal(page.nodes.get("#submit-order").disabled, true);
    }
    await page.nodes.get("#quote-shipping").onclick();
    const rows = page.nodes.get("#shipping-rates").children;
    assert.equal(rows.length, 2);
    rows[0].children[0].onchange(); rows[1].children[0].onchange();
    assert.equal(page.nodes.get("#summary-total").textContent, "$1,910.00");
    assert.equal(page.nodes.get("#accept-total").checked, false);
    assert.equal(page.requests.filter(request => request.route === "/api/orders").length, 0);
  } finally { await app.close(); }
});

test("Checkout visible: respuestas y errores antiguos no reemplazan tarifas ni quitan la carga de la petición nueva", async () => {
  for (const order of ["old-first", "new-first", "old-error-after-new"]) {
    const pending = [];
    const { app, page, quoted } = await pageWithRates({ onQuote: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
    const response = data => ({ ok: true, json: async () => data });
    const latest = { ...quoted, rates: quoted.rates.map(rate => ({ ...rate, id: randomUUID() })) };
    const button = page.nodes.get("#quote-shipping");
    try {
      const olderRequest = button.onclick();
      assert.equal(button.disabled, true);
      assert.equal(button.attrs["aria-busy"], "true");
      page.fields.postalCode.value = "37001"; page.nodes.get("#order-form").emit("input", page.fields.postalCode);
      assert.equal(button.disabled, false, "una nueva dirección permite recalcular sin esperar la respuesta obsoleta");
      const newerRequest = button.onclick();
      assert.equal(button.disabled, true);
      assert.match(page.nodes.get("#shipping-message").textContent, /Consultando/);
      if (order === "old-first") {
        pending[0].resolve(response(quoted)); await olderRequest;
        assert.equal(button.disabled, true, "el finally antiguo no habilita el botón de la petición nueva");
        assert.equal(button.attrs["aria-busy"], "true");
        assert.match(button.textContent, /Calculando/);
        assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
      }
      pending[1].resolve(response(latest)); await newerRequest;
      const rows = page.nodes.get("#shipping-rates").children;
      assert.deepEqual(rows.map(row => row.children[0].value), latest.rates.map(rate => rate.id));
      rows[0].children[0].onchange();
      page.nodes.get("#accept-total").checked = true; page.nodes.get("#accept-total").onchange();
      if (order !== "old-first") {
        if (order === "old-error-after-new") pending[0].reject(Error("Respuesta antigua fallida"));
        else pending[0].resolve(response(quoted));
        await olderRequest;
      }
      assert.deepEqual(page.nodes.get("#shipping-rates").children.map(row => row.children[0].value), latest.rates.map(rate => rate.id));
      assert.equal(page.nodes.get("#accept-total").checked, true);
      assert.equal(page.nodes.get("#summary-total").textContent, "$1,835.20");
      assert.equal(button.disabled, false);
      assert.equal(button.attrs["aria-busy"], "false");
      assert.doesNotMatch(page.nodes.get("#shipping-message").textContent, /antigua fallida|Consultando/);
      assert.equal(page.requests.filter(request => request.route === "/api/orders").length, 0);
    } finally {
      for (const item of pending) item.resolve(response(quoted));
      await app.close();
    }
  }
});

test("Checkout visible: radios de una cotización reemplazada o invalidada por el carrito no recuperan tarifas anteriores", async () => {
  const { app, page } = await pageWithRates({ onQuote: quoted => ({ ok: true, json: async () => ({ ...quoted,
    rates: quoted.rates.map(rate => ({ ...rate, id: randomUUID() })) }) }) });
  try {
    await page.nodes.get("#quote-shipping").onclick();
    const oldRadio = page.nodes.get("#shipping-rates").children[0].children[0];
    oldRadio.onchange();
    await page.nodes.get("#quote-shipping").onclick();
    const currentRadio = page.nodes.get("#shipping-rates").children[1].children[0];
    currentRadio.onchange();
    page.nodes.get("#accept-total").checked = true; page.nodes.get("#accept-total").onchange();
    oldRadio.onchange();
    assert.equal(page.nodes.get("#shipping-rates").children.length, 2);
    assert.equal(page.nodes.get("#summary-total").textContent, "$1,910.00");
    assert.equal(page.nodes.get("#accept-total").checked, true);
    const qty = page.descendants(page.nodes.get("#order-items")).find(node => node.tag === "input");
    qty.value = "2"; qty.oninput();
    currentRadio.onchange();
    assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
    assert.equal(page.nodes.get("#summary-total").textContent, "Por calcular");
    assert.equal(page.nodes.get("#submit-order").disabled, true);
  } finally { await app.close(); }
});

test("Checkout visible: dirección, talla y cantidad borran tarifas y aceptación", async () => {
  const { app, page } = await pageWithRates();
  try {
    for (const name of ["postalCode", "state", "street"]) {
      await page.nodes.get("#quote-shipping").onclick();
      page.nodes.get("#shipping-rates").children[0].children[0].onchange();
      page.nodes.get("#accept-total").checked = true;
      page.fields[name].value += "1"; page.nodes.get("#order-form").emit("input", page.fields[name]);
      assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
      assert.equal(page.nodes.get("#accept-total").checked, false);
      assert.equal(page.nodes.get("#submit-order").disabled, true);
    }
    await page.nodes.get("#quote-shipping").onclick();
    page.nodes.get("#shipping-rates").children[0].children[0].onchange();
    const nodes = page.descendants(page.nodes.get("#order-items"));
    const qty = nodes.find((node) => node.tag === "input"); qty.value = "2"; qty.oninput();
    assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
    assert.equal(page.nodes.get("#submit-order").disabled, true);
    const size = nodes.find((node) => node.tag === "select"); size.value = "VAR-HOODIE-L"; size.onchange();
    assert.equal(JSON.parse(page.storage.get("offcode-bag"))[0].size, "L");
    assert.equal(page.nodes.get("#accept-total").disabled, true);
  } finally { await app.close(); }
});

test("Checkout visible: ignora una respuesta de tarifas si los datos cambiaron durante la consulta", async () => {
  let finish;
  const delay = new Promise((resolve) => { finish = resolve; });
  const { app, page } = await pageWithRates({ rateDelay: delay });
  try {
    const quoting = page.nodes.get("#quote-shipping").onclick();
    page.fields.postalCode.value = "37001"; page.nodes.get("#order-form").emit("change", page.fields.postalCode);
    finish(); await quoting;
    assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
    assert.equal(page.nodes.get("#submit-order").disabled, true);
  } finally { finish(); await app.close(); }
});

test("Checkout visible: un rechazo al enviar exige cotizar y aceptar de nuevo sin cambiar la referencia de reintento", async () => {
  const { app, page, quoted } = await pageWithRates();
  try {
    const key = page.storage.get("offcode-request-key");
    await page.nodes.get("#quote-shipping").onclick();
    page.nodes.get("#shipping-rates").children[0].children[0].onchange();
    page.nodes.get("#accept-total").checked = true;
    page.nodes.get("#order-form").emit("submit"); await page.flush();
    const sent = page.requests.find((request) => request.route === "/api/orders").body;
    assert.equal(sent.requestKey, key);
    assert.equal(sent.shippingQuoteId, quoted.rates[0].id);
    assert.equal(sent.totalAccepted, true);
    assert.equal(sent.paymentMethod, "bank_transfer");
    assert.equal(sent.acceptedTotalCents, quoted.rates[0].totalCents);
    assert.equal(page.nodes.get("#shipping-rates").children.length, 0);
    assert.equal(page.nodes.get("#accept-total").checked, false);
    assert.equal(page.nodes.get("#submit-order").disabled, true);
    assert.equal(page.storage.get("offcode-request-key"), key);
  } finally { await app.close(); }
});
