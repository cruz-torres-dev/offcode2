const $ = (s) => document.querySelector(s);
const form = $("#settings-form");
let current = null,
  version = 0,
  canSave = false,
  canPreview = false;
const field = (name) => form.elements.namedItem(name);
function lock() {
  current = null;
  form.reset();
  $("#envia-preview-form").reset();
  $("#envia-preview-results").replaceChildren();
  $("#envia-preview-message").textContent = "";
  $("#envia-preview-submit").disabled = true;
  canPreview = false;
  $("#password-form").reset();
  $("#package-profiles").replaceChildren();
  $("#readiness-checks").replaceChildren();
  $("#login").hidden = false;
  $("#settings-panel").hidden = true;
  $("#logout").hidden = true;
}
async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error("El servidor del panel no está disponible.");
  }
  if (response.status === 401) lock();
  if (!response.ok)
    throw Error(data.error || "No se pudo completar la solicitud.");
  return data;
}
function text(tag, value, className) {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  return el;
}
function profile(qty = "", value = {}) {
  const row = document.createElement("div");
  row.className = "package-profile";
  for (const [name, label, min, step, initial] of [
    ["qty", "Cantidad de prendas", "1", "1", qty],
    ["weight", "Peso total (kg)", "0.01", "0.01", value.weight],
    ["length", "Largo (cm)", "0.1", "0.1", value.dimensions?.length],
    ["width", "Ancho (cm)", "0.1", "0.1", value.dimensions?.width],
    ["height", "Alto (cm)", "0.1", "0.1", value.dimensions?.height],
  ]) {
    const l = text("label", label),
      input = document.createElement("input");
    input.type = "number";
    input.dataset.field = name;
    input.required = true;
    input.min = min;
    input.step = step;
    input.max = name === "qty" ? "99" : name === "weight" ? "1000" : "300";
    input.value = initial ?? "";
    l.append(input);
    row.append(l);
  }
  const remove = text("button", "Quitar perfil", "secondary");
  remove.type = "button";
  remove.onclick = () => row.remove();
  row.append(remove);
  $("#package-profiles").append(row);
}
function loadStates(states) {
  for (const select of [field("senderState"), $("#envia-preview-form").elements.namedItem("state")]) {
    const chosen = select.value;
    select.replaceChildren(new Option("Selecciona el estado", ""));
    for (const state of states) select.append(new Option(state.name, state.code));
    if (chosen && !states.some((s) => s.code === chosen))
      select.append(new Option(chosen, chosen));
    select.value = chosen;
  }
}
async function load() {
  const data = await api("/api/admin/settings");
  current = data.settings;
  version = data.version;
  canSave = data.canSave;
  $("#login").hidden = true;
  $("#settings-panel").hidden = false;
  $("#logout").hidden = false;
  form.reset();
  for (const [name, value] of Object.entries({
    whatsapp: current.whatsapp,
    bankName: current.bank.name,
    bankBeneficiary: current.bank.beneficiary,
    bankClabe: current.bank.clabe,
    privacyUrl: current.privacyUrl,
    termsUrl: current.termsUrl,
    enviaEnvironment: current.envia.environment,
    printSize: current.envia.printSize,
  }))
    field(name).value = value;
  for (const [key, name] of Object.entries({
    name: "Name",
    phone: "Phone",
    email: "Email",
    company: "Company",
    street: "Street",
    number: "Number",
    district: "District",
    city: "City",
    postalCode: "PostalCode",
    reference: "Reference",
  }))
    field("sender" + name).value = current.envia.sender[key] ?? "";
  const state = field("senderState");
  state.replaceChildren(
    new Option(
      current.envia.sender.state || "Primero consulta el catálogo de Envia",
      current.envia.sender.state || "",
    ),
  );
  field("ordersEnabled").checked = current.enabled;
  field("ordersEnabled").disabled = data.ordersLockedByEnv;
  $("#orders-lock-message").textContent = data.ordersLockedByEnv
    ? "Recepción cerrada por ORDERS_ENABLED=false. Configurar o consultar Envia no cambia este bloqueo."
    : "La recepción solo cambia al guardar su casilla y cumplir los requisitos de compra.";
  field("enviaEnabled").checked = current.envia.enabled;
  $("#package-profiles").replaceChildren();
  for (const [qty, value] of Object.entries(current.envia.profiles))
    profile(qty, value);
  $("#token-status").textContent = current.envia.tokenConfigured
    ? "Token guardado. Déjalo en blanco para conservarlo; su valor no se devuelve al navegador."
    : "Todavía no hay un token configurado.";
  $("#readiness-checks").replaceChildren();
  for (const check of data.checks) {
    const block = document.createElement("div");
    block.className = "readiness-item";
    block.append(
      text(
        "span",
        check.id === "orders" ? (check.ok ? "Abierta" : "Cerrada") :
          check.optional ? (check.ok ? "Disponibles" : "Opcional") :
          (check.ok ? "Datos presentes" : "Pendiente"),
        check.ok ? "badge ready" : "badge",
      ),
      text("strong", check.label),
      text("p", check.detail, "fine"),
    );
    $("#readiness-checks").append(block);
  }
  $("#save-settings").disabled = !canSave;
  $("#saved-at").textContent = !canSave
    ? "Falta configurar SETTINGS_ENCRYPTION_KEY en las variables privadas del servidor. Puedes revisar los campos, pero todavía no guardar secretos."
    : data.updatedAt
      ? "Último guardado: " + new Date(data.updatedAt).toLocaleString("es-MX")
      : "Al guardar se creará tu configuración privada, que tendrá prioridad sobre los valores iniciales de Render.";
  $("#check-envia").disabled = !current.envia.tokenConfigured;
  const shippingCheck = data.checks.find((check) => check.id === "shipping");
  canPreview = !!shippingCheck?.ok;
  $("#envia-preview-form").reset();
  $("#envia-preview-results").replaceChildren();
  $("#envia-preview-message").textContent = "";
  $("#envia-preview-config").textContent =
    `Entorno guardado: ${current.envia.environment === "production" ? "producción (tarifas reales)" : "Sandbox (tarifas sin validez para envíos)"}. ` +
    (canPreview ? "Consulta el catálogo, selecciona el estado del destino y cotiza una tarifa. Los enlaces legales no son necesarios para esta consulta."
      : shippingCheck?.detail || "Completa y guarda el origen y los empaques antes de cotizar.");
  const select = $("#envia-preview-form").elements.namedItem("variantId");
  select.replaceChildren(new Option("Selecciona una prenda", ""));
  $("#envia-preview-submit").disabled = true;
  try {
    const catalog = await api("/api/catalog");
    for (const product of catalog.products)
      for (const variant of product.variants)
        select.append(new Option(`${product.name} · ${variant.size}`, variant.id));
    $("#envia-preview-submit").disabled = !canPreview || select.options.length < 2;
  } catch (e) {
    $("#envia-preview-message").textContent = e.message;
  }
}
$("#login-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ password: $("#password").value }),
    });
    $("#password").value = "";
    $("#settings-message").textContent = "";
    await load();
  } catch (e) {
    $("#settings-message").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#logout").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    lock();
    $("#settings-message").textContent = "Sesión cerrada.";
  } catch (e) {
    $("#settings-message").textContent = e.message;
  }
};
$("#reload-settings").onclick = () =>
  load().catch((e) => ($("#settings-message").textContent = e.message));
$("#add-package").onclick = () => profile();
$("#check-envia").onclick = async () => {
  const button = $("#check-envia");
  button.disabled = true;
  $("#envia-check-message").textContent =
    "Consultando el catálogo con la configuración guardada…";
  try {
    const data = await api("/api/admin/envia/check", {
      method: "POST",
      body: "{}",
    });
    loadStates(data.states);
    $("#envia-check-message").textContent =
      `Entorno consultado: ${data.environment === "production" ? "producción" : "Sandbox"}. ${data.message}`;
  } catch (e) {
    $("#envia-check-message").textContent = e.message;
  } finally {
    button.disabled = !current?.envia.tokenConfigured;
  }
};
$("#envia-preview-form").onsubmit = async (e) => {
  e.preventDefault();
  if (!current || !canPreview) return;
  const button = $("#envia-preview-submit");
  button.disabled = true;
  $("#envia-preview-results").replaceChildren();
  $("#envia-preview-message").textContent = "Consultando solo tarifas con la configuración guardada…";
  try {
    const { variantId, qty, ...customer } = Object.fromEntries(new FormData(e.currentTarget));
    const data = await api("/api/admin/envia/rates", {
      method: "POST",
      body: JSON.stringify({ version, variantId, qty: Number(qty), customer }),
    });
    $("#envia-preview-message").textContent =
      `${data.environment === "production" ? "Producción: tarifas reales." : "Sandbox: tarifas sin validez para envíos."} ${data.message}`;
    const money = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
    for (const rate of data.rates) {
      $("#envia-preview-results").append(text("p",
        `${rate.description} (${rate.service}): ${money.format(rate.shippingCents / 100)} MXN` +
        (rate.deliveryEstimate ? ` · Estimación de transporte: ${rate.deliveryEstimate}` : "")));
    }
  } catch (e) {
    $("#envia-preview-message").textContent = e.message;
  } finally {
    button.disabled = !current || !canPreview;
  }
};
form.onsubmit = async (e) => {
  e.preventDefault();
  if (!current || !canSave) return;
  const button = $("#save-settings");
  button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form)),
      profiles = {};
    for (const row of $("#package-profiles").children) {
      const get = (name) =>
          Number(row.querySelector(`[data-field="${name}"]`).value),
        qty = get("qty");
      if (Object.hasOwn(profiles, String(qty)))
        throw Error(
          "Cada cantidad de prendas debe tener un solo perfil de empaque.",
        );
      profiles[qty] = {
        weight: get("weight"),
        dimensions: {
          length: get("length"),
          width: get("width"),
          height: get("height"),
        },
      };
    }
    const sender = { country: "MX" };
    for (const [key, name] of Object.entries({
      name: "Name",
      phone: "Phone",
      email: "Email",
      company: "Company",
      street: "Street",
      number: "Number",
      district: "District",
      city: "City",
      state: "State",
      postalCode: "PostalCode",
      reference: "Reference",
    }))
      sender[key] = values["sender" + name];
    const settings = {
      enabled: field("ordersEnabled").checked,
      whatsapp: values.whatsapp,
      bank: {
        name: values.bankName,
        beneficiary: values.bankBeneficiary,
        clabe: values.bankClabe,
      },
      privacyUrl: values.privacyUrl,
      termsUrl: values.termsUrl,
      envia: {
        enabled: field("enviaEnabled").checked,
        environment: values.enviaEnvironment,
        token: values.enviaToken,
        clearToken: field("clearToken").checked,
        printSize: values.printSize,
        sender,
        profiles,
      },
    };
    await api("/api/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({
        version,
        settings,
        currentPassword: values.currentPassword,
      }),
    });
    await load();
    $("#settings-message").textContent =
      "Configuración guardada. Los cambios ya están disponibles; vuelve a cotizar los pedidos que estaban en preparación.";
  } catch (e) {
    $("#settings-message").textContent = e.message;
  } finally {
    field("currentPassword").value = "";
    button.disabled = !canSave;
  }
};
$("#password-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(e.currentTarget));
    if (data.newPassword !== data.confirmPassword)
      throw Error("Las nuevas contraseñas no coinciden.");
    await api("/api/admin/password", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    lock();
    $("#settings-message").textContent =
      "Contraseña actualizada. Vuelve a entrar con tu nueva contraseña.";
  } catch (e) {
    $("#settings-message").textContent = e.message;
  } finally {
    $("#password-form").reset();
    button.disabled = false;
  }
};
load().catch((e) => {
  if (!e.message.includes("Inicia sesión"))
    $("#settings-message").textContent = e.message;
});
