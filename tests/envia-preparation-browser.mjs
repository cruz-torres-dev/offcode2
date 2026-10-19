// Optional loopback-only browser QA. Envia responses and all addresses are synthetic.
// node tests/envia-preparation-browser.mjs <playwright/index.mjs> <browser.exe> <output-dir>
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createApp } from "../server/server.mjs";

const [modulePath, executablePath, outputPath] = process.argv.slice(2);
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : "playwright");
const probe = createServer(); await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port; await new Promise((r) => probe.close(r));
const origin = "http://127.0.0.1:" + port, password = "synthetic-envia-browser-password";
const calls = [], errors = [], metrics = [];
const app = await createApp({ origin, production: false, databasePath: ":memory:", enabled: false, ordersEnabledEnv: "false", password, settingsKey: "ab".repeat(32),
  privacyUrl: "", termsUrl: "", whatsapp: "", bank: { name: "", beneficiary: "", clabe: "" },
  envia: { enabled: false, token: "synthetic-saved-token", environment: "production", sender: {}, profiles: {}, fetch: async (url, options) => {
    assert.equal(options.headers.Authorization, "Bearer synthetic-saved-token");
    calls.push({ url, payload: options.body ? JSON.parse(options.body) : null });
    if (url === "https://queries.envia.com/state?country_code=MX")
      return Response.json({ data: [{ name: "Guanajuato", code_2_digits: "GT" }] });
    assert.equal(url, "https://api.envia.com/ship/rate/", "la prueba nunca compra guías");
    return Response.json({ meta: "rate", data: [{ carrier: "fedex", currency: "MXN", service: "ground", serviceDescription: "FedEx terrestre", totalPrice: 185.2 }] });
  } }, email: { env: {}, autoStart: false, logger: () => {} }, customers: { env: {}, logger: () => {} } });
await new Promise((r) => app.server.listen(port, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
if (outputPath) await mkdir(outputPath, { recursive: true });
after(async () => {
  try { if (outputPath) await writeFile(path.join(outputPath, "envia-preparation-results.json"), JSON.stringify({ metrics, errors, outboundCalls: calls.map((c) => c.url) }, null, 2) + "\n"); }
  finally { await browser.close(); await app.close(); }
});
async function fixture(width) {
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, isMobile: width < 760, hasTouch: width < 760 });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(origin + "/settings.html");
  await page.locator("#password").fill(password); await page.locator("#login-form button").click();
  await page.locator("#settings-panel").waitFor();
  return { context, page };
}
async function catalogue(page) {
  await page.locator("#check-envia").click();
  await page.waitForFunction(() => document.querySelector('#envia-preview-form [name="state"]').options.length > 1 &&
    document.querySelector("#envia-check-message").textContent.includes("no confirma"));
  assert.match(await page.locator("#envia-check-message").textContent(), /no confirma/);
}
async function quote(page) {
  const form = page.locator("#envia-preview-form");
  await form.locator('[name="variantId"]').selectOption({ index: 1 });
  for (const [name, value] of Object.entries({ name: "Destino Ficticio", phone: "520000000000", email: "destino@example.test",
    street: "Calle Ficticia 2", neighborhood: "Colonia Ficticia", city: "Ciudad Ficticia", postalCode: "37000" }))
    await form.locator(`[name="${name}"]`).fill(value);
  await form.locator('[name="state"]').selectOption("GT");
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/envia/rates");
  await page.locator("#envia-preview-submit").click();
  assert.equal((await response).status(), 200);
  await page.waitForFunction(() => document.querySelector("#envia-preview-results").textContent.includes("185.20"));
  assert.match(await page.locator("#envia-preview-message").textContent(), /No se creó pedido, reserva ni guía/);
}

test("Panel: guarda origen y empaques sin URLs legales ni nuevo token; cotiza con pedidos e integración cerrados", async () => {
  const { context, page } = await fixture(390);
  try {
    assert.equal(await page.locator("#envia-preview-submit").isDisabled(), true);
    assert.equal(await page.locator('[name="ordersEnabled"]').isDisabled(), true);
    await catalogue(page);
    for (const [name, value] of Object.entries({ senderName: "Origen Ficticio", senderPhone: "520000000000", senderEmail: "origen@example.test",
      senderStreet: "Calle Ficticia", senderNumber: "1", senderDistrict: "Colonia Ficticia", senderCity: "Ciudad Ficticia", senderPostalCode: "37000" }))
      await page.locator(`#settings-form [name="${name}"]`).fill(value);
    await page.locator('[name="senderState"]').selectOption("GT");
    await page.locator("#add-package").click();
    for (const [name, value] of Object.entries({ qty: "1", weight: "0.75", length: "30", width: "20", height: "10" }))
      await page.locator(`#package-profiles [data-field="${name}"]`).fill(value);
    await page.locator('#settings-form [name="currentPassword"]').fill(password);
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/settings" && r.request().method() === "PATCH");
    await page.locator("#save-settings").click(); assert.equal((await saved).status(), 200);
    await page.waitForFunction(() => !document.querySelector("#envia-preview-submit").disabled);
    assert.equal(await page.locator('[name="privacyUrl"]').inputValue(), "");
    assert.equal(await page.locator('[name="termsUrl"]').inputValue(), "");
    assert.equal(await page.locator('[name="enviaToken"]').inputValue(), "");
    assert.equal(await page.locator('[name="enviaEnabled"]').isChecked(), false);
    assert.match(await page.locator("#token-status").textContent(), /Token guardado/);
    await catalogue(page);
    await page.locator('[name="senderStreet"]').fill("Cambio local sin guardar");
    await quote(page);
    assert.equal(calls.at(-1).payload.origin.street, "Calle Ficticia", "se usa el único origen guardado, no el formulario sin guardar");
    const settings = await (await context.request.get(origin + "/api/admin/settings")).json();
    assert.equal(settings.settings.enabled, false); assert.equal(settings.settings.envia.enabled, false);
    assert.equal(settings.settings.envia.tokenConfigured, true); assert.equal(settings.settings.privacyUrl, "");
    assert.equal((await context.request.post(origin + "/api/orders", { headers: { Origin: origin }, data: {} })).status(), 503);
    await page.reload(); await page.locator("#settings-panel").waitFor();
    assert.equal(await page.locator('[name="senderStreet"]').inputValue(), "Calle Ficticia");
    assert.equal(await page.locator('#envia-preview-form [name="name"]').inputValue(), "");
    const checks = await page.locator("#readiness-checks").textContent();
    assert.match(checks, /Páginas legales/); assert.match(checks, /no bloquean/);
    metrics.push({ width: 390, savedWithoutLegal: true, reusedToken: true, ordersClosed: true });
  } finally { await context.close(); }
});

for (const width of [320, 360, 430, 1280]) {
  test(`Preparación de Envia ${width}px: destino, catálogo y tarifa sin desplazamiento horizontal`, async () => {
    const { context, page } = await fixture(width);
    try {
      await catalogue(page); await quote(page);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      if (outputPath) { await page.locator("#envia-preview-title").scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(outputPath, `envia-preview-${width}.png`) }); }
      metrics.push({ width, horizontalOverflow: false, quote: "simulada por fixture, sin llamada externa" });
    } finally { await context.close(); }
  });
}

test("Pruebas privadas: ninguna guía, pedido, reserva, tarifa de checkout o alteración de inventario", async () => {
  for (const table of ["orders", "order_reservations", "shipping_jobs", "shipping_quotes", "inventory_movements", "customers"])
    assert.equal((await app.db.get(`SELECT count(*) AS n FROM ${table}`)).n, 0, table);
  assert.equal((await app.db.get("SELECT count(*) AS n FROM inventory WHERE configured!=0 OR on_hand!=0 OR reserved!=0")).n, 0);
  assert.equal(calls.filter((c) => c.url.endsWith("/ship/rate/")).length, 5);
  const expected401 = errors.filter((e) => /Failed to load resource: the server responded with a status of 401/.test(e));
  const expected503 = errors.filter((e) => /Failed to load resource: the server responded with a status of 503/.test(e));
  assert.deepEqual(errors.filter((e) => !expected401.includes(e) && !expected503.includes(e)), []);
  assert.equal(expected401.length, 5, "sondas iniciales sin sesión");
});
