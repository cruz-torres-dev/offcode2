// Customer identity only. No owner/admin credentials or localStorage tokens.
const root = document.querySelector("#account-root");
const dialog = document.querySelector("#account-dialog");
const toggle = document.querySelector("#account-toggle");
let session = { user: null, emailEnabled: false }, mode = "login", linkToken = "";
const fragment = new URLSearchParams(location.hash.slice(1));
if (location.pathname.endsWith("cuenta.html")) {
  if (fragment.has("verify")) { mode = "verify"; linkToken = fragment.get("verify"); }
  if (fragment.has("reset")) { mode = "reset"; linkToken = fragment.get("reset"); }
  if (["verify", "reset"].some((k) => fragment.has(k))) history.replaceState(null, "", location.pathname);
}
async function api(path, data, method = "POST") {
  const r = await fetch("/api/customer/" + path, data === undefined ? { credentials: "same-origin" } : {
    method, credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const result = await r.json();
  if (!r.ok) throw Error(result.error || "No pudimos completar la solicitud.");
  return result;
}
function message(value) { root.querySelector("[data-status]").textContent = value; }
const base = () => `<div class="account-heading"><h2 id="account-title">Tu cuenta</h2>${dialog ? '<button type="button" data-close aria-label="Cerrar cuenta">×</button>' : '<a href="index.html" aria-label="Volver a la tienda">↗</a>'}</div><p data-status role="status" aria-live="polite"></p><div data-content></div>`;
function fillBase() {
  root.innerHTML = base();
  root.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
  queueMicrotask(() => {
    if (dialog?.open && !dialog.contains(document.activeElement)) root.querySelector("button, input, a")?.focus();
  });
  return root.querySelector("[data-content]");
}
async function action(button, fn) {
  button.disabled = true; message("Un momento…");
  try { await fn(); } catch (e) { message(e.message); }
  finally { button.disabled = false; }
}
function render() {
  const content = fillBase();
  if (session.user && !["verify", "reset"].includes(mode)) {
    content.innerHTML = `<p data-email></p><p data-verified></p><div class="account-links"><button data-profile>Mi perfil</button><button data-orders>Mis pedidos</button><button data-logout>Cerrar sesión</button></div><div data-detail></div>`;
    content.querySelector("[data-email]").textContent = session.user.email;
    content.querySelector("[data-verified]").textContent = session.user.verified ? "Correo verificado" : "Verifica tu correo para acceder a tu perfil y tus pedidos.";
    if (!session.user.verified) {
      const resend = document.createElement("button"); resend.textContent = "Solicitar verificación";
      resend.onclick = () => action(resend, async () => message((await api("verification", { email: session.user.email })).message)); content.append(resend);
    }
    content.querySelector("[data-logout]").onclick = (e) => action(e.currentTarget, async () => {
      await api("logout", {}); session.user = null; mode = "login"; render(); message("Has cerrado sesión.");
    });
    content.querySelector("[data-profile]").onclick = (e) => action(e.currentTarget, profile);
    content.querySelector("[data-orders]").onclick = (e) => action(e.currentTarget, orders);
    return;
  }
  if (mode === "verify") {
    content.innerHTML = '<p>Confirma que esta dirección de correo es tuya.</p><button class="account-primary" data-confirm>Verificar mi correo</button>';
    content.querySelector("button").onclick = (e) => action(e.currentTarget, async () => {
      const result = await api("verify", { token: linkToken }); linkToken = ""; mode = "login"; await load(); message(result.message);
    }); return;
  }
  const titles = { login: "Entrar", register: "Crear cuenta", recover: "Enviar enlace de recuperación", reset: "Guardar nueva contraseña" };
  content.innerHTML = `<form class="account-form">${mode !== "reset" ? '<label>Correo electrónico<input name="email" type="email" autocomplete="username" maxlength="254" required></label>' : ""}
    ${mode !== "recover" ? `<label>${mode === "reset" ? "Nueva contraseña" : "Contraseña"}<input name="password" type="password" autocomplete="${mode === "login" ? "current-password" : "new-password"}" minlength="12" maxlength="128" required></label>` : ""}
    <button class="account-primary" type="submit">${titles[mode]}</button></form>
    <div class="account-links"><button data-mode="login">Iniciar sesión</button><button data-mode="register">Crear cuenta</button><button data-mode="recover">Recuperar contraseña</button></div>
    <p class="account-note">La cuenta de cliente es independiente del panel del propietario. Verifica tu correo antes de consultar datos personales.</p>`;
  if (!session.emailEnabled && mode !== "login" && mode !== "reset") message("El envío de enlaces por correo aún no está habilitado. No se puede completar este paso hasta configurarlo.");
  content.querySelectorAll("[data-mode]").forEach((b) => b.onclick = () => { mode = b.dataset.mode; render(); });
  const form = content.querySelector("form");
  form.onsubmit = (e) => {
    e.preventDefault(); const data = Object.fromEntries(new FormData(form)), button = form.querySelector("button"), submittedMode = mode;
    if (form.elements.password) form.elements.password.value = "";
    action(button, async () => {
      const result = await api(submittedMode, { ...data, ...(submittedMode === "reset" ? { token: linkToken } : {}) });
      if (submittedMode === "login") { session.user = result.user; render(); message("Sesión iniciada."); }
      else { if (submittedMode === "reset") { linkToken = ""; mode = "login"; render(); } message(result.message); }
    });
  };
}
async function profile() {
  const data = await api("profile"), detail = root.querySelector("[data-detail]");
  detail.innerHTML = `<h3>Mi perfil</h3><form class="account-form" data-profile-form><label>Nombre<input name="name" autocomplete="name" minlength="3" maxlength="100" required></label><label><input name="saveAddress" type="checkbox"> Guardar una dirección de entrega</label><fieldset data-address><legend>Dirección privada</legend>${[["phone", "Teléfono", "tel"], ["street", "Calle y número", "text"], ["neighborhood", "Colonia", "text"], ["city", "Ciudad", "text"], ["state", "Estado", "text"], ["postalCode", "Código postal", "text"]].map(([key, title, type]) => `<label>${title}<input name="${key}" type="${type}" maxlength="150"></label>`).join("")}</fieldset><button class="account-primary">Guardar perfil</button></form>`;
  const form = detail.querySelector("form"); form.elements.name.value = data.user.name;
  form.elements.saveAddress.checked = !!data.address;
  for (const [key, value] of Object.entries(data.address ?? {})) if (form.elements[key] && key !== "email") form.elements[key].value = value;
  const sync = () => { form.querySelector("fieldset").disabled = !form.elements.saveAddress.checked; };
  form.elements.saveAddress.onchange = sync; sync(); message("");
  form.onsubmit = (e) => { e.preventDefault(); const values = Object.fromEntries(new FormData(form)); action(form.querySelector("button"), async () => {
    const result = await api("profile", { name: values.name, address: values.saveAddress ? values : null }, "PATCH"); session.user = result.user; message("Perfil guardado.");
  }); };
}
async function orders() {
  const data = await api("orders"), detail = root.querySelector("[data-detail]");
  detail.innerHTML = "<h3>Mis pedidos</h3><p>Se muestran los pedidos nuevos creados con esta sesión verificada y el mismo correo de compra. Las solicitudes anteriores no se vinculan automáticamente.</p>";
  const labels = { requested: "Por confirmar", awaiting_transfer: "Pendiente de transferencia", paid: "Pago verificado", shipped: "Enviado", delivered: "Entregado", cancelled: "Cancelado" };
  for (const order of data.orders) {
    const row = document.createElement("article"); row.className = "customer-order";
    const title = document.createElement("h4"); title.textContent = order.id;
    const state = document.createElement("p"); state.textContent = labels[order.status] || order.status;
    row.append(title, state);
    for (const item of order.items) { const line = document.createElement("p"); line.textContent = `${item.name || "OFFCODE"} · ${item.color || ""} · ${item.size} · ${item.qty} unidad(es)`; row.append(line); }
    if (order.tracking) { const tracking = document.createElement("p"); tracking.textContent = "Rastreo: " + order.tracking; row.append(tracking); }
    detail.append(row);
  }
  if (!data.orders.length) { const empty = document.createElement("p"); empty.textContent = "Todavía no hay pedidos vinculados a tu cuenta."; detail.append(empty); }
  message("");
}
async function load() {
  try { session = await api("session"); render(); }
  catch { render(); message("No pudimos conectar con el servidor de cuentas. Intenta más tarde."); }
}
toggle?.addEventListener("click", () => { dialog.showModal(); load(); });
dialog?.addEventListener("click", (e) => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } });
dialog?.addEventListener("close", () => toggle?.focus());
await load();
