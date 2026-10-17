import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { settingsStore } from "../server/owner-settings.mjs";
const origin = "http://127.0.0.1:9876",
  password = "synthetic-owner-password",
  key = "ab".repeat(32);
const customer = {
  name: "Persona Ficticia",
  phone: "520000000000",
  email: "persona@example.test",
  street: "Calle Ficticia 123",
  neighborhood: "Centro",
  city: "Ciudad Ficticia",
  state: "GT",
  postalCode: "37000",
};
async function start(options = {}) {
  const app = await createApp({
    origin,
    password,
    databasePath: ":memory:",
    enabled: false,
    settingsKey: key,
    ...options,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  async function call(route, method = "GET", body, headers = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return {
      status: response.status,
      headers: response.headers,
      data: await response.json(),
    };
  }
  return { ...app, call };
}
async function settings(app) {
  return (await app.call("/api/admin/settings")).data;
}
async function save(app, settings, version) {
  return app.call("/api/admin/settings", "PATCH", {
    settings,
    version,
    currentPassword: password,
  });
}
test("Configuración privada: borrador cifrado, token oculto, versiones y reinicio", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-settings-")),
    databasePath = path.join(folder, "test.sqlite");
  let app = await start({
    databasePath,
    envia: {
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [{ name: "Guanajuato", code_2_digits: "GT" }],
          }),
        ),
    },
  });
  try {
    assert.equal((await app.call("/api/admin/settings")).status, 401);
    await app.call("/api/session", "POST", { password });
    const initial = await settings(app),
      draft = initial.settings;
    draft.envia.token = "synthetic-private-token";
    assert.equal(
      (
        await app.call(
          "/api/admin/settings",
          "PATCH",
          { settings: draft, version: 0, currentPassword: password },
          { Origin: "https://other.test" },
        )
      ).status,
      403,
    );
    assert.equal((await save(app, draft, 0)).status, 200);
    assert.equal((await save(app, draft, 0)).status, 409);
    const saved = await settings(app);
    assert.equal(saved.settings.envia.tokenConfigured, true);
    assert.equal(saved.settings.envia.token, undefined);
    assert.doesNotMatch(
      JSON.stringify((await app.call("/api/config")).data),
      /synthetic-private-token/,
    );
    assert.equal(
      (await app.call("/api/admin/envia/check", "POST", {})).status,
      200,
    );
    assert.equal(
      (await save(app, { ...saved.settings, enabled: true }, 1)).status,
      400,
    );
    const db = new DatabaseSync(databasePath),
      row = db.prepare("SELECT payload FROM owner_settings").get();
    assert.ok(
      !Buffer.from(row.payload).includes(
        Buffer.from("synthetic-private-token"),
      ),
    );
    db.close();
    await app.close();
    await assert.rejects(
      () => createApp({ origin, password, databasePath, settingsKey: "" }),
      /original/,
    );
    await assert.rejects(
      () =>
        createApp({
          origin,
          password,
          databasePath,
          settingsKey: "cd".repeat(32),
        }),
      /cifrada/,
    );
    app = await start({ databasePath });
    await app.call("/api/session", "POST", { password });
    assert.equal((await settings(app)).settings.envia.tokenConfigured, true);
    const restored = (await settings(app)).settings;
    restored.envia.token = "";
    assert.equal((await save(app, restored, 1)).status, 200);
    assert.equal((await settings(app)).settings.envia.tokenConfigured, true);
    restored.envia.clearToken = true;
    assert.equal((await save(app, restored, 2)).status, 200);
    assert.equal((await settings(app)).settings.envia.tokenConfigured, false);
  } finally {
    await app.close();
    assert.ok(
      path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
test("Cambiar contraseña invalida sesiones y persiste sin publicar credenciales", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-auth-")),
    databasePath = path.join(folder, "test.sqlite");
  let app = await start({ databasePath });
  const next = "another-synthetic-owner-password";
  try {
    await app.call("/api/session", "POST", { password });
    assert.equal(
      (
        await app.call("/api/admin/password", "PATCH", {
          currentPassword: "wrong",
          newPassword: next,
          confirmPassword: next,
        })
      ).status,
      401,
    );
    await app.call("/api/session", "POST", { password });
    assert.equal(
      (
        await app.call("/api/admin/password", "PATCH", {
          currentPassword: password,
          newPassword: next,
          confirmPassword: next,
        })
      ).status,
      200,
    );
    assert.equal((await app.call("/api/admin/orders")).status, 401);
    assert.equal(
      (await app.call("/api/session", "POST", { password })).status,
      401,
    );
    assert.equal(
      (await app.call("/api/session", "POST", { password: next })).status,
      200,
    );
    await app.close();
    app = await start({ databasePath });
    assert.equal(
      (await app.call("/api/session", "POST", { password })).status,
      401,
    );
    assert.equal(
      (await app.call("/api/session", "POST", { password: next })).status,
      200,
    );
    const db = new DatabaseSync(databasePath),
      row = db.prepare("SELECT hash,salt FROM owner_auth").get();
    assert.equal(row.hash.length, 64);
    assert.equal(row.salt.length, 32);
    db.close();
  } finally {
    await app.close();
    assert.ok(
      path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
test("La cuenta acordada se conserva al editar la tienda; cerrar ventas bloquea pedidos", async () => {
  const app = await start();
  try {
    await app.call("/api/session", "POST", { password });
    const draft = (await settings(app)).settings;
    Object.assign(draft, {
      enabled: true,
      whatsapp: "520000000000",
      bank: {
        name: "BANCO FICTICIO",
        beneficiary: "PERSONA FICTICIA",
        clabe: "000000000000000000",
      },
      privacyUrl: "https://example.test/privacy",
      termsUrl: "https://example.test/terms",
    });
    assert.equal((await save(app, draft, 0)).status, 200);
    const created = await app.call("/api/orders", "POST", {
      requestKey: randomUUID(),
      customer,
      consent: true,
      items: [{ size: "L", qty: 2 }],
    });
    assert.equal(created.status, 201);
    const confirmed = await app.call(
      "/api/admin/orders/" + created.data.id,
      "PATCH",
      {
        version: 1,
        status: "awaiting_transfer",
        stockConfirmed: true,
        shippingCents: 10000,
      },
    );
    assert.equal(confirmed.data.order.transferAccount.name, "BANCO FICTICIO");
    draft.bank.name = "OTRO BANCO FICTICIO";
    draft.enabled = false;
    assert.equal((await save(app, draft, 1)).status, 200);
    assert.equal((await app.call("/api/config")).data.enabled, false);
    assert.equal((await app.call("/api/orders", "POST", {})).status, 503);
    const list = await app.call(
      "/api/admin/orders?q=" + created.data.id + "&status=awaiting_transfer",
    );
    assert.equal(list.data.total, 1);
    assert.equal(list.data.orders[0].transferAccount.name, "BANCO FICTICIO");
    assert.equal(
      (await app.call("/api/admin/orders?q=no-match")).data.total,
      0,
    );
    assert.equal(
      (await app.call("/api/admin/overview")).data.counts.awaiting_transfer,
      1,
    );
  } finally {
    await app.close();
  }
});
test("Cifrado autenticado: modificar el contenido impide abrir la configuración", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = settingsStore(db, key);
    store.save({ private: "synthetic" }, 0);
    db.exec("UPDATE owner_settings SET payload=x'00'");
    assert.throws(() => store.read(), /cifrada/);
  } finally {
    db.close();
  }
});
test("La búsqueda y los filtros abarcan pedidos fuera de la primera página", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-search-")),
    databasePath = path.join(folder, "test.sqlite");
  const app = await start({ databasePath });
  try {
    const db = new DatabaseSync(databasePath),
      insert = db.prepare(
        "INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)",
      );
    for (let i = 0; i < 55; i++) {
      const id = "OF-" + i.toString(16).padStart(12, "0").toUpperCase();
      insert.run(
        id,
        randomUUID(),
        new Date(i * 1000).toISOString(),
        JSON.stringify({
          id,
          customer: { name: i === 0 ? "Persona buscada" : "Otra persona" },
          status: i === 0 ? "paid" : "requested",
          totalCents: 165000,
        }),
      );
    }
    db.close();
    await app.call("/api/session", "POST", { password });
    const first = await app.call("/api/admin/orders");
    assert.equal(first.data.orders.length, 50);
    assert.equal(first.data.total, 55);
    assert.equal(first.data.more, true);
    const found = await app.call("/api/admin/orders?q=buscada&status=paid");
    assert.equal(found.data.total, 1);
    assert.equal(found.data.orders[0].customer.name, "Persona buscada");
    const overview = (await app.call("/api/admin/overview")).data;
    assert.equal(overview.total, 55);
    assert.equal(overview.paidTotalCents, 165000);
  } finally {
    await app.close();
    assert.ok(
      path.resolve(folder).startsWith(path.resolve(os.tmpdir()) + path.sep),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
test("Cambiar la configuración invalida tarifas anteriores sin generar guías", async () => {
  let purchases = 0;
  const fetcher = async (url) => {
    if (url.endsWith("/state?country_code=MX"))
      return new Response(
        JSON.stringify({ data: [{ name: "Guanajuato", code_2_digits: "GT" }] }),
      );
    if (url.endsWith("/ship/rate/"))
      return new Response(
        JSON.stringify({
          meta: "rate",
          data: [
            {
              carrier: "fedex",
              service: "ground",
              totalPrice: 185.2,
              currency: "MXN",
            },
          ],
        }),
      );
    purchases++;
    throw Error("No debe comprar");
  };
  const app = await start({
    enabled: true,
    bank: {
      name: "FICTICIO",
      beneficiary: "FICTICIO",
      clabe: "000000000000000000",
    },
    whatsapp: "520000000000",
    privacyUrl: "https://example.test/privacy",
    termsUrl: "https://example.test/terms",
    envia: {
      enabled: true,
      environment: "sandbox",
      token: "synthetic-only",
      fetch: fetcher,
      sender: {
        name: "Origen Ficticio",
        phone: "520000000000",
        email: "origen@example.test",
        street: "Calle Ficticia",
        number: "123",
        district: "Centro",
        city: "León",
        state: "GT",
        country: "MX",
        postalCode: "37000",
      },
      profiles: {
        1: { weight: 0.75, dimensions: { length: 30, width: 20, height: 10 } },
      },
    },
  });
  try {
    const items = [{ size: "M", qty: 1 }],
      rates = await app.call("/api/shipping/rates", "POST", {
        items,
        customer,
        consent: true,
      });
    assert.equal(rates.status, 200);
    await app.call("/api/session", "POST", { password });
    const draft = (await settings(app)).settings;
    draft.envia.token = "";
    draft.bank.name = "NUEVO FICTICIO";
    assert.equal((await save(app, draft, 0)).status, 200);
    const order = await app.call("/api/orders", "POST", {
      requestKey: randomUUID(),
      items,
      customer,
      consent: true,
      shippingQuoteId: rates.data.rates[0].id,
    });
    assert.ok([400, 409].includes(order.status));
    assert.equal(purchases, 0);
  } finally {
    await app.close();
  }
});
