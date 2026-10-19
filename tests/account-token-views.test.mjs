// Runs the actual account controller and HTTP backend with a small DOM double.
// This checks routing/submission, not browser layout or Gmail rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createApp } from "../server/server.mjs";

const code = await readFile(new URL("../dist/account.js", import.meta.url), "utf8");
const password = "synthetic-initial-password-123";
const origin = "http://localhost:8000";
class Node {
  constructor() { this.events = {}; this.dataset = {}; this.textContent = ""; this.isConnected = true; }
  addEventListener(type, fn) { this.events[type] = fn; }
  focus() {}
  scrollIntoView() {}
  append(child) { this.children.push(child); }
  querySelectorAll() { return []; }
  set innerHTML(html) {
    this.html = html;
    this.children = [];
    this.parts = {};
    this.form = html.includes("<form") ? new Node() : null;
    this.button = new Node();
    if (this.form) {
      this.form.elements = Object.fromEntries([...html.matchAll(/<input name="([^"]+)"/g)].map((m) => [m[1], { value: "", checked: false, focus() {} }]));
      this.form.querySelector = () => this.button;
      this.button.form = this.form;
    }
  }
  querySelector(selector) {
    if (selector === "form") return this.form;
    if (["[data-list]", "[data-editor]"].includes(selector)) return this.parts[selector] ??= new Node();
    if (/^\[data-[a-z-]+\]$/.test(selector)) return this.html.includes(selector.slice(1, -1)) ? this.button : null;
    return null;
  }
}

async function fixture() {
  const messages = [];
  const app = await createApp({ origin, databasePath: ":memory:", enabled: false, production: false,
    email: { env: {}, autoStart: false, logger: () => {} },
    customers: { env: { EMAIL_ENABLED: "true", EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test", RESEND_API_KEY: "synthetic-key" },
      logger: () => {}, fetcher: async (_, opts) => {
        messages.push(JSON.parse(opts.body));
        return new Response(JSON.stringify({ id: "12345678-1234-4234-8234-123456789abc" }));
      } },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  async function request(route, options = {}) {
    const response = await fetch(base + route, { ...options, headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json", ...options.headers } });
    if (response.headers.has("set-cookie")) cookie = response.headers.get("set-cookie").split(";")[0];
    return response;
  }
  const post = async (route, data) => request("/api/customer/" + route, { method: "POST", body: JSON.stringify(data) });
  const email = "controller@example.test";
  assert.equal((await post("register", { email, password })).status, 200);
  const link = () => new URL(messages.at(-1).text.match(/https?:\/\/\S+/)[0]);
  async function page(url) {
    const content = new Node(), status = new Node(), heading = new Node();
    const root = new Node();
    root.querySelector = (selector) => ({ "[data-content]": content, "[data-status]": status, "#account-title": heading }[selector] ?? null);
    const location = { hash: url.hash, pathname: url.pathname, search: url.search };
    const calls = [];
    const context = vm.createContext({
      document: { querySelector: (selector) => selector === "#account-root" ? root : null, createElement: () => new Node() },
      window: { addEventListener() {} }, location,
      history: { replaceState: (_, __, cleanUrl) => { assert.equal(cleanUrl, "/cuenta.html"); location.hash = ""; } },
      queueMicrotask,
      FormData: class { constructor(form) { this.values = Object.entries(form.elements).map(([key, input]) => [key, input.value]); } [Symbol.iterator]() { return this.values[Symbol.iterator](); } },
      fetch: (route, options) => { calls.push({ route, options }); return request(route, options); },
    });
    await vm.runInContext(`(async () => { ${code.replace(/await refresh\(\);\r?\nrender\(\);/, "await refresh();\nawait render();")}\n})()`, context);
    async function submit(values = {}) {
      const target = content.form ?? content.button;
      for (const [key, value] of Object.entries(values)) content.form.elements[key].value = value;
      target.events[content.form ? "submit" : "click"]({ preventDefault() {}, currentTarget: target });
      // Controller actions intentionally don't return their promise to the DOM.
      for (let i = 0; i < 500 && content.button.disabled; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(!content.button.disabled, "la acción termina");
    }
    return { content, root, status, calls, location, submit };
  }
  return { ...app, post, page, link, email };
}

test("Vista de verificación: abrir el enlace no consume el token; confirmar verifica y rechaza reutilización", async () => {
  const app = await fixture();
  try {
    const url = app.link();
    const page = await app.page(url);
    assert.equal(page.location.hash, "", "se retira el token de la barra de dirección");
    assert.match(page.content.html, /Verificar mi correo/);
    assert.deepEqual(page.calls.map((c) => c.route), ["/api/customer/session"], "abrir no verifica automáticamente");
    assert.equal((await app.db.get("SELECT verified_at FROM customers")).verified_at, null);
    await page.submit();
    assert.match(page.status.textContent, /Correo verificado/);
    assert.match(page.content.html, /autocomplete="current-password"/);
    assert.equal((await app.post("verify", { token: url.hash.slice(8) })).status, 400);
  } finally { await app.close(); }
});

test("Direcciones: guardar refresca la lista inmediatamente y conserva los datos al recargar", async () => {
  const app = await fixture();
  try {
    await app.post("verify", { token: app.link().hash.slice(8) });
    await app.post("login", { email: app.email, password });
    const url = new URL(origin + "/cuenta.html#/direcciones");
    const page = await app.page(url);
    const list = page.content.querySelector("[data-list]");
    assert.equal(list.children.length, 0);
    page.content.querySelector("[data-add]").events.click();
    const editor = page.content.querySelector("[data-editor]"), form = editor.form;
    for (const [key, value] of Object.entries({ label: "Casa sintética", name: "Persona Sintética", phone: "520000000000", street: "Calle de prueba 123", neighborhood: "Centro", city: "Ciudad de prueba", state: "Estado de prueba", postalCode: "00000" }))
      form.elements[key].value = value;
    form.events.submit({ preventDefault() {}, currentTarget: form });
    for (let i = 0; i < 500 && page.status.textContent === "Un momento…"; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(page.status.textContent, "Dirección guardada.");
    assert.equal(list.children.length, 1, "la dirección aparece antes de recargar");
    assert.match(list.children[0].html, /Casa sintética/);
    const reloaded = await app.page(url);
    const persisted = reloaded.content.querySelector("[data-list]");
    assert.equal(persisted.children.length, 1);
    assert.match(persisted.children[0].html, /Casa sintética/);
  } finally { await app.close(); }
});

test("Vista de recuperación: enlace real → formulario → contraseña nueva → login; enlace usado muestra error", async () => {
  const app = await fixture();
  try {
    await app.post("verify", { token: app.link().hash.slice(8) });
    await app.post("recover", { email: app.email }); await app.accounts.close();
    const url = app.link(), page = await app.page(url);
    assert.equal(page.location.hash, "");
    assert.match(page.content.html, /Guardar contraseña/);
    assert.match(page.content.html, /autocomplete="new-password" minlength="12" maxlength="128" required/);
    const next = "synthetic-updated-password-123";
    await page.submit({ password: next });
    assert.match(page.status.textContent, /Contraseña actualizada/);
    assert.match(page.content.html, /autocomplete="current-password"/);
    await page.submit({ email: app.email, password: next });
    assert.match(page.status.textContent, /Sesión iniciada/);
    assert.equal((await app.post("login", { email: app.email, password })).status, 401);
    const reused = await app.page(url);
    await reused.submit({ password: "another-synthetic-password-123" });
    assert.match(reused.status.textContent, /El enlace no es válido o ha vencido/);
    assert.equal(reused.status.dataset.kind, "error");
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  } finally { await app.close(); }
});
