const $ = (selector) => document.querySelector(selector);
const money = (cents) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100);
const form = $("#order-form");
const acceptance = $("#accept-total");
const customerFields = ["name", "phone", "email", "street", "neighborhood", "postalCode", "city", "state", "notes"];
let items = [], config, key, selectedRate = null, quoteRevision = 0, expiryTimer, orderReference = "", submitting = false;
try {
  items = JSON.parse(sessionStorage.getItem("offcode-bag") || "[]");
  key = sessionStorage.getItem("offcode-request-key") || crypto.randomUUID();
  sessionStorage.setItem("offcode-request-key", key);
} catch { items = []; }
function customer() {
  return Object.fromEntries(customerFields.map((name) => [name, form.elements.namedItem(name)?.value || ""]));
}
function customerFingerprint() { return JSON.stringify({ customer: customer(), consent: form.elements.namedItem("consent").checked }); }
function saveBag() { try { sessionStorage.setItem("offcode-bag", JSON.stringify(items)); } catch {} }
function validBag() {
  return Array.isArray(items) && items.length > 0 && items.length <= 12 &&
    items.every((item) => item && typeof item.size === "string" && Number.isInteger(item.qty) && item.qty >= 1 && item.qty <= 99) &&
    items.reduce((sum, item) => sum + item.qty, 0) <= 99;
}
function productFor(item) {
  const products = config.catalog || [];
  return products.find((product) => product.variants?.some((variant) => variant.id === item.variantId)) ||
    products.find((product) => product.id === item.productId) || products[0] || {
      name: config.product?.name || "OFFCODE", priceCents: config.unitCents,
      images: config.product?.images || [],
      variants: (config.product?.saleSizes || []).map((size) => ({ size, available: null })),
    };
}
function previewSubtotal() {
  if (!validBag()) return null;
  const values = items.map((item) => productFor(item).priceCents);
  return values.every(Number.isSafeInteger) ? items.reduce((sum, item, index) => sum + item.qty * values[index], 0) : null;
}
function totals(subtotalCents, shippingCents, totalCents) {
  for (const id of ["order-subtotal", "review-subtotal"]) $("#" + id).textContent = Number.isSafeInteger(subtotalCents) ? money(subtotalCents) : "—";
  for (const id of ["summary-shipping", "review-shipping"]) $("#" + id).textContent = Number.isSafeInteger(shippingCents) ? money(shippingCents) : "Por calcular";
  for (const id of ["summary-total", "review-total"]) $("#" + id).textContent = Number.isSafeInteger(totalCents) ? money(totalCents) : "Por calcular";
}
function updateSubmit() {
  $("#submit-order").disabled = submitting || !config?.enabled || !config?.shipping?.enabled || !selectedRate ||
    !acceptance.checked || Date.parse(selectedRate.expiresAt) <= Date.now();
}
function clearRates(message = "Completa tu dirección y pulsa Calcular envío.") {
  quoteRevision++;
  clearTimeout(expiryTimer);
  selectedRate = null;
  acceptance.checked = false; acceptance.disabled = true;
  $("#accept-total-label").textContent = "Elige un servicio para revisar y aceptar el total completo.";
  $("#shipping-rates").replaceChildren();
  $("#summary-service").textContent = "";
  $("#shipping-message").textContent = message;
  $("#shipping-summary").textContent = "El envío y el total se actualizarán al elegir una tarifa vigente.";
  totals(config ? previewSubtotal() : null, null, null);
  updateSubmit();
}
function renderItems(resolved = []) {
  $("#order-items").replaceChildren();
  items.forEach((item, index) => {
    const product = productFor(item), authoritative = resolved.find((line) => line.variantId === item.variantId);
    const row = document.createElement("div"); row.className = "summary-item";
    const imageWrap = document.createElement("div"); imageWrap.className = "summary-image";
    const image = document.createElement("img"); image.width = 72; image.height = 80;
    const photo = product.images?.[0];
    if (photo?.src?.startsWith("assets/") && !photo.src.includes("..")) { image.src = photo.src; image.alt = photo.alt || product.name; imageWrap.append(image); }
    const badge = document.createElement("span"); badge.className = "summary-badge"; badge.textContent = item.qty;
    imageWrap.append(badge);
    const info = document.createElement("div"), name = document.createElement("h3"), variantNote = document.createElement("p");
    name.textContent = authoritative?.name || product.name;
    variantNote.className = "variant-note";
    variantNote.textContent = [authoritative?.color || product.color, "Talla " + item.size].filter(Boolean).join(" · ");
    const editors = document.createElement("div"); editors.className = "summary-editors";
    const sizeLabel = document.createElement("label"), size = document.createElement("select");
    sizeLabel.textContent = "Talla"; size.setAttribute("aria-label", "Talla de " + product.name);
    for (const variant of product.variants || []) {
      const available = Number.isFinite(variant.available) ? variant.available > 0 : (config.product?.saleSizes || []).includes(variant.size);
      if (!available && variant.size !== item.size) continue;
      const option = new Option(variant.size, variant.id || variant.size); option.disabled = !available;
      option.selected = variant.id ? variant.id === item.variantId : variant.size === item.size;
      size.append(option);
    }
    size.onchange = () => {
      const variant = product.variants.find((candidate) => (candidate.id || candidate.size) === size.value);
      if (!variant) return;
      if (items.some((line, at) => at !== index && (variant.id ? line.variantId === variant.id : line.size === variant.size))) {
        $("#availability").textContent = "Esa talla ya está en tu bolsa. Edita las cantidades desde la bolsa para combinarla.";
        renderItems(); return;
      }
      items[index] = { size: variant.size, qty: item.qty, ...(product.id ? { productId: product.id } : {}), ...(variant.id ? { variantId: variant.id } : {}) };
      saveBag(); clearRates("Cambiaste la talla. Vuelve a calcular el envío y acepta el total."); renderItems();
    };
    sizeLabel.append(size);
    const qtyLabel = document.createElement("label"), qty = document.createElement("input");
    qtyLabel.textContent = "Cantidad"; qty.type = "number"; qty.min = "1"; qty.max = "99"; qty.step = "1"; qty.value = item.qty;
    qty.setAttribute("aria-label", "Cantidad de " + product.name + " talla " + item.size);
    const price = document.createElement("span"); price.className = "summary-line-price";
    const unitCents = authoritative?.unitCents ?? product.priceCents;
    price.textContent = Number.isSafeInteger(unitCents) ? money(unitCents * item.qty) : "—";
    qty.oninput = () => {
      items[index].qty = Number(qty.value);
      badge.textContent = qty.value || "—";
      price.textContent = Number.isInteger(items[index].qty) && items[index].qty > 0 && Number.isSafeInteger(unitCents) ? money(unitCents * items[index].qty) : "—";
      saveBag(); clearRates("Cambiaste la cantidad. Vuelve a calcular el envío y acepta el total.");
    };
    qtyLabel.append(qty); editors.append(sizeLabel, qtyLabel); info.append(name, variantNote, editors); row.append(imageWrap, info, price);
    $("#order-items").append(row);
  });
}
function selectRate(rate, snapshot) {
  if (snapshot !== customerFingerprint()) { clearRates("Tus datos cambiaron. Vuelve a calcular el envío."); return; }
  if (!Number.isSafeInteger(rate.totalCents) || !Number.isSafeInteger(rate.subtotalCents) || !Number.isSafeInteger(rate.shippingCents) ||
      rate.currency !== "MXN" || !Number.isFinite(Date.parse(rate.expiresAt)) || Date.parse(rate.expiresAt) <= Date.now()) {
    clearRates("La cotización no está vigente. Vuelve a calcular el envío."); return;
  }
  selectedRate = rate;
  totals(rate.subtotalCents, rate.shippingCents, rate.totalCents);
  $("#summary-service").textContent = rate.description;
  $("#shipping-summary").textContent = "Cotización vigente hasta " + new Date(rate.expiresAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" }) + ".";
  $("#accept-total-label").textContent = "He revisado y acepto el total completo de " + money(rate.totalCents) + " MXN para mi solicitud, incluido el envío.";
  acceptance.disabled = false; acceptance.checked = false;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => clearRates("La cotización venció. Vuelve a calcular el envío y acepta el nuevo total."), Math.max(0, Date.parse(rate.expiresAt) - Date.now()));
  updateSubmit();
}
async function init() {
  try {
    const response = await fetch("/api/config"); if (!response.ok) throw Error(); config = await response.json();
  } catch { $("#availability").textContent = "No pudimos conectar con la tienda. Recarga para intentar de nuevo."; return; }
  if (!validBag()) { $("#availability").textContent = "Tu bolsa está vacía o no es válida. Vuelve a la colección para elegir talla y cantidad."; return; }
  const saleSizes = config.product?.saleSizes || [];
  if (items.some((item) => !saleSizes.includes(item.size) && !item.variantId)) {
    $("#availability").textContent = "Tu bolsa incluye una talla que no está disponible. Vuelve a la colección para revisarla."; return;
  }
  items = items.map((item) => {
    const product = productFor(item);
    const variant = product.variants?.find((value) => item.variantId ? value.id === item.variantId : value.size === item.size);
    return variant ? { size: variant.size, qty: item.qty, ...(product.id ? { productId: product.id } : {}), ...(variant.id ? { variantId: variant.id } : {}) } : item;
  });
  saveBag(); renderItems(); totals(previewSubtotal(), null, null);
  if (!config.enabled) { $("#availability").textContent = "La recepción de pedidos está cerrada temporalmente."; return; }
  form.hidden = false;
  for (const [id, value] of [["privacy-link", config.privacyUrl], ["terms-link", config.termsUrl]]) {
    if (!value) continue;
    try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) continue;
      $("#" + id).href = url.href; $("#" + id).hidden = false; $("#checkout-policies").hidden = false;
    } catch {}
  }
  clearRates();
  if (!config.shipping?.enabled) {
    $("#availability").textContent = "La cotización de envíos todavía no está habilitada. Puedes consultar con OFFCODE antes de continuar.";
    $("#shipping-message").textContent = "No hay tarifas disponibles mientras la integración de envíos esté desactivada.";
    $("#quote-shipping").disabled = true; return;
  }
  $("#availability").textContent = config.shipping.environment === "sandbox"
    ? "Entorno de Sandbox: tarifas de simulación, sin validez para enviar paquetes. No transfieras dinero."
    : "Envíos por FedEx. Elige tu tarifa antes de enviar la solicitud; la transferencia se solicita después de confirmar disponibilidad.";
  try {
    const response = await fetch("/api/shipping/states"), data = await response.json();
    if (!response.ok) throw Error();
    const select = document.createElement("select"); select.name = "state"; select.required = true; select.autocomplete = "address-level1"; select.setAttribute("aria-label", "Estado");
    select.append(new Option("Selecciona tu estado", ""));
    for (const state of data.states) select.append(new Option(state.name, state.code));
    $("#state-text").replaceWith(select);
  } catch { $("#shipping-message").textContent = "No se pudieron cargar los estados. Recarga para intentar de nuevo."; $("#quote-shipping").disabled = true; }
}
for (const event of ["input", "change"]) form.addEventListener(event, (e) => {
  if (customerFields.includes(e.target.name) || e.target.name === "consent")
    clearRates("Tus datos cambiaron. Vuelve a calcular el envío para esta dirección.");
});
acceptance.onchange = updateSubmit;
$("#quote-shipping").onclick = async () => {
  if (submitting || !config?.enabled || !config.shipping?.enabled) return;
  for (const name of [...customerFields, "consent"]) {
    const field = form.elements.namedItem(name); if (field && !field.reportValidity()) return;
  }
  for (const field of document.querySelectorAll(".summary-editors input")) if (!field.reportValidity()) return;
  if (!validBag()) { $("#availability").textContent = "Revisa tu bolsa: máximo 99 prendas en total."; return; }
  clearRates();
  const revision = quoteRevision, snapshot = customerFingerprint(), bagSnapshot = JSON.stringify(items), button = $("#quote-shipping");
  button.disabled = true; button.textContent = "Calculando envío…";
  $("#shipping-message").textContent = "Consultando cobertura y tarifas de FedEx…";
  try {
    const response = await fetch("/api/shipping/rates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer: customer(), items, consent: true }) });
    const result = await response.json();
    if (revision !== quoteRevision || snapshot !== customerFingerprint() || bagSnapshot !== JSON.stringify(items)) return;
    if (!response.ok) throw Error(result.error || "No pudimos calcular el envío.");
    if (!Array.isArray(result.rates) || !result.rates.length) throw Error("FedEx no devolvió servicios disponibles para esta dirección.");
    renderItems(result.items || []);
    for (const rate of result.rates) {
      const label = document.createElement("label"), radio = document.createElement("input"), info = document.createElement("span"), name = document.createElement("span"), price = document.createElement("span");
      label.className = "shipping-option"; radio.type = "radio"; radio.name = "shipping-service"; radio.value = rate.id;
      name.className = "shipping-service-name"; name.textContent = rate.description; info.append(name);
      if (rate.deliveryEstimate) { const estimate = document.createElement("span"); estimate.className = "shipping-estimate"; estimate.textContent = "Estimado: " + rate.deliveryEstimate; info.append(estimate); }
      price.className = "shipping-price"; price.textContent = money(rate.shippingCents);
      radio.onchange = () => selectRate(rate, snapshot);
      label.append(radio, info, price); $("#shipping-rates").append(label);
    }
    $("#shipping-message").textContent = "Elige un servicio para ver y aceptar tu total. Los tiempos mostrados son estimaciones de la paquetería.";
  } catch (error) { if (revision === quoteRevision) $("#shipping-message").textContent = error.message; }
  finally { button.disabled = false; button.textContent = "Calcular envío"; }
};
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (submitting || !config?.enabled || !config.shipping?.enabled) return;
  if (!selectedRate || Date.parse(selectedRate.expiresAt) <= Date.now()) { clearRates("La tarifa venció. Vuelve a calcular el envío."); return; }
  if (!acceptance.checked || !form.reportValidity()) return;
  submitting = true; updateSubmit();
  const button = $("#submit-order"), accepted = selectedRate;
  const controls = [...document.querySelectorAll("#order-form input, #order-form select, #quote-shipping, .summary-editors input, .summary-editors select")];
  const disabledBefore = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  button.textContent = "Guardando solicitud…";
  try {
    const response = await fetch("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      requestKey: key, customer: customer(), items, consent: form.elements.namedItem("consent").checked,
      shippingQuoteId: accepted.id, totalAccepted: true, acceptedTotalCents: accepted.totalCents,
    }) });
    const result = await response.json();
    if (!response.ok) { if (response.status === 409) clearRates("La cotización o la selección cambió. Calcula de nuevo y vuelve a aceptar el total."); throw Error(result.error || "No se pudo guardar tu solicitud."); }
    if (!/^OF-[A-F0-9]{12}$/.test(result.id || "")) throw Error("No pudimos confirmar la referencia. Reintenta con la misma selección.");
    orderReference = result.id; clearTimeout(expiryTimer);
    $("#order-reference").textContent = "Tu referencia: " + result.id;
    $("#support-order").href = "contacto.html?pedido=" + encodeURIComponent(result.id);
    $("#whatsapp-order").href = "https://wa.me/" + config.whatsapp + "?text=" + encodeURIComponent(`Hola, quiero dar seguimiento a mi solicitud OFFCODE ${result.id}. Quedo pendiente de confirmar disponibilidad antes de transferir.`);
    form.hidden = true; $("#order-success").hidden = false;
    $("#availability").textContent = "Solicitud recibida. No transfieras hasta que OFFCODE confirme disponibilidad y te comparta los datos bancarios.";
    if (Number.isSafeInteger(result.totalCents)) totals(result.subtotalCents, result.shippingCents, result.totalCents);
    $("#order-success").focus();
    for (const field of document.querySelectorAll(".summary-editors input, .summary-editors select")) field.disabled = true;
    sessionStorage.removeItem("offcode-bag"); sessionStorage.removeItem("offcode-request-key");
  } catch (error) { $("#availability").textContent = error.message + " Tu selección sigue disponible para reintentar."; }
  finally {
    if (!orderReference) controls.forEach((control, index) => { control.disabled = disabledBefore[index]; });
    if (!selectedRate) acceptance.disabled = true;
    submitting = false; button.textContent = "Enviar solicitud de pedido →"; updateSubmit();
  }
});
$("#copy-order-reference").onclick = async () => {
  if (!orderReference) return;
  try { await navigator.clipboard.writeText(orderReference); $("#order-copy-status").textContent = "Referencia copiada."; }
  catch { $("#order-copy-status").textContent = "Tu referencia es " + orderReference + ". Puedes seleccionarla y copiarla."; }
};
window.addEventListener("pageshow", (event) => { if (event.persisted && !orderReference) location.reload(); });
init();
