import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { normalizeCustomerEmail } from "../server/customer-accounts.mjs";
import { migrate, SCHEMA_VERSION } from "../server/db.mjs";

const origin = "http://localhost:8000", password = "synthetic-customer-password-123", ownerPassword = "synthetic-owner-password-123";
const env = { EMAIL_ENABLED: "true", EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test", RESEND_API_KEY: "synthetic-resend-private-secret" };
const accepted = () => new Response(JSON.stringify({ id: "12345678-1234-4234-8234-123456789abc" }), { status: 200 });
const customer = (email) => ({ email, name: "Persona Ficticia", phone: "520000000000", street: "Calle ficticia 123", neighborhood: "Centro", city: "Ciudad", state: "Estado", postalCode: "00000" });
async function start(options = {}) {
  const messages = [], logs = [];
  const app = await createApp({ origin, password: ownerPassword, databasePath: options.databasePath ?? ":memory:",
    enabled: !options.production, production: !!options.production, origin: options.origin ?? origin, bank: { name: "FICTICIO", beneficiary: "FICTICIO", clabe: "000000000000000000" },
    whatsapp: "520000000000", privacyUrl: "https://example.test/privacy", termsUrl: "https://example.test/terms",
    email: { env: {}, autoStart: false, logger: () => {} },
    customers: { env, logger: (s) => logs.push(s), fetcher: async (_, opts) => { messages.push(JSON.parse(opts.body)); return accepted(); }, ...options.customers },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const client = () => {
    const cookies = new Map();
    return {
      cookies,
      async call(route, data, method = data === undefined ? "GET" : "POST", extra = {}) {
        const r = await fetch(base + route, { method, redirect: "manual", headers: { Origin: options.origin ?? origin, "Content-Type": "application/json", Cookie: [...cookies].map(([k,v]) => k + "=" + v).join("; "), ...extra },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        for (const c of r.headers.getSetCookie()) { const [k,v] = c.split(";")[0].split("="); cookies.set(k,v); }
        const text = await r.text();
        return { status: r.status, data: text ? JSON.parse(text) : null, headers: r.headers };
      },
    };
  };
  const token = (email, purpose = "verify") => {
    const text = messages.filter((m) => m.to[0] === email).at(-1)?.text ?? "";
    return text.match(new RegExp(`#${purpose}=([A-Za-z0-9_-]{43})`))?.[1];
  };
  async function register(client, email) {
    assert.equal((await client.call("/api/customer/register", { email, password })).status, 200);
    const value = token(email); assert.ok(value);
    assert.equal((await client.call("/api/customer/verify", { token: value })).status, 200);
    assert.equal((await client.call("/api/customer/login", { email, password })).status, 200);
  }
  return { ...app, client, messages, logs, token, register };
}
test("Clientes: registro, normalización, verificación, contraseña con hash y sesiones separadas", async () => {
  const app = await start();
  try {
    assert.equal(normalizeCustomerEmail("  BUYER@EXAMPLE.TEST  "), "buyer@example.test");
    for (const email of ["a..b@example.test", "a@-invalid.test", "a@example..test", "a@example.test\r\nBcc:x@example.test"])
      assert.throws(() => normalizeCustomerEmail(email));
    const c = app.client();
    assert.equal((await c.call("/api/customer/profile")).status, 401);
    assert.equal((await c.call("/api/customer/register", { email: "buyer@example.test", password: "short" })).status, 400);
    assert.equal((await c.call("/api/customer/register", { email: "BUYER@example.test", password })).status, 200);
    assert.equal((await c.call("/api/customer/login", { email: "buyer@example.test", password })).status, 200);
    assert.equal((await c.call("/api/customer/orders")).status, 403);
    assert.equal((await c.call("/api/admin/orders")).status, 401);
    const token = app.token("buyer@example.test");
    const row = await app.db.get("SELECT * FROM customers WHERE email=?", ["buyer@example.test"]);
    assert.match(row.password_hash, /^scrypt\$/); assert.ok(!row.password_hash.includes(password));
    const savedTokens = JSON.stringify(await app.db.all("SELECT * FROM customer_tokens"));
    assert.ok(!savedTokens.includes(token));
    assert.equal((await c.call("/api/customer/verify", { token })).status, 200);
    assert.equal((await c.call("/api/customer/verify", { token })).status, 400);
    const before = c.cookies.get("offcode_customer");
    const login = await c.call("/api/customer/login", { email: "buyer@example.test", password });
    assert.notEqual(c.cookies.get("offcode_customer"), before);
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Lax/);
    assert.equal((await c.call("/api/customer/profile")).headers.get("cache-control"), "no-store");
    assert.equal((await c.call("/api/session", { password: ownerPassword })).status, 200);
    assert.equal((await c.call("/api/customer/logout", {})).status, 200);
    assert.equal((await c.call("/api/admin/orders")).status, 200, "cerrar cliente no cierra al propietario");
    assert.equal((await c.call("/api/customer/profile")).status, 401);
    const exposed = JSON.stringify([login.data, app.logs, (await c.call("/api/config")).data]);
    for (const value of [password, env.RESEND_API_KEY, row.password_hash, token]) assert.ok(!exposed.includes(value));
  } finally { await app.close(); }
});

test("Aislamiento de dos clientes: perfil, dirección y pedidos solo del titular; nada de vínculos por correo histórico", async () => {
  const app = await start();
  try {
    const a = app.client(), b = app.client(), guest = app.client();
    const owner = app.client();
    assert.equal((await owner.call("/api/session", { password: ownerPassword })).status, 200);
    assert.equal((await owner.call("/api/admin/inventory/VAR-HOODIE-M/movements", { type: "entry", qty: 20, reason: "Conteo sintético" })).status, 201);
    const input = (email) => ({ requestKey: randomUUID(), consent: true, customer: customer(email), items: [{ size: "M", qty: 1 }] });
    const old = await guest.call("/api/orders", input("a@example.test"));
    await app.register(a, "a@example.test"); await app.register(b, "b@example.test");
    assert.deepEqual((await a.call("/api/customer/orders")).data.orders, []);
    const created = await a.call("/api/orders", input("a@example.test")); assert.equal(created.status, 201);
    const other = await b.call("/api/orders", input("b@example.test")); assert.equal(other.status, 201);
    const aOrders = (await a.call("/api/customer/orders?customerId=ignored")).data.orders;
    assert.deepEqual(aOrders.map((o) => o.id), [created.data.id]);
    assert.ok(!JSON.stringify(aOrders).includes(old.data.id));
    assert.equal((await b.call("/api/customer/orders/" + created.data.id)).status, 404);
    const profile = await a.call("/api/customer/profile", { customerId: "not-used", name: "Titular Sintetico" }, "PATCH");
    assert.equal(profile.status, 200); assert.equal(profile.data.user.name, "Titular Sintetico");
    // A saved address always takes the account email from the session, never
    // from the body, and belongs only to its owner.
    const saved = await a.call("/api/customer/addresses", { ...customer("evil@example.test"), label: "Casa" });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.address.isDefault, true);
    assert.equal(saved.data.address.label, "Casa");
    assert.equal((await b.call("/api/customer/addresses")).data.addresses.length, 0);
    assert.equal((await b.call("/api/customer/addresses/" + saved.data.address.id, {}, "DELETE")).status, 404);
    assert.equal((await a.call("/api/customer/profile")).data.address.id, saved.data.address.id);
    assert.equal((await b.call("/api/customer/profile")).data.address, null);
    assert.equal((await guest.call("/api/customer/profile")).status, 401);
    assert.equal((await a.call("/api/customer/logout", {}, "POST", { Origin: "https://evil.test" })).status, 403);
    assert.ok(!JSON.stringify(aOrders).includes("clabe"));
  } finally { await app.close(); }
});

test("Recuperación: respuesta indistinguible, token de un uso y caducidad, revocación de sesiones", async () => {
  let clock = Date.now();
  const app = await start({ customers: { now: () => clock } });
  try {
    const c = app.client(); await app.register(c, "recover@example.test");
    const otherDevice = app.client();
    assert.equal((await otherDevice.call("/api/customer/login", { email: "recover@example.test", password })).status, 200);
    const oldSession = otherDevice.cookies.get("offcode_customer");
    const existing = await c.call("/api/customer/recover", { email: "recover@example.test" });
    const absent = await c.call("/api/customer/recover", { email: "missing@example.test" });
    assert.deepEqual([existing.status,existing.data], [absent.status,absent.data]);
    await app.accounts.close();
    const token = app.token("recover@example.test", "reset"); assert.ok(token);
    const next = "another-synthetic-password-123";
    assert.equal((await c.call("/api/customer/reset", { token, password: next })).status, 200);
    assert.equal((await c.call("/api/customer/profile")).status, 401);
    assert.equal((await otherDevice.call("/api/customer/profile")).status, 401);
    assert.equal(otherDevice.cookies.get("offcode_customer"), oldSession, "se rechaza también la cookie anterior conservada");
    assert.equal((await c.call("/api/customer/reset", { token, password: next })).status, 400);
    assert.equal((await c.call("/api/customer/login", { email: "recover@example.test", password })).status, 401);
    assert.equal((await c.call("/api/customer/login", { email: "recover@example.test", password: next })).status, 200);
    await c.call("/api/customer/recover", { email: "recover@example.test" }); await app.accounts.close();
    const expired = app.token("recover@example.test", "reset"); clock += 31 * 60e3;
    assert.equal((await c.call("/api/customer/reset", { token: expired, password: next })).status, 400);
    assert.equal((await c.call("/api/customer/login", { email: "recover@example.test", password: next })).status, 200);
  } finally { await app.close(); }
});

test("Correos de cuenta: CTA y URL copiable conservan el enlace real del backend en el origen de producción", async () => {
  const productionOrigin = "https://offcode.mx";
  const app = await start({ production: true, origin: productionOrigin });
  try {
    const c = app.client(), email = "cta@example.test";
    assert.equal((await c.call("/api/customer/register", { email, password })).status, 200);
    const verifyMessage = app.messages.at(-1);
    assert.equal((await c.call("/api/customer/recover", { email })).status, 200);
    await app.accounts.close();
    const resetMessage = app.messages.at(-1);
    for (const [message, purpose, action, duration] of [
      [verifyMessage, "verify", "VERIFICAR MI CORREO", "24 horas"],
      [resetMessage, "reset", "RESTABLECER MI CONTRASEÑA", "30 minutos"],
    ]) {
      const [cta, fallback] = [...message.html.matchAll(/<a href="([^"]+)" style="([^"]+)">([^<]+)<\/a>/g)];
      assert.ok(cta && fallback);
      const url = new URL(cta[1]);
      assert.equal(url.origin, productionOrigin);
      assert.equal(url.pathname, "/cuenta.html");
      assert.equal(url.search, "");
      const token = url.hash.slice(purpose.length + 2);
      assert.match(url.hash, new RegExp(`^#${purpose}=[A-Za-z0-9_-]{43}$`));
      assert.equal(cta[3], action);
      assert.match(cta[2], /background-color:#ffffff/);
      assert.match(cta[2], /color:#080808/);
      assert.match(cta[2], /display:block/);
      assert.equal(fallback[1], url.href);
      assert.equal(fallback[3], url.href, "URL completa visible y copiable");
      assert.match(fallback[2], /text-decoration:underline/);
      assert.ok(message.text.includes(url.href) && message.text.includes(action));
      for (const copy of [message.html, message.text]) {
        assert.ok(copy.includes(duration));
        assert.match(copy, /un solo uso/);
        assert.match(copy, /Si no lo solicitaste, ignóralo/);
      }
      const saved = await app.db.get("SELECT * FROM customer_tokens WHERE purpose=?", [purpose]);
      assert.equal(saved.token_hash, createHash("sha256").update(token).digest("hex"));
      assert.ok(!JSON.stringify(app.logs).includes(token));
      assert.equal((await c.call("/api/customer/" + purpose, { token, ...(purpose === "reset" ? { password } : {}) })).status, 200);
    }
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  } finally { await app.close(); }
});

test("Verificación: rechaza token ausente, alterado, de recuperación, reemplazado y vencido sin verificar la cuenta", async () => {
  let clock = Date.now();
  const app = await start({ customers: { now: () => clock } });
  try {
    const c = app.client(), email = "verify-guards@example.test";
    assert.equal((await c.call("/api/customer/register", { email, password })).status, 200);
    const original = app.token(email);
    for (const token of [undefined, "bad", (original[0] === "A" ? "B" : "A") + original.slice(1)])
      assert.equal((await c.call("/api/customer/verify", { token })).status, 400);
    assert.equal((await c.call("/api/customer/recover", { email })).status, 200);
    await app.accounts.close();
    assert.equal((await c.call("/api/customer/verify", { token: app.token(email, "reset") })).status, 400);
    assert.equal((await c.call("/api/customer/reset", { token: original, password })).status, 400);
    assert.equal((await c.call("/api/customer/verification", { email })).status, 200);
    await app.accounts.close();
    const fresh = app.token(email);
    assert.notEqual(fresh, original);
    assert.equal((await c.call("/api/customer/verify", { token: original })).status, 400);
    clock += 86400e3; // At the exact expiry boundary, not only after it.
    assert.equal((await c.call("/api/customer/verify", { token: fresh })).status, 400);
    assert.equal((await app.db.get("SELECT verified_at FROM customers WHERE email=?", [email])).verified_at, null);
    assert.equal((await c.call("/api/customer/verification", { email })).status, 200);
    await app.accounts.close();
    const valid = app.token(email);
    assert.equal((await c.call("/api/customer/verify", { token: valid })).status, 200);
    assert.equal((await c.call("/api/customer/verify", { token: valid })).status, 400);
    assert.equal((await c.call("/api/customer/login", { email, password })).data.user.verified, true);
  } finally { await app.close(); }
});

test("Recuperación: reemplazar un enlace invalida el anterior; caduca exactamente a los 30 minutos", async () => {
  let clock = Date.now();
  const app = await start({ customers: { now: () => clock } });
  try {
    const c = app.client(), email = "reset-boundary@example.test";
    await app.register(c, email);
    await c.call("/api/customer/recover", { email }); await app.accounts.close();
    const first = app.token(email, "reset");
    await c.call("/api/customer/recover", { email }); await app.accounts.close();
    const current = app.token(email, "reset");
    assert.notEqual(current, first);
    const next = "unused-synthetic-password-123";
    for (const token of [undefined, "invalid", first])
      assert.equal((await c.call("/api/customer/reset", { token, password: next })).status, 400);
    clock += 30 * 60e3;
    assert.equal((await c.call("/api/customer/reset", { token: current, password: next })).status, 400);
    assert.equal((await c.call("/api/customer/login", { email, password: next })).status, 401);
    assert.equal((await c.call("/api/customer/login", { email, password })).status, 200);
  } finally { await app.close(); }
});

test("Sin correo configurado no se simulan envíos; contacto limitado, CSRF y HTML escapado", async () => {
  const off = await start({ customers: { env: {} } });
  try {
    const c = off.client();
    const config = (await c.call("/api/customer/session")).data;
    assert.equal(config.emailEnabled, false);
    assert.equal((await c.call("/api/customer/register", { email: "a@example.test", password })).status, 503);
    assert.equal((await c.call("/api/customer/recover", { email: "a@example.test" })).status, 503);
    assert.equal((await c.call("/api/customer/google/start", {})).status, 404);
    assert.equal((await c.call("/api/contact", { email: "a@example.test", message: "Una consulta ficticia", consent: true })).status, 503);
    assert.equal(off.messages.length, 0);
    const base = "http://127.0.0.1:" + off.server.address().port;
    for (const page of ["cuenta.html", "contacto.html"]) {
      const response = await fetch(base + "/" + page);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    for (const resource of ["account.js", "account.css", "contact.js", "public-header.js"]) {
      const response = await fetch(base + "/" + resource);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control"), /^public, max-age=0/);
      assert.ok(!(await response.text()).includes(env.RESEND_API_KEY));
    }
  } finally { await off.close(); }
  const app = await start();
  try {
    const c = app.client(), data = { email: "contact@example.test", message: '<script>alert("x")</script> Consulta ficticia', consent: true };
    assert.equal((await c.call("/api/contact", data, "POST", { Origin: "https://evil.test" })).status, 403);
    assert.equal((await c.call("/api/contact", data)).status, 200);
    assert.ok(!app.messages[0].html.includes('<script>'));
    assert.equal(app.messages[0].reply_to, data.email);
    await c.call("/api/contact", data); await c.call("/api/contact", data);
    assert.equal((await c.call("/api/contact", data)).status, 429);
  } finally { await app.close(); }
});

test("Persisten cuentas, identidad, sesión y migraciones en el mismo SQLite al reiniciar", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-customer-")), databasePath = path.join(folder, "store.sqlite");
  let app;
  try {
    app = await start({ databasePath }); const a = app.client(); await app.register(a, "persist@example.test");
    await a.call("/api/customer/profile", { name: "Nombre Persistente", address: null }, "PATCH");
    const saved = await a.call("/api/customer/addresses", { ...customer("persist@example.test"), label: "Casa persistente" });
    assert.equal(saved.status, 201);
    assert.equal((await a.call("/api/customer/preferences", { marketing: true, consentVersion: "commercial-v1" }, "PATCH")).status, 200);
    const cookies = [...a.cookies]; await app.close();
    app = await start({ databasePath }); const b = app.client(); cookies.forEach(([k,v]) => b.cookies.set(k,v));
    assert.equal((await b.call("/api/customer/profile")).data.user.name, "Nombre Persistente");
    assert.equal((await b.call("/api/customer/profile")).data.address.id, saved.data.address.id);
    assert.deepEqual((await b.call("/api/customer/addresses")).data.addresses, [saved.data.address]);
    assert.equal((await b.call("/api/customer/preferences")).data.marketing, "granted");
    assert.equal(await migrate(app.db), SCHEMA_VERSION); assert.equal(await migrate(app.db), SCHEMA_VERSION);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customers")).n, 1);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM variants")).n, 4);
    assert.equal((await app.db.get("PRAGMA integrity_check")).integrity_check, "ok");
  } finally { await app?.close(); await rm(folder, { recursive: true, force: true }); }
});

test("Acceso exclusivamente por correo: endpoints retirados y cuentas previas sin contraseña recuperables", async () => {
  const app = await start();
  try {
    const c = app.client();
    for (const [route, data] of [["/api/customer/google/start", {}], ["/api/customer/google/callback?code=ficticio", undefined]]) {
      const result = await c.call(route, data);
      assert.equal(result.status, 404);
      assert.equal(result.headers.get("location"), null);
    }
    assert.equal("googleEnabled" in (await c.call("/api/customer/session")).data, false);
    await app.db.run("INSERT INTO customers(id,email,verified_at,created_at) VALUES(?,?,?,?)", ["legacy", "legacy@example.test", "2026-01-01", "2026-01-01"]);
    assert.equal((await c.call("/api/customer/login", { email: "legacy@example.test", password })).status, 401);
    await c.call("/api/customer/recover", { email: "legacy@example.test" }); await app.accounts.close();
    const token = app.token("legacy@example.test", "reset"); assert.ok(token);
    assert.equal((await c.call("/api/customer/reset", { token, password })).status, 200);
    assert.equal((await c.call("/api/customer/login", { email: "legacy@example.test", password })).data.user.id, "legacy");
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customers")).n, 1);
    const base = "http://127.0.0.1:" + app.server.address().port;
    const script = await (await fetch(base + "/account.js")).text();
    assert.doesNotMatch(script, /data-google|googleEnabled|google\/start|Continuar con Google|account-or/);
  } finally { await app.close(); }
});

test("Fallo del correo de cuentas no confirma entregas ni filtra errores; recuperación conserva el mismo mensaje", async () => {
  let failing = false;
  const messages = [];
  const app = await start({ customers: { fetcher: async (_, opts) => {
    messages.push(JSON.parse(opts.body));
    return failing ? new Response(env.RESEND_API_KEY + password + messages.at(-1).text, { status: 503 }) : accepted();
  } } });
  try {
    const c = app.client();
    assert.equal((await c.call("/api/customer/register", { email: "failure@example.test", password })).status, 200);
    failing = true;
    const real = await c.call("/api/customer/recover", { email: "failure@example.test" });
    const absent = await c.call("/api/customer/recover", { email: "absent@example.test" });
    assert.deepEqual(real.data, absent.data); assert.equal(real.status, absent.status);
    await app.accounts.close();
    assert.ok(app.logs.some((s) => s.includes('"state":"uncertain"')));
    assert.ok(!JSON.stringify([real.data, app.logs]).includes(env.RESEND_API_KEY));
    assert.ok(!JSON.stringify(app.logs).includes(password));
    for (const message of messages) {
      const token = message.text.match(/#(?:verify|reset)=([A-Za-z0-9_-]{43})/)[1];
      assert.ok(!JSON.stringify(app.logs).includes(token), "los fallos del proveedor tampoco registran tokens");
    }
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customers")).n, 1);
    assert.equal((await app.db.get("SELECT verified_at FROM customers")).verified_at, null);
    for (let i = 0; i < 8; i++) assert.equal((await c.call("/api/customer/login", { email: "absent@example.test", password })).status, 401);
    assert.equal((await c.call("/api/customer/login", { email: "absent@example.test", password })).status, 429);
  } finally { await app.close(); }
});

test("Cookies de cliente en producción: prefijo Host, HttpOnly, Secure y sesión revocada al salir", async () => {
  const secureOrigin = "https://example.test";
  const app = await start({ production: true, origin: secureOrigin });
  try {
    const c = app.client(), headers = { Origin: secureOrigin };
    await c.call("/api/customer/register", { email: "secure@example.test", password }, "POST", headers);
    const result = await c.call("/api/customer/login", { email: "secure@example.test", password }, "POST", headers);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("set-cookie"), /^__Host-offcode_customer=.*HttpOnly; SameSite=Lax; Path=\/; Max-Age=604800; Secure$/);
    await c.call("/api/customer/logout", {}, "POST", headers);
    assert.equal((await c.call("/api/customer/session")).data.user, null);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  } finally { await app.close(); }
});

test("Sesión de cliente: solo hash en SQLite y rechazo de la cookie al cumplir siete días", async () => {
  let clock = Date.now();
  const app = await start({ customers: { now: () => clock } });
  try {
    const c = app.client(); await app.register(c, "session-expiry@example.test");
    const cookie = c.cookies.get("offcode_customer");
    const row = await app.db.get("SELECT * FROM customer_sessions");
    assert.equal(row.token_hash, createHash("sha256").update(cookie).digest("hex"));
    assert.equal(row.expires, clock + 7 * 86400e3);
    clock += 7 * 86400e3 - 1;
    assert.equal((await c.call("/api/customer/profile")).status, 200);
    clock++;
    assert.equal((await c.call("/api/customer/profile")).status, 401);
    assert.equal((await c.call("/api/customer/session")).data.user, null);
  } finally { await app.close(); }
});

test("Migración desde versión 1 añade cuentas sin duplicar catálogo ni tocar pedidos o existencias", async () => {
  const app = await start();
  try {
    await app.db.tx(async (tx) => {
      for (const table of ["customer_orders", "customer_identities", "customer_sessions", "customer_tokens", "customer_oauth", "customers"])
        await tx.exec(`DROP TABLE ${table}`); // Only this in-memory synthetic test database.
      await tx.exec("PRAGMA user_version=1");
      await tx.run("UPDATE inventory SET on_hand=7,configured=1 WHERE variant_id='VAR-HOODIE-M'");
      await tx.run("INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)", ["OF-LEGACY", "legacy", "2026-01-01", '{"id":"OF-LEGACY","status":"requested"}']);
    });
    assert.equal(await migrate(app.db), SCHEMA_VERSION);
    assert.equal(await migrate(app.db), SCHEMA_VERSION);
    assert.equal((await app.db.get("SELECT on_hand FROM inventory WHERE variant_id='VAR-HOODIE-M'")).on_hand, 7);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM products")).n, 1);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 1);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customers")).n, 0);
    assert.deepEqual(await app.db.all("PRAGMA foreign_key_check"), []);
  } finally { await app.close(); }
});
