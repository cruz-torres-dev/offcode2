// Data layer tests: temporary SQLite databases and synthetic records only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import {
  openDatabase,
  resolveDatabaseConfig,
  isUniqueViolation,
} from "../server/database.mjs";
import { migrate, readSchemaVersion, SCHEMA_VERSION } from "../server/db.mjs";
import { createCatalogStore } from "../server/catalog-store.mjs";
import { TABLE_ORDER } from "../server/schema.mjs";
const tempDb = async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-db-"));
  return { folder, file: path.join(folder, "test.sqlite") };
};

test("SQLite privado: configuración explícita y sin fallback de otro motor", () => {
  assert.deepEqual(resolveDatabaseConfig({}), { driver: "sqlite", path: "./data/offcode.sqlite" });
  const secret = "synthetic-private-value";
  assert.throws(() => resolveDatabaseConfig({ DB_DRIVER: secret }), (e) => e.code === "DB_CONFIG" && !e.message.includes(secret));
  assert.throws(() => resolveDatabaseConfig({ DATABASE_PATH: "./dist/private.sqlite" }), /fuera de dist/);
  assert.throws(() => resolveDatabaseConfig({ DATABASE_PATH: "" }), /DATABASE_PATH/);
  assert.throws(() => resolveDatabaseConfig({ RENDER: "true" }), /disco persistente/);
  assert.throws(() => resolveDatabaseConfig({ RENDER: "true", DATABASE_PATH: "./data/offcode.sqlite" }), /disco persistente/);
  assert.equal(resolveDatabaseConfig({ RENDER: "true", DATABASE_PATH: "/var/data/offcode.sqlite" }).path, "/var/data/offcode.sqlite");
  assert.equal(isUniqueViolation(new Error("UNIQUE constraint failed: orders.request_key")), true);
  assert.equal(isUniqueViolation(new Error("no such table")), false);
});

test("El esquema se crea completo, con índices y restricciones, y es idempotente", async () => {
  const { folder, file } = await tempDb();
  const db = await openDatabase({ driver: "sqlite", path: file });
  try {
    assert.equal(await readSchemaVersion(db), 0);
    assert.equal(await migrate(db), SCHEMA_VERSION);
    const tables = (
      await db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    ).map((row) => row.name);
    for (const table of TABLE_ORDER) assert.ok(tables.includes(table), table);
    const indexes = (
      await db.all("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'")
    ).map((row) => row.name);
    assert.ok(indexes.includes("inventory_movements_variant"));
    assert.ok(indexes.includes("order_reservations_variant"));
    // Re-running never duplicates the catalog nor touches existing orders.
    const counts = {};
    for (const table of TABLE_ORDER)
      counts[table] = (await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;
    await migrate(db);
    await migrate(db);
    for (const table of TABLE_ORDER)
      assert.equal(
        (await db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n,
        counts[table],
        table,
      );
    assert.equal(counts.products, 1);
    assert.equal(counts.variants, 4);
    assert.equal(counts.orders, 0);
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Dos compradores simultáneos no se llevan la última unidad", async () => {
  const { folder, file } = await tempDb();
  const db = await openDatabase({ driver: "sqlite", path: file });
  try {
    await migrate(db);
    const catalog = createCatalogStore(db);
    const variantId = "VAR-HOODIE-M";
    await catalog.recordMovement(variantId, {
      type: "entry",
      qty: 1,
      reason: "Conteo sintético",
    });
    const order = (suffix) => ({
      id: `OF-${suffix}`,
      requestKey: `key-${suffix}`,
      createdAt: new Date().toISOString(),
    });
    const attempt = async (suffix) => {
      const value = order(suffix);
      try {
        await catalog.tx(async (exec) => {
          await exec.run(
            "INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)",
            [value.id, value.requestKey, value.createdAt, JSON.stringify({ id: value.id, status: "requested" })],
          );
          await catalog.reserve(value.id, [{ variantId, size: "M", qty: 1 }], exec);
        });
        return "ok";
      } catch (error) {
        return error.status ?? "error";
      }
    };
    const results = await Promise.all([attempt("A"), attempt("B")]);
    assert.deepEqual(results.sort(), [409, "ok"], "una reserva gana y la otra se rechaza");
    const inventory = await db.get("SELECT on_hand, reserved FROM inventory WHERE variant_id=?", [
      variantId,
    ]);
    assert.equal(inventory.on_hand, 1);
    assert.equal(inventory.reserved, 1, "nunca se reserva más de lo que existe");
    assert.equal(
      (await db.get("SELECT COUNT(*) AS n FROM orders")).n,
      1,
      "el pedido rechazado no deja fila a medias",
    );
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Una transacción fallida no deja inventario descontado ni pedido a medias", async () => {
  const { folder, file } = await tempDb();
  const db = await openDatabase({ driver: "sqlite", path: file });
  try {
    await migrate(db);
    const catalog = createCatalogStore(db);
    const variantId = "VAR-HOODIE-L";
    await catalog.recordMovement(variantId, { type: "entry", qty: 3, reason: "Conteo sintético" });
    await assert.rejects(() =>
      catalog.tx(async (exec) => {
        await exec.run(
          "INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)",
          ["OF-ROLLBACK", "key-rollback", new Date().toISOString(), "{}"],
        );
        await catalog.reserve("OF-ROLLBACK", [{ variantId, size: "L", qty: 1 }], exec);
        throw new Error("fallo simulado después de reservar");
      }),
    );
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
    const inventory = await db.get("SELECT on_hand, reserved FROM inventory WHERE variant_id=?", [
      variantId,
    ]);
    assert.equal(inventory.reserved, 0, "la reserva se revierte con la transacción");
    assert.equal(inventory.on_hand, 3);
    assert.equal(
      (await db.get("SELECT COUNT(*) AS n FROM order_reservations")).n,
      0,
    );
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("Reservar, cobrar y cancelar mueven el inventario una sola vez", async () => {
  const { folder, file } = await tempDb();
  const db = await openDatabase({ driver: "sqlite", path: file });
  try {
    await migrate(db);
    const catalog = createCatalogStore(db);
    const variantId = "VAR-HOODIE-S";
    await catalog.recordMovement(variantId, { type: "entry", qty: 5, reason: "Conteo sintético" });
    const items = [{ variantId, size: "S", qty: 2 }];
    await catalog.tx(async (exec) => {
      await exec.run(
        "INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)",
        ["OF-FLOW", "key-flow", new Date().toISOString(), "{}"],
      );
      await catalog.reserve("OF-FLOW", items, exec);
    });
    let inventory = await db.get("SELECT on_hand, reserved FROM inventory WHERE variant_id=?", [variantId]);
    assert.deepEqual([inventory.on_hand, inventory.reserved], [5, 2]);
    await catalog.tx(async (exec) => {
      await catalog.sell("OF-FLOW", exec);
    });
    inventory = await db.get("SELECT on_hand, reserved FROM inventory WHERE variant_id=?", [variantId]);
    assert.deepEqual([inventory.on_hand, inventory.reserved], [3, 0]);
    // Cancelling after a sale must not return sold units to the shelf.
    await catalog.tx(async (exec) => {
      await catalog.release("OF-FLOW", exec);
    });
    inventory = await db.get("SELECT on_hand, reserved FROM inventory WHERE variant_id=?", [variantId]);
    assert.deepEqual([inventory.on_hand, inventory.reserved], [3, 0]);
    const movements = await catalog.listMovements(variantId);
    assert.deepEqual(
      movements.map((m) => m.type).sort(),
      ["entry", "reserve", "sale"],
    );
    assert.equal(movements.filter((m) => m.type === "sale").length, 1);
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("El inventario no admite cantidades negativas ni reservas por encima de existencias", async () => {
  const { folder, file } = await tempDb();
  const db = await openDatabase({ driver: "sqlite", path: file });
  try {
    await migrate(db);
    const catalog = createCatalogStore(db);
    const variantId = "VAR-HOODIE-XL";
    await assert.rejects(
      () => catalog.recordMovement(variantId, { type: "adjustment", qty: -1, reason: "prueba" }),
      /negativas/,
    );
    await assert.rejects(
      () => catalog.recordMovement(variantId, { type: "adjustment", qty: -1, reason: "" }),
      /motivo/,
    );
    await catalog.recordMovement(variantId, { type: "entry", qty: 2, reason: "Conteo" });
    await assert.rejects(
      () =>
        catalog.tx(async (exec) =>
          catalog.reserve("OF-X", [{ variantId, size: "XL", qty: 3 }], exec),
        ),
      (error) => error.status === 409,
    );
  } finally {
    await db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("El panel exige sesión, rechaza otro origen y no expone credenciales", async () => {
  const origin = "http://127.0.0.1:9876";
  const password = "synthetic-database-admin-password";
  const secret = "secreto-de-base-de-datos-que-no-debe-salir";
  const app = await createApp({
    origin,
    password,
    databasePath: ":memory:",
    enabled: false,
    env: { DB_DRIVER: "sqlite", DB_PASSWORD: secret },
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
    return { status: res.status, headers: res.headers, text: await res.text() };
  };
  try {
    assert.equal((await call("/api/admin/orders")).status, 401);
    assert.equal((await call("/api/admin/inventory")).status, 401);
    assert.equal(
      (await call("/api/session", "POST", { password }, { Origin: "https://otro.test" })).status,
      403,
    );
    assert.equal((await call("/api/session", "POST", { password: "incorrecta" })).status, 401);
    const login = await call("/api/session", "POST", { password });
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    const orders = await call("/api/admin/orders");
    assert.equal(orders.status, 200);
    assert.equal(orders.headers.get("cache-control"), "no-store");
    assert.ok(!orders.text.includes(secret));
    const config = await call("/api/config");
    assert.equal(config.status, 200);
    assert.ok(!config.text.includes(secret), "la configuración pública no filtra la contraseña de la base");
    assert.ok(!/DB_(HOST|USER|PASSWORD|NAME)/.test(config.text));
    assert.equal((await call("/api/logout", "POST", {})).status, 200);
    assert.equal((await call("/api/admin/orders")).status, 401);
  } finally {
    await app.close();
  }
});


test("Una petición externa espera al rollback de una transacción pausada", async () => {
  const db = await openDatabase({ path: ":memory:", env: {} });
  let release, entered;
  const gate = new Promise((r) => { release = r; });
  const ready = new Promise((r) => { entered = r; });
  try {
    await db.exec("CREATE TABLE isolation_test(id TEXT PRIMARY KEY)");
    const transaction = assert.rejects(db.tx(async (tx) => {
      await tx.run("INSERT INTO isolation_test VALUES(?)", ["rolled-back"]);
      entered();
      await gate;
      throw Error("synthetic rollback");
    }), /synthetic rollback/);
    await ready;
    let finished = false;
    const external = db.run("INSERT INTO isolation_test VALUES(?)", ["committed-outside"])
      .then(() => { finished = true; });
    await new Promise((r) => setImmediate(r));
    assert.equal(finished, false, "otra petición no puede ejecutar SQL dentro de la transacción ajena");
    release();
    await transaction;
    await external;
    assert.deepEqual((await db.all("SELECT id FROM isolation_test")).map((r) => r.id), ["committed-outside"]);
  } finally { release?.(); await db.close(); }
});

test("Migrar un esquema anterior preserva datos; una versión futura se rechaza sin tocar tablas", async () => {
  const db = await openDatabase({ path: ":memory:", env: {} });
  try {
    await db.exec("CREATE TABLE orders(id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL)");
    const payload = JSON.stringify({ id: "OF-LEGACY", status: "paid", items: [] });
    await db.run("INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)", ["OF-LEGACY", "legacy-key", "2026-01-01", payload]);
    await migrate(db);
    await migrate(db);
    assert.equal((await db.get("SELECT payload FROM orders WHERE id=?", ["OF-LEGACY"])).payload, payload);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM products")).n, 1);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM variants")).n, 4);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM inventory_movements")).n, 0);
    const tables = await db.all("SELECT name FROM sqlite_master ORDER BY name");
    await db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
    await assert.rejects(migrate(db), /más reciente/);
    assert.deepEqual(await db.all("SELECT name FROM sqlite_master ORDER BY name"), tables);
    assert.equal((await db.get("SELECT payload FROM orders WHERE id=?", ["OF-LEGACY"])).payload, payload);
  } finally { await db.close(); }
});

test("Crea el directorio privado y conserva inventario, reserva y movimientos tras reiniciar", async () => {
  const { folder } = await tempDb();
  const file = path.join(folder, "private", "nested", "orders.sqlite");
  let db;
  try {
    db = await openDatabase({ path: file, env: {} });
    await migrate(db);
    const catalog = createCatalogStore(db);
    await catalog.recordMovement("VAR-HOODIE-S", { type: "entry", qty: 2, reason: "Conteo sintético" });
    await catalog.tx(async (tx) => {
      await tx.run("INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)", ["OF-RESTART", "restart-key", "2026-01-01", "{}"]);
      await catalog.reserve("OF-RESTART", [{ variantId: "VAR-HOODIE-S", size: "S", qty: 1 }], tx);
    });
    await db.close();
    db = await openDatabase({ path: file, env: {} });
    await migrate(db);
    const stock = await db.get("SELECT on_hand,reserved FROM inventory WHERE variant_id=?", ["VAR-HOODIE-S"]);
    assert.deepEqual([stock.on_hand, stock.reserved], [2, 1]);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM orders")).n, 1);
    assert.equal((await db.get("SELECT state FROM order_reservations WHERE order_id=?", ["OF-RESTART"])).state, "reserved");
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM inventory_movements")).n, 2);
    assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
    assert.equal((await db.get("PRAGMA integrity_check")).integrity_check, "ok");
  } finally { if (db) await db.close(); await rm(folder, { recursive: true, force: true }); }
});
