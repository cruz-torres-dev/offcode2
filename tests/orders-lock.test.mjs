// ORDERS_ENABLED=false is a mandatory server switch: no dashboard value may
// reopen order reception while it is set. Sales keep requiring the commercial
// authorization and configuration the product already demands.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { settingsStore } from "../server/owner-settings.mjs";
import { migrate } from "../server/db.mjs";
import { openDatabase } from "../server/database.mjs";

const origin = "http://127.0.0.1:9876";
const password = "synthetic-lock-password";
const settingsKey = "ef".repeat(32);
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
const sales = {
  whatsapp: "520000000000",
  privacyUrl: "https://example.test/privacy",
  termsUrl: "https://example.test/terms",
  bank: {
    name: "BANCO DE PRUEBA",
    beneficiary: "CLIENTE FICTICIO",
    clabe: "000000000000000000",
  },
};
const enviaOn = {
  enabled: true,
  environment: "sandbox",
  printSize: "PAPER_4X6",
  token: "synthetic-envia-token",
  sender: {
    name: "OFFCODE",
    company: "OFFCODE",
    email: "envios@example.test",
    phone: "520000000000",
    street: "Calle Ficticia",
    number: "1",
    district: "Centro",
    city: "Ciudad Ficticia",
    state: "GT",
    postalCode: "37000",
    reference: "",
    country: "MX",
  },
  profiles: {
    1: { weight: 0.5, dimensions: { length: 20, width: 15, height: 5 } },
  },
};

async function seedSettings(databasePath, value) {
  const db = await openDatabase({ path: databasePath });
  try {
    await migrate(db);
    await settingsStore(db, settingsKey).save(value, 0);
  } finally {
    await db.close();
  }
}

async function start(options = {}) {
  const app = await createApp({
    origin,
    password,
    settingsKey,
    enabled: false,
    databasePath: ":memory:",
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  const call = async (route, method = "GET", data) => {
    const res = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    return { status: res.status, data: await res.json() };
  };
  return { ...app, call };
}

test("ORDERS_ENABLED=false bloquea los pedidos aunque la configuración guardada los habilite", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-lock-"));
  const databasePath = path.join(folder, "lock.sqlite");
  await seedSettings(databasePath, { enabled: true, ...sales, envia: enviaOn });
  const app = await start({ databasePath, ordersEnabledEnv: "false" });
  try {
    await app.call("/api/session", "POST", { password });
    // La configuración guardada dice "habilitados", pero el interruptor la cierra.
    const admin = await app.call("/api/admin/settings");
    assert.equal(admin.data.settings.enabled, false);
    assert.match(
      admin.data.checks.find((c) => c.id === "orders").detail,
      /ORDERS_ENABLED=false/,
    );
    // El panel no puede reactivarlos: el guardado se rechaza.
    const blocked = await app.call("/api/admin/settings", "PATCH", {
      settings: { ...admin.data.settings, enabled: true },
      version: admin.data.version,
      currentPassword: password,
    });
    assert.equal(blocked.status, 409);
    assert.match(blocked.data.error, /ORDERS_ENABLED=false/);
    // La tienda sigue cerrada y enviar una cotización no abre pedidos.
    assert.equal((await app.call("/api/config")).data.enabled, false);
    assert.equal(
      (await app.call("/api/shipping/states")).status,
      503,
    );
    assert.equal(
      (await app.call("/api/shipping/rates", "POST", { consent: true })).status,
      503,
    );
    // Contar existencias no abre la venta: el interruptor manda.
    assert.equal(
      (
        await app.call(
          "/api/admin/inventory/VAR-HOODIE-M/movements",
          "POST",
          { type: "entry", qty: 5, reason: "Conteo sintético" },
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          requestKey: randomUUID(),
          customer,
          consent: true,
          items: [{ size: "M", qty: 1 }],
        })
      ).status,
      503,
    );
    // El rechazo no crea pedidos ni reserva inventario.
    assert.equal((await app.call("/api/admin/orders")).data.orders.length, 0);
    const variant = (await app.call("/api/admin/inventory")).data.variants.find(
      (v) => v.size === "M",
    );
    assert.equal(variant.onHand, 5);
    assert.equal(variant.reserved, 0);
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Sin el interruptor, la configuración guardada habilita la venta y sigue exigiendo existencias contadas", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-lock-open-"));
  const databasePath = path.join(folder, "open.sqlite");
  await seedSettings(databasePath, {
    enabled: true,
    ...sales,
    envia: { enabled: false, environment: "sandbox", printSize: "PAPER_4X6", token: "", sender: { country: "MX" }, profiles: {} },
  });
  const app = await start({ databasePath, ordersEnabledEnv: "true" });
  try {
    assert.equal((await app.call("/api/config")).data.enabled, true);
    await app.call("/api/session", "POST", { password });
    // Sin conteo, la variante sigue sin poder comprarse.
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          requestKey: randomUUID(),
          customer,
          consent: true,
          items: [{ size: "M", qty: 1 }],
        })
      ).status,
      400,
    );
    await app.call(
      "/api/admin/inventory/VAR-HOODIE-M/movements",
      "POST",
      { type: "entry", qty: 2, reason: "Conteo sintético" },
    );
    assert.equal(
      (
        await app.call("/api/orders", "POST", {
          requestKey: randomUUID(),
          customer,
          consent: true,
          items: [{ size: "M", qty: 1 }],
        })
      ).status,
      201,
    );
  } finally {
    await app.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Con el interruptor en false, el arranque no abre ventas aunque se pida enabled:true sin datos completos", async () => {
  const app = await start({
    enabled: true,
    ordersEnabledEnv: "false",
    databasePath: ":memory:",
  });
  try {
    assert.equal((await app.call("/api/config")).data.enabled, false);
    assert.equal((await app.call("/api/orders", "POST", {})).status, 503);
  } finally {
    await app.close();
  }
});
