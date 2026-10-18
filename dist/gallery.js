/* Catalog images only; independent of sizes, stock, checkout and bag state. */
(() => {
  const $ = (s) => document.querySelector(s);
  const modal = $("#product-modal"), viewport = $("#zoom-viewport"), image = $("#zoom-image");
  const main = $("#gallery-main"), open = $("#product-open"), thumbs = $(".gallery-thumbs"), viewerThumbs = $("#viewer-thumbs");
  let media = {}, photos = [], index = 0, scale = 1, savedScroll = 0, drag = null, gesture = null, suppressClick = false;
  const pointers = new Map();
  const safeSource = (src) => typeof src === "string" && /^assets\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|avif)$/i.test(src);
  const source = (photo, kind) => media[photo.src]?.[kind] || photo.src;
  function zoom(value, point = null) {
    const previous = scale;
    const rect = viewport.getBoundingClientRect();
    const x = point ? point.x - rect.left : viewport.clientWidth / 2;
    const y = point ? point.y - rect.top : viewport.clientHeight / 2;
    const contentX = (viewport.scrollLeft + x) / previous;
    const contentY = (viewport.scrollTop + y) / previous;
    scale = Math.max(1, Math.min(2, value));
    viewport.style.setProperty("--photo-scale", scale);
    viewport.classList.toggle("is-zoomed", scale > 1);
    viewport.setAttribute("aria-pressed", String(scale > 1));
    viewport.setAttribute("aria-label", scale > 1 ? "Restablecer fotografía; arrastra para recorrer" : "Ampliar fotografía");
    viewport.scrollLeft = scale > 1 ? contentX * scale - x : 0;
    viewport.scrollTop = scale > 1 ? contentY * scale - y : 0;
  }
  function updateViewer() {
    if (!modal.open || !photos.length) return;
    const p = photos[index];
    image.src = source(p, "large"); image.alt = p.alt;
    const dimensions = media[p.src];
    image.width = dimensions?.width || 1080; image.height = dimensions?.height || 1080;
    $("#viewer-position").textContent = `${index + 1} / ${photos.length} · ${p.alt}`;
    zoom(1);
  }
  function show(next) {
    if (!photos.length) return;
    index = (next + photos.length) % photos.length;
    const p = photos[index];
    main.src = source(p, "main"); main.alt = p.alt;
    $("#photo-label").textContent = `${String(index + 1).padStart(2, "0")} / ${photos.length}`;
    open.setAttribute("aria-label", "Ampliar fotografía: " + p.alt);
    for (const host of [thumbs, viewerThumbs]) host.querySelectorAll("button").forEach((button, i) => {
      button.classList.toggle("active", i === index);
      button.setAttribute("aria-pressed", String(i === index));
    });
    updateViewer();
    if (modal.open) viewerThumbs.querySelectorAll("button")[index]?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }
  function setProduct(product) {
    const previous = photos[index]?.src;
    photos = (product.images || []).filter((p) => safeSource(p.src)).map((p) => ({ src: p.src, alt: p.alt || product.name || "Fotografía del producto" }));
    modal.querySelector("h2").textContent = (product.line || product.name || "OFFCODE").replace("LA AFRO", "LAAFRO");
    for (const host of [thumbs, viewerThumbs]) {
      host.replaceChildren();
      photos.forEach((p, i) => {
        const button = document.createElement("button"), thumb = document.createElement("img"), label = document.createElement("span");
        button.type = "button"; button.dataset.photo = i;
        button.setAttribute("aria-label", `Ver imagen ${i + 1}: ${p.alt}`);
        thumb.src = source(p, "thumb"); thumb.alt = ""; thumb.width = 160; thumb.height = 160; thumb.loading = "lazy"; thumb.decoding = "async";
        label.textContent = String(i + 1).padStart(2, "0");
        button.append(thumb, label); button.onclick = () => show(i); host.append(button);
      });
    }
    for (const id of ["photo-prev", "photo-next", "viewer-prev", "viewer-next"]) $("#" + id).disabled = photos.length < 2;
    open.disabled = !photos.length;
    if (!photos.length) { main.removeAttribute("src"); main.alt = "Fotografías pendientes"; $("#photo-label").textContent = "Sin fotografías"; if (modal.open) modal.close(); return; }
    show(Math.max(0, photos.findIndex((p) => p.src === previous)));
  }
  // Static preview remains usable. The server's actual catalog replaces this list.
  const fallback = [...thumbs.querySelectorAll("button")].map((b) => ({ src: b.querySelector("img").getAttribute("src").replace("-thumb.webp", ".jpg"), alt: b.textContent.trim() + " de la sudadera LA AFRO × OFFCODE" }));
  let product = { line: "LA AFRO × OFFCODE", images: fallback };
  document.addEventListener("offcode:product", (event) => { product = event.detail; setProduct(product); });
  fetch("assets/product-media.json").then((r) => r.ok ? r.json() : {}).then((data) => {
    // Optional optimization metadata cannot introduce external sources.
    media = Object.fromEntries(Object.entries(data).filter(([key, value]) => safeSource(key) && ["thumb", "main", "large"].every((kind) => safeSource(value[kind]))));
    setProduct(product);
  }).catch(() => {});
  setProduct(product);
  $("#photo-prev").onclick = $("#viewer-prev").onclick = () => show(index - 1);
  $("#photo-next").onclick = $("#viewer-next").onclick = () => show(index + 1);
  open.onclick = () => {
    if (!photos.length) return;
    savedScroll = window.scrollY;
    modal.showModal(); document.documentElement.classList.add("product-viewer-open");
    updateViewer(); modal.querySelector(".close").focus({ preventScroll: true });
  };
  modal.addEventListener("close", () => {
    document.documentElement.classList.remove("product-viewer-open");
    pointers.clear(); drag = gesture = null; zoom(1);
    window.scrollTo({ top: savedScroll, behavior: "instant" }); open.focus({ preventScroll: true });
  });
  viewport.addEventListener("click", (event) => {
    if (!suppressClick) zoom(scale > 1 ? 1 : 2, Number.isFinite(event.clientX) && event.detail !== 0 ? { x: event.clientX, y: event.clientY } : null);
    suppressClick = false;
  });
  image.addEventListener("dragstart", (e) => e.preventDefault());
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    suppressClick = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewport.setPointerCapture(e.pointerId); viewport.focus({ preventScroll: true });
    drag = { x: e.clientX, y: e.clientY, left: viewport.scrollLeft, top: viewport.scrollTop, moved: false };
    if (pointers.size === 2) { gesture = { distance: distance(), scale }; suppressClick = true; }
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && gesture) { zoom(gesture.scale * distance() / Math.max(gesture.distance, 1)); suppressClick = true; return; }
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = suppressClick = true;
    if (scale > 1) {
      viewport.classList.add("is-dragging");
      viewport.scrollLeft = drag.left + drag.x - e.clientX;
      viewport.scrollTop = drag.top + drag.y - e.clientY;
    }
  });
  function end(e) {
    if (!pointers.has(e.pointerId)) return;
    if (!gesture && scale === 1 && drag?.moved && e.type === "pointerup") {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) show(index + (dx < 0 ? 1 : -1));
    }
    pointers.delete(e.pointerId); drag = null;
    if (!pointers.size) gesture = null;
    viewport.classList.remove("is-dragging");
  }
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) viewport.addEventListener(event, end);
  modal.addEventListener("keydown", (e) => {
    // Preserve native editing controls and browser navigation shortcuts.
    if (e.altKey || e.ctrlKey || e.metaKey || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (e.target === viewport && ["Enter", " "].includes(e.key)) { e.preventDefault(); zoom(scale > 1 ? 1 : 2); return; }
    if (["+", "=", "-", "0"].includes(e.key)) { e.preventDefault(); zoom(e.key === "+" || e.key === "=" ? 2 : 1); return; }
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    if (scale > 1 && e.target === viewport && e.shiftKey) {
      e.preventDefault();
      viewport.scrollLeft += e.key === "ArrowRight" ? 70 : e.key === "ArrowLeft" ? -70 : 0;
      viewport.scrollTop += e.key === "ArrowDown" ? 70 : e.key === "ArrowUp" ? -70 : 0;
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); show(index + (e.key === "ArrowRight" ? 1 : -1)); }
  });
})();
