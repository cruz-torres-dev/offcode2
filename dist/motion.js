/* Independent of cart/API logic. Native animation effects never hide base content. */
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const hero = document.querySelector(".hero");
  if (!hero || !Element.prototype.animate) return;

  const ease = "cubic-bezier(0.22, 1, 0.36, 1)";
  const running = new Map();
  let observer, listeners, pointerListeners, galleryObserver;
  let clearGallery = () => {};
  let active = false;
  let resetPointers = () => {};
  let introPlayed = false;
  const introKey = "offcode-intro-seen-v1";
  const groups = [
    [".section-heading > *", 65],
    [".product-gallery, .product-info", 85],
    [".gallery-thumbs button", 65],
    [".editorial-heading > *", 65],
    [".editorial-grid figure", 90],
    [".closing > *", 65],
  ];

  function animate(element, frames, duration, delay = 0) {
    if (!element || reduced.matches || document.hidden) return;
    running.get(element)?.cancel();
    const animation = element.animate(frames, {
      duration, delay, easing: ease, fill: "backwards",
    });
    running.set(element, animation);
    const release = () => {
      if (running.get(element) === animation) running.delete(element);
    };
    animation.onfinish = release;
    animation.oncancel = release;
  }

  function cancelAll() {
    for (const animation of running.values()) animation.cancel();
    running.clear();
    resetPointers();
  }

  function introduction() {
    if (introPlayed) return;
    introPlayed = true;
    try {
      if (sessionStorage.getItem(introKey)) return;
      sessionStorage.setItem(introKey, "1");
    } catch { /* Storage denial must not prevent the storefront from working. */ }
    // Deep links, restored scroll and return trips to checkout need no entrance.
    if (location.hash || scrollY > 80 || document.hidden) return;
    // Sequence (~2 s): black composition, monogram, photos, headline, button.
    animate(document.querySelector(".hero-shade"), [
      { opacity: 0.35 }, { opacity: 1 },
    ], 1400);
    for (const selector of [".hero-top", ".hero-bottom"]) {
      animate(document.querySelector(selector), [
        { opacity: 0.2 }, { opacity: 1 },
      ], 900, 80);
    }
    animate(document.querySelector(".brand > a"), [
      { opacity: 0.2, transform: "translateY(10px) scale(0.88)", filter: "blur(2px)" },
      { opacity: 1, transform: "translateY(0) scale(1)", filter: "blur(0px)" },
    ], 950, 140);
    document.querySelectorAll(".hero-images picture").forEach((photo, index) => {
      animate(photo, [
        { opacity: 0.1, transform: "scale(1.05) translateY(10px)" },
        { opacity: 1, transform: "scale(1) translateY(0)" },
      ], 1450, 320 + index * 200);
    });
    [".hero-copy .eyebrow", ".hero h1"].forEach((selector, i) => {
      animate(document.querySelector(selector), [
        { opacity: 0.12, transform: "translateY(20px)" },
        { opacity: 1, transform: "translateY(0)" },
      ], 950, 700 + i * 140);
    });
    animate(document.querySelector(".hero-copy .button"), [
      { opacity: 0.1, transform: "translateY(12px)" },
      { opacity: 1, transform: "translateY(0)" },
    ], 800, 1180);
  }

  function observeSections() {
    if (!("IntersectionObserver" in window)) return;
    const delays = new Map();
    const armed = new WeakSet();
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target;
        if (!entry.isIntersecting) {
          // Rearm only fully offscreen blocks; don't flicker at the viewport edge.
          armed.add(element);
          continue;
        }
        if (!armed.has(element)) continue;
        armed.delete(element);
        if (element.contains(document.activeElement)) continue;
        const fromAbove = entry.boundingClientRect.top < 0;
        animate(element, [
          { opacity: 0.12, transform: `translateY(${fromAbove ? -12 : 24}px) scale(0.992)` },
          { opacity: 1, transform: "translateY(0) scale(1)" },
        ], 820, delays.get(element));
      }
    }, { threshold: 0 });
    for (const [selector, stagger] of groups) {
      document.querySelectorAll(selector).forEach((element, index) => {
        delays.set(element, Math.min(index * stagger, 180));
        observer.observe(element);
      });
    }
  }

  // app.js owns gallery state and swaps #gallery-main's src. Watching that
  // attribute keeps the crossfade out of the store logic: the previous photo
  // is laid over the new one and fades once the new one has decoded.
  function configureGallery() {
    const main = document.querySelector("#gallery-main");
    const frame = main?.parentElement;
    if (!main || !frame || !("MutationObserver" in window)) return;
    let ghost = null, token = 0;
    const dropGhost = () => {
      ghost?.remove();
      ghost = null;
    };
    clearGallery = () => {
      token++;
      dropGhost();
    };
    galleryObserver = new MutationObserver((records) => {
      const previous = records[0].oldValue;
      if (!active || reduced.matches || document.hidden) return;
      if (!previous || previous === main.getAttribute("src")) return;
      const id = ++token;
      dropGhost();
      const layer = new Image();
      layer.className = "gallery-ghost";
      layer.alt = "";
      layer.setAttribute("aria-hidden", "true");
      layer.decoding = "sync";
      layer.src = previous;
      main.after(layer);
      ghost = layer;
      let shown = false;
      const reveal = () => {
        if (shown || id !== token) return;
        shown = true;
        animate(main, [
          { opacity: 0, scale: "1.03" },
          { opacity: 1, scale: "1" },
        ], 520);
        const fade = layer.animate([{ opacity: 1 }, { opacity: 0 }], {
          duration: 380, easing: ease, fill: "forwards",
        });
        fade.onfinish = fade.oncancel = () => {
          layer.remove();
          if (ghost === layer) ghost = null;
        };
      };
      // Don't hold the old photo indefinitely on a slow network.
      setTimeout(reveal, 450);
      (main.decode ? main.decode() : Promise.resolve()).then(reveal, reveal);
    });
    galleryObserver.observe(main, {
      attributes: true, attributeFilter: ["src"], attributeOldValue: true,
    });
  }

  function configurePointers() {
    pointerListeners?.abort();
    resetPointers();
    if (!active || reduced.matches || !finePointer.matches) return;
    pointerListeners = new AbortController();
    const signal = pointerListeners.signal;
    const resets = [];
    const bind = (surface, paint, clear) => {
      if (!surface) return;
      let frame = 0, x = 0, y = 0;
      const reset = () => {
        cancelAnimationFrame(frame);
        frame = 0;
        clear();
      };
      resets.push(reset);
      surface.addEventListener("pointermove", (event) => {
        if (event.pointerType !== "mouse" || document.hidden) return;
        x = event.clientX;
        y = event.clientY;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          // One layout read per input frame, none when the pointer is stationary.
          const rect = surface.getBoundingClientRect();
          if (!rect.width || !rect.height) return;
          const clamp = (n) => Math.max(-1, Math.min(1, n));
          paint(clamp((x - rect.left) / rect.width * 2 - 1),
            clamp((y - rect.top) / rect.height * 2 - 1));
        });
      }, { signal, passive: true });
      for (const event of ["pointerleave", "pointercancel", "focusin"])
        surface.addEventListener(event, reset, { signal });
    };
    const photos = [...hero.querySelectorAll("picture")];
    photos.forEach((photo) => photo.classList.add("campaign-depth"));
    bind(hero, (x, y) => {
      photos.forEach((photo, index) => {
        const depth = index === 0 ? 4 : 7;
        photo.style.setProperty("--depth-x", `${x * depth}px`);
        photo.style.setProperty("--depth-y", `${y * depth * 0.6}px`);
        photo.style.setProperty("--depth-scale", "1.025");
      });
    }, () => photos.forEach((photo) => {
      for (const name of ["--depth-x", "--depth-y", "--depth-scale"])
        photo.style.removeProperty(name);
    }));
    const product = document.querySelector(".product-image");
    product?.classList.add("product-tilt");
    bind(product, (x, y) => {
      product.style.setProperty("--tilt-x", `${-y * 3.5}deg`);
      product.style.setProperty("--tilt-y", `${x * 3.5}deg`);
      product.style.setProperty("--tilt-scale", "0.975");
    }, () => {
      for (const name of ["--tilt-x", "--tilt-y", "--tilt-scale"])
        product?.style.removeProperty(name);
    });
    resetPointers = () => resets.forEach((reset) => reset());
    window.addEventListener("blur", resetPointers, { signal });
    window.addEventListener("resize", resetPointers, { signal, passive: true });
  }

  function stop() {
    active = false;
    observer?.disconnect();
    galleryObserver?.disconnect();
    clearGallery();
    listeners?.abort();
    pointerListeners?.abort();
    cancelAll();
  }
  function start() {
    stop();
    if (reduced.matches) return;
    active = true;
    listeners = new AbortController();
    const signal = listeners.signal;
    introduction();
    observeSections();
    configureGallery();
    configurePointers();
    // Input always wins: no faded controls or delayed keyboard focus.
    document.addEventListener("focusin", (event) => {
      for (const [element, animation] of running)
        if (element.contains(event.target)) animation.cancel();
    }, { signal });
    hero.addEventListener("pointerdown", cancelAll, { signal, passive: true });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) cancelAll();
    }, { signal });
  }
  reduced.addEventListener("change", start);
  finePointer.addEventListener("change", configurePointers);
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", (event) => { if (event.persisted) start(); });
  start();
})();
