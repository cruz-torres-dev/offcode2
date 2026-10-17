const $ = (s) => document.querySelector(s);
const unitPrice = 1650;
const money = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    n,
  ) + " MXN";
let ordersEnabled = false;
let size = "M",
  cart = [];
const cartDialog = $("#cart");
document.querySelectorAll("[data-size]").forEach((b) =>
  b.addEventListener("click", () => {
    size = b.dataset.size;
    document.querySelectorAll("[data-size]").forEach((x) => {
      x.classList.toggle("selected", x === b);
      x.setAttribute("aria-pressed", String(x === b));
    });
  }),
);
function renderCart() {
  $("#count").textContent = `(${cart.reduce((n, p) => n + p.qty, 0)})`;
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
$("#add").onclick = () => {
  const item = cart.find((p) => p.size === size);
  const qty = readQty();
  if (cart.reduce((sum, p) => sum + p.qty, 0) + qty > 99) {
    $("#toast").textContent = "Máximo 99 prendas por solicitud.";
    $("#toast").classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => $("#toast").classList.remove("visible"),
      3000,
    );
    return;
  }
  if (item) item.qty += qty;
  else cart.push({ size, qty });
  $("#checkout-message").textContent = "";
  renderCart();
  $("#toast").textContent =
    `${qty} × LA AFRO × OFFCODE, talla ${size}, agregada a la bolsa`;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2500);
};
$("#bag").onclick = () => {
  renderCart();
  cartDialog.showModal();
};
$("#product-open").onclick = () => {
  const p = photos[photoIndex];
  $("#zoom-image").src = p.src;
  $("#zoom-image").alt = p.alt;
  $("#product-modal").showModal();
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
    "Ampliar imagen: " + p.label.toLowerCase(),
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
    if (!config.enabled) return;
    ordersEnabled = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem("offcode-bag") || "[]");
      const sizes = new Set(saved.map((p) => p.size));
      if (
        !cart.length &&
        Array.isArray(saved) &&
        saved.length <= 4 &&
        sizes.size === saved.length &&
        saved.every(
          (p) =>
            ["S", "M", "L", "XL"].includes(p.size) &&
            Number.isInteger(p.qty) &&
            p.qty >= 1 &&
            p.qty <= 99,
        ) &&
        saved.reduce((sum, p) => sum + p.qty, 0) <= 99
      )
        cart = saved.map((p) => ({ size: p.size, qty: p.qty }));
    } catch {}
    renderCart();
    $("#site-notice").textContent = "OFFCODE · PEDIDOS POR TRANSFERENCIA";
    $("#checkout").textContent = "Solicitar pedido →";
    $("#cart-mode").textContent =
      "Confirmaremos disponibilidad y envío antes de solicitar la transferencia.";
    $("#subtotal-note").textContent =
      "Envío por confirmar. No transfieras hasta recibir el total final.";
    $("#product-status").textContent =
      "Disponibilidad y envío sujetos a confirmación. Pago por transferencia.";
    $("#selection-note").textContent = "— confirma disponibilidad al solicitar";
    $("#product-description").textContent =
      "Sudadera negra de la colaboración LA AFRO × OFFCODE. Explora las vistas y elige talla y cantidad para solicitar tu pedido.";
    $("#conditions-text").textContent =
      "Confirmaremos existencia, costo de envío y total antes de recibir la transferencia. Consulta las condiciones de compra al enviar tu solicitud.";
    $("#footer-mode").textContent = "OFFCODE · Pedidos por transferencia";
  })
  .catch(() => {});
