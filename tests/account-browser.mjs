// Optional real-browser regression; npm test remains dependency-free.
// node tests/account-browser.mjs <playwright/index.mjs> <browser.exe> <output-dir>
// All requests, accounts and captured messages belong to an in-memory local app.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createApp } from "../server/server.mjs";

const [modulePath, executablePath, outputPath] = process.argv.slice(2);
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : "playwright");
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const probe = createServer();
await new Promise((r) => probe.listen(0, "127.0.0.1", r));
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = "http://127.0.0.1:" + port;
const messages = [], metrics = [], errors = [], resourceErrors = [];
const app = await createApp({ origin, production: false, enabled: false, ordersEnabledEnv: "false", databasePath: ":memory:",
  email: { env: {}, autoStart: false, logger: () => {} },
  customers: { env: { EMAIL_ENABLED: "true", EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test", RESEND_API_KEY: "synthetic-only" },
    logger: () => {}, fetcher: async (_, options) => {
      messages.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ id: "12345678-1234-4234-8234-123456789abc" }));
    } },
});
await new Promise((r) => app.server.listen(port, "127.0.0.1", r));
if (outputPath) await mkdir(outputPath, { recursive: true });
const email = "mobile@example.test", password = "synthetic-browser-password-123";
const link = (purpose) => new URL(messages.findLast((m) => m.text.includes("#" + purpose + "=")).text.match(/https?:\/\/\S+/)[0]);
async function post(route, data) {
  const response = await fetch(origin + "/api/customer/" + route, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  assert.equal(response.status, 200);
}
await post("register", { email, password });
const verificationMessage = messages.at(-1);
await post("verify", { token: link("verify").hash.slice(8) });
await post("recover", { email }); await app.accounts.close();
const resetMessage = messages.at(-1), resetUrl = link("reset");
// Generate the third template through the backend, without confirming it.
const emailContext = await browser.newContext();
const loggedIn = await emailContext.request.post(origin + "/api/customer/login", { headers: { Origin: origin }, data: { email, password } });
assert.equal(loggedIn.status(), 200);
const requested = await emailContext.request.post(origin + "/api/customer/email", { headers: { Origin: origin }, data: { email: "new@example.test", password } });
assert.equal(requested.status(), 200);
const emailChangeMessage = messages.at(-1), seedCookies = await emailContext.cookies();
await emailContext.close();

after(async () => {
  try {
    if (outputPath) await writeFile(path.join(outputPath, "browser-results.json"), JSON.stringify({ metrics, errors, resourceErrors }, null, 2) + "\n");
  } finally { await browser.close(); await app.close(); }
});

async function fixture(width, { motion = "reduce", authenticated = true, slowImages = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: motion });
  // The test is deliberately confined to loopback, even if content gains a new URL.
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    if (slowImages && route.request().resourceType() === "image") await new Promise((r) => setTimeout(r, 120));
    return route.continue();
  });
  if (authenticated) {
    await context.addCookies(seedCookies);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const clean = (s) => String(s).replace(/#(?:verify|reset|email)=[^\s"<>]+/g, "#[redacted]");
  page.on("pageerror", (e) => errors.push(clean(e.message)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(clean(m.text())); });
  page.on("response", (r) => { if (r.status() >= 400 && new URL(r.url()).pathname !== "/favicon.ico") resourceErrors.push({ status: r.status(), path: new URL(r.url()).pathname }); });
  return { context, page };
}
async function title(page, text) {
  await page.waitForFunction((expected) => document.querySelector("#account-title")?.textContent === expected && !document.querySelector("#account-root .account-loading"), text);
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "sin desbordamiento horizontal");
}
async function screenshot(page, name) {
  if (outputPath) await page.screenshot({ path: path.join(outputPath, name + ".png") });
}

for (const width of [320, 360, 390, 430, 1280]) {
  test(`Cuenta ${width}px: login, cinco opciones, regreso, recarga, historial y cierre del panel`, async () => {
    const { context, page } = await fixture(width, { authenticated: false });
    try {
      await page.goto(origin);
      await page.locator("#account-toggle").click();
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill(password);
      await page.locator(".account-primary").click();
      await title(page, "Tu cuenta");
      await page.waitForFunction(() => document.querySelector("[data-status]")?.textContent === "Sesión iniciada.");
      const layout = await page.evaluate(() => {
        const nav = document.querySelector(".account-nav"), badge = document.querySelector(".account-badge");
        return { position: getComputedStyle(nav).position, gap: nav.getBoundingClientRect().top - badge.getBoundingClientRect().bottom,
          bottom: nav.getBoundingClientRect().bottom, height: innerHeight, links: nav.querySelectorAll("a").length };
      });
      assert.equal(layout.position, "static"); assert.equal(layout.links, 5);
      assert.ok(layout.gap >= 0 && layout.gap <= 48, "opciones junto al estado de correo");
      if (width < 760) assert.ok(layout.bottom < layout.height, "las cinco opciones caben sin desplazarse");
      await noOverflow(page); await screenshot(page, `account-${width}`);
      await page.getByRole("link", { name: "Pedidos", exact: true }).click(); await title(page, "Mis pedidos");
      await page.locator(".empty-state").waitFor();
      for (const [route, heading] of [["pedidos", "Mis pedidos"], ["perfil", "Mi perfil"], ["direcciones", "Direcciones"], ["preferencias", "Preferencias"], ["seguridad", "Seguridad"]]) {
        await page.goto(origin + "/cuenta.html#/home"); await title(page, "Tu cuenta");
        await page.locator(`.account-nav a[href="#/${route}"]`).click(); await title(page, heading);
        await page.reload(); await title(page, heading);
        await page.locator(".account-self-link").click(); await title(page, "Tu cuenta");
        await page.locator(`.account-nav a[href="#/${route}"]`).click(); await title(page, heading);
        await page.getByRole("link", { name: "← Mi cuenta", exact: true }).click(); await title(page, "Tu cuenta");
        await noOverflow(page);
      }
      await page.goto(origin + "/cuenta.html"); await title(page, "Tu cuenta");
      await page.getByRole("link", { name: "Pedidos", exact: true }).click(); await title(page, "Mis pedidos");
      await page.goBack(); await title(page, "Tu cuenta");
      await page.goForward(); await title(page, "Mis pedidos");
      await page.goto(origin); await page.locator("#account-toggle").click(); await title(page, "Tu cuenta");
      await page.locator("[data-close]").click(); await page.waitForFunction(() => !document.querySelector("#account-dialog").open);
      await page.locator("#account-toggle").click(); await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector("#account-dialog").open);
      assert.equal(await page.evaluate(() => document.activeElement.id), "account-toggle");
      metrics.push({ kind: "account", width, ...layout });
    } finally { await context.close(); }
  });

  test(`Campaña y Contacto ${width}px: orden, proporciones y espacio reservado al cargar`, async () => {
    const { context, page } = await fixture(width, { slowImages: true, motion: width === 390 ? "no-preference" : "reduce" });
    try {
      await page.addInitScript(() => { window.qaShifts = []; new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.qaShifts.push(entry.value); }).observe({ type: "layout-shift", buffered: true }); });
      await page.goto(origin);
      const initialHeight = await page.locator(".hero").evaluate((n) => n.getBoundingClientRect().height);
      for (const image of await page.locator('main img[loading="lazy"]').all()) {
        await image.scrollIntoViewIfNeeded();
        await image.evaluate((n) => n.decode());
      }
      await page.locator("footer").scrollIntoViewIfNeeded();
      await page.waitForFunction(() => [...document.images].filter((n) => n.getClientRects().length).every((n) => n.complete));
      // Wait for the site's actual finite animations, without changing their styles.
      await page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity).map((a) => a.finished.catch(() => {}))));
      const layout = await page.evaluate(() => {
        const footer = document.querySelector("footer").getBoundingClientRect(), contact = document.querySelector(".footer-links").getBoundingClientRect();
        const figures = [...document.querySelectorAll(".editorial-grid img,.editorial-grid video")].map((n) => ({ ratio: n.getBoundingClientRect().width / n.getBoundingClientRect().height, fit: getComputedStyle(n).objectFit }));
        const sections = [".hero", ".collection-strip", ".collection", ".editorial", ".closing", "footer"].map((selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { selector, top: r.top, bottom: r.bottom }; });
        return { position: getComputedStyle(document.querySelector(".footer-links")).position, insideFooter: contact.top >= footer.top && contact.bottom <= footer.bottom,
          heroHeight: document.querySelector(".hero").getBoundingClientRect().height, figures, sections, cls: window.qaShifts.reduce((a, b) => a + b, 0) };
      });
      assert.equal(layout.position, "static"); assert.equal(layout.insideFooter, true);
      assert.ok(Math.abs(layout.heroHeight - initialHeight) < 1, "la carga no cambia la altura de portada");
      for (const figure of layout.figures) { assert.ok(Math.abs(figure.ratio - .75) < .01); assert.equal(figure.fit, "cover"); }
      for (let i = 1; i < layout.sections.length; i++) assert.ok(Math.abs(layout.sections[i].top - layout.sections[i - 1].bottom) < 2, "secciones contiguas sin huecos ni solapamientos");
      await noOverflow(page); await screenshot(page, `contact-footer-${width}`);
      await page.getByRole("link", { name: "Contacto ↗", exact: true }).click();
      await page.locator("#contact-form").waitFor(); await noOverflow(page);
      metrics.push({ kind: "campaign", width, ...layout });
    } finally { await context.close(); }
  });
}

test("Una respuesta tardía no sustituye el regreso a Tu cuenta", async () => {
  const { context, page } = await fixture(390);
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const requested = new Promise((r) => { entered = r; });
  try {
    await context.route(origin + "/api/customer/orders", async (route) => { entered(); await gate; await route.fallback(); });
    await page.goto(origin + "/cuenta.html#/home"); await title(page, "Tu cuenta");
    await page.getByRole("link", { name: "Pedidos", exact: true }).click(); await requested;
    await page.locator(".account-loading").waitFor();
    await page.locator(".account-self-link").click(); await title(page, "Tu cuenta");
    const finished = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/customer/orders");
    release(); await finished;
    // Observe after the actual response has reached the controller.
    await page.waitForLoadState("networkidle");
    assert.equal(await page.locator("#account-title").textContent(), "Tu cuenta");
    assert.equal(await page.locator(".account-nav a").count(), 5);
  } finally { release(); await context.close(); }
});

test("Perfil, direcciones, preferencias y logout: persistencia y sesión privada", async () => {
  const { context, page } = await fixture(390);
  try {
    await page.goto(origin + "/cuenta.html#/perfil"); await page.locator("[data-profile]").waitFor();
    await page.locator('[name="name"]').fill("Persona Sintética");
    await page.getByRole("button", { name: "Guardar nombre", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Perfil guardado." }).waitFor();
    await page.reload(); assert.equal(await page.locator('[name="name"]').inputValue(), "Persona Sintética");
    await page.goto(origin + "/cuenta.html#/direcciones"); await page.locator("[data-add]").click();
    const data = { label: "Casa sintética", name: "Persona Sintética", phone: "520000000000", street: "Calle ficticia 123", neighborhood: "Centro", city: "Ciudad de prueba", state: "Estado de prueba", postalCode: "00000" };
    for (const [key, value] of Object.entries(data)) await page.locator(`[data-address-form] [name="${key}"]`).fill(value);
    await page.getByRole("button", { name: "Guardar dirección", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Dirección guardada." }).waitFor();
    await page.locator(".address-card").waitFor(); await page.reload(); await page.locator(".address-card").waitFor();
    await page.getByRole("button", { name: "Editar", exact: true }).click();
    await page.locator('[name="label"]').fill("Casa editada"); await page.getByRole("button", { name: "Guardar dirección", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Dirección actualizada." }).waitFor();
    await page.reload(); assert.ok((await page.locator(".address-card").innerText()).includes("Casa editada"));
    await page.goto(origin + "/cuenta.html#/preferencias"); await page.locator('[name="marketing"]').check();
    await page.getByRole("button", { name: "Guardar preferencia" }).click(); await page.getByRole("status").filter({ hasText: "Guardamos tu autorización." }).waitFor();
    await page.reload(); assert.equal(await page.locator('[name="marketing"]').isChecked(), true);
    await page.locator('[name="marketing"]').uncheck(); await page.getByRole("button", { name: "Guardar preferencia" }).click();
    await page.getByRole("status").filter({ hasText: "No enviaremos comunicaciones comerciales." }).waitFor();
    await page.reload(); assert.equal(await page.locator('[name="marketing"]').isChecked(), false);
    const savedCookies = await context.cookies();
    await page.goto(origin + "/cuenta.html#/seguridad"); await page.locator("[data-logout]").click(); await title(page, "Entrar");
    // Replaying the old cookie must still fail on the server.
    const response = await fetch(origin + "/api/customer/profile", { headers: { Cookie: savedCookies.map((c) => c.name + "=" + c.value).join("; ") } });
    assert.equal(response.status, 401);
    await page.reload(); await title(page, "Entrar");
    assert.equal(await page.locator("[data-profile],.address-card,.account-nav").count(), 0);
  } finally { await context.close(); }
});

for (const width of [320, 390, 1280]) {
  for (const [purpose, message] of [["verify", verificationMessage], ["reset", resetMessage], ["email", emailChangeMessage]]) {
    test(`Correo ${purpose} ${width}px: CTA, URL completa copiable y sin recortes`, async () => {
      const { context, page } = await fixture(width, { authenticated: false });
      try {
        await page.setContent(message.html);
        const layout = await page.evaluate(() => {
          const [cta, fallback] = document.querySelectorAll("a"), ctaStyle = getComputedStyle(cta), r = fallback.getBoundingClientRect();
          const selection = getSelection(); const range = document.createRange(); range.selectNodeContents(fallback); selection.removeAllRanges(); selection.addRange(range);
          return { sameUrl: cta.href === fallback.href, completeUrl: fallback.textContent === fallback.href, copyable: selection.toString() === fallback.href,
            background: ctaStyle.backgroundColor, color: ctaStyle.color, ctaHeight: cta.getBoundingClientRect().height, fallbackInside: r.left >= 0 && r.right <= innerWidth,
            unclipped: ![fallback, fallback.parentElement].some((n) => ["hidden", "clip"].includes(getComputedStyle(n).overflowX)) };
        });
        assert.equal(layout.sameUrl, true); assert.equal(layout.completeUrl, true); assert.equal(layout.copyable, true);
        assert.equal(layout.background, "rgb(255, 255, 255)"); assert.equal(layout.color, "rgb(8, 8, 8)");
        assert.ok(layout.ctaHeight >= 44); assert.equal(layout.fallbackInside, true); assert.equal(layout.unclipped, true);
        await noOverflow(page); metrics.push({ kind: "email", purpose, width, ...layout });
      } finally { await context.close(); }
    });
  }
}

test("Recuperación: foco del título, teclado y contraseña nueva con enlace real", async () => {
  const { context, page } = await fixture(320, { authenticated: false });
  try {
    await page.goto(resetUrl.href); await title(page, "Nueva contraseña");
    assert.ok(!new URL(page.url()).hash, "token retirado de la URL");
    assert.equal(await page.locator("#account-title").evaluate((n) => n === document.activeElement), true);
    assert.equal(await page.locator("#account-title").evaluate((n) => getComputedStyle(n).outlineStyle), "none");
    assert.equal(await page.locator("#account-title").evaluate((n) => getComputedStyle(n).textDecorationLine), "underline");
    await screenshot(page, "reset-form-320");
    await page.keyboard.press("Tab"); assert.equal(await page.evaluate(() => document.activeElement.className), "account-back");
    assert.equal(await page.locator(".account-back").evaluate((n) => getComputedStyle(n).outlineStyle), "solid");
    const nextPassword = "synthetic-new-browser-password-123";
    await page.locator('[name="password"]').fill(nextPassword); await page.getByRole("button", { name: "Guardar contraseña" }).click();
    await title(page, "Entrar");
    await page.locator('[name="email"]').fill(email); await page.locator('[name="password"]').fill(nextPassword); await page.locator(".account-primary").click(); await title(page, "Tu cuenta");
    const old = await context.request.post(origin + "/api/customer/login", { headers: { Origin: origin }, data: { email, password } });
    assert.equal(old.status(), 401);
    await page.goto(resetUrl.href); await title(page, "Nueva contraseña");
    await page.locator('[name="password"]').fill(nextPassword); await page.getByRole("button", { name: "Guardar contraseña" }).click();
    await page.getByRole("status").filter({ hasText: "El enlace no es válido o ha vencido." }).waitFor();
  } finally { await context.close(); }
});

test("El servidor publica el controlador exacto y el navegador no registra errores inesperados", async () => {
  const response = await fetch(origin + "/account.js"); assert.equal(response.status, 200);
  assert.equal(await response.text(), await readFile(new URL("../dist/account.js", import.meta.url), "utf8"));
  assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  // The reused recovery token is deliberately rejected once in the browser.
  assert.deepEqual(resourceErrors, [{ status: 400, path: "/api/customer/reset" }]);
  assert.deepEqual(errors, ["Failed to load resource: the server responded with a status of 400 (Bad Request)"]);
});
