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
