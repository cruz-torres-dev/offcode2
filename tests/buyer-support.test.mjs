import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buyerMessage, createBuyerSupport, whatsappLink } from "../dist/order-support.js";
import { createApp } from "../server/server.mjs";

const id = "OF-123456ABCDEF";
const bank = { name: "Banco sintético", beneficiary: "Titular sintético", clabe: "000000000000000000" };
const order = { id, customer: { phone: "525500001111" }, items: [{ name: "Hoodie", size: "M", qty: 1 }],
  subtotalCents: 165000, shippingCents: 18520, totalCents: 183520, transferAccount: bank };

test("Atención: cada etapa comunica su estado sin pedir nuevos pagos ni anticipar un envío", () => {
  const requested = buyerMessage({ ...order, status: "requested" });
  assert.match(requested.body, /No transfieras todavía/); assert.ok(!requested.body.includes(bank.clabe));
  const transfer = buyerMessage({ ...order, status: "awaiting_transfer" }, { ...bank, clabe: "111111111111111111" });
  assert.ok(transfer.body.includes(bank.clabe)); assert.ok(!transfer.body.includes("111111111111111111"));
  assert.match(transfer.body, /1,835\.20/); assert.ok(transfer.body.includes(id));
  assert.equal(buyerMessage({ ...order, status: "awaiting_transfer", totalCents: null }), null);
  const paid = buyerMessage({ ...order, status: "paid", labelJob: { state: "generated" }, tracking: "123456789012" });
  assert.match(paid.body, /está preparando/); assert.doesNotMatch(paid.body, /fedextrack|123456789012|CLABE/);
  assert.equal(buyerMessage({ ...order, status: "shipped" }), null);
  const shipped = buyerMessage({ ...order, status: "shipped", tracking: "123456789012" });
  assert.match(shipped.body, /entregó tu paquete a FedEx/);
  assert.match(shipped.body, /https:\/\/www\.fedex\.com\/fedextrack\/\?trknbr=123456789012/);
  const delivered = buyerMessage({ ...order, status: "delivered", tracking: "123456789012" });
  assert.match(delivered.body, /Registramos la entrega/); assert.doesNotMatch(delivered.body, /fue enviado/);
  assert.match(buyerMessage({ ...order, status: "cancelled" }).body, /no confirma ni realiza un reembolso/);
  assert.equal(buyerMessage({ ...order, status: "unknown" }), null);
});

class Node {
  constructor() { this.children = []; this.events = {}; this.value = ""; this.hidden = false; }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { this.events[name] = fn; }
  focus() { this.focused = true; }
  select() { this.selected = true; }
}
const documentDouble = { createElement(tag) { return Object.assign(new Node(), { tag }); } };

test("WhatsApp y copiar preparan mensajes sin solicitudes de red ni cambios del pedido", async () => {
  const copied = [], original = { ...order, status: "paid" }, snapshot = JSON.stringify(original);
  const details = createBuyerSupport(original, bank, { document: documentDouble, clipboard: { writeText: async (body) => copied.push(body) } });
  const [, , preview, actions, note, status] = details.children;
  assert.equal(preview.readOnly, true);
  const [button, link] = actions.children;
  const url = new URL(link.href);
  assert.equal(url.origin, "https://wa.me"); assert.equal(url.pathname, "/525500001111");
  assert.equal(url.searchParams.get("text"), preview.value);
  assert.match(note.textContent, /no envía ningún mensaje ni cambia el estado/);
  await button.onclick();
  assert.deepEqual(copied, [preview.value]); assert.match(status.textContent, /copiado/);
  assert.equal(JSON.stringify(original), snapshot);
  const fallback = createBuyerSupport({ ...original, customer: { phone: "javascript:alert(1)" } }, bank,
    { document: documentDouble, clipboard: { writeText: async () => { throw Error("denied"); } } });
  assert.equal(fallback.children[3].children.length, 1, "no hay enlace con un destinatario inválido");
  await fallback.children[3].children[0].onclick();
  assert.equal(fallback.children[2].selected, true); assert.match(fallback.children[5].textContent, /Cópialo/);
  assert.equal(whatsappLink("525500001111\nBcc:evil", "mensaje"), "");
});

test("Contacto ofrece ambos canales y conserva la referencia al preparar WhatsApp o enviar correo", async () => {
  const source = (await readFile(new URL("../dist/contact.js", import.meta.url), "utf8")).replace(/^import[^;]+;\s*/, "");
  for (const emailEnabled of [false, true]) {
    const nodes = new Map(["contact-form", "contact-status", "contact-whatsapp-section", "contact-whatsapp", "contact-order-context", "contact-email-status"].map((name) => ["#" + name, new Node()]));
    const reference = new Node(), button = new Node(), form = nodes.get("#contact-form");
    form.elements = { namedItem: () => reference, consent: { checked: true } };
    form.querySelector = () => button; form.reset = () => { reference.value = ""; };
    const requests = [];
    await vm.runInNewContext(source, {
      URL, location: { href: `https://shop.example.test/contacto.html?pedido=${id}` },
      document: { querySelector: (selector) => nodes.get(selector) }, whatsappLink,
      FormData: class { *[Symbol.iterator]() { yield ["email", "buyer@example.test"]; yield ["message", "Necesito ayuda con mi pedido"]; } },
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => url === "/api/config"
          ? { enabled: false, whatsapp: "", support: { whatsapp: "525500001111", emailEnabled } }
          : { message: "El proveedor aceptó tu mensaje." } };
      },
    });
    assert.equal(form.hidden, !emailEnabled); assert.equal(reference.value, id);
    assert.equal(nodes.get("#contact-whatsapp-section").hidden, false, "el soporte permanece disponible con ventas cerradas");
    let link = new URL(nodes.get("#contact-whatsapp").href);
    assert.match(link.searchParams.get("text"), new RegExp(id));
    assert.equal(requests.length, 1, "cargar Contacto no envía correos ni mensajes");
    reference.value = "OF-ABCDEF123456"; reference.events.input();
    link = new URL(nodes.get("#contact-whatsapp").href);
    assert.match(link.searchParams.get("text"), /OF-ABCDEF123456/);
    if (emailEnabled) {
      await form.onsubmit({ preventDefault() {} });
      assert.equal(requests.length, 2);
      assert.equal(JSON.parse(requests[1].options.body).orderId, "OF-ABCDEF123456");
      assert.equal(reference.value, "OF-ABCDEF123456");
      assert.match(nodes.get("#contact-status").textContent, /proveedor aceptó/);
    }
  }
});

test("Contacto: referencia explícita en correo, validación, autorización y configuración pública sin secretos", async () => {
  const origin = "https://shop.example.test", messages = [];
  const privateKey = "synthetic-contact-private-key";
  const app = await createApp({ origin, databasePath: ":memory:", enabled: false, whatsapp: "525500001111",
    email: { env: {}, autoStart: false, logger: () => {} },
    customers: { env: { EMAIL_ENABLED: "true", EMAIL_FROM: "store@example.test", ORDER_NOTIFICATION_EMAIL: "owner@example.test", RESEND_API_KEY: privateKey },
      fetcher: async (_, options) => { messages.push(JSON.parse(options.body)); return Response.json({ id: "12345678-1234-4234-8234-123456789abc" }); }, logger: () => {} } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  const post = (data, requestOrigin = origin) => fetch(base + "/api/contact", { method: "POST", headers: { Origin: requestOrigin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  try {
    const configResponse = await fetch(base + "/api/config"), config = await configResponse.json();
    assert.equal(configResponse.headers.get("cache-control"), "no-store");
    assert.equal(config.enabled, false); assert.equal(config.whatsapp, "");
    assert.deepEqual(config.support, { whatsapp: "525500001111", emailEnabled: true });
    assert.doesNotMatch(JSON.stringify(config), /synthetic-contact-private-key|owner@example|store@example/);
    const input = { email: "buyer@example.test", message: "<script>Consulta sobre mi pedido</script>", consent: true, orderId: id.toLowerCase() };
    assert.equal((await post(input, "https://other.test")).status, 403);
    assert.equal((await post({ ...input, consent: false })).status, 400);
    assert.equal((await post({ ...input, orderId: "OF-1\r\nBcc:evil" })).status, 400);
    assert.equal(messages.length, 0);
    assert.equal((await post(input)).status, 200);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].subject.endsWith(id)); assert.match(messages[0].text, new RegExp(`Referencia del pedido: ${id}`));
    assert.equal(messages[0].reply_to, input.email); assert.doesNotMatch(messages[0].html, /<script>/);
    assert.equal((await app.db.get("SELECT COUNT(*) AS n FROM orders")).n, 0);
  } finally { await app.close(); }
});
