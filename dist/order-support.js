const money = (cents) => new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(cents / 100) + " MXN";

export function whatsappLink(phone, message) {
  return typeof phone === "string" && /^\d{10,15}$/.test(phone)
    ? `https://wa.me/${phone}?text=${encodeURIComponent(message)}` : "";
}

export function buyerMessage(order, bank = {}) {
  const lines = [`OFFCODE · ${order.id}`];
  let title;
  switch (order.status) {
    case "requested":
      title = "Confirmar recepción de la solicitud";
      lines.push("Recibimos tu solicitud de pedido. Revisaremos disponibilidad y envío antes de confirmar el total y los datos de transferencia. No transfieras todavía.");
      break;
    case "awaiting_transfer": {
      const account = order.transferAccount ?? bank;
      if (![order.subtotalCents, order.shippingCents, order.totalCents].every(Number.isSafeInteger) ||
          !account.name || !account.beneficiary || !/^\d{18}$/.test(account.clabe)) return null;
      const concept = typeof order.transferConcept === "string" && order.transferConcept ? [`Concepto: ${order.transferConcept}`] : [];
      if (order.transferReport?.at) {
        title = "Confirmar que la transferencia está en verificación";
        lines.push(`Total del pedido: ${money(order.totalCents)}`, ...concept,
          "Recibimos tu aviso de transferencia. Estamos verificando el depósito directamente en el banco; el aviso no confirma el pago. Te confirmaremos cuando el abono quede verificado. El pedido aún no ha sido enviado.");
        break;
      }
      title = "Compartir total y datos de transferencia";
      lines.push(...[
        ...(order.items ?? []).map((item) => `${item.name || "LA AFRO × OFFCODE"} · Talla ${item.size} × ${item.qty}`),
        `Prendas: ${money(order.subtotalCents)}`, `Envío: ${money(order.shippingCents)}`, `Total confirmado: ${money(order.totalCents)}`,
        `Banco: ${account.name}`, `Beneficiario: ${account.beneficiary}`, `CLABE: ${account.clabe}`, `Referencia: ${order.id}`, ...concept,
        "Transfiere exactamente el total y usa el concepto indicado. Confirmaremos el pago después de comprobar el abono en nuestra cuenta. El pedido aún no ha sido enviado.",
      ]);
      break;
    }
    case "paid":
      title = "Confirmar pago y preparación";
      lines.push("Verificamos el pago de tu pedido. El vendedor está preparando el paquete y lo llevará a FedEx. Te compartiremos el rastreo cuando lo haya entregado a la paquetería.");
      break;
    case "shipped":
      if (!order.tracking) return null;
      title = "Compartir envío y rastreo";
      lines.push("El vendedor confirmó que entregó tu paquete a FedEx.", `Rastreo FedEx: ${order.tracking}`);
      if (/^[A-Za-z0-9]{4,40}$/.test(order.tracking))
        lines.push(`Consulta el seguimiento: https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(order.tracking)}`);
      break;
    case "delivered":
      title = "Confirmar entrega y ofrecer atención";
      lines.push("Registramos la entrega de tu pedido. Si necesitas ayuda con lo que recibiste, responde a este mensaje e incluye la referencia del pedido.");
      break;
    case "cancelled":
      title = "Informar cancelación";
      lines.push("Confirmamos la cancelación de tu pedido. Este aviso no confirma ni realiza un reembolso. Si habías pagado, comunícate con OFFCODE para gestionar la devolución por separado.");
      break;
    default: return null;
  }
  return { title, body: lines.join("\n\n") };
}

export function createBuyerSupport(order, bank, { document = globalThis.document, clipboard = globalThis.navigator?.clipboard } = {}) {
  const message = buyerMessage(order, bank);
  if (!message) return null;
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const details = node("details", "", "buyer-support");
  details.append(node("summary", "Atención al comprador"), node("p", message.title));
  const preview = node("textarea");
  preview.readOnly = true;
  preview.rows = 7;
  preview.value = message.body;
  preview.setAttribute("aria-label", `Mensaje para el comprador del pedido ${order.id}`);
  const actions = node("div", "", "buyer-support-actions");
  const copy = node("button", "Copiar mensaje", "secondary");
  copy.type = "button";
  const status = node("p", "", "fine");
  status.setAttribute("role", "status");
  copy.onclick = async () => {
    try {
      if (!clipboard?.writeText) throw Error();
      await clipboard.writeText(message.body);
      status.textContent = "Mensaje copiado. Puedes revisarlo y compartirlo con el comprador.";
    } catch {
      preview.focus(); preview.select();
      status.textContent = "Seleccionamos el mensaje. Cópialo desde el navegador para compartirlo.";
    }
  };
  actions.append(copy);
  const href = whatsappLink(order.customer?.phone, message.body);
  if (href) {
    const link = node("a", "Preparar WhatsApp ↗", "secondary");
    link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
    actions.append(link);
  }
  details.append(preview, actions, node("p", href
    ? "Revisa el mensaje y el destinatario antes de enviarlo. Abrir WhatsApp o copiar el texto no envía ningún mensaje ni cambia el estado del pedido."
    : "Para abrir WhatsApp, el teléfono debe incluir el código de país y contener solo dígitos. Puedes copiar el mensaje y contactar al comprador por otro canal.", "fine"), status);
  return details;
}
