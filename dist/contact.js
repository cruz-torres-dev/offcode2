import { whatsappLink } from "./order-support.js";

const $ = (selector) => document.querySelector(selector);
const form = $("#contact-form"), status = $("#contact-status");
const reference = form.elements.namedItem("orderId");
const initialReference = new URL(location.href).searchParams.get("pedido")?.trim().toUpperCase() ?? "";
if (/^OF-[A-F0-9]{12}$/.test(initialReference)) reference.value = initialReference;
let supportPhone = "";
function refreshWhatsApp() {
  const value = reference.value.trim().toUpperCase();
  const orderId = /^OF-[A-F0-9]{12}$/.test(value) ? value : "";
  const message = orderId ? `Hola OFFCODE, necesito ayuda con mi pedido ${orderId}.` : "Hola OFFCODE, necesito atención sobre un pedido, pago o envío.";
  const href = whatsappLink(supportPhone, message);
  $("#contact-whatsapp-section").hidden = !href;
  if (href) $("#contact-whatsapp").href = href;
  $("#contact-order-context").textContent = orderId ? `Consulta sobre el pedido ${orderId}.` : "Habla con el vendedor sobre tu compra.";
}
reference.addEventListener("input", refreshWhatsApp);
async function initContact() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw Error();
    const config = await response.json();
    supportPhone = config.support?.whatsapp ?? config.whatsapp ?? "";
    refreshWhatsApp();
    const emailEnabled = config.support?.emailEnabled;
    form.hidden = emailEnabled === false;
    $("#contact-email-status").textContent = emailEnabled === false
      ? "La atención por correo todavía no está habilitada. Puedes usar WhatsApp si aparece disponible arriba."
      : "Enviaremos tu consulta al equipo de OFFCODE para que pueda responderte por correo.";
  } catch {
    $("#contact-email-status").textContent = "No pudimos comprobar los canales disponibles. Puedes intentar enviar tu consulta por correo.";
  }
}
form.onsubmit = async (event) => {
  event.preventDefault(); const button = form.querySelector("button"); button.disabled = true; status.textContent = "Enviando…";
  try {
    const data = Object.fromEntries(new FormData(form)); data.consent = form.elements.consent.checked;
    data.orderId = reference.value.trim().toUpperCase();
    const response = await fetch("/api/contact", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "No pudimos enviar el mensaje.");
    status.textContent = result.message;
    const orderId = data.orderId;
    form.reset(); reference.value = orderId; refreshWhatsApp();
  } catch(e) { status.textContent = e.message; } finally { button.disabled = false; }
};
initContact();
