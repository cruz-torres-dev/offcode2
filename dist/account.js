// Customer account views. Identity only: no owner/admin credentials, no tokens
// in storage, no customer id read from the URL. The session lives in an
// HttpOnly cookie that only the server can issue or revoke.
const root = document.querySelector("#account-root");
const dialog = document.querySelector("#account-dialog");
const toggle = document.querySelector("#account-toggle");
const fullPage = !dialog;

let session = { user: null, emailEnabled: false };
let view = "home";
let viewParam = "";
let linkToken = "";
let rendered = "";
let busy = false;
let renderVersion = 0;

const money = (cents) => (Number.isSafeInteger(cents) && cents >= 0
  ? new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100)
  : "Por confirmar");
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function longDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("es-MX", { dateStyle: "long", timeStyle: "short" }).format(date);
}
const href = (target) => (fullPage ? "#/" + target : "cuenta.html#/" + target);

class RequestError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
async function api(path, data, method) {
  let response;
  try {
    response = await fetch("/api/customer/" + path, data === undefined && method === undefined
      ? { credentials: "same-origin" }
      : { method: method ?? "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data ?? {}) });
  } catch {
    throw new RequestError("No pudimos conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.");
  }
  let result = null;
  try { result = await response.json(); } catch { result = null; }
  if (!response.ok) {
    // The server only returns user-facing messages; internal failures stay generic.
    throw new RequestError(result?.error || (response.status >= 500
      ? "El servidor no pudo completar la solicitud. Inténtalo más tarde."
      : "No pudimos completar la solicitud."), response.status);
  }
  return result ?? {};
}

function status(value = "", kind = "info") {
  const node = root.querySelector("[data-status]");
  if (!node) return;
  node.textContent = value;
  node.dataset.kind = kind;
}
function frame(title) {
  root.innerHTML = `<div class="account-heading"><h1 id="account-title" tabindex="-1">${esc(title)}</h1>${
    fullPage
      ? `<a class="account-back" href="index.html" aria-label="Volver a la tienda">Tienda ↗</a>`
      : `<button type="button" data-close aria-label="Cerrar cuenta">×</button>`
  }</div>${fullPage && session.user && Object.hasOwn(VIEWS, view) && view !== "home"
    ? `<a class="account-back-link" href="${href("home")}">← Mi cuenta</a>`
    : ""}<p data-status role="status" aria-live="polite"></p><div data-content></div>`;
  root.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
  if (fullPage) document.title = `${title} — OFFCODE`;
  if (rendered !== view + viewParam) {
    rendered = view + viewParam;
    queueMicrotask(() => root.querySelector("#account-title")?.focus());
  }
  return root.querySelector("[data-content]");
}
function loading(title, text) {
  const content = frame(title);
  content.innerHTML = `<p class="account-loading" aria-busy="true">${esc(text)}</p>`;
}
// Every mutation goes through this: one click at a time, visible progress and a
// message the person can act on.
async function action(button, run) {
  if (busy) return;
  busy = true;
  const label = button?.textContent;
  if (button) { button.disabled = true; }
  status("Un momento…");
  try { await run(); }
  catch (error) { status(error?.message || "No pudimos completar la solicitud.", "error"); }
  finally {
    busy = false;
    if (button && button.isConnected) { button.disabled = false; if (label) button.textContent = label; }
  }
}

function renderGuest() {
  if (!["login", "register", "recover", "reset"].includes(view)) view = "login";
  const titles = { login: "Entrar", register: "Crear cuenta", recover: "Recuperar contraseña", reset: "Nueva contraseña" };
  const content = frame(titles[view]);
  content.innerHTML = `<form class="account-form" novalidate>
      ${view !== "reset" ? '<label>Correo electrónico<input name="email" type="email" autocomplete="username" maxlength="254" required></label>' : ""}
      ${view !== "recover" ? `<label>${view === "reset" ? "Nueva contraseña" : "Contraseña"}<input name="password" type="password" autocomplete="${view === "login" ? "current-password" : "new-password"}" minlength="12" maxlength="128" required></label>` : ""}
      <button class="account-primary" type="submit">${titles[view]}</button>
    </form>
    <div class="account-links">
      ${view !== "login" ? '<button type="button" data-mode="login">Iniciar sesión</button>' : ""}
      ${view !== "register" ? '<button type="button" data-mode="register">Crear cuenta</button>' : ""}
      ${view !== "recover" ? '<button type="button" data-mode="recover">Recuperar contraseña</button>' : ""}
    </div>
    <p class="account-note">La cuenta de cliente es independiente del panel del propietario. Verifica tu correo antes de consultar datos personales.</p>`;
  if (!session.emailEnabled && ["register", "recover", "reset"].includes(view))
    status("El envío de enlaces por correo aún no está habilitado. Este paso no puede completarse hasta configurarlo.", "error");
  content.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => { view = button.dataset.mode; viewParam = ""; render(); });
  });
  const form = content.querySelector("form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (form.elements.password) form.elements.password.value = "";
    action(form.querySelector("button"), async () => {
      const submitted = view;
      const result = await api(submitted, { ...data, ...(submitted === "reset" ? { token: linkToken } : {}) });
      if (submitted === "login") {
        session.user = result.user; view = "home"; linkToken = ""; await render(); status("Sesión iniciada.");
      } else if (submitted === "reset") {
        linkToken = ""; view = "login"; await render(); status(result.message);
      } else {
        status(result.message);
      }
    });
  });
}

function renderToken() {
  const copy = {
    verify: ["Verificar correo", "Confirma que esta dirección de correo es tuya.", "Verificar mi correo"],
    reset: ["Nueva contraseña", "Elige una contraseña de 12 a 128 caracteres.", "Guardar contraseña"],
    email: ["Confirmar nuevo correo", "Confirma la nueva dirección de tu cuenta. Tu correo actual sigue activo hasta que lo hagas.", "Confirmar dirección"],
  }[view];
  const content = frame(copy[0]);
  content.innerHTML = `<p>${esc(copy[1])}</p>${view === "reset"
    ? '<form class="account-form"><label>Nueva contraseña<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="account-primary" type="submit">Guardar contraseña</button></form>'
    : `<button class="account-primary" type="button" data-confirm>${esc(copy[2])}</button>`}`;
  const submit = async (button) => {
    const result = view === "reset"
      ? await api("reset", { token: linkToken, password: button.form.elements.password.value })
      : await api(view === "email" ? "email/confirm" : "verify", { token: linkToken });
    linkToken = ""; view = "login"; rendered = "";
    await refresh();
    await render();
    status(result.message);
  };
  content.querySelector("form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    action(button, () => submit(button));
  });
  content.querySelector("[data-confirm]")?.addEventListener("click", (event) => action(event.currentTarget, () => submit(event.currentTarget)));
}

function renderHome() {
  const content = frame("Tu cuenta");
  const user = session.user;
  content.innerHTML = `<p class="account-email">${esc(user.email)}</p>
    <p class="account-badge ${user.verified ? "is-ok" : "is-warn"}">${user.verified ? "Correo verificado" : "Correo sin verificar"}</p>
    ${user.verified ? "" : '<p class="account-note">Verifica tu correo para consultar tu perfil y tus pedidos.</p><button type="button" class="account-link-button" data-resend>Solicitar enlace de verificación</button>'}
    <nav class="account-nav" aria-label="Secciones de tu cuenta">
      ${user.verified ? `<a href="${href("pedidos")}">Pedidos<span aria-hidden="true">→</span></a>
      <a href="${href("perfil")}">Perfil<span aria-hidden="true">→</span></a>
      <a href="${href("direcciones")}">Direcciones<span aria-hidden="true">→</span></a>
      <a href="${href("preferencias")}">Preferencias<span aria-hidden="true">→</span></a>` : ""}
      <a href="${href("seguridad")}">Seguridad<span aria-hidden="true">→</span></a>
    </nav>
    <button type="button" class="account-secondary" data-logout>Cerrar sesión</button>`;
  content.querySelector("[data-logout]").addEventListener("click", (event) =>
    action(event.currentTarget, async () => {
      await api("logout", {});
      session.user = null; view = "login"; rendered = ""; await render(); status("Has cerrado sesión.");
    }));
  content.querySelector("[data-resend]")?.addEventListener("click", (event) =>
    action(event.currentTarget, async () => {
      const result = await api("verification", { email: user.email });
      status(result.message);
    }));
}

async function renderOrders(version) {
  loading("Mis pedidos", "Cargando tus pedidos…");
  const data = await api("orders");
  if (version !== renderVersion) return;
  const content = frame("Mis pedidos");
  if (!data.orders.length) {
    content.innerHTML = `<div class="empty-state">
      <p>Todavía no hay pedidos vinculados a tu cuenta.</p>
      <p class="account-note">Los pedidos que envíes con esta sesión verificada se guardan aquí. Las solicitudes hechas sin iniciar sesión no se vinculan automáticamente.</p>
      <a class="account-primary" href="index.html#collection">Volver a la tienda</a>
    </div>`;
    return;
  }
  const list = document.createElement("ol");
  list.className = "order-list";
  for (const order of data.orders) {
    const item = document.createElement("li");
    item.className = "customer-order";
    const pieces = order.items.reduce((sum, line) => sum + line.qty, 0);
    item.innerHTML = `<div class="order-head">
        <h2 class="order-id">${esc(order.id)}</h2>
        <span class="order-badge" data-state="${esc(order.status)}">${esc(order.statusLabel)}</span>
      </div>
      <p class="order-meta">${esc(longDate(order.createdAt))}</p>
      <p class="order-meta">${pieces} ${pieces === 1 ? "prenda" : "prendas"} · ${esc(order.payment.label)} · ${esc(order.shipping.label)}</p>
      <div class="order-foot">
        <p class="order-total">${esc(money(order.totalCents))}</p>
        <a class="order-link" href="${href("pedidos/" + order.id)}">Ver detalle<span aria-hidden="true">→</span></a>
      </div>`;
    list.append(item);
  }
  content.append(list);
}

async function renderOrderDetail(version) {
  if (!/^OF-[A-F0-9]{12}$/.test(viewParam)) { view = "pedidos"; viewParam = ""; return renderOrders(version); }
  loading("Detalle del pedido", "Cargando el pedido…");
  const { order } = await api("orders/" + viewParam);
  if (version !== renderVersion) return;
  const content = frame("Pedido");
  if (fullPage) document.title = `Pedido ${order.id} — OFFCODE`;
  const rows = order.items.map((line) => `<li class="order-line">
      <span class="order-line-name">${esc(line.name || "OFFCODE")}</span>
      <span class="order-line-detail">${[line.color, line.size ? "Talla " + line.size : "", line.qty + " ×"].filter(Boolean).map(esc).join(" · ")} ${esc(money(line.unitCents))}</span>
    </li>`).join("");
  content.innerHTML = `<a class="account-back-link" href="${href("pedidos")}">← Todos mis pedidos</a>
    <div class="order-head"><p class="order-id">${esc(order.id)}</p><span class="order-badge" data-state="${esc(order.status)}">${esc(order.statusLabel)}</span></div>
    <p class="order-meta">${esc(longDate(order.createdAt))}</p>
    <section class="order-section" aria-label="Estado del pago y del envío">
      <h2>Pago</h2><p>${esc(order.payment.label)}</p>
      ${order.cancellationReason === "unpaid_transfer_expired" ? '<p class="account-note">La reserva venció sin aviso de transferencia ni pago verificado. La solicitud fue cancelada; inicia una nueva solicitud para consultar disponibilidad. Si ya transferiste, contacta a OFFCODE.</p><a class="order-link" href="index.html#collection">Iniciar una nueva solicitud ↗</a>' : ""}
      ${order.status === "awaiting_transfer" ? `<p class="account-note">${order.transferReport
        ? "Recibimos tu aviso de transferencia. Estamos verificando el depósito; el pago se confirma solo después de comprobarlo en el banco."
        : "Transfiere el total exacto con el concepto indicado y después avísanos desde la página del pedido."}</p>
      <p><a class="order-link" href="checkout.html?pedido=${encodeURIComponent(order.id)}">${order.transferReport ? "Ver datos de transferencia" : "Ver datos de transferencia y avisar pago"}<span aria-hidden="true">→</span></a></p>` : ""}
      <h2>Envío</h2><p>${esc(order.shipping.label)}${order.shipping.description ? " · " + esc(order.shipping.description) : ""}</p>
      ${order.shipping.estimate ? `<p class="account-note">Entrega estimada: ${esc(order.shipping.estimate)}</p>` : ""}
      ${order.shipping.tracking ? `<p>${order.shipping.carrier ? "Guía " + esc(order.shipping.carrier) : "Guía"}: ${order.shipping.trackingUrl
        ? `<a href="${esc(order.shipping.trackingUrl)}" rel="noopener noreferrer" target="_blank">${esc(order.shipping.tracking)} ↗</a>`
        : esc(order.shipping.tracking)}</p>` : ""}
    </section>
    <section class="order-section" aria-label="Artículos"><h2>Artículos</h2><ul class="order-lines">${rows}</ul></section>
    <section class="order-section" aria-label="Importes">
      <h2>Importes</h2>
      <dl class="order-totals">
        <div><dt>Subtotal</dt><dd>${esc(money(order.subtotalCents))}</dd></div>
        <div><dt>Envío</dt><dd>${esc(money(order.shippingCents))}</dd></div>
        <div><dt>Total</dt><dd>${esc(money(order.totalCents))}</dd></div>
      </dl>
    </section>
    <section class="order-section" aria-label="Dirección de envío">
      <h2>Dirección de envío</h2>
      <p>${esc(order.address.name)}<br>${esc([order.address.street, order.address.number].filter(Boolean).join(" "))}<br>${esc(order.address.neighborhood)}, ${esc(order.address.city)}, ${esc(order.address.state)} ${esc(order.address.postalCode)}<br>${esc(order.address.phone)}</p>
      ${order.address.notes ? `<p class="account-note">Referencias: ${esc(order.address.notes)}</p>` : ""}
    </section>
    <section class="order-section" aria-label="Historial del pedido">
      <h2>Historial</h2>
      <ol class="order-history">${order.history.map((entry) => `<li>${esc(entry.label)} <span class="order-meta">${esc(longDate(entry.at))}</span></li>`).join("")}</ol>
    </section>`;
}

async function renderProfile(version) {
  loading("Mi perfil", "Cargando tu perfil…");
  const data = await api("profile");
  if (version !== renderVersion) return;
  const content = frame("Mi perfil");
  content.innerHTML = `<form class="account-form" data-profile>
      <label>Nombre<input name="name" autocomplete="name" minlength="3" maxlength="100" required value="${esc(data.user.name)}"></label>
      <button class="account-primary" type="submit">Guardar nombre</button>
    </form>
    <section class="order-section" aria-label="Correo de la cuenta">
      <h2>Correo electrónico</h2>
      <p>${esc(data.user.email)} <span class="account-badge ${data.user.verified ? "is-ok" : "is-warn"}">${data.user.verified ? "Verificado" : "Sin verificar"}</span></p>
      <button type="button" class="account-link-button" data-change-email aria-expanded="false" aria-controls="email-change">Cambiar correo</button>
      <div data-email-form id="email-change" hidden>
        <form class="account-form">
          <label>Contraseña actual<input name="password" type="password" autocomplete="current-password" maxlength="128" required></label>
          <label>Nuevo correo<input name="email" type="email" autocomplete="email" maxlength="254" required></label>
          <p class="account-note">Enviaremos un enlace de confirmación a la nueva dirección. El cambio no se aplica hasta que lo confirmes.</p>
          <button class="account-primary" type="submit">Enviar confirmación</button>
        </form>
      </div>
    </section>
    <section class="order-section" aria-label="Direcciones guardadas">
      <h2>Direcciones</h2>
      <p class="account-note">${data.address ? `Predeterminada: ${esc(data.address.street)} ${esc(data.address.number)}, ${esc(data.address.city)}.` : "Todavía no guardas una dirección de envío."}</p>
      <a class="account-link-button" href="${href("direcciones")}">Administrar direcciones</a>
    </section>`;
  const form = content.querySelector("[data-profile]");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(form.querySelector("button"), async () => {
      const result = await api("profile", { name: form.elements.name.value }, "PATCH");
      session.user = result.user;
      status("Perfil guardado.");
    });
  });
  const block = content.querySelector("[data-email-form]");
  content.querySelector("[data-change-email]").addEventListener("click", (event) => {
    block.hidden = !block.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!block.hidden));
    if (!block.hidden) block.querySelector("input[name=email]").focus();
  });
  block.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const emailForm = event.currentTarget, button = emailForm.querySelector("button");
    const values = Object.fromEntries(new FormData(emailForm));
    emailForm.elements.password.value = "";
    action(button, async () => {
      const result = await api("email", values);
      block.hidden = true;
      status(result.message);
    });
  });
}

async function renderAddresses(version) {
  loading("Direcciones", "Cargando tus direcciones…");
  const data = await api("addresses");
  if (version !== renderVersion) return;
  const content = frame("Direcciones");
  const fields = [["label", "Etiqueta (Casa, Oficina)", "text", 40], ["name", "Nombre de quien recibe", "text", 100],
    ["phone", "Teléfono", "tel", 15], ["street", "Calle y número", "text", 150], ["number", "Número exterior e interior", "text", 30],
    ["neighborhood", "Colonia", "text", 100], ["city", "Ciudad", "text", 100], ["state", "Estado", "text", 60], ["postalCode", "Código postal", "text", 5],
    ["notes", "Referencias (opcional)", "text", 300]];
  const formHtml = (saved) => {
    const value = saved ?? {};
    return `<form class="account-form" data-address-form>
      ${fields.map(([key, label, type, max]) => `<label>${label}<input name="${key}" type="${type}" maxlength="${max}" ${["name", "phone", "street", "neighborhood", "city", "state", "postalCode"].includes(key) ? "required" : ""} value="${esc(value[key] ?? "")}"></label>`).join("")}
      <label class="account-check"><input name="isDefault" type="checkbox" ${value.isDefault ? "checked" : ""}> Usar como dirección predeterminada</label>
      <div class="account-actions"><button class="account-primary" type="submit">Guardar dirección</button><button type="button" class="account-secondary" data-cancel>Cancelar</button></div>
    </form>`;
  };
  content.innerHTML = `<div data-list></div>
    <div data-editor hidden></div>
    <button type="button" class="account-primary" data-add>Añadir dirección</button>`;
  const list = content.querySelector("[data-list]"), editor = content.querySelector("[data-editor]");
  const addButton = content.querySelector("[data-add]");

  function closeEditor() { editor.hidden = true; editor.innerHTML = ""; addButton.hidden = false; }

  function openEditor(address) {
    addButton.hidden = true;
    editor.hidden = false;
    editor.innerHTML = `<h2 class="account-subtitle">${address ? "Editar dirección" : "Nueva dirección"}</h2>${formHtml(address)}`;
    const form = editor.querySelector("form");
    editor.querySelector("[data-cancel]").addEventListener("click", closeEditor);
    form.elements.name.focus();
    editor.scrollIntoView({ block: "start" });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const payload = { ...values, isDefault: form.elements.isDefault.checked };
      action(form.querySelector("button"), async () => {
        if (address) await api("addresses/" + address.id, payload, "PATCH");
        else await api("addresses", payload);
        closeEditor();
        await reload();
        status(address ? "Dirección actualizada." : "Dirección guardada.");
      });
    });
  }

  function paint() {
    list.innerHTML = data.addresses.length ? "" : `<p class="account-note">Todavía no guardas direcciones de envío. Se usan solo si tú lo autorizas al pagar; nunca modifican pedidos anteriores.</p>`;
    for (const address of data.addresses) {
      const card = document.createElement("article");
      card.className = "address-card";
      card.innerHTML = `<div class="order-head"><h2 class="order-id">${esc(address.label || "Dirección")}</h2>${address.isDefault ? '<span class="account-badge is-ok">Predeterminada</span>' : ""}</div>
        <p>${esc(address.name)}<br>${esc([address.street, address.number].filter(Boolean).join(" "))}<br>${esc(address.neighborhood)}, ${esc(address.city)}, ${esc(address.state)} ${esc(address.postalCode)}<br>${esc(address.phone)}</p>
        ${address.notes ? `<p class="account-note">${esc(address.notes)}</p>` : ""}
        <div class="account-actions">
          <button type="button" class="account-link-button" data-edit>Editar</button>
          ${address.isDefault ? "" : '<button type="button" class="account-link-button" data-default>Usar como predeterminada</button>'}
          <button type="button" class="account-link-button is-danger" data-delete>Eliminar</button>
        </div>
        <div data-confirm hidden class="account-confirm" role="group" aria-label="Confirmar eliminación">
          <p>¿Eliminar esta dirección? No cambia los pedidos ya enviados.</p>
          <button type="button" class="account-danger" data-confirm-delete>Sí, eliminar</button>
          <button type="button" class="account-secondary" data-cancel-delete>Cancelar</button>
        </div>`;
      card.querySelector("[data-edit]").addEventListener("click", () => openEditor(address));
      card.querySelector("[data-default]")?.addEventListener("click", (event) =>
        action(event.currentTarget, async () => {
          await api("addresses/" + address.id + "/default", {});
          await reload();
          status("Dirección predeterminada actualizada.");
        }));
      const confirmBox = card.querySelector("[data-confirm]");
      card.querySelector("[data-delete]").addEventListener("click", () => {
        confirmBox.hidden = false;
        card.querySelector("[data-confirm-delete]").focus();
      });
      card.querySelector("[data-cancel-delete]").addEventListener("click", () => {
        confirmBox.hidden = true;
        card.querySelector("[data-delete]").focus();
      });
      card.querySelector("[data-confirm-delete]").addEventListener("click", (event) =>
        action(event.currentTarget, async () => {
          await api("addresses/" + address.id, {}, "DELETE");
          await reload();
          status("Dirección eliminada.");
        }));
      list.append(card);
    }
  }

  async function reload() {
    const fresh = await api("addresses");
    data.addresses = fresh.addresses;
    paint();
  }

  paint();
  addButton.addEventListener("click", () => openEditor(null));
}

async function renderPreferences(version) {
  loading("Preferencias", "Cargando tus preferencias…");
  const data = await api("preferences");
  if (version !== renderVersion) return;
  const content = frame("Preferencias");
  const checked = data.marketing === "granted";
  content.innerHTML = `<form class="account-form">
      <label class="account-check"><input name="marketing" type="checkbox" ${checked ? "checked" : ""}> Recibir comunicaciones comerciales por correo</label>
      <p class="account-note">${esc(data.consentText)}</p>
      <p class="account-note">Los correos necesarios sobre tus pedidos (confirmación, pago y envío) no son publicidad y no dependen de esta preferencia. ${data.marketing === "unset" ? "Todavía no has registrado una elección." : ""}</p>
      <button class="account-primary" type="submit">Guardar preferencia</button>
    </form>`;
  const form = content.querySelector("form");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    action(form.querySelector("button"), async () => {
      const result = await api("preferences", { marketing: form.elements.marketing.checked, consentVersion: data.consentVersion }, "PATCH");
      status(result.marketing === "granted" ? "Guardamos tu autorización." : "No enviaremos comunicaciones comerciales.");
    });
  });
}

function renderSecurity() {
  const content = frame("Seguridad");
  content.innerHTML = `<section class="order-section" aria-label="Sesiones">
      <h2>Sesiones</h2>
      <p class="account-note">Tu sesión se guarda en una cookie privada del servidor. Cerrar sesión la invalida de inmediato.</p>
      <button type="button" class="account-secondary" data-logout>Cerrar sesión</button>
      <button type="button" class="account-danger" data-revoke>Cerrar sesión en todos los dispositivos</button>
      <div data-confirm hidden class="account-confirm" role="group" aria-label="Confirmar cierre de sesiones">
        <p>Se cerrará tu sesión en este y en todos los dispositivos donde hayas entrado.</p>
        <button type="button" class="account-danger" data-confirm-revoke>Sí, cerrar todas</button>
        <button type="button" class="account-secondary" data-cancel-revoke>Cancelar</button>
      </div>
    </section>
    <section class="order-section" aria-label="Contraseña">
      <h2>Contraseña</h2>
      <p class="account-note">Te enviaremos un enlace de un solo uso para elegir una contraseña nueva. Al usarlo se cierran todas tus sesiones.</p>
      <button type="button" class="account-link-button" data-recover>Enviar enlace para cambiar mi contraseña</button>
    </section>`;
  content.querySelector("[data-logout]").addEventListener("click", (event) =>
    action(event.currentTarget, async () => {
      await api("logout", {});
      session.user = null; view = "login"; rendered = ""; await render(); status("Has cerrado sesión.");
    }));
  const box = content.querySelector("[data-confirm]");
  content.querySelector("[data-revoke]").addEventListener("click", () => {
    box.hidden = false;
    content.querySelector("[data-confirm-revoke]").focus();
  });
  content.querySelector("[data-cancel-revoke]").addEventListener("click", () => {
    box.hidden = true;
    content.querySelector("[data-revoke]").focus();
  });
  content.querySelector("[data-confirm-revoke]").addEventListener("click", (event) =>
    action(event.currentTarget, async () => {
      const result = await api("sessions/revoke-all", {});
      session.user = null; view = "login"; rendered = ""; await render(); status(result.message);
    }));
  content.querySelector("[data-recover]").addEventListener("click", (event) =>
    action(event.currentTarget, async () => {
      const result = await api("recover", { email: session.user.email });
      status(result.message);
    }));
}

const VIEWS = {
  home: renderHome,
  pedidos: renderOrders,
  perfil: renderProfile,
  direcciones: renderAddresses,
  preferencias: renderPreferences,
  seguridad: renderSecurity,
};

async function render() {
  // A slow response must not replace a newer view after Back, logout or a
  // click on the account icon. Requests still use the normal session checks.
  const version = ++renderVersion;
  try {
    if (["verify", "reset", "email"].includes(view)) return renderToken();
    if (!session.user) return renderGuest();
    if (!VIEWS[view]) { view = "home"; viewParam = ""; }
    if (!session.user.verified && !["home", "seguridad"].includes(view)) {
      view = "home"; viewParam = ""; renderHome();
      status("Verifica tu correo para consultar tu perfil y tus pedidos.", "error");
      return;
    }
    if (view === "pedidos" && viewParam) return await renderOrderDetail(version);
    await VIEWS[view](version);
  } catch (error) {
    if (version !== renderVersion) return;
    if (error?.status === 401) {
      // The session expired or was revoked elsewhere: back to a clean sign-in.
      session.user = null; view = "login"; viewParam = ""; rendered = "";
      renderGuest();
      status("Tu sesión terminó. Inicia sesión de nuevo.", "error");
      return;
    }
    const title = { pedidos: "Mis pedidos", perfil: "Mi perfil", direcciones: "Direcciones", preferencias: "Preferencias", seguridad: "Seguridad" }[view] || "Tu cuenta";
    const content = frame(title);
    content.innerHTML = `<div class="empty-state"><p>No pudimos cargar esta sección.</p><p class="account-note">${esc(error?.message || "Inténtalo de nuevo.")}</p><button type="button" class="account-primary" data-retry>Reintentar</button></div>`;
    content.querySelector("[data-retry]").addEventListener("click", () => render());
  }
}

function readRoute() {
  let raw = location.hash.slice(1);
  try { raw = decodeURIComponent(raw); } catch { return false; }
  // Returning with browser Back can remove the hash altogether. The old
  // header anchor is also accepted for already-open pages and saved links.
  if (!raw || raw === "account-root" || raw === "/") {
    view = "home"; viewParam = "";
    return true;
  }
  for (const key of ["verify", "reset", "email"]) {
    if (raw.startsWith(key + "=")) {
      linkToken = raw.slice(key.length + 1);
      view = key; viewParam = ""; rendered = "";
      // The token never stays in the URL or in the Referer of later requests.
      history.replaceState(null, "", location.pathname + location.search);
      return true;
    }
  }
  if (raw.startsWith("/")) {
    const [name, param] = raw.slice(1).split("/");
    if (name === "home" || Object.hasOwn(VIEWS, name) || name === "pedidos") {
      view = name === "home" ? "home" : name;
      viewParam = param ? decodeURIComponent(param) : "";
      return true;
    }
  }
  return false;
}

async function refresh() {
  try { session = await api("session"); }
  catch { session = { user: null, emailEnabled: false }; status("No pudimos conectar con el servidor de cuentas. Intenta más tarde.", "error"); }
}

readRoute();
await refresh();
render();

window.addEventListener("hashchange", () => {
  if (readRoute()) return render();
});

toggle?.addEventListener("click", async () => {
  if (!dialog.open) dialog.showModal();
  view = "home"; viewParam = ""; rendered = "";
  await refresh(); render();
});
dialog?.addEventListener("click", (event) => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
dialog?.addEventListener("close", () => toggle?.focus());
