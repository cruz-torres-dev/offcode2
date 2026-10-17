// Repeatable loopback-only exercise. This is NOT a Render or Envia capacity test.
import { createApp } from "../server/server.mjs";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-load-"));
const origin = "http://127.0.0.1:9876",
  password = "synthetic-load-password";
let app;
try {
  app = await createApp({
    databasePath: path.join(folder, "load.sqlite"),
    origin,
    password,
    production: false,
    email: { env: {}, autoStart: false, logger: () => {} },
    enabled: true,
    waitlistEnabled: false,
    trustRenderProxy: false,
    bank: {
      name: "FICTICIO",
      beneficiary: "PRUEBA",
      clabe: "000000000000000000",
    },
    whatsapp: "520000000000",
    privacyUrl: "https://example.test/privacy",
    termsUrl: "https://example.test/terms",
    envia: { enabled: false },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  async function batch(name, count, concurrency, job) {
    let cursor = 0,
      errors = 0,
      bytes = 0;
    const latencies = [],
      started = performance.now();
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < count) {
          const index = cursor++,
            at = performance.now();
          const r = await job(index);
          bytes += (await r.arrayBuffer()).byteLength;
          if (!r.ok) errors++;
          latencies.push(performance.now() - at);
        }
      }),
    );
    const elapsedMs = performance.now() - started;
    latencies.sort((a, b) => a - b);
    const result = {
      name,
      requests: count,
      concurrency,
      errors,
      elapsedMs: Math.round(elapsedMs),
      p95Ms: Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]),
      bytes,
    };
    assert.equal(errors, 0, `${name}: hubo errores`);
    return result;
  }
  const routes = [
    "/",
    "/styles.css",
    "/app.js",
    "/api/config",
    "/assets/campaign-front-640.webp",
    "/assets/offcode-original.glb",
  ];
  const catalog = await batch(
    "Catálogo y recursos, sin CDN local",
    600,
    50,
    (i) => fetch(base + routes[i % routes.length]),
  );
  const requests = Array.from({ length: 120 }, (_, i) => ({
    requestKey: randomUUID(),
    consent: true,
    items: [{ size: "M", qty: 1 }],
    customer: {
      name: "Persona Ficticia",
      phone: "520000000000",
      email: `qa-load-${i}@example.test`,
      street: "Calle de prueba 123",
      neighborhood: "Centro",
      city: "León",
      state: "Guanajuato",
      postalCode: "37000",
    },
  }));
  const post = (data) =>
    fetch(base + "/api/orders", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  const orders = await batch(
    "Solicitudes guardadas en SQLite temporal",
    120,
    20,
    (i) => post(requests[i]),
  );
  const retries = await batch(
    "Reintentos de las mismas solicitudes",
    120,
    20,
    (i) => post(requests[i]),
  );
  const login = await fetch(base + "/api/session", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  let saved = 0,
    page = 0,
    more;
  do {
    const data = await (
      await fetch(base + "/api/admin/orders?page=" + page++, {
        headers: { Cookie: cookie },
      })
    ).json();
    saved += data.orders.length;
    more = data.more;
  } while (more);
  assert.equal(saved, 120, "Los reintentos no deben duplicar los pedidos");
  const result = {
    executedAt: new Date().toISOString(),
    scope:
      "LOCAL loopback, disco temporal, sin CDN; no representa hardware de Render, latencia real, API Envia ni usuarios simultáneos en producción.",
    node: process.version,
    stages: [catalog, orders, retries],
    uniqueSavedOrders: saved,
  };
  await mkdir(new URL("../qa/", import.meta.url), { recursive: true });
  await writeFile(
    new URL("../qa/load-local.json", import.meta.url),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (app) await app.close();
  const relative = path.relative(os.tmpdir(), path.resolve(folder));
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
  );
  await rm(folder, { recursive: true, force: true });
}
