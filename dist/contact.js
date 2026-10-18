const form = document.querySelector("#contact-form"), status = document.querySelector("#contact-status");
form.onsubmit = async (event) => {
  event.preventDefault(); const button = form.querySelector("button"); button.disabled = true; status.textContent = "Enviando…";
  try {
    const data = Object.fromEntries(new FormData(form)); data.consent = form.elements.consent.checked;
    const response = await fetch("/api/contact", { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "No pudimos enviar el mensaje.");
    status.textContent = result.message; form.reset();
  } catch(e) { status.textContent = e.message; } finally { button.disabled = false; }
};
