/* Catalog images only; independent of sizes, stock, checkout and bag state. */
(() => {
  const $ = (s) => document.querySelector(s);
  const modal = $("#product-modal"), viewport = $("#zoom-viewport"), image = $("#zoom-image");
  const main = $("#gallery-main"), open = $("#product-open"), thumbs = $(".gallery-thumbs"), viewerThumbs = $("#viewer-thumbs");
  let media = {}, photos = [], index = 0, scale = 1, x = 0, y = 0, savedScroll = 0, drag = null, gesture = null, suppressClick = false;
  const pointers = new Map();
  const safeSource = (src) => typeof src === "string" && /^assets\/[A-Za-z0-9._-]+\.(jpg|jpeg|png|webp|avif)$/i.test(src);
  const source = (photo, kind) => media[photo.src]?.[kind] || photo.src;
  function bounds() {
    const width = image.naturalWidth || image.width || 1080, height = image.naturalHeight || image.height || 1080;
    const fit = Math.min(viewport.clientWidth / width, viewport.clientHeight / height);
    return { width: width * fit, height: height * fit, max: Math.max(1, Math.min(4, 1 / fit)) };
  }
  function paintZoom() {
    const fitted = bounds();
    scale = Math.max(1, Math.min(fitted.max, scale));
    const limitX = Math.max(0, (fitted.width * scale - viewport.clientWidth) / 2);
    const limitY = Math.max(0, (fitted.height * scale - viewport.clientHeight) / 2);
    x = scale === 1 ? 0 : Math.max(-limitX, Math.min(limitX, x));
    y = scale === 1 ? 0 : Math.max(-limitY, Math.min(limitY, y));
    viewport.style.setProperty("--photo-scale", scale);
    viewport.style.setProperty("--photo-x", x + "px");
    viewport.style.setProperty("--photo-y", y + "px");
    viewport.classList.toggle("is-zoomed", scale > 1);
    viewport.setAttribute("aria-pressed", String(scale > 1));
    viewport.setAttribute("aria-label", scale > 1 ? "Restablecer fotografía; arrastra para recorrer" : "Ampliar fotografía");
  }
  function local(point) {
    const rect = viewport.getBoundingClientRect();
    return { x: point.x - rect.left - viewport.clientWidth / 2, y: point.y - rect.top - viewport.clientHeight / 2 };
  }
  function zoom(value, point = null) {
    const anchor = point ? local(point) : { x: 0, y: 0 };
    const next = Math.max(1, Math.min(bounds().max, value));
    x = anchor.x - (anchor.x - x) * next / scale;
    y = anchor.y - (anchor.y - y) * next / scale;
    scale = next; paintZoom();
  }
  function clearPointers() {
    const captured = [...pointers.keys()];
    pointers.clear(); drag = gesture = null;
    for (const id of captured) if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    viewport.classList.remove("is-dragging");
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
    if (!photos.length || (gesture && pointers.size)) return;
    clearPointers();
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
    listenForGestures(true);
    updateViewer(); modal.querySelector(".close").focus({ preventScroll: true });
  };
  modal.addEventListener("close", () => {
    document.documentElement.classList.remove("product-viewer-open");
    listenForGestures(false); clearPointers(); suppressClick = false; zoom(1);
    window.scrollTo({ top: savedScroll, behavior: "instant" }); open.focus({ preventScroll: true });
  });
  viewport.addEventListener("click", (event) => {
    if (modal.open && !pointers.size && !suppressClick) zoom(scale > 1 ? 1 : 2, Number.isFinite(event.clientX) && event.detail !== 0 ? { x: event.clientX, y: event.clientY } : null);
    suppressClick = false;
  });
  image.addEventListener("dragstart", (e) => e.preventDefault());
  image.addEventListener("load", () => { if (modal.open) paintZoom(); });
  const distance = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const midpoint = () => { const [a, b] = [...pointers.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  function start(e) {
    if (e.button !== 0 || pointers.size >= 2) return;
    if (!pointers.size) suppressClick = false;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    viewport.setPointerCapture(e.pointerId); viewport.focus({ preventScroll: true });
    drag = { x: e.clientX, y: e.clientY, offsetX: x, offsetY: y, moved: false };
    if (pointers.size === 2) {
      const center = local(midpoint());
      gesture = { distance: Math.max(distance(), 1), scale, anchorX: (center.x - x) / scale, anchorY: (center.y - y) / scale };
      suppressClick = true;
    }
  }
  function move(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && gesture) {
      const center = local(midpoint());
      scale = Math.max(1, Math.min(bounds().max, gesture.scale * distance() / gesture.distance));
      x = center.x - gesture.anchorX * scale; y = center.y - gesture.anchorY * scale;
      paintZoom(); suppressClick = true; return;
    }
    if (!drag) return;
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) drag.moved = suppressClick = true;
    if (scale > 1) {
      viewport.classList.add("is-dragging");
      x = drag.offsetX + e.clientX - drag.x;
      y = drag.offsetY + e.clientY - drag.y;
      paintZoom();
    }
  }
  function end(e) {
    if (!pointers.has(e.pointerId)) return;
    if (!gesture && scale === 1 && drag?.moved && e.type === "pointerup") {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) show(index + (dx < 0 ? 1 : -1));
    }
    pointers.delete(e.pointerId); drag = null;
    if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
    if (!pointers.size) gesture = null;
    else {
      // Keep the pinch flag until all fingers lift: the remaining finger may
      // pan immediately, but cannot accidentally swipe or toggle zoom.
      const remaining = [...pointers.values()][0];
      drag = { x: remaining.x, y: remaining.y, offsetX: x, offsetY: y, moved: false };
    }
    if (e.type !== "pointerup") suppressClick = true;
    viewport.classList.remove("is-dragging");
  }
  function resize() { clearPointers(); zoom(1); }
  function listenForGestures(enabled) {
    const method = enabled ? "addEventListener" : "removeEventListener";
    for (const [event, handler] of [["pointerdown", start], ["pointermove", move], ["pointerup", end], ["pointercancel", end], ["lostpointercapture", end]]) viewport[method](event, handler);
    window[method]("resize", resize);
    window.visualViewport?.[method]("resize", resize);
  }
  modal.addEventListener("keydown", (e) => {
    // Preserve native editing controls and browser navigation shortcuts.
    if (e.altKey || e.ctrlKey || e.metaKey || ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable) return;
    if (e.target === viewport && ["Enter", " "].includes(e.key)) { e.preventDefault(); zoom(scale > 1 ? 1 : 2); return; }
    if (["+", "=", "-", "0"].includes(e.key)) { e.preventDefault(); zoom(e.key === "+" || e.key === "=" ? 2 : 1); return; }
    if (!["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    if (scale > 1 && e.target === viewport && e.shiftKey) {
      e.preventDefault();
      x += e.key === "ArrowRight" ? -70 : e.key === "ArrowLeft" ? 70 : 0;
      y += e.key === "ArrowDown" ? -70 : e.key === "ArrowUp" ? 70 : 0;
      paintZoom();
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); show(index + (e.key === "ArrowRight" ? 1 : -1)); }
  });
})();
