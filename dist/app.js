const $ = (s) => document.querySelector(s);
// Replaced by the server price as soon as /api/config responds.
let unitPrice = 1650;
const money = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    n,
  ) + " MXN";
let ordersEnabled = false;
let size = "M",
  cart = [];
// Mirrors server/catalog.mjs. The server payload replaces this when available.
const FALLBACK_SALE_SIZES = ["S", "M", "L", "XL"];
const cartDialog = $("#cart");
// variantId by size, so the bag can name the exact variant it is buying.
let variantsBySize = new Map();
let productId = null;

// Sizes and measurements come from the server so the guide cannot drift from
// what the order endpoint actually accepts. Static markup stays usable without JS.
function applyProduct(product) {
  if (!product || !Array.isArray(product.sizes) || !product.sizes.length) return;
  const saleSizes = Array.isArray(product.saleSizes) && product.saleSizes.length
    ? product.saleSizes
    : product.sizes.filter((s) => s.available).map((s) => s.code);
  const byCode = new Map(product.sizes.map((item) => [item.code, item]));
  productId = product.id ?? null;
  variantsBySize = new Map(
    product.sizes
      .filter((item) => item.variantId)
      .map((item) => [item.code, item.variantId]),
  );
  const buttons = [...document.querySelectorAll("[data-size]")];
  const soldOutSizes = [];
  for (const button of buttons) {
    const code = button.dataset.size;
    const item = byCode.get(code);
    // A size without a variant is not offered; a sold-out variant stays
    // visible but disabled, so nobody thinks it was removed by mistake.
    const offered = item ? item.variantId !== null : saleSizes.includes(code);
    const soldOut = Boolean(item?.soldOut);
    if (soldOut) soldOutSizes.push(code);
    button.hidden = !offered;
    button.disabled = !offered || soldOut;
    button.classList.toggle("is-sold-out", soldOut);
    button.setAttribute("aria-disabled", String(button.disabled));
    button.setAttribute("aria-label", soldOut ? `${code}, agotado` : code);
    if (soldOut) button.title = "Talla agotada";
  }
  const soldOutNote = $("#sold-out-note");
  if (soldOutNote) {
    soldOutNote.hidden = !soldOutSizes.length;
    soldOutNote.textContent = soldOutSizes.length
      ? `Agotado por ahora: ${soldOutSizes.join(", ")}. Escríbenos para avisarte cuando vuelva.`
      : "";
  }
  if (!saleSizes.includes(size) && saleSizes.length) {
    const next = saleSizes.includes("M") ? "M" : saleSizes[0];
    size = next;
    for (const button of buttons) {
      const active = button.dataset.size === next;
      button.classList.toggle("selected", active);
      button.setAttribute("aria-pressed", String(active));
    }
  }
  const rows = new Map(
    [...document.querySelectorAll("[data-guide-size]")].map((row) => [
      row.dataset.guideSize,
      row,
    ]),
  );
  for (const item of product.sizes) {
    const row = rows.get(item.code);
    if (!row) continue;
    const cell = row.querySelector("[data-guide-status]");
    if (!cell) continue;
    cell.textContent = item.soldOut
      ? "Agotado"
      : item.available
        ? "Disponible"
        : "Por confirmar";
    cell.classList.toggle("is-available", Boolean(item.available));
  }
  const fields = product.measurements?.fields ?? [];
  const values = product.measurements?.rows ?? {};
  const codes = product.sizes.map((s) => s.code).filter((code) => values[code]);
  const host = $("#guide-measures-table");
  const note = $("#guide-measures-note");
  if (!host || !note) return;
  if (!codes.length || !fields.length) return;
  const table = document.createElement("table");
  table.className = "guide-table";
  const caption = document.createElement("caption");
  caption.textContent = `Medidas verificadas (${product.measurements.unit})`;
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(document.createElement("th"));
  headRow.firstChild.scope = "col";
  headRow.firstChild.textContent = "Talla";
  for (const field of fields) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = field.label;
    headRow.append(th);
  }
  head.append(headRow);
  const tbody = document.createElement("tbody");
  for (const code of codes) {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = code;
    tr.append(th);
    for (const field of fields) {
      const td = document.createElement("td");
      const value = values[code]?.[field.key];
      td.textContent = Number.isFinite(value) ? String(value) : "—";
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(caption, head, tbody);
  host.replaceChildren(table);
  host.hidden = false;
  note.hidden = true;
}

document.querySelectorAll("[data-size]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.disabled) return;
    size = b.dataset.size;
    document.querySelectorAll("[data-size]").forEach((x) => {
      x.classList.toggle("selected", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
  }),
);
$("#size-guide-open").onclick = () => $("#size-guide").showModal();
function renderCart() {
  const itemCount = cart.reduce((n, p) => n + p.qty, 0);
  $("#count").textContent = String(itemCount);
  $("#bag").setAttribute("aria-label",
    `Abrir bolsa de compra, ${itemCount} ${itemCount === 1 ? "artículo" : "artículos"}`);
  const items = $("#cart-items");
  items.replaceChildren();
  if (!cart.length) {
    const p = document.createElement("p");
    p.textContent = "Tu bolsa está vacía. Explora la colección.";
    items.append(p);
  }
  cart.forEach((p) => {
    const row = document.createElement("div");
    row.className = "cart-row";
    const text = document.createElement("p");
    text.textContent = `LA AFRO × OFFCODE — Talla ${p.size} · Cantidad: ${p.qty} · ${money(p.qty * unitPrice)}`;
    const remove = document.createElement("button");
    remove.textContent = "Quitar";
    remove.setAttribute("aria-label", `Quitar talla ${p.size}`);
    remove.onclick = () => {
      cart = cart.filter((x) => x.size !== p.size);
      $("#checkout-message").textContent = "";
      renderCart();
    };
    row.append(text, remove);
    items.append(row);
  });
  $("#cart-total").textContent =
    "Subtotal: " + money(cart.reduce((n, p) => n + p.qty * unitPrice, 0));
  $("#checkout").disabled = !cart.length;
  if (ordersEnabled) {
    try {
      sessionStorage.setItem("offcode-bag", JSON.stringify(cart));
    } catch {}
  }
}
let toastTimer;
function toast(message, ms = 2500) {
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), ms);
}
$("#add").onclick = () => {
  const button = document.querySelector(`[data-size="${size}"]`);
  if (button && (button.disabled || button.hidden)) {
    toast(`La talla ${size} está agotada. Elige otra talla disponible.`, 3000);
    return;
  }
  const item = cart.find((p) => p.size === size);
  const qty = readQty();
  if (cart.reduce((sum, p) => sum + p.qty, 0) + qty > 99) {
    toast("Máximo 99 prendas por solicitud.", 3000);
    return;
  }
  if (item) item.qty += qty;
  else
    cart.push({
      size,
      qty,
      ...(productId ? { productId } : {}),
      ...(variantsBySize.get(size) ? { variantId: variantsBySize.get(size) } : {}),
    });
  $("#checkout-message").textContent = "";
  renderCart();
  toast(`${qty} × LA AFRO × OFFCODE, talla ${size}, agregada a la bolsa`);
};
$("#bag").onclick = () => {
  renderCart();
  cartDialog.showModal();
};
const zoomViewport = $("#zoom-viewport");
const zoomToggle = $("#zoom-toggle");
let zoomed = false;
let zoomDrag = null;
function setProductZoom(enabled) {
  zoomed = enabled;
  zoomViewport.classList.toggle("is-zoomed", enabled);
  zoomToggle.setAttribute("aria-pressed", String(enabled));
  zoomToggle.setAttribute("aria-label", enabled ? "Restablecer fotografía" : "Acercar fotografía al doble");
  zoomToggle.querySelector("span").textContent = enabled ? "Restablecer 1×" : "Acercar 2×";
  $("#zoom-help").textContent = enabled ? "Arrastra o desliza para recorrer la foto. Con teclado, enfoca la imagen y usa las flechas." : "Acerca la foto para ver los detalles.";
  zoomViewport.scrollLeft = enabled ? (zoomViewport.scrollWidth - zoomViewport.clientWidth) / 2 : 0;
  zoomViewport.scrollTop = enabled ? (zoomViewport.scrollHeight - zoomViewport.clientHeight) / 2 : 0;
}
zoomToggle.onclick = () => setProductZoom(!zoomed);
zoomViewport.addEventListener("pointerdown", (event) => {
  if (!zoomed || event.pointerType !== "mouse" || event.button !== 0) return;
  zoomDrag = { x: event.clientX, y: event.clientY, left: zoomViewport.scrollLeft, top: zoomViewport.scrollTop };
  zoomViewport.setPointerCapture(event.pointerId);
  zoomViewport.classList.add("is-dragging");
  zoomViewport.focus({ preventScroll: true });
  event.preventDefault();
});
zoomViewport.addEventListener("pointermove", (event) => {
  if (!zoomDrag) return;
  zoomViewport.scrollLeft = zoomDrag.left + zoomDrag.x - event.clientX;
  zoomViewport.scrollTop = zoomDrag.top + zoomDrag.y - event.clientY;
});
function endZoomDrag() { zoomDrag = null; zoomViewport.classList.remove("is-dragging"); }
zoomViewport.addEventListener("pointerup", endZoomDrag);
zoomViewport.addEventListener("pointercancel", endZoomDrag);
zoomViewport.addEventListener("lostpointercapture", endZoomDrag);
$("#product-modal").addEventListener("close", () => {
  endZoomDrag();
  setProductZoom(false);
  $("#product-open").focus({ preventScroll: true });
});
$("#product-open").onclick = () => {
  const p = photos[photoIndex];
  $("#zoom-image").src = p.src;
  $("#zoom-image").alt = p.alt;
  $("#product-modal").showModal();
  setProductZoom(false);
};
document.querySelectorAll("dialog").forEach((d) => {
  d.querySelector(".close").onclick = () => d.close();
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  });
});
$("#checkout").onclick = () => {
  if (ordersEnabled && cart.length) {
    try {
      sessionStorage.setItem("offcode-bag", JSON.stringify(cart));
      sessionStorage.removeItem("offcode-request-key");
      location.href = "checkout.html";
    } catch {
      $("#checkout-message").textContent =
        "Permite el almacenamiento de sesión del navegador para continuar con tu selección.";
    }
    return;
  }
  $("#checkout-message").textContent =
    "Prueba completada. No se creó ningún pedido ni se realizó ningún cobro. Para vender falta habilitar los pedidos por transferencia y configurar la cuenta de Envia.";
};
renderCart();

const photos = [
  {
    src: "assets/product-front.jpg",
    label: "FRENTE",
    alt: "Frente de la sudadera LA AFRO × OFFCODE",
  },
  {
    src: "assets/product-back.jpg",
    label: "ESPALDA",
    alt: "Espalda de la sudadera LA AFRO × OFFCODE",
  },
  {
    src: "assets/product-detail.jpg",
    label: "DETALLE",
    alt: "Detalle de los gráficos y capucha de la sudadera",
  },
];
let photoIndex = 0;
function showPhoto(i) {
  photoIndex = (i + photos.length) % photos.length;
  const p = photos[photoIndex];
  $("#gallery-main").src = p.src;
  $("#gallery-main").alt = p.alt;
  $("#photo-label").textContent =
    String(photoIndex + 1).padStart(2, "0") + " / " + p.label;
  $("#product-open").setAttribute(
    "aria-label",
    "Ampliar fotografía del producto: " + p.label.toLowerCase(),
  );
  document.querySelectorAll("[data-photo]").forEach((b) => {
    const active = Number(b.dataset.photo) === photoIndex;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", String(active));
  });
}
document
  .querySelectorAll("[data-photo]")
  .forEach((b) => (b.onclick = () => showPhoto(Number(b.dataset.photo))));
$("#photo-prev").onclick = () => showPhoto(photoIndex - 1);
$("#photo-next").onclick = () => showPhoto(photoIndex + 1);
function readQty() {
  const n = Number($("#quantity").value);
  const q = Number.isFinite(n) ? Math.max(1, Math.min(99, Math.floor(n))) : 1;
  $("#quantity").value = q;
  return q;
}
$("#quantity").onchange = readQty;
$("#qty-minus").onclick = () => {
  $("#quantity").value = Math.max(1, readQty() - 1);
};
$("#qty-plus").onclick = () => {
  $("#quantity").value = Math.min(99, readQty() + 1);
};

const menuButton = $("#menu-toggle");
menuButton.onclick = () => {
  const open = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(open));
  $("#main-nav").classList.toggle("open", open);
};
function closeMenu() {
  menuButton.setAttribute("aria-expanded", "false");
  $("#main-nav").classList.remove("open");
}
document
  .querySelectorAll("#main-nav a")
  .forEach((a) => a.addEventListener("click", closeMenu));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
  if ($("#product-modal").open) {
    if (zoomed && e.target === zoomViewport) return;
    if (e.key === "ArrowRight") showPhoto(photoIndex + 1);
    if (e.key === "ArrowLeft") showPhoto(photoIndex - 1);
    const p = photos[photoIndex];
    $("#zoom-image").src = p.src;
    $("#zoom-image").alt = p.alt;
  }
});
const video = $("#campaign-video"),
  videoButton = $("#video-toggle");
videoButton.onclick = async () => {
  if (video.paused) {
    try {
      await video.play();
    } catch {
      videoButton.textContent = "Reintentar reproducción ▶";
    }
  } else video.pause();
};
video.addEventListener("play", () => {
  videoButton.textContent = "Pausar clip Ⅱ";
  videoButton.setAttribute("aria-label", "Pausar video de campaña");
});
video.addEventListener("pause", () => {
  videoButton.textContent = "Reproducir clip ▶";
  videoButton.setAttribute("aria-label", "Reproducir video de campaña");
});
new IntersectionObserver(
  (entries) => {
    if (!entries[0].isIntersecting) video.pause();
  },
  { threshold: 0.1 },
).observe(video);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) video.pause();
});

// Static previews keep their demo behavior. Only the configured server enables requests.
fetch("/api/config")
  .then(async (response) => {
    if (!response.ok) return;
    const config = await response.json();
    for (const [id, value] of [
      ["footer-privacy", config.privacyUrl],
      ["footer-terms", config.termsUrl],
      [
        "footer-contact",
        config.whatsapp ? "https://wa.me/" + config.whatsapp : "",
      ],
    ]) {
      if (!value) continue;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) continue;
        const link = $("#" + id);
        link.href = url.href;
        link.hidden = false;
        $(".footer-links").hidden = false;
      } catch {}
    }
    applyProduct(config.product);
    if (Number.isFinite(config.unitCents) && config.unitCents > 0) {
      unitPrice = config.unitCents / 100;
      const price = $("#product-price");
      if (price) price.textContent = money(unitPrice);
      // The compare-at price only makes sense below the current price.
      const compare = $("#product-compare");
      if (compare && config.unitCents >= 209900) compare.hidden = true;
      renderCart();
    }
    if (!config.enabled) return;
    ordersEnabled = true;
    const saleSizes =
      Array.isArray(config.product?.saleSizes) && config.product.saleSizes.length
        ? config.product.saleSizes
        : FALLBACK_SALE_SIZES;
    try {
      const saved = JSON.parse(sessionStorage.getItem("offcode-bag") || "[]");
      const sizes = new Set(saved.map((p) => p.size));
      if (
        !cart.length &&
        Array.isArray(saved) &&
        saved.length <= saleSizes.length &&
        sizes.size === saved.length &&
        saved.every(
          (p) =>
            saleSizes.includes(p.size) &&
            Number.isInteger(p.qty) &&
            p.qty >= 1 &&
            p.qty <= 99,
        ) &&
        saved.reduce((sum, p) => sum + p.qty, 0) <= 99
      )
        cart = saved.map((p) => ({
          size: p.size,
          qty: p.qty,
          ...(productId ? { productId } : {}),
          ...(variantsBySize.get(p.size) ? { variantId: variantsBySize.get(p.size) } : {}),
        }));
    } catch {}
    renderCart();
    $("#checkout").textContent = "Solicitar pedido →";
    $("#cart-mode").textContent =
      "Confirmaremos disponibilidad y envío antes de solicitar la transferencia.";
    $("#subtotal-note").textContent =
      "Envío por confirmar. No transfieras hasta recibir el total final.";
    $("#product-status").textContent =
      "Disponibilidad y envío sujetos a confirmación. Pago por transferencia.";
    $("#selection-note").textContent = "— confirma disponibilidad al solicitar";
    $("#product-description").textContent =
      "Hoodie oversize negra de 420 g/m², confeccionada en 100% algodón. Explora las vistas y elige talla y cantidad para solicitar tu pedido.";
    $("#conditions-text").textContent =
      "Confirmaremos existencia, costo de envío y total antes de recibir la transferencia. Consulta las condiciones de compra al enviar tu solicitud.";
    $("#footer-mode").textContent = "OFFCODE · Pedidos por transferencia";
  })
  .catch(() => {});
