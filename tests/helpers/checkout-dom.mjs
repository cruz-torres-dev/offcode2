import { readFile } from "node:fs/promises";
import vm from "node:vm";

class Element {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.events = {}; this.attrs = {}; this.value = ""; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = ""; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attrs[name] = value; }
  addEventListener(name, fn) { (this.events[name] ??= []).push(fn); }
  emit(name, target) { for (const fn of this.events[name] || []) fn({ target, preventDefault() {} }); }
  reportValidity() { return true; }
  focus() { this.focused = true; }
}
export async function checkoutDom(config, { bag = [{ size: "M", qty: 1 }], fetcher, now = Date.now() } = {}) {
  const html = await readFile(new URL("../../dist/checkout.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../../dist/checkout.js", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(([, tag, attrs, id]) => {
    const node = new Element(tag); node.hidden = /\bhidden\b/.test(attrs); node.disabled = /\bdisabled\b/.test(attrs);
    node.href = attrs.match(/\bhref="([^"]*)"/)?.[1] || "";
    return ["#" + id, node];
  }));
  const fields = Object.fromEntries(["name", "phone", "email", "street", "neighborhood", "postalCode", "city", "state", "notes", "consent"].map((name) => [name, Object.assign(new Element("input"), { name })]));
  Object.assign(nodes.get("#payment-transfer"), { checked: true, value: "bank_transfer" });
  nodes.get("#order-form").elements = { namedItem: (name) => fields[name] };
  nodes.get("#state-text").replaceWith = (node) => { fields.state = node; };
  const storage = new Map([["offcode-bag", JSON.stringify(bag)]]), requests = [], timers = new Map();
  let clock = now, timerId = 0;
  const descendants = (node) => node.children.flatMap((child) => typeof child === "object" ? [child, ...descendants(child)] : []);
  const document = { querySelector: (selector) => nodes.get(selector), createElement: (tag) => new Element(tag),
    querySelectorAll: (selector) => selector.includes("summary-editors") ? descendants(nodes.get("#order-items")).filter((node) => node.tag === "input" || (selector.includes("select") && node.tag === "select")) : [],
  };
  const pending = [];
  const context = vm.createContext({ document, URL, window: { addEventListener() {} }, location: { reload() {} },
    Option: class extends Element { constructor(text, value) { super("option"); this.textContent = text; this.value = value; } },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    crypto: { randomUUID: () => "12345678-1234-4234-8234-123456789abc" },
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, until: clock + delay }); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (route, options) => {
      requests.push({ route, ...(options ? { body: JSON.parse(options.body) } : {}) });
      const operation = (async () => route === "/api/config" ? { ok: true, json: async () => config }
        : route === "/api/shipping/states" ? { ok: true, json: async () => ({ states: [{ name: "Guanajuato", code: "GT" }] }) }
          : fetcher(route, options))();
      pending.push(operation); return operation;
    },
  });
  const flush = async () => { for (let i = 0; i < 5; i++) { await Promise.all(pending); await new Promise((resolve) => setImmediate(resolve)); } };
  vm.runInContext(source, context); await flush();
  return { nodes, fields, storage, requests, flush, descendants,
    advance(ms) { clock += ms; for (const [id, timer] of [...timers]) if (timer.until <= clock) { timers.delete(id); timer.fn(); } },
  };
}
