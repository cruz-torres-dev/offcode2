import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, openSync, closeSync, fsyncSync } from "node:fs";
import path from "node:path";
import { createEmailTransport, renderOrderEmail, validEmail } from "./email.mjs";
import { transferInstructions } from "./bank-transfer.mjs";

const events = new Set(["requested", "awaiting_transfer", "paid", "shipped", "delivered", "cancelled"]);
const windowMs = 23 * 60 * 60 * 1000; // Margin below Resend's 24-hour idempotency retention.

// Sidecar journal: no change to the database schema, orders or shipping
// transactions. A single application instance owns this directory, like the
// SQLite service itself. An explicit directory preserves existing journals.
export async function createEmailOutbox({ databasePath, outboxDirectory, listOrders, contactUrl = "", env, fetcher, logger = console.info,
  now = Date.now, timeoutMs, autoStart = true, recoveryUrl } = {}) {
  const transport = createEmailTransport({ env, fetcher, timeoutMs });
  const directory = outboxDirectory
    ? path.resolve(outboxDirectory)
    : databasePath === ":memory:"
      ? null
      : path.resolve(databasePath + ".email-outbox");
  const jobs = new Map();
  const orderStatuses = new Map();
  let healthy = true, stopped = false, active = null, timer;
  const log = (code, job) => {
    try { logger(JSON.stringify({ component: "email", code, ...(job ? { notification: job.id, order: job.orderId, state: job.state, attempts: job.attempts } : {}) })); } catch {}
  };
  function persist(name, value) {
    if (!directory) return;
    const tmp = path.join(directory, `${name}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path.join(directory, name));
    // Linux deployment: make the rename durable as well as the file contents.
    if (process.platform !== "win32") {
      const dirFd = openSync(directory, "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  }
  function put(job) {
    persist(job.id + ".json", job);
    jobs.set(job.id, job);
  }
  function capture(order, baseline = false) {
    if (!healthy) return;
    try {
      orderStatuses.set(order.id, order.status);
      for (const [index, entry] of (order.history ?? []).entries()) {
        // A buyer's transfer notice keeps the order state, so it only alerts the
        // owner and can never replace or supersede a buyer email.
        const reported = entry.event === "transfer_reported";
        if (!reported && !events.has(entry.status)) continue;
        const event = reported ? "transfer_reported" : entry.status;
        // New orders alert the owner, whether they start as a request or, after
        // a quoted checkout, already awaiting the transfer.
        const audiences = reported ? ["owner"]
          : event === "requested" || (index === 0 && event === "awaiting_transfer") ? ["owner", "buyer"] : ["buyer"];
        for (const audience of audiences) {
          const id = createHash("sha256").update(`offcode-email-v1/${order.id}/${event}/${audience}`).digest("hex");
          if (jobs.has(id)) continue;
          const to = audience === "owner" ? transport.owner : order.customer?.email;
          const obsolete = audience === "buyer" && event !== "requested" && event !== order.status;
          const withTotal = event === "awaiting_transfer" || event === "transfer_reported";
          const invalid = !validEmail(to) || (event === "shipped" && !order.tracking) ||
            (withTotal && !Number.isSafeInteger(order.totalCents));
          const state = baseline || !transport.enabled || invalid ? "skipped" : obsolete ? "superseded" : "pending";
          let supportUrl = "";
          if (audience === "buyer") {
            try {
              const url = new URL(contactUrl);
              if (url.protocol === "https:" && !url.username && !url.password) {
                url.searchParams.set("pedido", order.id);
                supportUrl = url.href;
              }
            } catch {}
          }
          const transfer = audience === "buyer" && event === "awaiting_transfer" ? transferInstructions(order) : null;
          // Only whitelisted template facts and a public support URL. Never
          // customer name/address/phone/notes or a plaintext access URL. The
          // receiving account appears only in the buyer's transfer instructions.
          const data = state === "pending" ? {
            template: order.orderRecovery ? 4 : 3, orderId: order.id, event, audience,
            from: transport.from, to,
            items: order.items.map(({ size, qty }) => ({ size, qty })),
            totalCents: withTotal ? order.totalCents : null,
            tracking: event === "shipped" ? order.tracking : "",
            supportUrl,
            concept: audience === "owner" && withTotal && typeof order.transferConcept === "string" ? order.transferConcept : "",
            transfer: transfer ? { bank: transfer.bank, beneficiary: transfer.beneficiary, clabe: transfer.clabe, concept: transfer.concept } : null,
            reportedAt: reported ? entry.at : null,
            ...(order.orderRecovery ? { orderRecovery: audience === "buyer" ? order.orderRecovery : null,
              cancellationReason: order.cancellation?.reason === "unpaid_transfer_expired" ? "unpaid_transfer_expired" : null } : {}),
          } : null;
          const job = { id, orderId: order.id, event, audience, state, attempts: 0,
            code: baseline ? "historical" : !transport.enabled ? transport.reason : invalid ? "invalid_data" : state,
            createdAt: now(), firstAttempt: null, nextAttempt: 0, data };
          put(job);
          log(job.code, job);
        }
      }
    } catch { healthy = false; log("journal_write_failed"); }
  }
  try {
    let initialized = false;
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const files = readdirSync(directory);
      initialized = files.includes("initialized.json");
      for (const file of files.filter((f) => /^[a-f0-9]{64}\.json$/.test(f))) {
        const job = JSON.parse(readFileSync(path.join(directory, file), "utf8"));
        if (file !== job.id + ".json") throw Error();
        jobs.set(job.id, job);
      }
    }
    // First installation never sends a backlog of historical orders.
    // listOrders is async now: orders live behind the shared data layer.
    for (const order of await listOrders()) capture(order, !initialized);
    if (!healthy) throw Error();
    if (!initialized) persist("initialized.json", { version: 1 });
    for (const job of jobs.values()) if (job.state === "sending")
      put({ ...job, state: "uncertain", code: "interrupted", nextAttempt: now() });
  } catch { healthy = false; log("journal_unavailable"); }
  log(transport.reason);

  function metadata(job) {
    const canRetry = healthy && transport.enabled && ["failed", "uncertain"].includes(job.state) &&
      job.firstAttempt !== null && now() - job.firstAttempt < windowMs;
    return { id: job.id, orderId: job.orderId, event: job.event, audience: job.audience,
      state: job.state, code: job.code, attempts: job.attempts, canRetry };
  }
  function retry(id) {
    const job = jobs.get(id);
    if (!job || !metadata(job).canRetry) return false;
    try { put({ ...job, state: "pending", nextAttempt: now() }); log("retry_queued", jobs.get(id)); return true; }
    catch { healthy = false; log("journal_write_failed"); return false; }
  }
  async function run() {
    if (!healthy || stopped) return;
    try {
      if (!transport.enabled) return;
      // At most one request per tick. No burst against the provider's rate limit.
      for (let job of jobs.values()) {
        if (!["pending", "uncertain", "failed"].includes(job.state)) continue;
        if (job.firstAttempt !== null && now() - job.firstAttempt >= windowMs) {
          put({ ...job, state: "review", code: "idempotency_window_expired", data: null }); continue;
        }
        if (job.audience === "buyer" && job.event !== "requested" && orderStatuses.get(job.orderId) !== job.event) {
          put({ ...job, state: "superseded", code: "newer_order_state", data: null }); continue;
        }
        if (job.nextAttempt > now() || (job.state !== "pending" && job.attempts >= 3)) continue;
        job = { ...job, state: "sending", attempts: job.attempts + 1, firstAttempt: job.firstAttempt ?? now() };
        put(job); // Durable BEFORE contacting Resend; restart keeps the same key and facts.
        // The authenticated URL exists only in memory during delivery. The
        // durable job contains an encrypted envelope, never a raw bearer.
        const data = job.data.template === 4 && job.data.orderRecovery
          ? { ...job.data, recoveryUrl: recoveryUrl(job.orderId, job.data.orderRecovery) } : job.data;
        const outcome = await transport.send(renderOrderEmail(data), job.id);
        put({ ...job, ...outcome, nextAttempt: now() + Math.min(15 * 60e3, 60e3 * 2 ** (job.attempts - 1)),
          ...(outcome.state === "accepted" ? { data: null } : {}) });
        log(outcome.code, jobs.get(job.id));
        break;
      }
    } catch { healthy = false; log("worker_failed"); }
  }
  function drain() {
    if (!active) active = run().finally(() => { active = null; });
    return active;
  }
  if (autoStart) { timer = setInterval(drain, 1500); timer.unref(); }
  return {
    capture, drain, retry,
    status: () => ({ enabled: transport.enabled, reason: transport.reason, healthy }),
    list: (orderId) => [...jobs.values()].filter((j) => j.orderId === orderId).map(metadata),
    async close() { stopped = true; clearInterval(timer); await active; },
  };
}
