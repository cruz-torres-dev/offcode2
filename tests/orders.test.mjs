import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";

const origin = "http://127.0.0.1:9876";
const password = "synthetic-test-password-only";
const config = {
  origin,
  password,
  enabled: true,
  bank: {
    name: "BANCO DE PRUEBA",
    beneficiary: "CLIENTE FICTICIO",
    clabe: "000000000000000000",
  },
  whatsapp: "520000000000",
  privacyUrl: "https://example.test/privacy",
  termsUrl: "https://example.test/terms",
};
const customer = {
  name: "Persona Ficticia",
  phone: "520000000000",
  email: "persona@example.test",
  street: "Calle de prueba 123",
  neighborhood: "Colonia ficticia",
  city: "Ciudad de prueba",
  state: "Estado de prueba",
  postalCode: "00000",
  notes: "",
};
async function start(options = {}) {
  const app = await createApp({
    ...config,
    databasePath: ":memory:",
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  const call = async (route, method = "GET", data, extra = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...extra,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, headers: res.headers, data: await res.json() };
  };
  return { ...app, call, base };
}
test("Transferencia manual: solicitud, confirmación, pago, envío y persistencia", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-test-"));
  const db = path.join(folder, "orders.sqlite");
  let app = await start({ databasePath: db });
  try {
    assert.equal((await app.call("/api/admin/orders")).status, 401);
    assert.equal((await app.call("/api/orders", "POST", null)).status, 400);
    assert.equal(
      (
        await app.call(
          "/api/session",
          "POST",
          { password },
          { Origin: "https://other.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await app.call("/api/session", "POST", { password: "wrong" })).status,
      401,
    );
    const login = await app.call("/api/session", "POST", { password });
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const request = {
      requestKey: randomUUID(),
      customer,
      consent: true,
      items: [{ size: "M", qty: 2, unitCents: 1 }],
    };
    assert.equal(
      (await app.call("/api/orders", "POST", { ...request, consent: false }))
        .status,
      400,
    );
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          ...request,
          items: [{ size: "M", qty: -1 }],
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          ...request,
          items: [
            { size: "M", qty: 1 },
            { size: "M", qty: 2 },
          ],
        })
      ).status,
      400,
    );
    const created = await app.call("/api/orders", "POST", request);
    assert.equal(created.status, 201);
    assert.equal(created.data.subtotalCents, 330000);
    const repeat = await app.call("/api/orders", "POST", request);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.data.id, created.data.id);
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          ...request,
          customer: { ...customer, name: "Otra persona" },
        })
      ).status,
      409,
    );
    const route = "/api/admin/orders/" + created.data.id;
    assert.equal(
      (
        await app.call(route, "PATCH", {
          version: 1,
          status: "shipped",
          carrier: "Prueba",
          tracking: "0000",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await app.call(route, "PATCH", {
          version: 1,
          status: "awaiting_transfer",
          shippingCents: 10550,
        })
      ).status,
      400,
    );
    const quote = await app.call(route, "PATCH", {
      version: 1,
      status: "awaiting_transfer",
      shippingCents: 10550,
      stockConfirmed: true,
    });
    assert.equal(quote.status, 200);
    assert.equal(quote.data.order.totalCents, 340550);
    assert.equal(
      (
        await app.call(route, "PATCH", {
          version: 1,
          status: "paid",
          paymentVerified: true,
        })
      ).status,
      409,
    );
    assert.equal(
      (await app.call(route, "PATCH", { version: 2, status: "paid" })).status,
      400,
    );
    assert.equal(
      (
        await app.call(route, "PATCH", {
          version: 2,
          status: "paid",
          paymentVerified: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await app.call(route, "PATCH", {
          version: 3,
          status: "shipped",
          carrier: "",
          tracking: "x",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await app.call(route, "PATCH", {
          version: 3,
          status: "shipped",
          carrier: "DHL",
          tracking: "TEST0001",
          handedToCarrier: true,
        })
      ).status,
      400,
    );
    const shipped = await app.call(route, "PATCH", {
      version: 3,
      status: "shipped",
      carrier: "FedEx",
      tracking: "TEST0001",
      handedToCarrier: true,
    });
    assert.equal(shipped.status, 200);
    const delivered = await app.call(route, "PATCH", {
      version: 4,
      status: "delivered",
    });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.data.order.history.length, 5);
    await app.close();
    app = await start({ databasePath: db });
    await app.call("/api/session", "POST", { password });
    const list = await app.call("/api/admin/orders");
    assert.equal(list.data.orders.length, 1);
    assert.equal(list.data.orders[0].status, "delivered");
    assert.equal(list.data.orders[0].tracking, "TEST0001");
    await app.call("/api/logout", "POST", {});
    assert.equal((await app.call("/api/admin/orders")).status, 401);
  } finally {
    await app.close();
    const relative = path.relative(os.tmpdir(), path.resolve(folder));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
test("Ventas desactivadas por defecto y recursos privados fuera del servidor estático", async () => {
  const app = await start({ enabled: false });
  try {
    assert.equal((await app.call("/api/config")).data.enabled, false);
    assert.equal((await app.call("/api/orders", "POST", {})).status, 503);
    assert.equal((await fetch(app.base + "/.env")).status, 404);
    assert.equal((await fetch(app.base + "/server/server.mjs")).status, 404);
    const home = await fetch(app.base + "/");
    assert.equal(home.status, 200);
    const homeHtml = await home.text();
    assert.match(homeHtml, /id="collection"/);
    assert.doesNotMatch(homeHtml, /Lista VIP|Quiero estar dentro|teaser\.js/);
    const range = await fetch(app.base + "/assets/campaign.mp4", {
      headers: { Range: "bytes=0-99" },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
  } finally {
    await app.close();
  }
});
test("No se habilitan ventas sin configuración completa", async () => {
  await assert.rejects(
    () => createApp({ enabled: true, password: "", databasePath: ":memory:" }),
    /Completa/,
  );
});
