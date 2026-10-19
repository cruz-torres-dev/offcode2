const $ = (s) => document.querySelector(s);
const money = (cents) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    cents / 100,
  ) + " MXN";
let items = [],
  config,
  key,
  selectedRate = null,
  orderReference = "";
const subtotal = () => items.reduce((s, p) => s + p.qty * config.unitCents, 0);
const form = $("#order-form");
$("#copy-order-reference").onclick = async () => {
  if (!orderReference) return;
  try {
    await navigator.clipboard.writeText(orderReference);
    $("#order-copy-status").textContent = "Referencia copiada. Inclúyela al contactar a OFFCODE.";
  } catch {
    $("#order-copy-status").textContent = `Tu referencia es ${orderReference}. Puedes seleccionarla y copiarla.`;
  }
};
function clearRates() {
  selectedRate = null;
  $("#shipping-rates").replaceChildren();
  $("#shipping-message").textContent =
    "Consulta FedEx después de completar tus datos y aceptar su uso para gestionar el pedido y el envío.";
  $("#shipping-summary").textContent = "Envío pendiente de cotizar.";
  $("#shipping-summary").className = "fine";
  $("#submit-order").disabled = true;
}
try {
  items = JSON.parse(sessionStorage.getItem("offcode-bag") ?? "[]");
  key = sessionStorage.getItem("offcode-request-key") || crypto.randomUUID();
  sessionStorage.setItem("offcode-request-key", key);
} catch {
  items = [];
}
// Mirrors server/catalog.mjs until /api/config answers with the sale sizes.
const FALLBACK_SALE_SIZES = ["S", "M", "L", "XL"];
function validBag(saleSizes) {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= saleSizes.length &&
    items.every(
      (p) =>
        saleSizes.includes(p.size) &&
        Number.isInteger(p.qty) &&
        p.qty >= 1 &&
        p.qty <= 99,
    )
  );
}
async function init() {
  if (!Array.isArray(items) || !items.length) {
    $("#availability").textContent =
      "Tu bolsa está vacía o no es válida. Vuelve a la colección para elegir talla y cantidad.";
    return;
  }
  try {
    const r = await fetch("/api/config");
    if (!r.ok) throw Error();
    config = await r.json();
  } catch {
    $("#availability").textContent =
      "La recepción de pedidos no está conectada en esta vista. Puedes seguir explorando la colección.";
    return;
  }
  // Trust the server list even when empty: with no counted stock there is
  // nothing to sell, so the bag is never validated against a fixed fallback.
  const saleSizes = Array.isArray(config.product?.saleSizes)
    ? config.product.saleSizes
    : FALLBACK_SALE_SIZES;
  if (!validBag(saleSizes)) {
    $("#availability").textContent =
      "Tu bolsa incluye una talla que no está habilitada para venta. Vuelve a la colección para elegirla de nuevo.";
    return;
  }
  for (const item of items) {
    const p = document.createElement("p");
    p.textContent = `Talla ${item.size} · ${item.qty} ${item.qty === 1 ? "prenda" : "prendas"}`;
    $("#order-items").append(p);
  }
  $("#order-subtotal").textContent =
    "Subtotal: " +
    money(items.reduce((s, p) => s + p.qty * config.unitCents, 0));
  if (!config.enabled) {
    $("#availability").textContent =
      "Pedidos todavía no habilitados. No se guardarán datos ni se realizarán cobros.";
    return;
  }
  for (const [selector, value] of [
    ["#privacy-link", config.privacyUrl],
    ["#terms-link", config.termsUrl],
  ]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      $(selector).href = url.href;
      $(selector).hidden = false;
      $("#checkout-policies").hidden = false;
    } catch {}
  }
  $("#availability").textContent =
    "Pago por transferencia bancaria. Primero confirmaremos tu solicitud y el envío.";
  $("#order-form").hidden = false;
  if (config.shipping?.enabled) {
    $("#availability").textContent =
      config.shipping.environment === "sandbox"
        ? "Sandbox: tarifas y guías sin validez para envíos reales. No transfieras dinero."
        : "Envíos por FedEx. Paga por transferencia después de que OFFCODE confirme disponibilidad y total.";
    $("#shipping-section").hidden = false;
    clearRates();
    try {
      const response = await fetch("/api/shipping/states");
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      const select = document.createElement("select");
      select.name = "state";
      select.setAttribute("aria-label", "Estado");
      select.required = true;
      select.autocomplete = "address-level1";
      select.append(new Option("Selecciona tu estado", ""));
      for (const state of result.states)
        select.append(new Option(state.name, state.code));
      $("#state-text").replaceWith(select);
    } catch {
      $("#shipping-message").textContent =
        "No se pudieron cargar los estados. Recarga la página para intentar de nuevo.";
      $("#quote-shipping").disabled = true;
    }
  }
}
form.addEventListener("input", (e) => {
  if (config?.shipping?.enabled && e.target.name !== "shipping-service")
    clearRates();
});
$("#quote-shipping").onclick = async () => {
  if (!form.reportValidity()) return;
  clearRates();
  const button = $("#quote-shipping");
  button.disabled = true;
  $("#shipping-message").textContent =
    "Consultando cobertura y tarifas de FedEx…";
  try {
    const customerSnapshot = JSON.stringify(
      Object.fromEntries(new FormData(form)),
    );
    const response = await fetch("/api/shipping/rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer: JSON.parse(customerSnapshot),
        items,
        consent: true,
      }),
    });
    const result = await response.json();
    if (!response.ok)
      throw Error(result.error || "No se pudo cotizar el envío.");
    if (
      customerSnapshot !==
      JSON.stringify(Object.fromEntries(new FormData(form)))
    )
      throw Error(
        "Cambiaste tus datos durante la consulta. Vuelve a cotizar FedEx.",
      );
    for (const rate of result.rates) {
      const label = document.createElement("label"),
        radio = document.createElement("input"),
        span = document.createElement("span");
      label.className = "shipping-option";
      radio.type = "radio";
      radio.name = "shipping-service";
      radio.value = rate.id;
      span.textContent = `${rate.description} · ${money(rate.shippingCents)}${rate.deliveryEstimate ? " · Estimado: " + rate.deliveryEstimate : ""}`;
      radio.onchange = () => {
        selectedRate = rate;
        $("#shipping-summary").textContent =
          `Envío FedEx: ${money(rate.shippingCents)}\nTotal: ${money(subtotal() + rate.shippingCents)}`;
        $("#shipping-summary").className = "shipping-total";
        $("#submit-order").disabled = false;
      };
      label.append(radio, span);
      $("#shipping-rates").append(label);
    }
    $("#shipping-message").textContent =
      "Selecciona un servicio. La cotización vence en 15 minutos.";
  } catch (e) {
    $("#shipping-message").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#order-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!config?.enabled) return;
  if (
    config.shipping?.enabled &&
    (!selectedRate || Date.parse(selectedRate.expiresAt) <= Date.now())
  ) {
    clearRates();
    $("#shipping-message").textContent =
      "Vuelve a cotizar FedEx antes de enviar la solicitud.";
    return;
  }
  const button = $("#submit-order");
  button.disabled = true;
  button.textContent = "Guardando solicitud…";
  const data = Object.fromEntries(new FormData(e.currentTarget));
  try {
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestKey: key,
        // The exact variant is sent when known; the server still validates
        // existence, price and stock before creating the order.
        items: items.map((p) => ({
          size: p.size,
          qty: p.qty,
          ...(typeof p.variantId === "string" && p.variantId ? { variantId: p.variantId } : {}),
          ...(typeof p.productId === "string" && p.productId ? { productId: p.productId } : {}),
        })),
        customer: data,
        consent: data.consent === "on",
        shippingQuoteId: selectedRate?.id,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "No se pudo guardar.");
    if (!/^OF-[A-F0-9]{12}$/.test(result.id ?? "")) throw Error("No pudimos confirmar la referencia de la solicitud.");
    orderReference = result.id;
    $("#order-reference").textContent = "Tu referencia: " + result.id;
    $("#support-order").href = "contacto.html?pedido=" + encodeURIComponent(result.id);
    $("#whatsapp-order").href =
      "https://wa.me/" +
      config.whatsapp +
      "?text=" +
      encodeURIComponent(
        `Hola, quiero dar seguimiento a mi solicitud OFFCODE ${result.id}. Quedo pendiente de confirmar disponibilidad y envío antes de transferir.`,
      );
    $("#order-form").hidden = true;
    $("#order-success").hidden = false;
    $("#availability").textContent =
      "Solicitud guardada. Aún no es una compra confirmada.";
    $("#order-success").focus();
    sessionStorage.removeItem("offcode-bag");
    sessionStorage.removeItem("offcode-request-key");
  } catch (error) {
    $("#availability").textContent =
      error.message + " Tu selección sigue disponible para reintentar.";
  } finally {
    button.disabled = false;
    if (config.shipping?.enabled && !selectedRate) button.disabled = true;
    button.textContent = "Solicitar pedido →";
  }
});
init();
