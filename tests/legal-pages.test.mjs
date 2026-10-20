import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkoutDom } from "./helpers/checkout-dom.mjs";
import { createApp } from "../server/server.mjs";

const origin = "https://offcode.mx", password = "synthetic-legal-review-password";
const privacy = origin + "/privacidad.html", terms = origin + "/condiciones-de-compra.html";
async function start() {
  const app = await createApp({ origin, production: false, enabled: false, ordersEnabledEnv: "false", databasePath: ":memory:",
    password, settingsKey: "ab".repeat(32), privacyUrl: "", termsUrl: "", whatsapp: "",
    bank: { name: "SYNTHETIC", beneficiary: "SYNTHETIC", clabe: "000000000000000000" },
    envia: { enabled: false, token: "synthetic-private-envia-key", environment: "sandbox", sender: {}, profiles: {} },
    email: { env: {}, autoStart: false, logger: () => {} }, customers: { env: {}, logger: () => {} } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  async function call(route, data, method = data ? "POST" : "GET") {
    const response = await fetch(base + route, { method, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" }, ...(data ? { body: JSON.stringify(data) } : {}) });
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return { status: response.status, data: await response.json() };
  }
  return { ...app, base, call };
}

test("Páginas legales: condiciones públicas y aviso antiguo retirado hacia la política canónica", async () => {
  const app = await start();
  try {
    const termsPage = await fetch(app.base + "/condiciones-de-compra.html");
    assert.equal(termsPage.status, 200); assert.match(termsPage.headers.get("content-type"), /^text\/html/);
    const html = await termsPage.text();
    assert.ok(html.includes('<h1 class="legal-title">Condiciones de compra</h1>'));
    assert.match(html, /Versión para revisión del propietario/);
    assert.match(html, /name="robots" content="noindex,nofollow"/);
    assert.doesNotMatch(html, /\[PENDIENTE\]|\[RFC\]|\[DOMICILIO\]|\[CORREO\]/i);
    for (const id of ["menu-toggle", "main-nav", "account-toggle", "account-dialog", "contenido"]) assert.ok(html.includes(`id="${id}"`));
    assert.match(html, /href="index\.html">← Volver a la tienda/);
    assert.match(html, /href="privacidad\.html"/);
    assert.doesNotMatch(html, /aviso-de-privacidad\.html/);
    assert.equal((await fetch(app.base + "/condiciones-de-compra.html", { method: "HEAD" })).status, 200);

    // The retired notice no longer serves a second policy: it redirects.
    const legacy = await fetch(app.base + "/aviso-de-privacidad.html", { redirect: "manual" });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/privacidad.html");
    assert.equal(legacy.headers.get("cache-control"), "no-store");
    const followed = await fetch(app.base + "/aviso-de-privacidad.html");
    assert.equal(followed.status, 200);
    const body = await followed.text();
    assert.equal(body, await readFile(new URL("../dist/privacidad.html", import.meta.url), "utf8"));
    assert.doesNotMatch(body, /<h1 class="legal-title">Aviso de privacidad/);

    const style = await fetch(app.base + "/legal.css"); assert.equal(style.status, 200);
    assert.match(style.headers.get("content-type"), /^text\/css/);
  } finally { await app.close(); }
});

test("Pie: conserva enlaces locales legibles sin URLs del propietario configuradas", async () => {
  const app = await start();
  try {
    const config = (await app.call("/api/config")).data;
    assert.equal(config.enabled, false); assert.equal(config.privacyUrl, ""); assert.equal(config.termsUrl, "");
    for (const [page, ids] of [["index.html", ["footer-privacy", "footer-terms"]]]) {
      const html = await (await fetch(app.base + "/" + page)).text();
      for (const [index, route] of ["privacidad.html", "condiciones-de-compra.html"].entries()) {
        const tag = html.match(new RegExp(`<a\\b[^>]*id="${ids[index]}"[^>]*>`))?.[0];
        assert.ok(tag?.includes(`href="${route}"`)); assert.doesNotMatch(tag, /\bhidden\b/);
        assert.equal((await fetch(new URL(route, app.base + "/" + page))).status, 200);
      }
    }
  } finally { await app.close(); }
});

test("Checkout: abre el formulario con consentimiento de uso de datos y muestra solo documentos configurados", async () => {
  const html = await readFile(new URL("../dist/checkout.html", import.meta.url), "utf8");
  const consent = html.match(/<input\b[^>]*name="consent"[^>]*>[\s\S]*?<\/label\s*>/)?.[0];
  assert.ok(consent); assert.match(consent, /\brequired\b/);
  assert.match(consent, /datos[\s\S]*gestionar/i); assert.doesNotMatch(consent, /he leído/i);
  for (const urls of [
    { privacyUrl: "", termsUrl: "" },
    { privacyUrl: privacy, termsUrl: terms },
    { privacyUrl: privacy, termsUrl: "" },
    { privacyUrl: "", termsUrl: terms },
  ]) {
    const { nodes } = await checkoutDom({ enabled: true, unitCents: 165000,
      product: { saleSizes: ["M"] }, shipping: { enabled: false }, ...urls });
    assert.equal(nodes.get("#order-form").hidden, false, "las URLs vacías no impiden abrir el formulario");
    assert.equal(nodes.get("#privacy-link").href, "privacidad.html");
    assert.equal(nodes.get("#privacy-link").hidden, false);
    for (const [id, url, fallback] of [["#terms-link", urls.termsUrl, "condiciones-de-compra.html"]]) {
      const link = nodes.get(id);
      assert.equal(link.hidden, !url);
      assert.equal(link.href, url || fallback, "nunca se crea un enlace al checkout actual mediante href vacío");
    }
    assert.equal(nodes.get("#checkout-policies").hidden, false);
  }
});

test("Panel existente: guarda las URLs HTTPS nuevas sin activar pedidos ni alterar banco o token de Envia", async () => {
  const app = await start();
  try {
    assert.equal((await app.call("/api/session", { password })).status, 200);
    const before = (await app.call("/api/admin/settings")).data;
    const bank = { ...before.settings.bank };
    const settings = { ...before.settings, privacyUrl: privacy, termsUrl: terms };
    const saved = await app.call("/api/admin/settings", { settings, version: before.version, currentPassword: password }, "PATCH");
    assert.equal(saved.status, 200);
    const after = (await app.call("/api/admin/settings")).data;
    assert.equal(after.settings.privacyUrl, privacy); assert.equal(after.settings.termsUrl, terms);
    assert.equal(after.settings.enabled, false); assert.equal(after.settings.envia.enabled, false);
    assert.equal(after.settings.envia.tokenConfigured, true); assert.equal(after.settings.envia.token, undefined);
    assert.deepEqual(after.settings.bank, bank);
    const config = (await app.call("/api/config")).data;
    assert.equal(config.privacyUrl, privacy); assert.equal(config.termsUrl, terms); assert.equal(config.enabled, false);
    for (const field of ["privacyUrl", "termsUrl"])
      for (const invalid of ["http://offcode.mx/legal", "https://user:password@offcode.mx/legal", "javascript:alert(1)"]) {
        const rejected = await app.call("/api/admin/settings", { settings: { ...settings, [field]: invalid }, version: after.version, currentPassword: password }, "PATCH");
        assert.equal(rejected.status, 400);
      }
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customers")).n, 0);
  } finally { await app.close(); }
});
