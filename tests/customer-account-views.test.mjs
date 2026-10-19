import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { migrate, SCHEMA_VERSION } from "../server/db.mjs";

const origin = "http://localhost:8000", password = "synthetic-customer-password-123", ownerPassword = "synthetic-owner-password-123";
const env = { EMAIL_ENABLED: "true", EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test", RESEND_API_KEY: "synthetic-resend-private-secret" };
const accepted = () => new Response(JSON.stringify({ id: "12345678-1234-4234-8234-123456789abc" }), { status: 200 });
const customer = (email) => ({ email, name: "Persona Ficticia", phone: "520000000000", street: "Calle ficticia 123", neighborhood: "Centro", city: "Ciudad", state: "Estado", postalCode: "00000" });
const address = (extra = {}) => ({ label: "Casa", name: "Persona Ficticia", phone: "520000000000", street: "Calle ficticia 123", number: "Int. 4", neighborhood: "Centro", city: "Ciudad de prueba", state: "Estado de prueba", postalCode: "00000", notes: "", ...extra });

async function start(options = {}) {
  const messages = [], logs = [];
  const app = await createApp({ origin: options.origin ?? origin, password: ownerPassword, databasePath: options.databasePath ?? ":memory:",
    enabled: !options.production, production: !!options.production, bank: { name: "FICTICIO", beneficiary: "FICTICIO", clabe: "000000000000000000" },
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
        const r = await fetch(base + route, { method, redirect: "manual", headers: { Origin: options.origin ?? origin, "Content-Type": "application/json", Cookie: [...cookies].map(([k, v]) => k + "=" + v).join("; "), ...extra },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
        for (const c of r.headers.getSetCookie()) { const [k, v] = c.split(";")[0].split("="); cookies.set(k, v); }
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
  const order = (email, extra = {}) => ({ requestKey: randomUUID(), consent: true, customer: customer(email), items: [{ size: "M", qty: 1 }], ...extra });
  return { ...app, base, client, messages, logs, token, register, order };
}

async function stock(app) {
  const owner = app.client();
  assert.equal((await owner.call("/api/session", { password: ownerPassword })).status, 200);
  assert.equal((await owner.call("/api/admin/inventory/VAR-HOODIE-M/movements", { type: "entry", qty: 20, reason: "Conteo sintético" })).status, 201);
  return owner;
}

test("Pedidos: el titular ve solo los suyos, con estados persistidos y sin datos inventados", async () => {
  const app = await start();
  try {
    const owner = await stock(app);
    const a = app.client(), b = app.client(), guest = app.client();
    await app.register(a, "a@example.test");
    await app.register(b, "b@example.test");

    const mine = await a.call("/api/orders", app.order("a@example.test", { items: [{ size: "M", qty: 2 }] }));
    assert.equal(mine.status, 201);
    const theirs = await b.call("/api/orders", app.order("b@example.test"));
    assert.equal(theirs.status, 201);

    assert.equal((await guest.call("/api/customer/orders")).status, 401);
    const list = (await a.call("/api/customer/orders?customerId=" + theirs.data.id)).data.orders;
    assert.deepEqual(list.map((o) => o.id), [mine.data.id], "un customerId en la URL no cambia el titular");
    assert.equal((await b.call("/api/customer/orders")).data.orders.length, 1);

    assert.equal((await a.call("/api/customer/orders/" + theirs.data.id)).status, 404);
    assert.equal((await guest.call("/api/customer/orders/" + mine.data.id)).status, 401);
    assert.equal((await a.call("/api/customer/orders/OF-000000000000")).status, 404);

    const detail = (await a.call("/api/customer/orders/" + mine.data.id)).data.order;
    assert.equal(detail.items[0].size, "M");
    assert.equal(detail.items[0].qty, 2);
    assert.equal(detail.items[0].unitCents, 165000);
    assert.equal(detail.subtotalCents, 330000);
    // Shipping was not quoted, so no total is invented and no tracking exists.
    assert.equal(detail.totalCents, null);
    assert.equal(detail.shippingCents, null);
    assert.equal(detail.shipping.tracking, "");
    assert.equal(detail.shipping.trackingUrl, "");
    assert.equal(detail.payment.status, "pending");
    assert.equal(detail.shipping.status, "pending");
    assert.equal(detail.address.city, "Ciudad");
    assert.equal(detail.history.length, 1);

    // Real owner transitions only: the account reflects them, nothing more.
    let version = (await owner.call("/api/admin/orders")).data.orders.find((o) => o.id === mine.data.id).version;
    for (const change of [
      { status: "awaiting_transfer", stockConfirmed: true, shippingCents: 0 },
      { status: "paid", paymentVerified: true },
      { status: "shipped", handedToCarrier: true, carrier: "fedex", tracking: "123456789012" },
    ]) {
      const moved = await owner.call("/api/admin/orders/" + mine.data.id, { version, ...change }, "PATCH");
      assert.equal(moved.status, 200, JSON.stringify(moved.data));
      version = moved.data.order.version;
    }
    const shipped = (await a.call("/api/customer/orders/" + mine.data.id)).data.order;
    assert.equal(shipped.payment.status, "paid");
    assert.equal(shipped.shipping.status, "shipped");
    assert.equal(shipped.shipping.tracking, "123456789012");
    assert.equal(shipped.shipping.trackingUrl, "https://www.fedex.com/fedextrack/?trknbr=123456789012");
    assert.equal(shipped.history.length, 4);
    assert.ok(shipped.history.every((entry) => entry.label));

    const exposed = JSON.stringify([list, detail, shipped]);
    for (const secret of ["clabe", "transferAccount", env.RESEND_API_KEY, password]) assert.ok(!exposed.includes(secret), secret);
  } finally { await app.close(); }
});

test("Pedidos: una cuenta sin verificar no puede consultar historial ni detalle", async () => {
  const app = await start();
  try {
    const c = app.client();
    assert.equal((await c.call("/api/customer/register", { email: "pending@example.test", password })).status, 200);
    assert.equal((await c.call("/api/customer/login", { email: "pending@example.test", password })).status, 200);
    assert.equal((await c.call("/api/customer/orders")).status, 403);
    assert.equal((await c.call("/api/customer/orders/OF-000000000000")).status, 403);
    assert.equal((await c.call("/api/customer/addresses")).status, 403);
    assert.equal((await c.call("/api/customer/preferences")).status, 403);
  } finally { await app.close(); }
});

test("Direcciones: alta, edición, predeterminada única, borrado y aislamiento entre clientes", async () => {
  const app = await start();
  try {
    await stock(app);
    const a = app.client(), b = app.client();
    await app.register(a, "a@example.test");
    await app.register(b, "b@example.test");
    assert.deepEqual((await a.call("/api/customer/addresses")).data.addresses, []);

    const first = await a.call("/api/customer/addresses", address());
    assert.equal(first.status, 201);
    assert.equal(first.data.address.isDefault, true, "la primera dirección es predeterminada");
    const second = await a.call("/api/customer/addresses", address({ label: "Oficina", street: "Avenida ficticia 456", isDefault: true }));
    assert.equal(second.status, 201);
    assert.equal(second.data.address.isDefault, true);
    let list = (await a.call("/api/customer/addresses")).data.addresses;
    assert.equal(list.filter((x) => x.isDefault).length, 1, "solo una predeterminada");
    assert.equal(list[0].id, second.data.address.id, "la predeterminada se muestra primero");
    assert.ok(!("email" in list[0]), "la dirección no guarda el correo de la cuenta");

    const edited = await a.call("/api/customer/addresses/" + second.data.address.id, { city: "Otra ciudad", isDefault: true }, "PATCH");
    assert.equal(edited.status, 200); assert.equal(edited.data.address.city, "Otra ciudad");
    assert.equal((await a.call("/api/customer/addresses/" + second.data.address.id, { postalCode: "12" }, "PATCH")).status, 400);
    assert.equal((await a.call("/api/customer/addresses/" + second.data.address.id, { street: "" }, "PATCH")).status, 400);
    assert.equal((await a.call("/api/customer/addresses", address({ postalCode: "0000" }))).status, 400);
    assert.equal((await a.call("/api/customer/addresses", address({ phone: "abc" }))).status, 400);
    assert.equal((await a.call("/api/customer/addresses", { ...address(), email: "evil@example.test" })).status, 201);

    assert.equal((await b.call("/api/customer/addresses")).data.addresses.length, 0);
    assert.equal((await b.call("/api/customer/addresses/" + second.data.address.id, { city: "Robada" }, "PATCH")).status, 404);
    assert.equal((await b.call("/api/customer/addresses/" + second.data.address.id, {}, "DELETE")).status, 404);
    assert.equal((await b.call("/api/customer/addresses/" + second.data.address.id + "/default", {})).status, 404);

    // Editing or deleting a saved address never rewrites a past order.
    const created = await a.call("/api/orders", app.order("a@example.test"));
    assert.equal(created.status, 201);
    const before = (await a.call("/api/customer/orders/" + created.data.id)).data.order.address;
    assert.equal((await a.call("/api/customer/addresses/" + second.data.address.id, { city: "Ciudad nueva" }, "PATCH")).status, 200);
    assert.equal((await a.call("/api/customer/addresses/" + second.data.address.id, {}, "DELETE")).status, 200);
    const after = (await a.call("/api/customer/orders/" + created.data.id)).data.order.address;
    assert.deepEqual(after, before);

    list = (await a.call("/api/customer/addresses")).data.addresses;
    assert.equal(list.length, 2);
    assert.equal(list.filter((x) => x.isDefault).length, 1, "borrar la predeterminada promueve otra");
    assert.equal((await a.call("/api/customer/profile")).data.address.isDefault, true);
  } finally { await app.close(); }
});

test("Cambio de correo: exige contraseña, verifica la nueva dirección y revoca sesiones", async () => {
  const app = await start();
  try {
    const a = app.client(), other = app.client();
    await app.register(a, "old@example.test");
    await app.register(other, "taken@example.test");

    assert.equal((await a.call("/api/customer/email", { password: "wrong-password-000", email: "new@example.test" })).status, 401);
    assert.equal((await a.call("/api/customer/email", { password, email: "old@example.test" })).status, 400);

    const requested = await a.call("/api/customer/email", { password, email: "new@example.test" });
    assert.equal(requested.status, 200);
    assert.ok(!requested.data.message.includes("new@example.test"));
    const token = app.token("new@example.test", "email"); assert.ok(token, "el enlace va solo a la dirección nueva");
    const message = app.messages.at(-1);
    assert.match(message.html, />CONFIRMAR MI NUEVO CORREO<\/a>/);
    const links = [...message.html.matchAll(/href="([^"]*#email=[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(links, [origin + "/cuenta.html#email=" + token, origin + "/cuenta.html#email=" + token]);
    assert.ok(message.text.includes(links[0]));
    assert.match(message.html, /60 minutos/);
    // Nothing changes until the new address is confirmed.
    assert.equal((await a.call("/api/customer/profile")).data.user.email, "old@example.test");
    assert.equal((await a.call("/api/customer/login", { email: "new@example.test", password })).status, 401);

    const confirmed = await a.call("/api/customer/email/confirm", { token });
    assert.equal(confirmed.status, 200); assert.equal(confirmed.data.email, "new@example.test");
    assert.equal((await a.call("/api/customer/profile")).status, 401, "el cambio cierra todas las sesiones");
    assert.equal((await a.call("/api/customer/email/confirm", { token })).status, 400, "token de un solo uso");
    assert.equal((await a.call("/api/customer/login", { email: "old@example.test", password })).status, 401);
    const relogin = await a.call("/api/customer/login", { email: "new@example.test", password });
    assert.equal(relogin.status, 200); assert.equal(relogin.data.user.verified, true);

    // An address already used by another account produces the same public answer
    // and never sends a message to that address.
    const messagesBefore = app.messages.length;
    const taken = await a.call("/api/customer/email", { password, email: "taken@example.test" });
    assert.equal(taken.status, 200);
    assert.equal(taken.data.message, requested.data.message);
    assert.equal(app.messages.length, messagesBefore);
    assert.equal(app.token("taken@example.test", "email"), undefined);
  } finally { await app.close(); }
});

test("Cambio de correo: URL canónica y rechazo por propósito, reemplazo y límite exacto de 60 minutos", async () => {
  let clock = Date.now();
  const productionOrigin = "https://offcode.mx";
  const app = await start({ origin: productionOrigin, production: true, customers: { now: () => clock } });
  try {
    const c = app.client(), email = "email-guards@example.test", nextEmail = "email-next@example.test";
    await app.register(c, email);
    const verifyToken = app.token(email);
    await c.call("/api/customer/recover", { email }); await app.accounts.close();
    const resetToken = app.token(email, "reset");
    assert.equal((await c.call("/api/customer/email", { password, email: nextEmail })).status, 200);
    const original = app.token(nextEmail, "email");
    const message = app.messages.at(-1);
    const links = [...message.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    const expected = productionOrigin + "/cuenta.html#email=" + original;
    assert.ok(links.length === 2 && links.every((link) => link === expected), "CTA y alternativa usan el mismo enlace canónico emitido");
    assert.ok(message.html.includes(">" + expected + "</a>") && message.text.includes(expected), "la URL completa es visible y está en el texto plano");
    const saved = await app.db.get("SELECT token_hash,expires FROM customer_email_changes");
    assert.ok(saved.token_hash === createHash("sha256").update(original).digest("hex"), "el token corresponde al hash persistido");
    assert.equal(saved.expires - clock, 60 * 60e3);
    for (const token of [undefined, "invalid", verifyToken, resetToken])
      assert.equal((await c.call("/api/customer/email/confirm", { token })).status, 400);
    assert.equal((await c.call("/api/customer/verify", { token: original })).status, 400);
    assert.equal((await c.call("/api/customer/reset", { token: original, password })).status, 400);
    assert.equal((await c.call("/api/customer/email", { password, email: nextEmail })).status, 200);
    const fresh = app.token(nextEmail, "email");
    assert.ok(fresh !== original);
    assert.equal((await c.call("/api/customer/email/confirm", { token: original })).status, 400);
    clock += 60 * 60e3;
    assert.equal((await c.call("/api/customer/email/confirm", { token: fresh })).status, 400);
    assert.equal((await c.call("/api/customer/profile")).data.user.email, email);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  } finally { await app.close(); }
});

test("Preferencias: consentimiento persistente, baja real de la lista VIP y sin publicidad por defecto", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-prefs-"));
  const databasePath = path.join(folder, "store.sqlite");
  let app = await start({ databasePath });
  try {
    const c = app.client();
    await app.register(c, "prefs@example.test");
    const initial = await c.call("/api/customer/preferences");
    assert.equal(initial.status, 200);
    assert.equal(initial.data.marketing, "unset", "sin elección no hay consentimiento");
    assert.equal((await c.call("/api/customer/preferences", { marketing: true }, "PATCH")).status, 400);

    const granted = await c.call("/api/customer/preferences", { marketing: true, consentVersion: initial.data.consentVersion }, "PATCH");
    assert.equal(granted.status, 200); assert.equal(granted.data.marketing, "granted");
    const row = await app.db.get("SELECT * FROM customer_preferences");
    assert.equal(row.marketing_consent, "granted");
    assert.ok(row.consent_text.length > 20 && row.consent_version);

    // The only commercial list that exists today must honour the withdrawal.
    await app.db.run("INSERT INTO vip_members(id,email,created_at,consent_at,privacy_url,consent_version,consent_text) VALUES(?,?,?,?,?,?,?)",
      [randomUUID(), "prefs@example.test", "2026-01-01", "2026-01-01", "https://example.test/privacy", "vip-v1", "texto"]);
    const withdrawn = await c.call("/api/customer/preferences", { marketing: false }, "PATCH");
    assert.equal(withdrawn.data.marketing, "withdrawn");
    assert.equal((await app.db.get("SELECT status FROM vip_members WHERE email=?", ["prefs@example.test"])).status, "withdrawn");

    // Persists across a restart with the same database file.
    const cookies = [...c.cookies]; await app.close();
    app = await start({ databasePath });
    const again = app.client(); cookies.forEach(([k, v]) => again.cookies.set(k, v));
    assert.equal((await again.call("/api/customer/preferences")).data.marketing, "withdrawn");
  } finally { await app?.close(); await rm(folder, { recursive: true, force: true }); }
});

test("Sesiones: cerrar sesión invalida la actual y revocar todas invalida el resto", async () => {
  const app = await start();
  try {
    const one = app.client(), two = app.client();
    await app.register(one, "session@example.test");
    assert.equal((await two.call("/api/customer/login", { email: "session@example.test", password })).status, 200);
    assert.equal((await two.call("/api/customer/profile")).status, 200);

    const oldCookie = one.cookies.get("offcode_customer");
    assert.equal((await one.call("/api/customer/logout", {})).status, 200);
    one.cookies.set("offcode_customer", oldCookie);
    assert.equal((await one.call("/api/customer/profile")).status, 401);
    assert.equal((await two.call("/api/customer/profile")).status, 200, "salir no cierra las otras sesiones");

    const revoked = await two.call("/api/customer/sessions/revoke-all", {});
    assert.equal(revoked.status, 200);
    assert.equal((await two.call("/api/customer/profile")).status, 401);
    assert.equal((await one.call("/api/customer/profile")).status, 401);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customer_sessions")).n, 0);
    assert.equal((await two.call("/api/customer/login", { email: "session@example.test", password })).status, 200);
  } finally { await app.close(); }
});

test("Errores de red y de API: mensajes útiles sin datos sensibles ni identificadores del navegador", async () => {
  const app = await start();
  try {
    const c = app.client();
    await app.register(c, "errors@example.test");
    const missing = await c.call("/api/customer/orders/OF-AAAAAAAAAAAA");
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error, "Pedido no encontrado.");
    assert.equal((await c.call("/api/customer/addresses/00000000-0000-4000-8000-000000000000", {}, "DELETE")).status, 404);
    assert.equal((await c.call("/api/customer/email", { password, email: "not-an-email" })).status, 400);

    const exposed = JSON.stringify([missing.data, (await c.call("/api/customer/profile")).data]);
    const row = await app.db.get("SELECT password_hash FROM customers WHERE email=?", ["errors@example.test"]);
    for (const value of [password, row.password_hash, env.RESEND_API_KEY]) assert.ok(!exposed.includes(value));
    assert.ok(!JSON.stringify(app.logs).includes("errors@example.test"), "no se registran correos de clientes");

    const script = await (await fetch(app.base + "/account.js")).text();
    assert.match(script, /No pudimos conectar con el servidor/);
    assert.doesNotMatch(script, /localStorage|sessionStorage/);
    assert.doesNotMatch(script, /customerId/);
    assert.match(script, /aria-live/);
    assert.match(script, /data-confirm-revoke/);

    // Checkout reuse is opt-in: the module only reads the session and copies
    // values on an explicit click, so an unauthenticated visit never asks.
    const reuse = await (await fetch(app.base + "/checkout-address.js")).text();
    assert.match(reuse, /\/api\/customer\/session/);
    assert.match(reuse, /addEventListener\("click"/);
    assert.doesNotMatch(reuse, /localStorage|sessionStorage/);
    assert.match(await (await fetch(app.base + "/checkout.html")).text(), /checkout-address\.js/);
  } finally { await app.close(); }
});

test("Migración v2→v3 conserva la dirección heredada y no duplica al repetir", async () => {
  const app = await start();
  try {
    await app.db.tx(async (tx) => {
      await tx.run("INSERT INTO customers(id,email,verified_at,address,created_at) VALUES(?,?,?,?,?)",
        ["legacy-1", "legacy@example.test", "2026-01-01", JSON.stringify(customer("legacy@example.test")), "2026-01-01"]);
      for (const table of ["customer_addresses", "customer_preferences", "customer_email_changes"]) await tx.exec(`DROP TABLE ${table}`);
      await tx.exec("PRAGMA user_version=2");
    });
    assert.equal(await migrate(app.db), SCHEMA_VERSION);
    const saved = await app.db.all("SELECT * FROM customer_addresses");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].customer_id, "legacy-1");
    assert.equal(saved[0].street, "Calle ficticia 123");
    assert.equal(saved[0].is_default, 1);
    assert.equal((await app.db.get("SELECT address FROM customers WHERE id='legacy-1'")).address, null);
    assert.equal(await migrate(app.db), SCHEMA_VERSION);
    assert.equal((await app.db.all("SELECT * FROM customer_addresses")).length, 1);
    assert.deepEqual(await app.db.all("PRAGMA foreign_key_check"), []);
  } finally { await app.close(); }
});
