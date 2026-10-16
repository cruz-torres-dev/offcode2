// Original OFFCODE GLB from the supplied Shopify reference; renderer vendored locally.
const viewer = document.querySelector("#logo-model");
const brand = document.querySelector(".brand");
const control = document.querySelector("#motion");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
let paused = false;
function syncMotion() {
  const stop = paused || reduced.matches || document.hidden;
  viewer.toggleAttribute("auto-rotate", !stop);
  brand.classList.toggle("reduced-motion", reduced.matches);
  control.hidden = reduced.matches || !brand.classList.contains("model-ready");
  control.textContent = paused ? "Reanudar giro" : "Pausar giro";
  control.setAttribute(
    "aria-label",
    paused ? "Reanudar giro del monograma" : "Pausar giro del monograma",
  );
  control.setAttribute("aria-pressed", String(paused));
}
control.hidden = true;
control.onclick = () => {
  paused = !paused;
  syncMotion();
};
viewer.addEventListener("load", () => {
  // Retain the original geometry; soften the mirror finish for restrained reflections.
  viewer.model?.materials.forEach((material) => {
    material.pbrMetallicRoughness.setRoughnessFactor(0.32);
    material.pbrMetallicRoughness.setMetallicFactor(0.85);
  });
  brand.classList.add("model-ready");
  syncMotion();
});
viewer.addEventListener("error", () => {
  brand.classList.remove("model-ready");
  syncMotion();
});
reduced.addEventListener("change", () => {
  syncMotion();
  if (!reduced.matches) loadViewer();
});
document.addEventListener("visibilitychange", syncMotion);
syncMotion();
// Keep the static mark and avoid the renderer/model downloads when motion is reduced.
let viewerLoad;
function loadViewer() {
  if (!viewerLoad) {
    viewerLoad = import("./assets/vendor/model-viewer.min.js").catch(() => {
      brand.classList.remove("model-ready");
      syncMotion();
    });
  }
  return viewerLoad;
}
if (!reduced.matches) loadViewer();
