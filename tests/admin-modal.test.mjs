// Exercises the real dialog-close controller with a small DOM/event double.
// Native <dialog> behavior (Escape, focus and scroll restoration) is a browser
// guarantee this suite only checks is not intercepted; it is verified in Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { wireDialogClose } from "../dist/dialog-close.js";

class Element {
  constructor(tag) {
    this.tag = tag;
    this.classes = new Set();
    this.dataset = {};
    this.children = [];
    this.parent = null;
    this.events = {};
    this.open = false;
    this.rect = { left: 100, top: 100, right: 500, bottom: 400 };
  }
  set className(value) {
    for (const name of String(value).split(/\s+/).filter(Boolean))
      this.classes.add(name);
  }
  get className() {
    return [...this.classes].join(" ");
  }
  get classList() {
    return {
      add: (name) => this.classes.add(name),
      contains: (name) => this.classes.has(name),
    };
  }
  append(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  addEventListener(type, handler) {
    (this.events[type] ??= []).push(handler);
  }
  emit(type, event = {}) {
    for (const handler of this.events[type] ?? []) handler(event);
    if (this.parent) this.parent.emit(type, event);
    return event;
  }
  matches(selector) {
    if (selector === this.tag) return true;
    if (selector.startsWith(".")) return this.classes.has(selector.slice(1));
    return false;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parent;
    }
    return null;
  }
  getBoundingClientRect() {
    return this.rect;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.emit("close", { target: this });
  }
}

function scene() {
  const doc = new Element("#document");
  const productDialog = doc.append(new Element("dialog"));
  const movementDialog = doc.append(new Element("dialog"));
  productDialog.id = "product-dialog";
  movementDialog.id = "movement-dialog";
  const productClose = productDialog.append(new Element("button"));
  const movementClose = movementDialog.append(new Element("button"));
  productClose.className = "close";
  movementClose.className = "close";
  const field = movementDialog.append(new Element("input"));
  const submit = movementDialog.append(new Element("button"));
  submit.className = "primary";
  doc.querySelectorAll = (selector) =>
    selector === "dialog" ? [productDialog, movementDialog] : [];
  return { doc, productDialog, movementDialog, productClose, movementClose, field, submit };
}

const click = (target, event) => target.emit("click", { target, ...event });

test("La X del modal de Inventario lo cierra", () => {
  const s = scene();
  wireDialogClose(s.doc);
  s.movementDialog.showModal();
  assert.equal(s.movementDialog.open, true);
  click(s.movementClose);
  assert.equal(s.movementDialog.open, false);
});

test("La X del modal de producto también lo cierra", () => {
  const s = scene();
  wireDialogClose(s.doc);
  s.productDialog.showModal();
  click(s.productClose);
  assert.equal(s.productDialog.open, false);
});

test("El fondo exterior cierra, pero el contenido y los campos no", () => {
  const s = scene();
  wireDialogClose(s.doc);
  s.movementDialog.showModal();
  // Clic dentro del recuadro del diálogo: no cierra.
  click(s.movementDialog, { clientX: 200, clientY: 200 });
  assert.equal(s.movementDialog.open, true);
  // Clic en un campo del formulario: no cierra.
  click(s.field);
  assert.equal(s.movementDialog.open, true);
  // Clic en el fondo exterior: cierra solo al pulsar fuera del recuadro.
  click(s.movementDialog, { clientX: 5, clientY: 5 });
  assert.equal(s.movementDialog.open, false);
});

test("Escape queda a cargo del <dialog> nativo y no se intercepta", () => {
  const s = scene();
  wireDialogClose(s.doc);
  s.movementDialog.showModal();
  assert.equal(s.movementDialog.events.cancel, undefined);
  assert.equal(s.movementDialog.events.keydown, undefined);
  assert.equal(s.doc.events.cancel, undefined);
  let prevented = false;
  s.movementDialog.emit("cancel", {
    target: s.movementDialog,
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
});

test("Se puede abrir y cerrar repetidamente sin acumular listeners", () => {
  const s = scene();
  wireDialogClose(s.doc);
  const wired = s.doc.events.click.length;
  wireDialogClose(s.doc);
  assert.equal(s.doc.events.click.length, wired);
  for (let i = 0; i < 3; i++) {
    s.movementDialog.showModal();
    click(s.movementClose);
    assert.equal(s.movementDialog.open, false);
  }
});

test("El panel conserva la accesibilidad y el registro de movimientos intactos", async () => {
  const html = await readFile(new URL("../dist/admin.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../dist/admin.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../dist/admin.css", import.meta.url), "utf8");
  const source = await readFile(new URL("../dist/dialog-close.js", import.meta.url), "utf8");
  assert.match(html, /<dialog id="movement-dialog"/);
  assert.match(
    html,
    /<button type="button" class="close" aria-label="Cerrar inventario">✕<\/button>/,
  );
  assert.match(
    html,
    /<button type="button" class="close" aria-label="Cerrar producto">✕<\/button>/,
  );
  assert.match(html, /<script type="module" src="dialog-close\.js"><\/script>/);
  assert.match(html, /<form id="movement-form"/);
  assert.match(html, /<button type="submit" class="primary">Registrar movimiento<\/button>/);
  assert.match(js, /\$\("#movement-form"\)\.onsubmit/);
  assert.match(js, /\/api\/admin\/inventory\/\$\{movementVariant\.id\}\/movements/);
  assert.match(css, /dialog \.close \{[^}]*min-height: 44px[^}]*\}/);
  // Closing the dialog must not save, cancel or record any stock movement.
  assert.doesNotMatch(source, /fetch\(|\/api\/|movement|threshold/);
});
