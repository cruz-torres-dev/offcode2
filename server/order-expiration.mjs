export const EXPIRATION_REASON = "unpaid_transfer_expired";

// Both states hold stock with an explicit deadline. `awaiting_transfer` already
// shows bank details; `requested` never does, so it can only be paid off-system
// and a transfer notice is impossible there. Leaving it out locked stock forever.
const EXPIRABLE = new Set(["awaiting_transfer", "requested"]);

export function createOrderExpiration({ db, catalog, persistOrder, onExpired = async () => {}, now = Date.now,
  autoStart = true, batchSize = 25, logger = console.info } = {}) {
  let active, timer, followup, stopped = false;
  async function expireCurrent(order, exec) {
    const deadline = Date.parse(order.reservationExpiresAt);
    if (!EXPIRABLE.has(order.status) || !Number.isFinite(deadline) || deadline > now() || order.transferReport ||
        order.history?.some((entry) => entry.event === "transfer_reported" || ["paid", "shipped", "delivered"].includes(entry.status))) return null;
    if (!(await exec.get("SELECT 1 FROM order_reservations WHERE order_id=? AND state='reserved' LIMIT 1", [order.id])) ||
        await exec.get("SELECT 1 FROM shipping_jobs WHERE order_id=?", [order.id])) return null;
    const at = new Date(now()).toISOString();
    // Recorded so the panel can tell an unquoted request from a quoted one
    // after the status has already become terminal.
    const previousStatus = order.status;
    order.status = "cancelled"; order.updatedAt = at;
    order.cancellation = { reason: EXPIRATION_REASON, at, reservationExpiresAt: order.reservationExpiresAt, previousStatus };
    order.history.push({ at, status: "cancelled", event: "reservation_expired", reason: EXPIRATION_REASON,
      note: previousStatus === "requested"
        ? "La solicitud seguía en revisión de disponibilidad y su reserva venció sin datos de transferencia ni pago verificado. Se canceló la solicitud y se liberaron las unidades reservadas."
        : "La reserva venció sin aviso de transferencia ni pago verificado. Se canceló la solicitud y se liberaron las unidades reservadas." });
    await catalog.release(order.id, exec, { reason: EXPIRATION_REASON, actor: "system" });
    return persistOrder(order, exec);
  }
  async function expireOne(id) {
    const result = await catalog.tx(async (exec) => {
      const row = await exec.get("SELECT payload,version FROM orders WHERE id=?", [id]);
      return row ? expireCurrent({ ...JSON.parse(row.payload), version: row.version }, exec) : null;
    });
    if (result) await onExpired(result);
    return !!result;
  }
  async function batch() {
    const rows = await db.all(`SELECT id FROM orders WHERE json_extract(payload,'$.status') IN ('awaiting_transfer','requested')
      AND json_type(payload,'$.reservationExpiresAt')='text' AND json_extract(payload,'$.reservationExpiresAt')<=?
      AND json_extract(payload,'$.transferReport') IS NULL
      AND EXISTS(SELECT 1 FROM order_reservations r WHERE r.order_id=orders.id AND r.state='reserved')
      AND NOT EXISTS(SELECT 1 FROM shipping_jobs j WHERE j.order_id=orders.id)
      ORDER BY json_extract(payload,'$.reservationExpiresAt'),id LIMIT ?`, [new Date(now()).toISOString(), batchSize]);
    let expired = 0;
    for (const row of rows) if (await expireOne(row.id)) expired++;
    // Further batches run in later turns of the event loop, not one large sweep.
    if (rows.length === batchSize && expired && !stopped && autoStart) {
      clearTimeout(followup); followup = setTimeout(kick, 0); followup.unref();
    }
    if (expired) try { logger(JSON.stringify({ component: "reservation_expiration", code: "batch", expired })); } catch {}
    return expired;
  }
  function sweep() {
    if (stopped) return Promise.resolve(0);
    if (!active) active = batch().finally(() => { active = null; });
    return active;
  }
  function kick() { sweep().catch(() => { try { logger(JSON.stringify({ component: "reservation_expiration", code: "retry_next_cycle" })); } catch {} }); }
  return { expireCurrent, expireOne, sweep, kick,
    async start() { await sweep(); if (autoStart && !stopped) { timer = setInterval(kick, 60e3); timer.unref(); } },
    async close() { stopped = true; clearInterval(timer); clearTimeout(followup); await active; },
  };
}
