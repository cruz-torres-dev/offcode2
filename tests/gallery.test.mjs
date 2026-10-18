// Exercises the actual controller with a small DOM/event double, without email or production.
// Layout and native dialog behavior are verified separately in Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const code = await readFile(new URL("../dist/gallery.js", import.meta.url), "utf8");
class Element {
  constructor() {
    this.children = []; this.attrs = {}; this.events = {}; this.dataset = {}; this.textContent = "";
    this.scrollLeft = this.scrollTop = 0; this.clientWidth = this.clientHeight = 500;
    const classes = new Set();
    this.classList = { add: (k) => classes.add(k), remove: (k) => classes.delete(k), toggle: (k, value) => value ? classes.add(k) : classes.delete(k) };
    this.style = { setProperty: (k, v) => { this.attrs[k] = v; } };
  }
  get scrollWidth() { return 500 * (this.attrs["--photo-scale"] || 1); }
  get scrollHeight() { return this.scrollWidth; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; delete this[k]; }
  addEventListener(k, fn) { (this.events[k] ??= []).push(fn); }
  emit(type, args = {}) { const event = { type, target: this, button: 0, preventDefault() {}, ...args }; for (const fn of this.events[type] || []) fn(event); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(s) { return this.parts?.[s] || this.children.find((x) => x.tag === s); }
  querySelectorAll(s) { return this.children.filter((x) => x.tag === s); }
  focus() { this.document.activeElement = this; }
  setPointerCapture() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.emit("close"); }
}
async function fixture() {
  const ids = ["product-modal", "zoom-viewport", "zoom-image", "gallery-main", "product-open", "viewer-thumbs", "viewer-position", "photo-label", "photo-prev", "photo-next", "viewer-prev", "viewer-next"];
  const elements = Object.fromEntries(ids.map((id) => ["#" + id, new Element()]));
  elements[".gallery-thumbs"] = new Element();
  const doc = new Element(); doc.documentElement = new Element();
  doc.querySelector = (s) => elements[s];
  doc.createElement = (tag) => { const el = new Element(); el.tag = tag; el.document = doc; return el; };
  for (const e of Object.values(elements)) e.document = doc;
  elements["#product-modal"].parts = { h2: new Element(), ".close": doc.createElement("button") };
  const manifest = JSON.parse(await readFile(new URL("../dist/assets/product-media.json", import.meta.url)));
  const win = { scrollY: 456, scrollTo: ({ top }) => { win.scrollY = top; } };
  vm.runInNewContext(code, { document: doc, window: win, fetch: async () => ({ ok: true, json: async () => manifest }) });
  await new Promise((r) => setImmediate(r));
  const product = (images) => doc.emit("offcode:product", { detail: { name: "Prenda", images } });
  return { elements, doc, win, product, manifest };
}
test("Galería dinámica: seis vistas, selección sin recarga y alta resolución solo al abrir", async () => {
  const { elements: e, product, manifest, doc, win } = await fixture();
  const images = Array.from({ length: 6 }, (_, i) => ({ src: i % 2 ? "assets/product-back.jpg" : "assets/product-front.jpg", alt: `Vista ${i}` }));
  product(images);
  assert.equal(e[".gallery-thumbs"].children.length, 6);
  assert.equal(e["#viewer-thumbs"].children.length, 6);
  assert.equal(e["#zoom-image"].src, undefined);
  e[".gallery-thumbs"].children[5].onclick();
  assert.equal(e["#gallery-main"].src, manifest[images[5].src].main);
  assert.equal(e[".gallery-thumbs"].children[5].getAttribute("aria-pressed"), "true");
  e["#product-open"].onclick();
  assert.equal(e["#zoom-image"].src, manifest[images[5].src].large);
  assert.equal(doc.activeElement, e["#product-modal"].parts[".close"]);
  e["#product-modal"].close();
  assert.equal(doc.activeElement, e["#product-open"]); assert.equal(win.scrollY, 456);
  assert.equal(e["#gallery-main"].alt, "Vista 5");
  product([]); assert.equal(e["#product-open"].disabled, true);
  product([{ src: "https://external.test/photo.jpg" }]); assert.equal(e[".gallery-thumbs"].children.length, 0);
});
test("Visor: teclado, zoom 2×, arrastre y vuelta a 1×", async () => {
  const { elements: e, product } = await fixture();
  product([{ src: "assets/product-front.jpg", alt: "Frente" }, { src: "assets/product-back.jpg", alt: "Espalda" }]);
  e["#product-open"].onclick(); const v = e["#zoom-viewport"], modal = e["#product-modal"];
  modal.emit("keydown", { key: "ArrowRight" }); assert.equal(e["#zoom-image"].alt, "Espalda");
  modal.emit("keydown", { key: "+" }); assert.equal(v.attrs["--photo-scale"], 2);
  v.emit("pointerdown", { pointerId: 1, clientX: 200, clientY: 200 });
  v.emit("pointermove", { pointerId: 1, clientX: 100, clientY: 120 });
  assert.equal(v.scrollLeft, 350); assert.equal(v.scrollTop, 330);
  v.emit("pointerup", { pointerId: 1, clientX: 100, clientY: 120 });
  v.emit("click"); assert.equal(v.attrs["--photo-scale"], 2, "arrastre no activa el clic de zoom");
  modal.emit("keydown", { key: "ArrowRight", target: v, shiftKey: true }); assert.equal(v.scrollLeft, 420);
  modal.emit("keydown", { key: "0" }); assert.equal(v.attrs["--photo-scale"], 1);
  v.emit("click"); assert.equal(v.getAttribute("aria-pressed"), "true");
  e["#product-modal"].emit("keydown", { key: "0" }); assert.equal(v.attrs["--photo-scale"], 1);
});
test("Gestos simulados: swipe cambia fotografía, pinch amplía y cancelar no cambia selección", async () => {
  const { elements: e, product } = await fixture();
  product([{ src: "assets/product-front.jpg", alt: "Frente" }, { src: "assets/product-back.jpg", alt: "Espalda" }]);
  e["#product-open"].onclick(); const v = e["#zoom-viewport"];
  const pointer = (type, id, x, y = 100) => v.emit(type, { pointerId: id, pointerType: "touch", clientX: x, clientY: y });
  pointer("pointerdown", 1, 200); pointer("pointermove", 1, 90); pointer("pointerup", 1, 90);
  assert.equal(e["#zoom-image"].alt, "Espalda");
  pointer("pointerdown", 1, 100); pointer("pointerdown", 2, 200); pointer("pointermove", 2, 300);
  assert.equal(v.attrs["--photo-scale"], 2);
  pointer("pointerup", 2, 300); pointer("pointerup", 1, 100);
  e["#product-modal"].emit("keydown", { key: "0" });
  pointer("pointerdown", 1, 200); pointer("pointermove", 1, 90); pointer("pointercancel", 1, 90);
  assert.equal(e["#zoom-image"].alt, "Espalda");
});


test("Regresión del visor: miniaturas y contador sincronizados, navegación circular y una sola vista", async () => {
  const { elements: e, product } = await fixture();
  const images = Array.from({ length: 6 }, (_, i) => ({ src: `assets/test-${i}.jpg`, alt: `Vista ${i + 1}` }));
  product(images);
  e["#photo-next"].onclick(); assert.equal(e["#gallery-main"].alt, "Vista 2");
  e["#photo-prev"].onclick(); assert.equal(e["#gallery-main"].alt, "Vista 1");
  e["#product-open"].onclick();
  for (let i = 0; i < images.length; i++) {
    e["#viewer-thumbs"].children[i].onclick();
    assert.equal(e["#zoom-image"].alt, images[i].alt);
    assert.match(e["#viewer-position"].textContent, new RegExp(`^${i + 1} / 6`));
    for (const host of [e["#viewer-thumbs"], e[".gallery-thumbs"]])
      host.children.forEach((button, n) => assert.equal(button.getAttribute("aria-pressed"), String(n === i)));
    e["#viewer-next"].onclick(); assert.equal(e["#zoom-image"].alt, images[(i + 1) % 6].alt);
    e["#viewer-prev"].onclick(); assert.equal(e["#zoom-image"].alt, images[i].alt);
  }
  const v = e["#zoom-viewport"], modal = e["#product-modal"];
  modal.emit("keydown", { key: "Enter", target: v }); assert.equal(v.attrs["--photo-scale"], 2);
  modal.emit("keydown", { key: " ", target: v }); assert.equal(v.attrs["--photo-scale"], 1);
  v.emit("click", { clientX: 100, clientY: 150, detail: 1 });
  assert.equal(v.scrollLeft, 100); assert.equal(v.scrollTop, 150);
  modal.emit("keydown", { key: "ArrowRight", target: v });
  assert.equal(e["#zoom-image"].alt, "Vista 1", "flecha normal navega incluso después de ampliar");
  assert.equal(v.attrs["--photo-scale"], 1);
  modal.emit("keydown", { key: "ArrowLeft", target: { tagName: "INPUT" } });
  modal.emit("keydown", { key: "ArrowLeft", target: v, altKey: true });
  assert.equal(e["#zoom-image"].alt, "Vista 1", "respeta edición y navegación del navegador");
  product([images[0]]);
  assert.equal(e["#viewer-prev"].disabled, true); assert.equal(e["#viewer-next"].disabled, true);
});

test("Marcado público: sin barra superior de zoom y footer definitivo incluso con pedidos habilitados", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../dist/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /id="zoom-toggle"|class="zoom-toolbar"|Acercar 2/);
  assert.doesNotMatch(html + app, /Concepto web de demostración/);
  assert.match(html, /OFFCODE™ · Hecho para salir del código\./);
  assert.match(app, /footer-mode.*OFFCODE™ · Hecho para salir del código\./);
});
