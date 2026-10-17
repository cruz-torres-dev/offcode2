import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { createEnvia } from "../server/envia.mjs";

const origin = "http://127.0.0.1:9876",
  password = "synthetic-shipping-password";
const customer = {
  name: "Persona Ficticia",
  phone: "520000000000",
  email: "persona@example.test",
  street: "Calle Ficticia 123",
  neighborhood: "Centro",
  city: "Ciudad de prueba",
  state: "GT",
  postalCode: "37000",
  notes: "",
};
const items = [{ size: "M", qty: 1 }];
const sender = {
  name: "Origen de prueba",
  phone: "520000000000",
  email: "origen@example.test",
  street: "Calle Ficticia",
  number: "123",
  district: "Centro",
  city: "León",
  state: "GT",
  country: "MX",
  postalCode: "37000",
};
const config = {
  origin,
  password,
  enabled: true,
  databasePath: ":memory:",
  bank: {
    name: "PRUEBA",
    beneficiary: "FICTICIO",
    clabe: "000000000000000000",
  },
  whatsapp: "520000000000",
  privacyUrl: "https://example.test/privacy",
  termsUrl: "https://example.test/terms",
};
function provider() {
  const mock = {
    calls: [],
    rateError: false,
    noCoverage: false,
    generateError: false,
    gate: null,
  };
  mock.fetch = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    mock.calls.push({
      url,
      body,
      authorization: options.headers.Authorization,
    });
    const response = (data) =>
      new Response(JSON.stringify(data), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (url.endsWith("/state?country_code=MX"))
      return response({
        data: [{ name: "Guanajuato", code_2_digits: "GT", country_code: "MX" }],
      });
    assert.equal(body.shipment.carrier, "fedex");
    assert.equal(body.packages[0].weight, 0.75);
    if (url.endsWith("/ship/rate/")) {
      if (mock.rateError)
        return response({
          meta: "error",
          error: { message: "sensitive-provider-token" },
        });
      return response({
        meta: "rate",
        data: mock.noCoverage
          ? []
          : [
              {
                carrier: "dhl",
                service: "ground",
                serviceDescription: "No debe aparecer",
                totalPrice: 1,
                currency: "MXN",
              },
              {
                carrier: "fedex",
                service: "international",
                totalPrice: 10,
                currency: "USD",
              },
              {
                carrier: "fedex",
                service: "bad",
                totalPrice: -1,
                currency: "MXN",
              },
              {
                carrier: "fedex",
                service: "ground",
                serviceDescription: "FedEx de prueba",
                totalPrice: "185.20",
                currency: "MXN",
                deliveryEstimate: "Estimación ficticia",
              },
            ],
      });
    }
    assert.ok(url.endsWith("/ship/generate/"));
    assert.equal(body.shipment.service, "ground");
    assert.match(body.shipment.orderReference, /^OF-/);
    assert.equal(body.settings.printFormat, "PDF");
    if (mock.gate) await mock.gate;
    if (mock.generateError)
      throw Error("network failure after possible charge");
    return response({
      meta: "generate",
      data: [
        {
          carrier: "fedex",
          service: "ground",
          shipmentId: 1234,
          trackingNumber: "TEST123456",
          label: "https://files.envia.com/labels/test.pdf",
          trackUrl: "https://tracking.envia.com/test",
          currency: "MXN",
          totalPrice: 185.2,
        },
      ],
    });
  };
  return mock;
}
async function start(mock, options = {}) {
  const app = await createApp({
    ...config,
    ...options,
    envia: {
      enabled: true,
      environment: "sandbox",
      token: "synthetic-envia-token",
      sender,
      profiles: {
        1: { weight: 0.75, dimensions: { length: 30, width: 20, height: 10 } },
      },
      fetch: mock.fetch,
      ...options.envia,
    },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  const call = async (route, method = "GET", data, headers = {}) => {
    const r = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (r.headers.get("set-cookie"))
      cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, data: await r.json() };
  };
  return { ...app, call, base };
}
async function createOrder(app) {
  const rates = await app.call("/api/shipping/rates", "POST", {
    items,
    customer,
    consent: true,
  });
  assert.equal(rates.status, 200);
  const request = {
    requestKey: randomUUID(),
    customer,
    items,
    consent: true,
    shippingQuoteId: rates.data.rates[0].id,
    shippingCents: 1,
  };
  const created = await app.call("/api/orders", "POST", request);
  assert.equal(created.status, 201);
  await app.call("/api/session", "POST", { password });
  const id = created.data.id,
    route = "/api/admin/orders/" + id;
  return { id, route, request };
}
async function pay(app, route) {
  const confirmed = await app.call(route, "PATCH", {
    version: 1,
    status: "awaiting_transfer",
    stockConfirmed: true,
    shippingCents: 1,
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.data.order.totalCents, 183520);
  assert.equal(confirmed.data.order.shippingCents, 18520);
  const paid = await app.call(route, "PATCH", {
    version: 2,
    status: "paid",
    paymentVerified: true,
  });
  assert.equal(paid.status, 200);
}
test("FedEx exclusivo: cotización ligada a datos, total del servidor, compra privada tras transferencia y entrega física", async () => {
  const mock = provider(),
    app = await start(mock);
  try {
    const publicConfig = await app.call("/api/config");
    assert.equal(publicConfig.data.shipping.carrier, "FedEx");
    assert.ok(!JSON.stringify(publicConfig).includes("synthetic-envia-token"));
    assert.ok(!JSON.stringify(publicConfig).includes(sender.street));
    assert.equal(
      (
        await app.call("/api/shipping/rates", "POST", {
          items,
          customer,
          consent: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await app.call(
          "/api/shipping/rates",
          "POST",
          { items, customer, consent: true },
          { Origin: "https://other.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.call("/api/shipping/rates", "POST", {
          items: [{ size: "M", qty: 2 }],
          customer,
          consent: true,
        })
      ).status,
      422,
    );
    const quotes = await app.call("/api/shipping/rates", "POST", {
      items,
      customer,
      consent: true,
    });
    assert.equal(quotes.data.rates.length, 1);
    assert.equal(quotes.data.rates[0].shippingCents, 18520);
    const request = {
      requestKey: randomUUID(),
      items,
      customer,
      consent: true,
      shippingQuoteId: quotes.data.rates[0].id,
    };
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          ...request,
          customer: { ...customer, street: "Otra calle 456" },
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          ...request,
          shippingQuoteId: "forged",
        })
      ).status,
      409,
    );
    const created = await app.call("/api/orders", "POST", request),
      route = "/api/admin/orders/" + created.data.id;
    assert.equal(created.status, 201);
    assert.equal((await app.call(route + "/label", "POST", {})).status, 401);
    await app.call("/api/session", "POST", { password });
    assert.equal(
      (
        await app.call(route + "/label", "POST", {
          version: 1,
          confirmPurchase: true,
        })
      ).status,
      409,
    );
    await pay(app, route);
    const q = await app.call(route + "/shipping-rates", "POST", { version: 3 });
    const payload = {
      version: 3,
      confirmPurchase: true,
      quoteId: q.data.rates[0].id,
      expectedCents: 18520,
    };
    assert.equal(
      (
        await app.call(route + "/label", "POST", {
          ...payload,
          confirmPurchase: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await app.call(route + "/label", "POST", {
          ...payload,
          expectedCents: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await app.call(route, "PATCH", {
          version: 3,
          status: "shipped",
          handedToCarrier: true,
        })
      ).status,
      400,
    );
    const generated = await app.call(route + "/label", "POST", payload);
    assert.equal(generated.status, 201);
    assert.equal(generated.data.order.status, "paid");
    assert.equal(generated.data.order.labelJob.result.tracking, "TEST123456");
    assert.equal(
      (await app.call(route + "/label", "POST", payload)).status,
      200,
    );
    assert.equal(
      mock.calls.filter((c) => c.url.endsWith("/ship/generate/")).length,
      1,
    );
    assert.equal(
      (await app.call(route, "PATCH", { version: 3, status: "shipped" }))
        .status,
      400,
    );
    const shipped = await app.call(route, "PATCH", {
      version: 3,
      status: "shipped",
      handedToCarrier: true,
      carrier: "dhl",
      tracking: "tampered",
    });
    assert.equal(shipped.status, 200);
    assert.equal(shipped.data.order.carrier, "FedEx");
    assert.equal(shipped.data.order.tracking, "TEST123456");
    assert.ok(
      mock.calls.every(
        (c) => c.authorization === "Bearer synthetic-envia-token",
      ),
    );
    assert.ok(
      mock.calls.every(
        (c) =>
          c.url.startsWith("https://api-test.envia.com") ||
          c.url.startsWith("https://queries.test.envia.com"),
      ),
    );
  } finally {
    await app.close();
  }
});
test("Compra concurrente: una sola llamada; error incierto se conserva tras reinicio y se concilia sin recomprar", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-shipping-")),
    databasePath = path.join(folder, "shipping.sqlite");
  const mock = provider();
  let app = await start(mock, { databasePath });
  try {
    const { route } = await createOrder(app);
    await pay(app, route);
    const rates = await app.call(route + "/shipping-rates", "POST", {
      version: 3,
    });
    let release;
    mock.gate = new Promise((r) => (release = r));
    mock.generateError = true;
    const payload = {
      version: 3,
      confirmPurchase: true,
      quoteId: rates.data.rates[0].id,
      expectedCents: 18520,
    };
    const pending = app.call(route + "/label", "POST", payload);
    // Observe the lock through the public server's authenticated panel; no timing guesses.
    for (let i = 0; i < 50; i++) {
      const list = await app.call("/api/admin/orders");
      if (list.data.orders[0].labelJob) break;
    }
    assert.equal(
      (await app.call(route + "/label", "POST", payload)).status,
      409,
    );
    assert.equal(
      (await app.call(route, "PATCH", { version: 3, status: "cancelled" }))
        .status,
      409,
    );
    release();
    assert.equal((await pending).status, 502);
    await app.close();
    app = await start(mock, { databasePath });
    await app.call("/api/session", "POST", { password });
    assert.equal(
      (await app.call(route + "/label", "POST", payload)).status,
      409,
    );
    assert.equal(
      mock.calls.filter((c) => c.url.endsWith("/ship/generate/")).length,
      1,
    );
    const reconciled = await app.call(route + "/label-reconcile", "POST", {
      version: 3,
      checkedInEnvia: true,
      shipmentId: "1234",
      tracking: "EXISTING123",
      labelUrl: "https://files.envia.com/verified.pdf",
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.data.order.labelJob.state, "generated");
    assert.equal(
      (await app.call(route + "/label", "POST", payload)).status,
      200,
    );
    await app.close();
    app = await start(mock, { databasePath });
    await app.call("/api/session", "POST", { password });
    assert.equal(
      (await app.call(route + "/label", "POST", payload)).data.order.labelJob
        .result.tracking,
      "EXISTING123",
    );
    assert.equal(
      mock.calls.filter((c) => c.url.endsWith("/ship/generate/")).length,
      1,
    );
  } finally {
    await app.close();
    const relative = path.relative(os.tmpdir(), path.resolve(folder));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
test("Envia: sin cobertura, meta:error HTTP200 y estado inválido nunca producen tarifa ni filtran errores privados", async () => {
  const mock = provider(),
    app = await start(mock);
  try {
    mock.noCoverage = true;
    assert.equal(
      (
        await app.call("/api/shipping/rates", "POST", {
          items,
          customer,
          consent: true,
        })
      ).status,
      422,
    );
    mock.noCoverage = false;
    mock.rateError = true;
    const r = await app.call("/api/shipping/rates", "POST", {
      items,
      customer,
      consent: true,
    });
    assert.equal(r.status, 502);
    assert.ok(!JSON.stringify(r).includes("sensitive-provider-token"));
    assert.equal(
      (
        await app.call("/api/shipping/rates", "POST", {
          items,
          customer: { ...customer, state: "Falso" },
          consent: true,
        })
      ).status,
      422,
    );
  } finally {
    await app.close();
  }
});
test("Caducidad y recuperación de intento interrumpido: no se compra de nuevo sin revisión expresa", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-expiry-")),
    databasePath = path.join(folder, "orders.sqlite");
  const mock = provider();
  let app = await start(mock, { databasePath });
  try {
    const quotes = await app.call("/api/shipping/rates", "POST", {
      items,
      customer,
      consent: true,
    });
    const db = new DatabaseSync(databasePath);
    db.prepare("UPDATE shipping_quotes SET expires=0 WHERE id=?").run(
      quotes.data.rates[0].id,
    );
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          requestKey: randomUUID(),
          items,
          customer,
          consent: true,
          shippingQuoteId: quotes.data.rates[0].id,
        })
      ).status,
      409,
    );
    const { route, id } = await createOrder(app);
    await pay(app, route);
    db.prepare(
      "INSERT INTO shipping_jobs(order_id,state,payload) VALUES(?,'pending',?)",
    ).run(id, JSON.stringify({ environment: "sandbox" }));
    db.close();
    await app.close();
    app = await start(mock, { databasePath });
    await app.call("/api/session", "POST", { password });
    assert.equal(
      (await app.call("/api/admin/orders")).data.orders[0].labelJob.state,
      "uncertain",
    );
    assert.equal(
      (
        await app.call(route + "/label-reconcile", "POST", {
          version: 3,
          checkedInEnvia: true,
          confirmNoShipment: true,
          reference: "wrong",
        })
      ).status,
      400,
    );
    const released = await app.call(route + "/label-reconcile", "POST", {
      version: 3,
      checkedInEnvia: true,
      confirmNoShipment: true,
      reference: id,
    });
    assert.equal(released.status, 200);
    assert.equal(released.data.order.version, 4);
    assert.equal(released.data.order.labelJob, null);
    assert.equal(
      mock.calls.filter((c) => c.url.endsWith("/ship/generate/")).length,
      0,
    );
  } finally {
    await app.close();
    const relative = path.relative(os.tmpdir(), path.resolve(folder));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
test("Configuración incompleta y tarifas de sandbox bloqueadas para ventas en producción", async () => {
  assert.throws(() => createEnvia({ enabled: true, token: "" }), /ENVIA_TOKEN/);
  assert.throws(
    () => createEnvia({ enabled: true, token: "fake", sender: {} }),
    /ENVIA_ORIGIN_JSON/,
  );
  await assert.rejects(
    () =>
      createApp({
        ...config,
        origin: "https://example.test",
        production: true,
        envia: {
          enabled: true,
          environment: "sandbox",
          token: "fake",
          sender,
          profiles: {
            1: { weight: 1, dimensions: { length: 20, width: 20, height: 10 } },
          },
        },
      }),
    /simuladas/,
  );
});
