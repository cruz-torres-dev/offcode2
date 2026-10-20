// Private, optional Resend transport. Never expose config or raw provider errors.
export const validEmail = (v) => typeof v === "string" && v.length <= 254 &&
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(v);

export function createEmailTransport({ env = process.env, fetcher, timeoutMs = 5000 } = {}) {
  const from = env.EMAIL_FROM?.trim() ?? "";
  const owner = env.ORDER_NOTIFICATION_EMAIL?.trim() ?? "";
  const key = env.RESEND_API_KEY?.trim() ?? "";
  const reason = env.EMAIL_ENABLED !== "true" ? "disabled" :
    !key || !validEmail(from) || !validEmail(owner) ? "configuration_missing" :
    process.env.NODE_TEST_CONTEXT && !fetcher ? "test_transport_required" : "enabled";
  const enabled = reason === "enabled";
  return {
    enabled, reason, from, owner,
    async send(message, idempotencyKey) {
      if (!enabled) return { state: "disabled", code: reason };
      if (!validEmail(message.to?.[0]) || !validEmail(message.from))
        return { state: "failed", code: "invalid_address" };
      const controller = new AbortController();
      let timer;
      try {
        // Race also bounds an injected transport that does not honor AbortSignal.
        return await Promise.race([
          (async () => {
            const response = await (fetcher ?? fetch)("https://api.resend.com/emails", {
              method: "POST", redirect: "error", signal: controller.signal,
              headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
              body: JSON.stringify(message),
            });
            if (!response.ok) {
              await response.body?.cancel();
              return { state: response.status >= 500 || response.status === 409 ? "uncertain" : "failed", code: `http_${response.status}` };
            }
            const result = await response.json();
            // An HTTP 2xx alone is not evidence that Resend accepted the message.
            if (!/^[a-f0-9-]{36}$/i.test(result?.id ?? ""))
              return { state: "uncertain", code: "invalid_response" };
            return { state: "accepted", code: "provider_accepted", providerId: result.id };
          })(),
          new Promise((resolve) => { timer = setTimeout(() => {
            controller.abort(); resolve({ state: "uncertain", code: "timeout" });
          }, timeoutMs); }),
        ]);
      } catch {
        return { state: "uncertain", code: "transport_error" };
      } finally { clearTimeout(timer); }
    },
  };
}

const titles = {
  requested: "Recibimos tu solicitud", awaiting_transfer: "Instrucciones para tu transferencia",
  paid: "Pago verificado", shipped: "Tu pedido fue enviado", delivered: "Entrega confirmada",
  cancelled: "Cancelación confirmada",
};
const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Keep v1 deterministic: queued retries must generate identical provider bodies.
// New designs must use a new version while retaining this renderer for old jobs.
export function renderEmailV1(data) {
  const title = data.audience === "owner" ? "Nueva solicitud de pedido" : titles[data.event];
  if (!title) throw Error("unsupported_email_event");
  const lines = [`Referencia: ${data.orderId}`];
  if (data.event === "requested") {
    lines.push(`LA AFRO × OFFCODE · ${data.items.map((i) => `${i.qty} × talla ${i.size}`).join(" / ")}`);
    lines.push("Recibir esta solicitud no confirma disponibilidad, pago ni envío.");
    if (data.audience === "owner") lines.push("Revisa la solicitud en tu panel privado de OFFCODE.");
  }
  if (data.event === "awaiting_transfer") {
    lines.push(`Total confirmado: ${(data.totalCents / 100).toFixed(2)} MXN.`);
    lines.push("Usa la referencia del pedido al realizar la transferencia. Solicita los datos bancarios por el canal de atención acordado con OFFCODE y verifica el importe antes de transferir. Este correo no incluye datos bancarios.");
    lines.push("El pago se confirmará únicamente después de verificar el abono. El pedido todavía no ha sido enviado.");
  }
  if (data.event === "paid") lines.push("OFFCODE verificó el pago de tu pedido. Esto no significa que el paquete haya sido entregado a la paquetería.");
  if (data.event === "shipped") lines.push("OFFCODE confirmó la entrega del paquete a FedEx.", `Rastreo FedEx: ${data.tracking}`);
  if (data.event === "delivered") lines.push("OFFCODE registró la entrega confirmada de tu pedido.");
  if (data.event === "cancelled") lines.push("La cancelación de tu pedido fue confirmada. Este aviso no confirma ni realiza un reembolso; cualquier devolución se gestiona por separado con OFFCODE.");
  return {
    from: data.from, to: [data.to], subject: `OFFCODE · ${title} · ${data.orderId}`,
    text: `OFFCODE\n${title}\n\n${lines.join("\n\n")}\n\nNotificación transaccional de tu pedido.`,
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body style="margin:0;background:#080808;color:#f5f5f5;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" style="max-width:600px;background:#181818;border:1px solid #303030" cellpadding="28"><tr><td><p style="letter-spacing:3px;font-size:13px;color:#a6a6a6">OFFCODE</p><h1 style="font-size:28px;font-weight:400">${escapeHtml(title)}</h1>${lines.map((line) => `<p style="font-size:15px;line-height:1.7;color:#e0e0e0">${escapeHtml(line)}</p>`).join("")}<p style="border-top:1px solid #454545;padding-top:20px;color:#a6a6a6;font-size:12px">Notificación transaccional de tu pedido.</p></td></tr></table></td></tr></table></body></html>`,
  };
}

// V1 remains frozen so a queued retry keeps exactly the same provider body.
export function renderEmailV2(data) {
  const message = renderEmailV1(data);
  if (data.audience !== "buyer") return message;
  const actions = [];
  if (data.event === "shipped" && /^[A-Za-z0-9]{4,40}$/.test(data.tracking ?? ""))
    actions.push({ label: "Consultar rastreo FedEx", url: `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(data.tracking)}` });
  try {
    const url = new URL(data.supportUrl);
    if (url.protocol === "https:" && !url.username && !url.password)
      actions.push({ label: "Contactar a OFFCODE sobre este pedido", url: url.href });
  } catch {}
  if (!actions.length) return message;
  const buttons = actions.map(({ label, url }) => `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 20px;background:#f5f5f5;color:#080808;font-size:14px;text-decoration:none">${escapeHtml(label)} ↗</a></p><p style="font-size:12px;line-height:1.7;overflow-wrap:anywhere;color:#a6a6a6">${escapeHtml(url)}</p>`).join("");
  return {
    ...message,
    text: message.text + "\n\n" + actions.map(({ label, url }) => `${label}: ${url}`).join("\n\n"),
    html: message.html.replace('<p style="border-top:', buttons + '<p style="border-top:'),
  };
}

export function renderOrderEmail(data) {
  if (data?.template === 1) return renderEmailV1(data);
  if (data?.template === 2) return renderEmailV2(data);
  if (data?.template === 3) return renderEmailV3(data);
  if (data?.template === 4) return renderEmailV4(data);
  throw Error("unsupported_email_template");
}

// Deterministic on purpose (no Intl): a queued retry must rebuild the same body.
const mxn = (cents) => "$" + String(Math.trunc(cents / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") +
  "." + String(cents % 100).padStart(2, "0") + " MXN";
function supportActions(data) {
  try {
    const url = new URL(data.supportUrl);
    if (url.protocol === "https:" && !url.username && !url.password)
      return [{ label: "Contactar a OFFCODE sobre este pedido", url: url.href }];
  } catch {}
  return [];
}
function composeEmail(data, title, lines, actions = []) {
  const buttons = actions.map(({ label, url }) => `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 20px;background:#f5f5f5;color:#080808;font-size:14px;text-decoration:none">${escapeHtml(label)} ↗</a></p><p style="font-size:12px;line-height:1.7;overflow-wrap:anywhere;color:#a6a6a6">${escapeHtml(url)}</p>`).join("");
  return {
    from: data.from, to: [data.to], subject: `OFFCODE · ${title} · ${data.orderId}`,
    text: `OFFCODE\n${title}\n\n${lines.join("\n\n")}\n\nNotificación transaccional de tu pedido.` +
      (actions.length ? "\n\n" + actions.map(({ label, url }) => `${label}: ${url}`).join("\n\n") : ""),
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8"></head><body style="margin:0;background:#080808;color:#f5f5f5;font-family:Arial,Helvetica,sans-serif"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" style="max-width:600px;background:#181818;border:1px solid #303030" cellpadding="28"><tr><td><p style="letter-spacing:3px;font-size:13px;color:#a6a6a6">OFFCODE</p><h1 style="font-size:28px;font-weight:400">${escapeHtml(title)}</h1>${lines.map((line) => `<p style="font-size:15px;line-height:1.7;color:#e0e0e0">${escapeHtml(line)}</p>`).join("")}${buttons}<p style="border-top:1px solid #454545;padding-top:20px;color:#a6a6a6;font-size:12px">Notificación transaccional de tu pedido.</p></td></tr></table></td></tr></table></body></html>`,
  };
}

// V3 adds the transfer details to the buyer's instructions, an owner alert for
// orders created already awaiting the transfer, and the owner alert for a
// buyer's transfer notice. Every other event renders exactly like V2.
export function renderEmailV3(data) {
  const concept = typeof data.concept === "string" && data.concept ? [`Concepto esperado: ${data.concept}`] : [];
  if (data.event === "transfer_reported") {
    if (data.audience !== "owner") throw Error("unsupported_email_event");
    return composeEmail(data, "Transferencia reportada: verifica en tu banco", [
      `Referencia: ${data.orderId}`,
      `Total esperado: ${mxn(data.totalCents)}`,
      ...concept,
      ...(typeof data.reportedAt === "string" ? [`Aviso registrado: ${data.reportedAt.slice(0, 16).replace("T", " ")} UTC`] : []),
      "El comprador indicó en la tienda que ya realizó la transferencia. Este aviso no confirma el pago.",
      "Verifica el depósito directamente en tu banca por el total y el concepto exactos. Marca el pago como verificado en tu panel privado solo después de comprobar el abono.",
    ]);
  }
  if (data.event === "awaiting_transfer" && data.audience === "owner")
    return composeEmail(data, "Nuevo pedido pendiente de transferencia", [
      `Referencia: ${data.orderId}`,
      `LA AFRO × OFFCODE · ${data.items.map((i) => `${i.qty} × talla ${i.size}`).join(" / ")}`,
      `Total aceptado por el comprador: ${mxn(data.totalCents)}`,
      ...concept,
      "El inventario quedó reservado y el comprador recibió los datos de transferencia de la cuenta configurada.",
      "Este aviso no confirma el pago. Verifica el abono en tu banco antes de marcarlo como pagado en tu panel privado.",
    ]);
  if (data.event === "awaiting_transfer" && data.audience === "buyer" && data.transfer)
    return composeEmail(data, "Realiza tu transferencia bancaria", [
      `Referencia del pedido: ${data.orderId}`,
      `Total exacto a transferir: ${mxn(data.totalCents)}`,
      `Titular: ${data.transfer.beneficiary}`,
      `Banco: ${data.transfer.bank}`,
      `CLABE: ${data.transfer.clabe}`,
      `Concepto: ${data.transfer.concept}`,
      "Transfiere exactamente el total y escribe el concepto tal como aparece para que podamos identificar tu pago.",
      "Cuando hayas transferido, avísanos con el botón «Ya realicé la transferencia» en la página de tu pedido o por el canal de atención de OFFCODE. El aviso no confirma el pago.",
      "El pago se confirmará únicamente después de verificar el depósito en el banco. Tu pedido todavía no ha sido preparado ni enviado.",
    ], supportActions(data));
  return renderEmailV2(data);
}

// Prior renderers and pending jobs are immutable. V4 alone adds scoped recovery
// and distinguishes expiry from a manual cancellation, with the same job keys.
export function renderEmailV4(data) {
  const actions = [];
  if (data.audience === "buyer" && typeof data.recoveryUrl === "string") {
    const url = new URL(data.recoveryUrl);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
        url.pathname === "/checkout.html" && url.searchParams.get("pedido") === data.orderId && /^#access=[A-Za-z0-9_-]{43}$/.test(url.hash))
      actions.push({ label: "Consultar mi pedido", url: url.href });
  }
  if (data.event === "cancelled" && data.cancellationReason === "unpaid_transfer_expired")
    return composeEmail(data, "Tu solicitud venció", [
      `Referencia: ${data.orderId}`,
      "La reserva venció sin aviso de transferencia ni pago verificado. La solicitud fue cancelada y sus prendas dejaron de estar reservadas.",
      "Inicia una nueva solicitud para volver a consultar disponibilidad. No transfieras a este pedido; si ya lo hiciste, contacta a OFFCODE con tu referencia.",
      "Este aviso no confirma ni realiza un reembolso.",
    ], [...actions, ...supportActions(data)]);
  const message = renderEmailV3(data);
  if (!actions.length) return message;
  const notice = "Guarda este correo para regresar al mismo pedido desde otro navegador. El enlace es privado, tiene caducidad y no confirma ningún pago.";
  const buttons = actions.map(({ label, url }) => `<p style="margin:24px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 20px;background:#f5f5f5;color:#080808;text-decoration:none">${label} ↗</a></p>`).join("");
  return { ...message, text: message.text + "\n\n" + actions.map(({ label, url }) => `${label}: ${url}`).join("\n") + "\n\n" + notice,
    html: message.html.replace('<p style="border-top:', buttons + `<p style="font-size:13px;line-height:1.7;color:#c7c7c7">${notice}</p><p style="border-top:`) };
}
