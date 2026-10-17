import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server/server.mjs";
import { clientIp } from "../server/http-policy.mjs";

test("Render usa su URL asignada al inicio y respeta después el dominio explícito", async () => {
  const keys = ["PUBLIC_ORIGIN", "RENDER", "RENDER_EXTERNAL_URL"];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  let app;
  const password = "synthetic-render-origin-password";
  async function login(origin) {
    const response = await fetch(
      "http://127.0.0.1:" + app.server.address().port + "/api/session",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      },
    );
    return response.status;
  }
  async function start() {
    app = await createApp({
      production: true,
      password,
      enabled: false,
      waitlistEnabled: false,
      databasePath: ":memory:",
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  }
  try {
    delete process.env.PUBLIC_ORIGIN;
    process.env.RENDER = "true";
    process.env.RENDER_EXTERNAL_URL = "https://synthetic-store.onrender.com";
    await start();
    assert.equal(await login(process.env.RENDER_EXTERNAL_URL), 200);
    await app.close();
    app = null;
    process.env.PUBLIC_ORIGIN = "https://shop.example.test";
    await start();
    assert.equal(await login(process.env.RENDER_EXTERNAL_URL), 403);
    assert.equal(await login(process.env.PUBLIC_ORIGIN), 200);
  } finally {
    if (app) await app.close();
    for (const key of keys)
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
  }
});

test("La raíz abre la tienda y las páginas de registro VIP ya no se publican", async () => {
  // An old HOME_PAGE=teaser setting cannot replace the requested normal store.
  const app = await createApp({
    databasePath: ":memory:",
    enabled: false,
    waitlistEnabled: false,
    home: "teaser",
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  try {
    const response = await fetch(base + "/"),
      html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /id="collection"/);
    assert.match(html, /id="logo-model"/);
    assert.doesNotMatch(
      html,
      /Quiero estar dentro|Lista VIP|teaser\.js|teaser\.css/,
    );
    for (const route of [
      "/vip-admin.html",
      "/vip-admin.js",
      "/teaser.js",
      "/teaser.css",
      "/archive/vip/index.html",
    ])
      assert.equal((await fetch(base + route)).status, 404);
    for (const route of ["/tienda.html", "/teaser.html"]) {
      const alias = await (await fetch(base + route)).text();
      assert.match(alias, /store-redirect\.js/);
      assert.doesNotMatch(alias, /Lista VIP/);
    }
    const admin = await (await fetch(base + "/admin.html")).text();
    assert.doesNotMatch(admin, /vip-admin|Lista VIP/);
  } finally {
    await app.close();
  }
});

test("Caché solo de catálogo y recursos públicos, revalidación ETag y API/checkout/panel privados", async () => {
  const app = await createApp({
    databasePath: ":memory:",
    enabled: false,
    waitlistEnabled: false,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  try {
    for (const route of [
      "/",
      "/app.js",
      "/styles.css",
      "/assets/offcode-original.glb",
      "/assets/campaign.mp4",
    ]) {
      const r = await fetch(base + route, { method: "HEAD" });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("cache-control"), /public/);
      assert.equal(r.headers.get("set-cookie"), null);
      const conditional = await fetch(base + route, {
        headers: { "If-None-Match": r.headers.get("etag") },
      });
      assert.equal(conditional.status, 304);
    }
    for (const route of [
      "/api/config",
      "/api/admin/orders",
      "/admin.html",
      "/checkout.html",
      "/admin.js",
      "/checkout.js",
      "/missing.jpg",
    ]) {
      const r = await fetch(base + route);
      assert.equal(r.headers.get("cache-control"), "no-store");
      await r.arrayBuffer();
    }
    const range = await fetch(base + "/assets/campaign.mp4", {
      headers: { Range: "bytes=0-99" },
    });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 100);
  } finally {
    await app.close();
  }
});

test("Límites detrás de Render: IP real validada; encabezados ignorados en acceso directo", async () => {
  const req = {
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(clientIp(req, false), "127.0.0.1");
  assert.equal(clientIp(req, true), "203.0.113.7");
  assert.equal(
    clientIp({ ...req, headers: { "x-forwarded-for": "no-es-ip" } }, true),
    "127.0.0.1",
  );
  const app = await createApp({
    databasePath: ":memory:",
    enabled: false,
    waitlistEnabled: false,
    trustRenderProxy: true,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  try {
    for (let i = 1; i <= 9; i++) {
      const r = await fetch(base + "/api/session", {
        method: "POST",
        headers: {
          Origin: "http://localhost:8000",
          "Content-Type": "application/json",
          "X-Forwarded-For": `203.0.113.${i}`,
        },
        body: JSON.stringify({ password: "wrong" }),
      });
      assert.equal(r.status, 401);
      await r.arrayBuffer();
    }
  } finally {
    await app.close();
  }
});
