const $ = (s) => document.querySelector(s);
const unitPrice = 1650;
const money = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    n,
  ) + " MXN";
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
}
let toastTimer;
$("#add").onclick = () => {
  const item = cart.find((p) => p.size === size);
  const qty = readQty();
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
  $("#checkout-message").textContent =
    "Prueba completada. No se creó ningún pedido ni se realizó ningún cobro. Para vender será necesario confirmar precios, inventario y conectar una pasarela de pagos.";
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
