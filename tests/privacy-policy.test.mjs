import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { checkoutApp } from "./helpers/checkout-app.mjs";
import { privacyPage } from "../scripts/build-privacy.mjs";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

test("Política pública: sin referencias ni enlaces a Shopify", async () => {
  const source = await read("docs/politica-privacidad.md");
  const page = await read("dist/privacidad.html");
  const script = await read("scripts/build-privacy.mjs");
  for (const [label, text] of [["fuente", source], ["página", page]]) {
    assert.doesNotMatch(text, /shopify|shop pay/i, `${label} no debe mencionar Shopify`);
    assert.doesNotMatch(text, /shopify\.com|myshopify\.com|privacy\.shopify/i, `${label} no debe enlazar dominios de Shopify`);
  }
  // The build refuses a source that reintroduces the platform.
  assert.throws(() => privacyPage("# Política de privacidad\n\nÚltima actualización: 20 de octubre de 2026\n\nAlojado en Shopify."), /Shopify/);
  assert.match(script, /politica-privacidad\.md/);
  assert.doesNotMatch(script, /politica-privacidad-original\.md/);
});

test("Generación: dist/privacidad.html proviene de docs/politica-privacidad.md", async () => {
  const source = await read("docs/politica-privacidad.md");
  const saved = await read("dist/privacidad.html");
  assert.equal(saved, privacyPage(source), "Ejecuta node scripts/build-privacy.mjs al cambiar la fuente");
  assert.match(saved, /Última actualización: 20 de octubre de 2026/);
  assert.equal((saved.match(/<h2>/g) || []).length, 17);
  assert.match(saved, /<meta name="robots" content="noindex,nofollow"/);
  assert.doesNotMatch(saved, /<script\b|<iframe\b/);
  assert.doesNotMatch(saved, /privacy-review|Documento original pendiente de revisión/);
  // The historical backup stays intact and is not the public content.
  const original = await read("docs/politica-privacidad-original.md");
  assert.match(original, /shopify/i);
  assert.notEqual(original.trim(), source.trim());
});

test("Página y modal comparten exactamente el mismo documento", async () => {
  const script = await read("dist/privacy.js");
  assert.match(script, /fetch\("privacidad\.html"/);
  assert.match(script, /\[data-privacy-document\]/);
  assert.match(script, /cloneNode\(true\)/);
  // One document in the site: the modal clones it instead of keeping a copy.
  const files = (await readdir(new URL("../dist/", import.meta.url))).filter((name) => name.endsWith(".html"));
  let documents = 0;
  for (const file of files) {
    const html = await read("dist/" + file);
    documents += (html.match(/data-privacy-document/g) || []).length;
  }
  assert.equal(documents, 1);
  // No policy prose is embedded in the script that builds the dialog.
  assert.doesNotMatch(script, /transferencia bancaria|Envia|Resend/i);
});

test("Enlaces de tienda y checkout abren el modal y permiten la página independiente", async () => {
  const app = await checkoutApp();
  try {
    for (const route of ["/index.html", "/checkout.html"]) {
      const html = await (await fetch(app.origin + route)).text();
      assert.match(html, /href="privacidad\.html" data-privacy-link>Política de privacidad/);
      assert.match(html, /src="privacy\.js"/);
      assert.match(html, /href="privacy\.css"/);
    }
    const page = await fetch(app.origin + "/privacidad.html");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.equal((await fetch(app.origin + "/privacidad.html", { method: "HEAD" })).status, 200);
  } finally { await app.close(); }
  const script = await read("dist/privacy.js");
  // Modified clicks keep normal navigation (new tab / new window).
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) assert.match(script, new RegExp(modifier));
  assert.match(script, /window\.location\.assign\(link\.href\)/, "una carga fallida deriva a la página independiente");
  assert.match(script, /HTMLDialogElement/, "sin soporte de dialog se navega a la página");
});

test("Contactos de la política bien formados", async () => {
  const html = await read("dist/privacidad.html");
  const mailto = html.match(/href="mailto:([^"]+)"/g) ?? [];
  const tel = html.match(/href="tel:([^"]+)"/g) ?? [];
  assert.deepEqual(mailto, ['href="mailto:brandoffcode@gmail.com"']);
  assert.deepEqual(tel, ['href="tel:+524771610537"']);
  assert.match(html, /Flor de Azar 101, 37667 Leon GTO, México/);
  assert.doesNotMatch(html, /href="(mailto:|tel:)[^"]*\s[^"]*"/, "sin espacios dentro de mailto/tel");
  assert.doesNotMatch(html, /href="https?:\/\/(www\.)?shopify/i);
});

test("Sin datos legales ni proveedores inventados", async () => {
  const html = await read("dist/privacidad.html");
  for (const invented of [/\bRFC\b/, /S\.A\. de C\.V\./i, /S\. de R\.L\./i, /Cláusulas Contractuales Estándar/i, /\bSCC\b/])
    assert.doesNotMatch(html, invented);
  for (const provider of ["Shopify", "Stripe", "PayPal", "Mercado Pago", "Mailchimp", "Klaviyo", "Google Analytics", "Meta Pixel"])
    assert.doesNotMatch(html, new RegExp(provider, "i"));
  // Only providers the repository actually configures.
  for (const provider of ["Render", "Resend", "Envia", "FedEx"]) assert.match(html, new RegExp(provider));
  // No card processing is claimed, and the limitation is stated.
  assert.match(html, /no captura ni procesa tarjetas/i);
  assert.doesNotMatch(html, /procesamos (pagos )?con tarjeta/i);
  assert.match(html, /La verificación del abono es manual/i);
  // No blanket legal-compliance claim.
  assert.doesNotMatch(html, /cumple (con )?todas las leyes|jurídicamente validada|plenamente conforme/i);
});

test("Modal accesible y responsive conservado", async () => {
  const css = await read("dist/privacy.css");
  for (const rule of ["max-width:680px", "max-height:85vh", "max-height:85dvh", "overflow:auto", "::backdrop", "focus-visible", "@media(max-width:430px)"])
    assert.ok(css.includes(rule), `falta ${rule}`);
  const script = await read("dist/privacy.js");
  for (const token of ["showModal", 'aria-modal', "aria-labelledby", 'role", "dialog"', "autofocus", "Tab", "keydown", "opener.focus"])
    assert.ok(script.includes(token), `falta ${token}`);
  assert.match(script, /Native Escape dispatches cancel and closes this dialog/);
  // Opening is a click handler: no auto-open, no consent is set.
  assert.doesNotMatch(script, /DOMContentLoaded|window\.onload/);
  assert.doesNotMatch(script, /\.checked\s*=\s*true/);
});

test("Checkout conserva transferencia, aceptación explícita y confirmación manual", async () => {
  const html = await read("dist/checkout.html"), script = await read("dist/checkout.js"), server = await read("server/server.mjs");
  assert.match(html, /name="paymentMethod" type="radio" value="bank_transfer" checked required/);
  assert.match(html, /id="accept-total" name="totalAcceptance" type="checkbox" required/);
  assert.match(script, /paymentMethod: transfer\.value/);
  assert.match(script, /totalAccepted: true, acceptedTotalCents: accepted\.totalCents/);
  assert.match(server, /change\.status === "paid" && change\.paymentVerified !== true/);
  assert.match(server, /"bank_transfer"/);
  assert.doesNotMatch(html, /\bcard\b|cvv|tarjeta de crédito/i);
});

test("Cotizar no crea pedidos, reservas, movimientos ni guías", async () => {
  const app = await checkoutApp();
  try {
    const before = await app.snapshot();
    const quoted = await app.quote();
    assert.equal(quoted.status, 200);
    assert.ok(quoted.data.rates.length > 0);
    const after = await app.snapshot();
    for (const table of ["orders", "order_reservations", "inventory_movements", "shipping_jobs"])
      assert.equal(after[table].length, before[table].length, `${table} no debe cambiar al cotizar`);
    assert.deepEqual(after.inventory, before.inventory);
    assert.equal(app.provider.generateCalls, 0);
  } finally { await app.close(); }
});
