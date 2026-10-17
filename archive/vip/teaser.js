const form = document.querySelector("#vip-form");
const email = document.querySelector("#vip-email");
const consent = document.querySelector("#vip-consent");
const submit = document.querySelector("#vip-submit");
const message = document.querySelector("#vip-message");
const success = document.querySelector("#vip-success");
let config,
  busy = false;

async function configure() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) return;
    config = await response.json();
    if (config.privacyUrl) {
      const privacy = document.querySelector("#vip-privacy");
      privacy.href = config.privacyUrl;
      privacy.hidden = false;
      document.querySelector("#privacy-unavailable").hidden = true;
    }
    if (!config.waitlistEnabled) return;
    email.disabled = consent.disabled = submit.disabled = false;
    message.textContent = "Un correo. El primer aviso del próximo lanzamiento.";
  } catch {
    /* Static preview: never claim that an email was saved. */
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!config?.waitlistEnabled || busy) return;
  busy = true;
  submit.disabled = true;
  email.disabled = consent.disabled = true;
  submit.querySelector("span").textContent = "Guardando tu solicitud…";
  message.textContent = "Un momento…";
  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email.value.trim(),
        consent: consent.checked,
        consentVersion: config.vipConsentVersion,
        website: form.elements.website.value,
      }),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw Error("No pudimos confirmar tu registro. Inténtalo de nuevo.");
    }
    if (!response.ok || !result.ok)
      throw Error(
        result.error || "No pudimos guardar tu solicitud. Inténtalo de nuevo.",
      );
    form.hidden = true;
    success.hidden = false;
    message.textContent = "Registro recibido para la lista VIP.";
    email.value = "";
    consent.checked = false;
    success.focus();
  } catch (error) {
    message.textContent =
      error instanceof TypeError
        ? "No pudimos conectar. Tu registro no se ha confirmado; vuelve a intentarlo."
        : error.message ||
          "No pudimos guardar tu solicitud. Inténtalo de nuevo.";
  } finally {
    busy = false;
    submit.disabled = !config?.waitlistEnabled;
    email.disabled = consent.disabled = !config?.waitlistEnabled;
    submit.querySelector("span").textContent = "Quiero estar dentro";
  }
});
document.querySelector("#vip-reset").onclick = () => {
  success.hidden = true;
  form.hidden = false;
  form.reset();
  message.textContent = "Un correo. El primer aviso del próximo lanzamiento.";
  email.focus();
};
configure();
