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
    `${data.total} pedidos encontrados · ${loaded.length} en esta página.`;
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
$("#refresh").onclick = () =>
  load().catch((e) => ($("#admin-message").textContent = e.message));
$("#previous").onclick = () => {
  page = Math.max(0, page - 1);
  $("#refresh").click();
};
$("#next").onclick = () => {
  page++;
  $("#refresh").click();
};
load().catch((e) => {
  if (!e.message.includes("Inicia sesión"))
    $("#admin-message").textContent = e.message;
});
