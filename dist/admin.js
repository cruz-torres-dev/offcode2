const $ = (s) => document.querySelector(s);
const money = (c) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    c / 100,
  ) + " MXN";
let page = 0,
  loaded = [],
  bank = {},
  labels = {},
  shipping = {};
async function api(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let data;
  try {
    data = await r.json();
  } catch {
    throw Error("El servidor de pedidos no está disponible.");
  }
  if (r.status === 401) {
    loaded = [];
    bank = {};
    $("#orders").replaceChildren();
    $("#overview").replaceChildren();
    $("#login").hidden = false;
    $("#dashboard").hidden = true;
    $("#logout").hidden = true;
  }
  if (!r.ok) throw Error(data.error || "No se pudo completar.");
  return data;
}
function text(tag, content, className) {
  const el = document.createElement(tag);
  el.textContent = content;
  if (className) el.className = className;
  return el;
}
function input(label, type = "text", value = "") {
  const l = text("label", label),
    i = document.createElement("input");
  i.type = type;
  i.value = value;
  l.append(i);
  return { label: l, input: i };
}
function fieldCheck(label) {
  const l = document.createElement("label");
  l.className = "check";
  const i = document.createElement("input");
  i.type = "checkbox";
  i.required = true;
  l.append(i, text("span", label));
  return { label: l, input: i };
}
let loadRevision = 0;
async function load() {
  const revision = ++loadRevision;
  const params = new URLSearchParams({
    page: String(page),
    q: $("#search").value,
    status: $("#status-filter").value,
  });
  const data = await api("/api/admin/orders?" + params);
  const overview = await api("/api/admin/overview");
  if (revision !== loadRevision) return;
  $("#overview").replaceChildren();
  for (const [label, value] of [
    ["Por confirmar", overview.counts.requested],
    ["Pendientes de pago", overview.counts.awaiting_transfer],
    ["Por despachar", overview.counts.paid],
    ["Enviados", overview.counts.shipped],
  ]) {
    const block = document.createElement("div");
    block.append(text("span", label), text("strong", String(value)));
    $("#overview").append(block);
  }
  loaded = data.orders;
  bank = data.bank;
  labels = data.labels;
  shipping = data.shipping ?? {};
  $("#shipping-status").textContent = shipping.enabled
    ? `Envia configurado · Solo FedEx · ${shipping.environment === "sandbox" ? "PRUEBAS: guías sin validez para enviar" : "Producción: comprar una guía genera un cargo en Envia"}.`
    : "Envia pendiente de configuración. Solo puedes registrar guías FedEx compradas por separado.";
  $("#login").hidden = true;
  $("#dashboard").hidden = false;
  $("#logout").hidden = false;
  $("#next").disabled = !data.more;
  $("#previous").disabled = page === 0;
  $("#page-number").textContent = "Página " + (page + 1);
  $("#page-summary").textContent =
    `${data.total} ${data.total === 1 ? "pedido encontrado" : "pedidos encontrados"} · ${loaded.length} en esta página.`;
  render();
}
async function shippingAction(order, action, data, button) {
  button.disabled = true;
  try {
    const result = await api(`/api/admin/orders/${order.id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ version: order.version, ...data }),
    });
    if (action !== "shipping-rates") {
      $("#admin-message").textContent =
        "Guía guardada. Marca enviado únicamente después de entregar el paquete a FedEx.";
      await load();
    }
    return result;
  } catch (e) {
    $("#admin-message").textContent = e.message;
    if (action !== "shipping-rates") await load().catch(() => {});
  } finally {
    button.disabled = false;
  }
}
function quoteChoices(card, order, onSelect) {
  const block = document.createElement("div"),
    list = document.createElement("div");
  const button = text(
    "button",
    "Consultar tarifas actuales de FedEx",
    "secondary",
  );
  button.type = "button";
  button.onclick = async () => {
    list.replaceChildren();
    onSelect(null);
    const result = await shippingAction(order, "shipping-rates", {}, button);
    if (!result) return;
    const rates = result.rates.filter(
      (r) =>
        order.status !== "paid" ||
        !order.shipping?.service ||
        r.service === order.shipping.service,
    );
    if (!rates.length)
      list.append(
        text(
          "p",
          "El servicio acordado no está disponible. Revisa el pedido con el cliente antes de continuar.",
        ),
      );
    for (const rate of rates) {
      const label = document.createElement("label"),
        radio = document.createElement("input");
      label.className = "shipping-option";
      radio.type = "radio";
      radio.name = "quote-" + order.id;
      label.append(
        radio,
        text(
          "span",
          `${rate.description} · ${money(rate.shippingCents)}${rate.deliveryEstimate ? " · Estimado: " + rate.deliveryEstimate : ""}`,
        ),
      );
      radio.onchange = () => onSelect(rate);
      list.append(label);
    }
    list.append(
      text(
        "p",
        "Cotización válida durante 15 minutos. El costo puede diferir del acordado antes de la transferencia.",
        "fine",
      ),
    );
  };
  block.append(button, list);
  card.append(block);
}
function labelDetails(card, order) {
  const job = order.labelJob;
  if (!job) return;
  if (job.state === "generated") {
    card.append(
      text(
        "h3",
        job.environment === "sandbox"
          ? "Guía de PRUEBA · No válida para enviar"
          : "Guía preparada · Falta entregar el paquete",
      ),
    );
    const link = text("a", "Abrir guía PDF ↗", "secondary");
    link.href = job.result.labelUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.append(link, text("p", `FedEx · Rastreo: ${job.result.tracking}`));
    if (job.result.chargedCents)
      card.append(
        text(
          "p",
          "Cargo reportado por Envia: " + money(job.result.chargedCents),
          "fine",
        ),
      );
    return;
  }
  card.append(
    text(
      "p",
      job.state === "pending"
        ? "Generando guía. Actualiza para consultar el resultado; no se comprará otra guía."
        : "Resultado sin confirmar. Revisa en Envia si se compró la guía de este pedido. La recompra está bloqueada.",
      "message",
    ),
  );
  if (job.state === "uncertain" && order.status === "paid") {
    const details = document.createElement("details");
    details.append(text("summary", "Registrar la guía que verifiqué en Envia"));
    const form = document.createElement("form");
    form.className = "action-form";
    const shipmentId = input("Identificador de envío en Envia"),
      tracking = input("Rastreo FedEx"),
      labelUrl = input("Enlace HTTPS de la guía PDF", "url");
    for (const field of [shipmentId, tracking, labelUrl]) {
      field.input.required = true;
      form.append(field.label);
    }
    const checked = fieldCheck(
      "Verifiqué en Envia que esta guía FedEx corresponde a este pedido y domicilio.",
    );
    const button = text("button", "Guardar guía existente", "primary");
    form.append(checked.label, button);
    form.onsubmit = (e) => {
      e.preventDefault();
      shippingAction(
        order,
        "label-reconcile",
        {
          shipmentId: shipmentId.input.value,
          tracking: tracking.input.value,
          labelUrl: labelUrl.input.value,
          checkedInEnvia: checked.input.checked,
        },
        button,
      );
    };
    details.append(form);
    card.append(details);
    const retry = document.createElement("details");
    retry.append(
      text("summary", "Envia confirmó que el intento no creó ninguna guía"),
    );
    const retryForm = document.createElement("form");
    retryForm.className = "action-form";
    const reference = input("Escribe la referencia completa del pedido");
    reference.input.required = true;
    const absent = fieldCheck(
      "Comprobé directamente en Envia que no existe guía ni cargo pendiente para este intento. Autorizaré una compra nueva por separado.",
    );
    const release = text("button", "Habilitar una nueva compra", "secondary");
    retryForm.append(reference.label, absent.label, release);
    retryForm.onsubmit = (e) => {
      e.preventDefault();
      shippingAction(
        order,
        "label-reconcile",
        {
          confirmNoShipment: true,
          reference: reference.input.value,
          checkedInEnvia: absent.input.checked,
        },
        release,
      );
    };
    retry.append(retryForm);
    card.append(retry);
  }
}
async function update(order, change, button) {
  button.disabled = true;
  try {
    await api("/api/admin/orders/" + order.id, {
      method: "PATCH",
      body: JSON.stringify({ version: order.version, ...change }),
    });
    $("#admin-message").textContent = "Pedido actualizado.";
    await load();
  } catch (e) {
    $("#admin-message").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}
function formAction(card, order, label, fields, build) {
  const form = document.createElement("form");
  form.className = "action-form";
  form.append(...fields.map((f) => f.label));
  const b = text("button", label, "primary");
  form.append(b);
  form.onsubmit = (e) => {
    e.preventDefault();
    update(order, build(), b);
  };
  card.append(form);
}
function transferMessage(o) {
  const account = o.transferAccount ?? bank;
  return `OFFCODE · ${o.id}\nLA AFRO × OFFCODE: ${o.items.map((p) => `${p.qty} talla ${p.size}`).join(", ")}\nPrendas: ${money(o.subtotalCents)}\nEnvío: ${money(o.shippingCents)}\nTotal: ${money(o.totalCents)}\nBanco: ${account.name}\nBeneficiario: ${account.beneficiary}\nCLABE: ${account.clabe}\nReferencia: ${o.id}\nEl pago se confirmará al verificar el abono en nuestra cuenta.`;
}
function emailDetails(card, order) {
  const details = document.createElement("details");
  details.append(text("summary", "Correos transaccionales"));
  const results = document.createElement("div");
  const refresh = text("button", "Consultar correos", "secondary");
  refresh.type = "button";
  const states = {
    pending: "En cola", sending: "En proceso", accepted: "Aceptado por Resend; entrega no confirmada",
    failed: "Falló", uncertain: "Resultado incierto", review: "Requiere revisión en Resend",
    skipped: "Omitido", superseded: "Omitido por un estado posterior",
  };
  async function refreshEmails() {
    refresh.disabled = true;
    try {
      const data = await api("/api/admin/email-notifications?orderId=" + encodeURIComponent(order.id));
      results.replaceChildren(text("p", !data.healthy ? "Registro de correos no disponible. Revisa el servidor antes de reintentar." :
        data.enabled ? "Envío habilitado. La aceptación del proveedor no confirma la recepción en el buzón." : "Correos desactivados o configuración incompleta."));
      for (const job of data.notifications) {
        const row = document.createElement("p");
        row.append(text("span", `${labels[job.event] || job.event} · ${job.audience === "owner" ? "Propietario" : "Comprador"} · ${states[job.state] || job.state} · Intentos: ${job.attempts} · ${job.code}`));
        if (job.canRetry) {
          const retry = text("button", "Reintentar con la misma referencia", "secondary");
          retry.type = "button";
          retry.onclick = async () => {
            retry.disabled = true;
            try {
              await api(`/api/admin/email-notifications/${job.id}/retry`, { method: "POST", body: "{}" });
              await refreshEmails();
            } catch (e) { results.append(text("p", e.message)); }
          };
          row.append(retry);
        }
        results.append(row);
      }
    } catch (e) { results.replaceChildren(text("p", e.message)); }
    finally { refresh.disabled = false; }
  }
  refresh.onclick = refreshEmails;
  details.append(refresh, results);
  card.append(details);
}
function render() {
  const filtered = loaded;
  $("#orders").replaceChildren();
  if (!filtered.length) {
    $("#orders").append(
      text(
        "p",
        loaded.length
          ? "No hay coincidencias con esos filtros."
          : "Todavía no hay pedidos.",
        "empty",
      ),
    );
    return;
  }
  for (const o of filtered) {
    const card = document.createElement("article");
    card.className = "order-card";
    const head = document.createElement("div");
    head.className = "order-head";
    head.append(
      text("h2", o.id),
      text("span", labels[o.status] || o.status, "badge"),
    );
    card.append(
      head,
      text("p", new Date(o.createdAt).toLocaleString("es-MX"), "fine"),
      text("h3", o.customer.name),
    );
    card.append(
      text("p", `${o.customer.phone} · ${o.customer.email}`),
      text(
        "p",
        `${o.customer.street}, ${o.customer.neighborhood}, ${o.customer.city}, ${o.customer.state}, CP ${o.customer.postalCode}.`,
      ),
    );
    if (o.customer.notes)
      card.append(text("p", "Referencias: " + o.customer.notes));
    card.append(
      text("p", o.items.map((p) => `Talla ${p.size} × ${p.qty}`).join(" / ")),
      text("p", "Prendas: " + money(o.subtotalCents)),
    );
    card.append(
      text(
        "p",
        o.shippingCents === null
          ? "Envío y total pendientes de confirmar."
          : `Envío: ${money(o.shippingCents)} · Total: ${money(o.totalCents)}`,
        "total",
      ),
    );
    if (o.labelJob && o.status !== "paid") labelDetails(card, o);
    if (o.status === "requested") {
      if (shipping.enabled) {
        let chosen = null;
        const stock = fieldCheck(
          "Confirmé la disponibilidad real de todas las tallas.",
        );
        quoteChoices(card, o, (rate) => {
          chosen = rate;
        });
        formAction(
          card,
          o,
          "Confirmar total y solicitar transferencia",
          [stock],
          () => ({
            status: "awaiting_transfer",
            stockConfirmed: stock.input.checked,
            quoteId: chosen?.id,
          }),
        );
      } else {
        const fee = input("Costo de envío confirmado (MXN)", "number");
        fee.input.min = "0";
        fee.input.max = "10000";
        fee.input.step = "0.01";
        fee.input.required = true;
        const stock = fieldCheck(
          "Confirmé la disponibilidad real de todas las tallas.",
        );
        formAction(
          card,
          o,
          "Confirmar total y solicitar transferencia",
          [fee, stock],
          () => ({
            status: "awaiting_transfer",
            shippingCents: Math.round(Number(fee.input.value) * 100),
            stockConfirmed: stock.input.checked,
          }),
        );
      }
    }
    if (o.status === "awaiting_transfer") {
      const details = document.createElement("details");
      details.append(text("summary", "Datos para compartir con el cliente"));
      const message = document.createElement("textarea");
      message.readOnly = true;
      message.rows = 9;
      message.value = transferMessage(o);
      details.append(message);
      const link = text("a", "Abrir mensaje en WhatsApp ↗", "secondary");
      link.href =
        "https://wa.me/" +
        o.customer.phone +
        "?text=" +
        encodeURIComponent(message.value);
      link.target = "_blank";
      link.rel = "noopener";
      details.append(
        link,
        text(
          "p",
          "Revisa el total y los datos antes de enviar. El enlace no envía automáticamente.",
          "fine",
        ),
      );
      card.append(details);
      const verified = fieldCheck(
        "Verifiqué en la cuenta bancaria el abono del total de este pedido.",
      );
      formAction(card, o, "Marcar pago verificado", [verified], () => ({
        status: "paid",
        paymentVerified: verified.input.checked,
      }));
    }
    if (o.status === "paid") {
      labelDetails(card, o);
      if (shipping.enabled && !o.labelJob) {
        let chosen = null;
        quoteChoices(card, o, (rate) => {
          chosen = rate;
        });
        const form = document.createElement("form");
        form.className = "action-form";
        const accepted = fieldCheck(
          "Autorizo comprar esta guía con saldo de Envia. Revisé el costo actual; cualquier diferencia no se cobrará automáticamente al cliente.",
        );
        const button = text("button", "Comprar guía FedEx", "primary");
        form.append(
          accepted.label,
          button,
          text(
            "p",
            "La guía no programa una recolección. Prepara el paquete y coordina su entrega con FedEx.",
            "fine",
          ),
        );
        form.onsubmit = (e) => {
          e.preventDefault();
          if (!chosen || Date.parse(chosen.expiresAt) <= Date.now()) {
            $("#admin-message").textContent =
              "Consulta y selecciona una tarifa FedEx vigente.";
            return;
          }
          shippingAction(
            o,
            "label",
            {
              quoteId: chosen.id,
              expectedCents: chosen.shippingCents,
              confirmPurchase: accepted.input.checked,
            },
            button,
          );
        };
        card.append(form);
      }
      if (!shipping.enabled && !o.labelJob) {
        const carrier = input("Paquetería", "text", "FedEx"),
          tracking = input("Número de guía / rastreo");
        carrier.input.readOnly = true;
        carrier.input.required = true;
        carrier.input.minLength = 2;
        tracking.input.required = true;
        tracking.input.minLength = 4;
        const handed = fieldCheck(
          "Ya entregué físicamente el paquete a FedEx.",
        );
        formAction(
          card,
          o,
          "Registrar envío",
          [carrier, tracking, handed],
          () => ({
            status: "shipped",
            carrier: carrier.input.value,
            tracking: tracking.input.value,
            handedToCarrier: handed.input.checked,
          }),
        );
      }
      if (o.labelJob?.state === "generated") {
        const handed = fieldCheck(
          "Ya entregué físicamente el paquete a FedEx.",
        );
        formAction(card, o, "Marcar enviado", [handed], () => ({
          status: "shipped",
          handedToCarrier: handed.input.checked,
        }));
      }
    }
    if (o.tracking) {
      card.append(text("p", `Envío: ${o.carrier} · Rastreo: ${o.tracking}`));
      const notify = text("a", "Preparar aviso de envío ↗", "secondary");
      notify.href =
        "https://wa.me/" +
        o.customer.phone +
        "?text=" +
        encodeURIComponent(
          `OFFCODE · ${o.id}\nTu pedido fue enviado por ${o.carrier}. Número de rastreo: ${o.tracking}.`,
        );
      notify.target = "_blank";
      notify.rel = "noopener";
      card.append(notify);
    }
    if (o.status === "shipped") {
      const delivered = fieldCheck(
        "Confirmé la entrega con la paquetería o el cliente.",
      );
      formAction(card, o, "Marcar entregado", [delivered], () => ({
        status: "delivered",
      }));
    }
    if (
      ["requested", "awaiting_transfer", "paid"].includes(o.status) &&
      !o.labelJob
    ) {
      const cancel = text("button", "Cancelar pedido", "cancel");
      cancel.type = "button";
      cancel.onclick = () => {
        if (
          confirm(
            o.status === "paid"
              ? "Cancelar no devuelve dinero. ¿Ya acordaste por separado cómo gestionar la devolución y quieres cancelar?"
              : "¿Cancelar esta solicitud?",
          )
        )
          update(o, { status: "cancelled" }, cancel);
      };
      card.append(cancel);
    }
    const history = document.createElement("details");
    history.append(text("summary", "Historial"));
    for (const e of o.history)
      history.append(
        text(
          "p",
          new Date(e.at).toLocaleString("es-MX") +
            " · " +
            labels[e.status] +
            (e.note ? " · " + e.note : ""),
          "fine",
        ),
      );
    card.append(history);
    emailDetails(card, o);
    $("#orders").append(card);
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
    $("#admin-message").textContent = "";
    await load();
    // load() already fetched the orders page; the visible tab loads itself.
    if (currentView !== "orders") await switchView(currentView);
  } catch (e) {
    $("#admin-message").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
$("#logout").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    loaded = [];
    $("#orders").replaceChildren();
    $("#login").hidden = false;
    $("#dashboard").hidden = true;
    $("#logout").hidden = true;
    $("#admin-message").textContent = "Sesión cerrada.";
  } catch (e) {
    $("#admin-message").textContent = e.message;
  }
};
let searchTimer;
function filterOrders() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    page = 0;
    load().catch((e) => ($("#admin-message").textContent = e.message));
  }, 300);
}
$("#search").oninput = filterOrders;
$("#status-filter").onchange = filterOrders;
$("#previous").onclick = () => {
  page = Math.max(0, page - 1);
  $("#refresh").click();
};
$("#next").onclick = () => {
  page++;
  $("#refresh").click();
};
load()
  .then(() => (currentView === "orders" ? undefined : switchView(currentView)))
  .catch((e) => {
    if (!e.message.includes("Inicia sesión"))
      $("#admin-message").textContent = e.message;
  });

// ---------- Dashboard: secciones ----------
const STATUS_LABELS = { draft: "Borrador", published: "Publicado", archived: "Archivado" };
let currentView = "summary",
  movementVariant = null;

const views = {
  summary: { title: "Resumen.", load: loadSummary },
  orders: { title: "Pedidos.", load },
  products: { title: "Productos.", load: loadProducts },
  inventory: { title: "Inventario.", load: loadInventory },
  shipping: { title: "Envíos.", load: loadShipping },
  settings: { title: "Configuración.", load: loadSettings },
};

function switchView(name) {
  if (!views[name]) return;
  currentView = name;
  for (const key of Object.keys(views)) {
    const active = key === name;
    const tab = document.getElementById("tab-" + key);
    const panel = document.getElementById("view-" + key);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  $("#view-title").textContent = views[name].title;
  views[name].load().catch((e) => ($("#admin-message").textContent = e.message));
}

document.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.onclick = () => switchView(tab.id.replace("tab-", ""));
  tab.onkeydown = (event) => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(tab);
    let next = null;
    if (event.key === "ArrowRight") next = tabs[(index + 1) % tabs.length];
    if (event.key === "ArrowLeft") next = tabs[(index - 1 + tabs.length) % tabs.length];
    if (event.key === "Home") next = tabs[0];
    if (event.key === "End") next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
    switchView(next.id.replace("tab-", ""));
  };
});

function statCard(label, value, note) {
  const card = document.createElement("article");
  card.className = "stat-card";
  card.append(text("p", label, "eyebrow"), text("strong", String(value)));
  if (note) card.append(text("p", note, "fine"));
  return card;
}

async function loadSummary() {
  const data = await api("/api/admin/summary");
  const grid = $("#summary-cards");
  grid.replaceChildren(
    statCard("Pedidos pendientes", data.orders.pending, "Solicitudes recibidas sin confirmar."),
    statCard("Pagos por verificar", data.orders.awaitingPayment, "Transferencias sin comprobar en el banco."),
    statCard("Variantes con stock bajo", data.inventory.lowStockVariants, `${data.inventory.lowStockUnits} unidades disponibles en esas variantes.`),
    statCard("Pedidos por preparar", data.orders.toPrepare, "Pago verificado, sin entregar a FedEx."),
    statCard("Envíos pendientes", data.orders.pendingShipments, "En tránsito sin entrega confirmada."),
  );
  const note = $("#summary-inventory-note");
  note.replaceChildren();
  if (data.inventory.unconfiguredVariants) {
    note.hidden = false;
    const count = data.inventory.unconfiguredVariants;
    note.append(
      text(
        "span",
        `${count} ${count === 1 ? "variante no tiene" : "variantes no tienen"} existencias configuradas. Mientras siga así, los pedidos se aceptan sin control de stock.`,
      ),
    );
    const go = text("button", "Configurar inventario →", "secondary");
    go.onclick = () => switchView("inventory");
    note.append(go);
  } else {
    note.hidden = true;
  }
}

function statusBadge(status) {
  return text("span", STATUS_LABELS[status] || status, "badge badge-" + status);
}

function productCard(product) {
  const card = document.createElement("article");
  card.className = "product-card";
  const head = document.createElement("div");
  head.className = "product-card-head";
  head.append(text("h2", product.name), statusBadge(product.status));
  card.append(head);
  card.append(
    text(
      "p",
      `${money(product.priceCents)} · ${product.variants.filter((v) => v.status === "active").length} variantes activas · ${product.variants.length} en total`,
      "fine",
    ),
  );
  const list = document.createElement("ul");
  list.className = "variant-list";
  for (const variant of product.variants) {
    const stock =
      variant.status !== "active"
        ? "archivada"
        : !variant.configured
          ? "sin inventario configurado"
          : `${variant.available} disponibles · ${variant.onHand} físicas · ${variant.reserved} reservadas`;
    list.append(
      text("li", `${variant.size} · ${variant.color || "sin color"} · ${variant.sku} · ${stock}`),
    );
  }
  card.append(list);
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const edit = text("button", "Editar", "secondary");
  edit.onclick = () => openProduct(product);
  actions.append(edit);
  if (product.status !== "archived") {
    const toggle = text(
      "button",
      product.status === "published" ? "Despublicar" : "Publicar",
      "secondary",
    );
    toggle.onclick = () =>
      setProductStatus(product.id, product.status === "published" ? "draft" : "published", toggle);
    actions.append(toggle);
    const archive = text("button", "Archivar", "secondary");
    archive.onclick = () => setProductStatus(product.id, "archived", archive);
    actions.append(archive);
  } else {
    const restore = text("button", "Volver a borrador", "secondary");
    restore.onclick = () => setProductStatus(product.id, "draft", restore);
    actions.append(restore);
  }
  card.append(actions);
  return card;
}

async function loadProducts() {
  const data = await api("/api/admin/products");
  const host = $("#products-list");
  host.replaceChildren();
  if (!data.products.length) {
    host.append(text("p", "Todavía no hay productos. Crea el primero.", "notice"));
    return;
  }
  for (const product of data.products) host.append(productCard(product));
}

async function setProductStatus(id, status, button) {
  button.disabled = true;
  try {
    await api(`/api/admin/products/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
    await loadProducts();
    $("#admin-message").textContent =
      status === "archived"
        ? "Producto archivado. Los pedidos anteriores no cambian."
        : "Estado actualizado.";
  } catch (e) {
    $("#admin-message").textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

function variantRow(variant = {}) {
  const row = document.createElement("div");
  row.className = "variant-row";
  if (variant.id) row.dataset.id = variant.id;
  const fields = [
    ["size", "Talla", variant.size ?? "", 6],
    ["color", "Color", variant.color ?? "", 40],
    ["sku", "SKU", variant.sku ?? "", 40],
  ];
  for (const [name, label, value, max] of fields) {
    const wrapper = document.createElement("label");
    wrapper.append(text("span", label));
    const field = document.createElement("input");
    field.dataset.variant = name;
    field.value = value;
    field.maxLength = max;
    if (name === "size") field.required = true;
    if (name === "sku") field.required = true;
    wrapper.append(field);
    row.append(wrapper);
  }
  const state = document.createElement("label");
  state.append(text("span", "Estado"));
  const select = document.createElement("select");
  select.dataset.variant = "status";
  select.append(new Option("Activa", "active"), new Option("Archivada", "archived"));
  select.value = variant.status === "archived" ? "archived" : "active";
  state.append(select);
  row.append(state);
  const remove = text("button", "Quitar", "secondary");
  remove.type = "button";
  remove.onclick = () => row.remove();
  row.append(remove);
  return row;
}

function openProduct(product = null) {
  $("#product-dialog-title").textContent = product ? "Editar producto" : "Nuevo producto";
  $("#p-name").value = product?.name ?? "";
  $("#p-price").value = product ? (product.priceCents / 100).toFixed(2) : "";
  $("#p-color").value = product?.color ?? "";
  $("#p-composition").value = product?.composition ?? "";
  $("#p-weight").value = product?.fabricWeightGsm ?? "";
  $("#p-fit").value = product?.fit ?? "";
  $("#p-status").value = product?.status ?? "draft";
  $("#p-description").value = product?.description ?? "";
  $("#p-images").value = (product?.images ?? [{ src: "assets/product-front.jpg", alt: "" }])
    .map((image) => `${image.src}${image.alt ? " | " + image.alt : ""}`)
    .join("\n");
  const rows = $("#variant-rows");
  rows.replaceChildren();
  const variants = product?.variants?.length
    ? product.variants
    : [{ size: "", color: product?.color ?? "", sku: "" }];
  for (const variant of variants) rows.append(variantRow(variant));
  $("#product-error").textContent = "";
  $("#product-dialog").showModal();
}

function parseImages(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [src, ...rest] = line.split("|");
      return { src: src.trim(), alt: rest.join("|").trim() };
    });
}

$("#add-variant").onclick = () => $("#variant-rows").append(variantRow());
$("#new-product").onclick = () => openProduct();
$("#cancel-product").onclick = () => $("#product-dialog").close();

$("#product-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  const variants = [...document.querySelectorAll("#variant-rows .variant-row")].map((row) => ({
    ...(row.dataset.id ? { id: row.dataset.id } : {}),
    size: row.querySelector('[data-variant="size"]').value,
    color: row.querySelector('[data-variant="color"]').value,
    sku: row.querySelector('[data-variant="sku"]').value,
    status: row.querySelector('[data-variant="status"]').value,
  }));
  const body = {
    name: $("#p-name").value,
    description: $("#p-description").value,
    color: $("#p-color").value,
    composition: $("#p-composition").value,
    fabricWeightGsm: $("#p-weight").value === "" ? null : Number($("#p-weight").value),
    fit: $("#p-fit").value,
    priceCents: Math.round(Number($("#p-price").value) * 100),
    status: $("#p-status").value,
    images: parseImages($("#p-images").value),
    variants,
  };
  button.disabled = true;
  $("#product-error").textContent = "";
  try {
    const id = $("#product-dialog").dataset.productId;
    if (id)
      await api(`/api/admin/products/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    else await api("/api/admin/products", { method: "POST", body: JSON.stringify(body) });
    $("#product-dialog").close();
    $("#admin-message").textContent = id
      ? "Producto actualizado."
      : "Producto creado. Publícalo cuando esté listo.";
    await loadProducts();
    if (currentView === "inventory") await loadInventory();
  } catch (e) {
    $("#product-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};

// Guarda el id que se está editando junto al diálogo; openProduct(null) = alta.
const openProductForm = openProduct;
openProduct = function (product = null) {
  $("#product-dialog").dataset.productId = product?.id ?? "";
  openProductForm(product);
};

function td(value, label) {
  const cell = document.createElement("td");
  cell.textContent = value;
  if (label) cell.dataset.label = label;
  return cell;
}

async function loadInventory() {
  const data = await api("/api/admin/inventory");
  const rows = $("#inventory-rows");
  rows.replaceChildren();
  for (const variant of data.variants) {
    const tr = document.createElement("tr");
    const low =
      variant.configured && variant.available <= variant.lowStockThreshold && variant.status === "active";
    if (variant.status !== "active") tr.className = "is-archived";
    else if (low) tr.className = "is-low";
    tr.append(
      td(variant.productName, "Producto"),
      td(variant.size, "Talla"),
      td(variant.color || "—", "Color"),
      td(variant.sku, "SKU"),
      td(variant.configured ? String(variant.onHand) : "—", "Físico"),
      td(variant.configured ? String(variant.reserved) : "—", "Reservado"),
      td(variant.configured ? String(variant.available) : "Sin configurar", "Disponible"),
      td(variant.configured ? String(variant.lowStockThreshold) : "—", "Umbral"),
    );
    const actions = document.createElement("td");
    const button = text("button", "Movimientos", "secondary");
    button.onclick = () => openMovement(variant);
    actions.append(button);
    tr.append(actions);
    rows.append(tr);
  }
  const unconfigured = data.variants.filter((v) => !v.configured && v.status === "active").length;
  const note = $("#inventory-note");
  note.hidden = !unconfigured;
  note.textContent = unconfigured
    ? `${unconfigured} ${unconfigured === 1 ? "variante sigue" : "variantes siguen"} sin existencias configuradas. Registra una entrada con el conteo real para activar el control de stock.`
    : "";
}

async function loadHistory(variantId) {
  const host = $("#movement-history");
  const data = await api(`/api/admin/inventory/${variantId}/movements`);
  host.replaceChildren();
  if (!data.movements.length) {
    host.append(text("p", "Sin movimientos registrados.", "fine"));
    return;
  }
  for (const movement of data.movements) {
    const sign = movement.qty > 0 ? "+" : "";
    host.append(
      text(
        "p",
        `${new Date(movement.createdAt).toLocaleString("es-MX")} · ${movement.type} ${sign}${movement.qty}${
          movement.reservedDelta ? ` · reservado ${movement.reservedDelta > 0 ? "+" : ""}${movement.reservedDelta}` : ""
        }${movement.reason ? " · " + movement.reason : ""} · físico ${movement.onHandAfter} · reservado ${movement.reservedAfter}${
          movement.orderId ? " · " + movement.orderId : ""
        }`,
        "fine",
      ),
    );
  }
}

async function openMovement(variant) {
  movementVariant = variant;
  $("#movement-variant").textContent = `${variant.productName} · Talla ${variant.size} · ${variant.color || "sin color"} · ${variant.sku}`;
  $("#m-qty").value = "";
  $("#m-reason").value = "";
  $("#movement-error").textContent = "";
  $("#t-threshold").value = variant.lowStockThreshold;
  $("#movement-history").replaceChildren(text("p", "Cargando…", "fine"));
  $("#movement-dialog").showModal();
  await loadHistory(variant.id);
}

$("#movement-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $("#movement-error").textContent = "";
  try {
    await api(`/api/admin/inventory/${movementVariant.id}/movements`, {
      method: "POST",
      body: JSON.stringify({
        type: $("#m-type").value,
        qty: Number($("#m-qty").value),
        reason: $("#m-reason").value,
      }),
    });
    $("#m-qty").value = "";
    $("#m-reason").value = "";
    await loadInventory();
    await loadHistory(movementVariant.id);
  } catch (e) {
    $("#movement-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};

$("#threshold-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api(`/api/admin/inventory/${movementVariant.id}`, {
      method: "PATCH",
      body: JSON.stringify({ lowStockThreshold: Number($("#t-threshold").value) }),
    });
    await loadInventory();
    $("#movement-error").textContent = "";
    $("#admin-message").textContent = "Umbral actualizado.";
  } catch (e) {
    $("#movement-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};

async function loadShipping() {
  const data = await api("/api/admin/summary");
  const value = data.shipping ?? {};
  $("#shipping-panel-status").textContent = value.enabled
    ? `Envia configurado · Solo FedEx · ${
        value.environment === "sandbox"
          ? "PRUEBAS: las guías no tienen validez para enviar."
          : "Producción: comprar una guía genera un cargo real."
      }`
    : "Envia pendiente de configuración: los pedidos se guardan sin tarifa de envío y no se puede comprar guía.";
}

document.querySelectorAll("[data-order-filter]").forEach((button) => {
  button.onclick = () => {
    $("#status-filter").value = button.dataset.orderFilter;
    page = 0;
    switchView("orders");
  };
});

async function loadSettings() {
  const data = await api("/api/admin/summary");
  const value = data.shipping ?? {};
  $("#settings-envia-status").textContent = value.enabled
    ? `Envia: ${value.environment === "sandbox" ? "sandbox (pruebas)" : "producción"}.`
    : "Envia: pendiente de configuración.";
}

$("#refresh").onclick = () =>
  views[currentView].load().catch((e) => ($("#admin-message").textContent = e.message));
