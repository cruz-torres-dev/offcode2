import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkoutApp } from "./helpers/checkout-app.mjs";
import { privacyPage } from "../scripts/build-privacy.mjs";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
// Git may deliver text with CRLF depending on the checkout settings while the
// generator always emits LF. Compare content, not line terminators.
const lf = (text) => text.replace(/\r\n/g, "\n");

test("Aviso antiguo: no sirve una segunda política y redirige a la canónica", async () => {
  const app = await checkoutApp();
  try {
    const legacy = await fetch(app.origin + "/aviso-de-privacidad.html", { redirect: "manual" });
    assert.equal(legacy.status, 302);
    assert.equal(legacy.headers.get("location"), "/privacidad.html");
    assert.equal(legacy.headers.get("cache-control"), "no-store");
    const body = await legacy.text();
    assert.equal(body, "", "la respuesta de redirección no debe incluir contenido");
    // The file is kept on disk as a historical artifact, never served.
    const onDisk = await read("dist/aviso-de-privacidad.html");
    assert.match(onDisk, /Aviso de privacidad/);
    assert.doesNotMatch(onDisk, /data-privacy-document/);
  } finally { await app.close(); }
});

test("Rutas: la canónica responde y la heredada llega al mismo documento", async () => {
  const app = await checkoutApp();
  try {
    const canonical = await fetch(app.origin + "/privacidad.html");
    assert.equal(canonical.status, 200);
    assert.match(canonical.headers.get("content-type"), /^text\/html/);
    assert.equal((await fetch(app.origin + "/privacidad.html", { method: "HEAD" })).status, 200);
    const followed = await fetch(app.origin + "/aviso-de-privacidad.html");
    assert.equal(followed.status, 200);
    assert.equal(followed.url, app.origin + "/privacidad.html");
    assert.equal(await followed.text(), await read("dist/privacidad.html"));
    // Query strings do not bypass the redirect.
    const withQuery = await fetch(app.origin + "/aviso-de-privacidad.html?origen=pie", { redirect: "manual" });
    assert.equal(withQuery.status, 302);
    assert.equal(withQuery.headers.get("location"), "/privacidad.html");
  } finally { await app.close(); }
});

test("Fuente canónica íntegra y separada de la histórica", async () => {
  const source = await read("docs/politica-privacidad.md");
  assert.doesNotMatch(source, /shopify/i);
  assert.match(source, /Última actualización: 20 de octubre de 2026/);
  assert.equal(lf(await read("dist/privacidad.html")), lf(privacyPage(source)));
  // The historical backup is untracked: a clean checkout must regenerate the
  // page from the canonical source alone, so the generator cannot reference it.
  const build = await read("scripts/build-privacy.mjs");
  assert.match(build, /docs\/politica-privacidad\.md/);
  assert.doesNotMatch(build, /politica-privacidad-original\.md/);
});

test("Página y modal consumen el mismo documento", async () => {
  const script = await read("dist/privacy.js");
  assert.match(script, /fetch\("privacidad\.html"/);
  assert.match(script, /\[data-privacy-document\]/);
  assert.match(script, /cloneNode\(true\)/);
  const files = ["privacidad.html", "aviso-de-privacidad.html", "index.html", "checkout.html", "condiciones-de-compra.html"];
  let documents = 0;
  for (const file of files) documents += ((await read("dist/" + file)).match(/data-privacy-document/g) || []).length;
  assert.equal(documents, 1, "solo la página canónica contiene el documento");
});

test("Sin Shopify ni enlaces a sus dominios en el contenido público", async () => {
  for (const file of ["dist/privacidad.html", "dist/condiciones-de-compra.html", "docs/politica-privacidad.md"]) {
    const text = await read(file);
    assert.doesNotMatch(text, /shopify|shop pay/i, file);
    assert.doesNotMatch(text, /shopify\.com|myshopify\.com|privacy\.shopify/i, file);
  }
});

test("Enlaces de privacidad en tienda, checkout y condiciones", async () => {
  const app = await checkoutApp();
  try {
    for (const route of ["/index.html", "/checkout.html"]) {
      const html = await (await fetch(app.origin + route)).text();
      assert.match(html, /href="privacidad\.html" data-privacy-link>Política de privacidad/);
      assert.match(html, /src="privacy\.js"/);
    }
    const conditions = await (await fetch(app.origin + "/condiciones-de-compra.html")).text();
    assert.match(conditions, /href="privacidad\.html">política de privacidad/);
    assert.match(conditions, /href="privacidad\.html">Privacidad/);
    assert.doesNotMatch(conditions, /aviso-de-privacidad\.html/);
    for (const route of ["/privacidad.html", "/condiciones-de-compra.html"]) assert.equal((await fetch(app.origin + route)).status, 200);
  } finally { await app.close(); }
  const script = await read("dist/privacy.js");
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) assert.match(script, new RegExp(modifier));
  assert.match(script, /window\.location\.assign\(link\.href\)/);
});

test("Modal accesible y responsive, sin apertura automática ni consentimientos", async () => {
  const css = await read("dist/privacy.css"), script = await read("dist/privacy.js");
  for (const rule of ["max-width:680px", "max-height:85vh", "overflow:auto", "::backdrop", "@media(max-width:430px)"])
    assert.ok(css.includes(rule), `falta ${rule}`);
  for (const token of ["showModal", 'aria-modal', "aria-labelledby", "autofocus", "keydown", "opener.focus"])
    assert.ok(script.includes(token), `falta ${token}`);
  assert.doesNotMatch(script, /DOMContentLoaded|window\.onload/);
  assert.doesNotMatch(script, /\.checked\s*=\s*true/);
});

test("Página no indexable y checkout con transferencia y aceptación intactas", async () => {
  const page = await read("dist/privacidad.html");
  assert.match(page, /<meta name="robots" content="noindex,nofollow"/);
  const checkout = await read("dist/checkout.html"), script = await read("dist/checkout.js");
  assert.match(checkout, /name="paymentMethod" type="radio" value="bank_transfer" checked required/);
  assert.match(checkout, /id="accept-total" name="totalAcceptance" type="checkbox" required/);
  assert.match(script, /totalAccepted: true, acceptedTotalCents: accepted\.totalCents/);
});
