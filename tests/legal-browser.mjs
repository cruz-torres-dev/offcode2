// Optional browser QA. Only loopback and an isolated in-memory app are used.
// node tests/legal-browser.mjs <playwright/index.mjs> <browser.exe> <output-dir>
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
const origin = "http://127.0.0.1:" + port, password = "synthetic-legal-browser-password";
const app = await createApp({ origin, production: false, databasePath: ":memory:", enabled: false, ordersEnabledEnv: "false", password, settingsKey: "ab".repeat(32),
  privacyUrl: "", termsUrl: "", whatsapp: "", bank: { name: "", beneficiary: "", clabe: "" },
  envia: { enabled: false, token: "", environment: "sandbox", sender: {}, profiles: {} },
  email: { env: {}, autoStart: false, logger: () => {} }, customers: { env: {}, logger: () => {} } });
await new Promise((r) => app.server.listen(port, "127.0.0.1", r));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const errors = [], metrics = [];
if (outputPath) await mkdir(outputPath, { recursive: true });
after(async () => {
  try { if (outputPath) await writeFile(path.join(outputPath, "legal-results.json"), JSON.stringify({ metrics, errors }, null, 2) + "\n"); }
  finally { await browser.close(); await app.close(); }
});
async function fixture(width, javaScriptEnabled = true) {
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, reducedMotion: "reduce", isMobile: width < 760, hasTouch: width < 760, javaScriptEnabled });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return { context, page };
}

for (const width of [320, 360, 390, 430, 1280]) {
  test(`Legales ${width}px: enlaces desde tienda, lectura, menú, regreso y acceso directo`, async () => {
    const { context, page } = await fixture(width);
    try {
      for (const [route, title, id] of [["condiciones-de-compra.html", "Condiciones de compra", "footer-terms"]]) {
        await page.goto(origin); await page.locator("#" + id).scrollIntoViewIfNeeded();
        assert.equal(await page.locator("#" + id).isVisible(), true);
        await page.locator("#" + id).click(); await page.waitForURL("**/" + route);
        assert.equal(await page.locator(".legal-title").textContent(), title);
        assert.equal(await page.locator(".legal-review").isVisible(), true);
        assert.equal(await page.locator(".legal-index a").count(), 8);
        assert.equal(await page.locator(".legal-content section").count(), 8);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(await page.locator("body").evaluate((n) => getComputedStyle(n).backgroundColor), "rgb(8, 8, 8)");
        if (width < 760) {
          await page.locator("#menu-toggle").click(); assert.equal(await page.locator("#main-nav").isVisible(), true);
          await page.keyboard.press("Escape"); assert.equal(await page.locator("#menu-toggle").getAttribute("aria-expanded"), "false");
        }
        await page.locator(".legal-index a").nth(6).click();
        const sectionId = await page.locator(".legal-index a").nth(6).getAttribute("href");
        assert.ok((await page.locator(sectionId).boundingBox()).y >= 100, "el ancla no queda bajo el encabezado fijo");
        await page.locator(".legal-return").click(); await page.waitForURL("**/index.html");
        await page.goto(origin + "/" + route); await page.reload();
        assert.equal(await page.locator(".legal-title").textContent(), title);
        const current = page.locator('footer [aria-current="page"]'); assert.equal(await current.count(), 1);
        if (outputPath) await page.screenshot({ path: path.join(outputPath, `${route.replace(".html", "")}-${width}.png`) });
        metrics.push({ width, route, horizontalOverflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), sections: 8 });
      }
    } finally { await context.close(); }
  });
}

test("Condiciones se leen sin JavaScript y enlazan a la política canónica", async () => {
  const { context, page } = await fixture(320, false);
  try {
    await page.goto(origin + "/condiciones-de-compra.html");
    assert.equal(await page.locator(".legal-title").textContent(), "Condiciones de compra");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
    await page.locator('.footer-links a[href="privacidad.html"]').click();
    await page.waitForURL("**/privacidad.html");
    assert.match(await page.locator("h1").first().textContent(), /Política de privacidad/);
    await page.goto(origin);
  } finally { await context.close(); }
});

test("Panel privado: el formulario real guarda las URLs HTTPS y mantiene recepción de pedidos cerrada", async () => {
  const { context, page } = await fixture(390);
  try {
    await page.goto(origin + "/settings.html");
    await page.locator("#password").fill(password); await page.locator("#login-form button").click();
    await page.locator("#settings-panel").waitFor();
    await page.locator('[name="privacyUrl"]').fill("https://offcode.mx/privacidad.html");
    await page.locator('[name="termsUrl"]').fill("https://offcode.mx/condiciones-de-compra.html");
    await page.locator('#settings-form [name="currentPassword"]').fill(password);
    const saved = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/admin/settings" && r.request().method() === "PATCH");
    await page.locator('#save-settings').click(); assert.equal((await saved).status(), 200);
    await page.reload(); await page.locator("#settings-panel").waitFor();
    assert.equal(await page.locator('[name="privacyUrl"]').inputValue(), "https://offcode.mx/privacidad.html");
    assert.equal(await page.locator('[name="termsUrl"]').inputValue(), "https://offcode.mx/condiciones-de-compra.html");
    const config = await (await context.request.get(origin + "/api/config")).json();
    assert.equal(config.enabled, false); assert.equal(config.privacyUrl, "https://offcode.mx/privacidad.html");
    // Existing configured HTTPS links still override the store's static fallback.
    await page.goto(origin); await page.waitForFunction(() => document.querySelector("#footer-privacy").getAttribute("href") === "https://offcode.mx/privacidad.html");
    assert.equal(await page.locator("#footer-terms").getAttribute("href"), "https://offcode.mx/condiciones-de-compra.html");
  } finally { await context.close(); }
});

test("Sin errores de JavaScript y sin clientes o pedidos creados", async () => {
  // The private settings screen first probes its session and receives 401
  // before the login form is submitted. This is its existing expected flow.
  assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 401 (Unauthorized)"]);
  assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customers")).n, 0);
});
