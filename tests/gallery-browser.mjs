// Optional Chromium regression using real touch input, without a physical phone.
// node tests/gallery-browser.mjs <playwright/index.mjs> <browser.exe> <output-dir>
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createApp } from "../server/server.mjs";

const [modulePath, executablePath, outputPath] = process.argv.slice(2);
const { chromium } = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : "playwright");
const app = await createApp({ origin: "http://localhost:8000", production: false, databasePath: ":memory:", enabled: false, ordersEnabledEnv: "false",
  email: { env: {}, autoStart: false, logger: () => {} }, customers: { env: {}, logger: () => {} } });
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + app.server.address().port;
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const metrics = [], errors = [];
if (outputPath) await mkdir(outputPath, { recursive: true });
after(async () => {
  try { if (outputPath) await writeFile(path.join(outputPath, "gallery-results.json"), JSON.stringify({ metrics, errors }, null, 2) + "\n"); }
  finally { await browser.close(); await app.close(); }
});

async function fixture(width, height = 844) {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: "reduce" });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelectorAll(".product-gallery .gallery-thumbs button").length >= 3);
  await page.locator("#product-open").scrollIntoViewIfNeeded();
  const scroll = await page.evaluate(() => scrollY);
  await page.locator("#product-open").click();
  await page.locator("#zoom-image").evaluate((n) => n.decode());
  return { context, page, scroll, cdp: await context.newCDPSession(page) };
}
const state = (page) => page.locator("#zoom-viewport").evaluate((n) => ({
  scale: Number(n.style.getPropertyValue("--photo-scale")), x: parseFloat(n.style.getPropertyValue("--photo-x")), y: parseFloat(n.style.getPropertyValue("--photo-y")),
}));
const touch = (cdp, type, points = []) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([id, x, y]) => ({ id, x, y, radiusX: 3, radiusY: 3, force: 1 })) });
async function pinch(cdp, cx, cy, startDistance, endDistance) {
  await touch(cdp, "touchStart", [[1, cx - startDistance / 2, cy], [2, cx + startDistance / 2, cy]]);
  for (let step = 1; step <= 8; step++) {
    const distance = startDistance + (endDistance - startDistance) * step / 8;
    await touch(cdp, "touchMove", [[1, cx - distance / 2, cy], [2, cx + distance / 2, cy]]);
  }
  await touch(cdp, "touchEnd");
}
async function shot(page, name) {
  if (outputPath) await page.screenshot({ path: path.join(outputPath, name + ".png") });
}

for (const width of [320, 360, 390, 430]) {
  test(`Visor móvil ${width}px: pantalla completa, blanco, controles, tres originales y cierre`, async () => {
    const { context, page, scroll } = await fixture(width);
    try {
      const layout = await page.evaluate(() => {
        const modal = document.querySelector("#product-modal"), viewport = document.querySelector("#zoom-viewport"), image = document.querySelector("#zoom-image");
        return { modal: modal.getBoundingClientRect().toJSON(), viewport: viewport.getBoundingClientRect().toJSON(), background: getComputedStyle(modal).backgroundColor,
          padding: getComputedStyle(modal).padding, border: getComputedStyle(modal).borderWidth, fit: getComputedStyle(image).objectFit,
          documentWidth: document.documentElement.scrollWidth, height: innerHeight, width: innerWidth, touchAction: getComputedStyle(viewport).touchAction, bodyTouchAction: getComputedStyle(document.body).touchAction };
      });
      assert.equal(layout.modal.x, 0); assert.equal(layout.modal.y, 0);
      assert.equal(layout.modal.width, width); assert.equal(layout.modal.height, layout.height);
      assert.equal(layout.viewport.width, width); assert.equal(layout.viewport.height, layout.height);
      assert.equal(layout.background, "rgb(255, 255, 255)"); assert.equal(layout.padding, "0px"); assert.equal(layout.border, "0px"); assert.equal(layout.fit, "contain");
      assert.equal(layout.documentWidth, width); assert.equal(layout.touchAction, "none"); assert.equal(layout.bodyTouchAction, "auto");
      for (const selector of ["#product-modal .close", "#viewer-prev", "#viewer-next", "#viewer-thumbs button.active"]) {
        assert.ok(await page.locator(selector).evaluate((n) => { const r = n.getBoundingClientRect(); return r.width >= 44 && r.height >= 44 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("button") === n; }), "control accesible y sin elementos superpuestos: " + selector);
      }
      await shot(page, `gallery-initial-${width}`);
      const sources = [];
      for (let index = 0; index < 3; index++) {
        await page.locator("#viewer-thumbs button").nth(index).click(); await page.locator("#zoom-image").evaluate((n) => n.decode());
        sources.push(await page.locator("#zoom-image").getAttribute("src"));
        assert.equal((await state(page)).scale, 1);
        assert.ok((await page.locator("#viewer-position").innerText()).startsWith(`${index + 1} /`));
      }
      assert.deepEqual(sources, ["assets/product-front-large.webp", "assets/product-back-large.webp", "assets/product-detail-large.webp"]);
      await page.mouse.wheel(0, 350); assert.equal(await page.evaluate(() => scrollY), scroll, "el fondo no se desplaza");
      await page.locator("#product-modal .close").click();
      await page.waitForFunction(() => !document.querySelector("#product-modal").open);
      assert.equal(await page.evaluate(() => scrollY), scroll); assert.equal(await page.evaluate(() => document.activeElement.id), "product-open");
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("product-viewer-open")), false);
      metrics.push({ kind: "layout", width, ...layout });
    } finally { await context.close(); }
  });

  test(`Multitáctil emulado ${width}px: acercar, arrastrar, alejar y restablecer al cambiar`, async () => {
    const { context, page, cdp, scroll } = await fixture(width);
    try {
      const cx = width * .38, cy = 422;
      await pinch(cdp, cx, cy, 70, 140);
      const zoomed = await state(page);
      assert.ok(Math.abs(zoomed.scale - 2) < .03, "dos dedos amplían a 2×");
      assert.ok(Math.abs(zoomed.x - (width / 2 - cx)) < 2, "el zoom conserva el punto entre los dedos");
      assert.equal(await page.locator("#viewer-thumbs button.active").getAttribute("data-photo"), "0");
      await shot(page, `gallery-zoom-${width}`);
      await touch(cdp, "touchStart", [[1, width / 2, cy]]);
      await touch(cdp, "touchMove", [[1, width / 2 - 45, cy]]); await touch(cdp, "touchEnd");
      const dragged = await state(page);
      assert.ok(Math.abs(dragged.x - (zoomed.x - 45)) < 2); assert.ok(Math.abs(dragged.scale - zoomed.scale) < .01);
      await pinch(cdp, width / 2, cy, 140, 60);
      assert.deepEqual(await state(page), { scale: 1, x: 0, y: 0 });
      assert.equal(await page.locator("#viewer-thumbs button.active").getAttribute("data-photo"), "0", "el pinch no se convierte en swipe");
      await pinch(cdp, width / 2, cy, 70, 140);
      await page.locator("#viewer-next").click();
      assert.deepEqual(await state(page), { scale: 1, x: 0, y: 0 });
      assert.equal(await page.locator("#viewer-thumbs button.active").getAttribute("data-photo"), "1");
      await page.locator("#viewer-prev").click(); await page.locator("#zoom-image").evaluate((n) => n.decode());
      // A swipe at 1× remains distinct from a zoom/pan gesture.
      await touch(cdp, "touchStart", [[1, width - 70, cy]]);
      await touch(cdp, "touchMove", [[1, 70, cy]]); await touch(cdp, "touchEnd");
      assert.equal(await page.locator("#viewer-thumbs button.active").getAttribute("data-photo"), "1");
      assert.equal(await page.evaluate(() => scrollY), scroll);
      await page.setViewportSize({ width, height: 700 });
      assert.equal(await page.locator("#product-modal").evaluate((n) => n.getBoundingClientRect().height), 700);
      assert.deepEqual(await state(page), { scale: 1, x: 0, y: 0 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await page.locator("#product-modal .close").click();
      await page.waitForFunction(() => !document.querySelector("#product-modal").open);
      await page.locator("#product-open").click(); assert.deepEqual(await state(page), { scale: 1, x: 0, y: 0 });
      await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector("#product-modal").open);
      metrics.push({ kind: "touch", width, zoomed, dragged, resizedHeight: 700 });
    } finally { await context.close(); }
  });
}

test("Escritorio y horizontal: teclado, ratón, miniaturas, proporciones y Escape", async () => {
  for (const [width, height] of [[1280, 900], [1440, 900], [844, 390]]) {
    const { context, page } = await fixture(width, height);
    try {
      await page.locator("#zoom-viewport").focus(); await page.keyboard.press("Enter");
      assert.ok((await state(page)).scale > 1);
      const before = await state(page);
      await page.mouse.move(width / 2, height / 2); await page.mouse.down(); await page.mouse.move(width / 2, height / 2 - 35); await page.mouse.up();
      assert.ok((await state(page)).y < before.y, "arrastra sobre el eje donde la fotografía ampliada excede el viewport");
      await page.keyboard.press("ArrowRight"); assert.deepEqual(await state(page), { scale: 1, x: 0, y: 0 });
      await page.locator("#viewer-thumbs button").nth(2).click(); await page.locator("#zoom-image").evaluate((n) => n.decode());
      assert.ok((await page.locator("#zoom-image").getAttribute("src")).endsWith("product-detail-large.webp"));
      assert.equal(await page.locator("#zoom-image").evaluate((n) => getComputedStyle(n).objectFit), "contain");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await shot(page, `gallery-desktop-${width}`);
      await page.keyboard.press("Escape"); await page.waitForFunction(() => !document.querySelector("#product-modal").open);
      metrics.push({ kind: "desktop", width, height });
    } finally { await context.close(); }
  }
});

test("Sin errores de JavaScript, datos reales ni solicitudes de pedido", async () => {
  assert.deepEqual(errors, []);
  assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM customers")).n, 0);
});
