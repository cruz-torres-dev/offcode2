import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  randomBytes,
  randomUUID,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { safeUrl } from "./envia.mjs";
import { clientIp, staticPolicy } from "./http-policy.mjs";
import { createCustomerAccounts } from "./customer-accounts.mjs";
import { createEmailOutbox } from "./email-outbox.mjs";
import { migrate, readSchemaVersion } from "./db.mjs";
import { openDatabase } from "./database.mjs";
import { createCatalogStore } from "./catalog-store.mjs";
import { bankSnapshot, transferConcept, transferInstructions } from "./bank-transfer.mjs";
import { createOrderAccess, orderDurations } from "./order-access.mjs";
import { createOrderExpiration, EXPIRATION_REASON } from "./order-expiration.mjs";
import {
  initialSettings,
  normalizeSettings,
  validateActivation,
  publicSettings,
  settingsStore,
  readiness,
} from "./owner-settings.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const UNIT_CENTS = 165000;
const VIP_CONSENT_VERSION = "vip-v1";
const VIP_CONSENT_TEXT =
  "Quiero recibir novedades y avisos de lanzamiento de OFFCODE por correo. He leído el aviso de privacidad.";
const labels = {
  requested: "Por confirmar",
  awaiting_transfer: "Pendiente de transferencia",
  paid: "Pago verificado",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
};
const httpError = (status, message) =>
  Object.assign(new Error(message), { status });
const clean = (v, min, max, label) => {
  if (
    typeof v !== "string" ||
    /[\u0000-\u001f\u007f]/.test(v) ||
    v.trim().length < min ||
    v.trim().length > max
  )
    throw httpError(400, `Revisa ${label}.`);
  return v.trim();
};
function validateCustomer(c) {
  if (!c || typeof c !== "object")
    throw httpError(400, "Faltan los datos de contacto.");
  const result = {};
  for (const [field, min, max, label] of [
    ["name", 3, 100, "tu nombre"],
    ["phone", 10, 15, "tu teléfono"],
    ["email", 5, 150, "tu correo"],
    ["street", 5, 150, "calle y número"],
    ["neighborhood", 2, 100, "la colonia"],
    ["city", 2, 100, "la ciudad"],
    ["state", 2, 60, "el estado"],
    ["postalCode", 5, 5, "el código postal"],
  ])
    result[field] = clean(c[field], min, max, label);
  if (
    !/^\d{10,15}$/.test(result.phone) ||
    !/^\d{5}$/.test(result.postalCode) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)
  )
    throw httpError(400, "Revisa teléfono, correo y código postal.");
  result.notes = c.notes ? clean(c.notes, 0, 300, "las referencias") : "";
  if (c.number)
    result.number = clean(c.number, 1, 30, "el número exterior e interior");
  return result;
}
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw httpError(415, "Se requiere JSON.");
  let raw = "";
  for await (const part of req) {
    raw += part;
    if (Buffer.byteLength(raw) > 16384)
      throw httpError(413, "Solicitud demasiado grande.");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error();
    return parsed;
  } catch {
    throw httpError(400, "JSON no válido.");
  }
}

export async function createApp(options = {}) {
  const orderClock = options.orderLifecycle?.now ?? Date.now;
  const durations = orderDurations({ env: options.env ?? process.env, ...options.orderLifecycle });
  const trustRenderProxy =
    options.trustRenderProxy ?? process.env.TRUST_RENDER_PROXY === "true";
  const production =
    options.production ?? process.env.NODE_ENV === "production";
  const origin =
    options.origin ??
    process.env.PUBLIC_ORIGIN ??
    (process.env.RENDER === "true"
      ? process.env.RENDER_EXTERNAL_URL
      : undefined) ??
    "http://localhost:8000";
  if (
    new URL(origin).origin !== origin ||
    (production && !origin.startsWith("https://"))
  )
    throw Error(
      "PUBLIC_ORIGIN debe ser un origen exacto; HTTPS en producción.",
    );
  const password = options.password ?? process.env.ADMIN_PASSWORD ?? "";
  if (password && password.length < 16)
    throw Error("ADMIN_PASSWORD debe tener al menos 16 caracteres.");
  let salt = randomBytes(32),
    passwordHash = password ? scryptSync(password, salt, 64) : null;
  const waitlistEnabled =
    options.waitlistEnabled ?? process.env.WAITLIST_ENABLED === "true";
  // Hard safety switch. An explicit ORDERS_ENABLED=false in the process
  // environment keeps order reception closed no matter what the encrypted
  // dashboard settings say; the panel cannot override it. Unset (or any other
  // value) leaves the stored setting in charge, as before.
  const ordersEnabledEnv =
    options.ordersEnabledEnv ?? process.env.ORDERS_ENABLED;
  const ordersLockedByEnv = ordersEnabledEnv === "false";
  const db = await openDatabase({
    driver: options.driver,
    path: options.databasePath,
    env: options.env ?? process.env,
  });
  const databasePath = db.describe().path;
  let store, currentSettings, settingsVersion, settingsUpdatedAt, shipping, freshDatabase;
  try {
    // Versioned, idempotent setup. Never drops, never rewrites an existing row.
    freshDatabase = (await readSchemaVersion(db)) === 0;
    await migrate(db);
    const credentials = await db.get("SELECT salt,hash FROM owner_auth WHERE id=1");
    if (credentials) {
      salt = Buffer.from(credentials.salt);
      passwordHash = Buffer.from(credentials.hash);
    }
    store = settingsStore(
      db,
      options.settingsKey ?? process.env.SETTINGS_ENCRYPTION_KEY ?? "",
    );
    const stored = await store.read();
    currentSettings = stored?.value ?? initialSettings(options);
    // The environment switch wins over any stored value, so a stale or
    // accidental "enabled: true" can never reopen sales while it is false.
    if (ordersLockedByEnv && currentSettings.enabled)
      currentSettings = { ...currentSettings, enabled: false };
    settingsVersion = stored?.version ?? 0;
    settingsUpdatedAt = stored?.updatedAt ?? null;
    shipping = validateActivation(currentSettings, {
      production,
      passwordConfigured: !!passwordHash,
      fetcher: options.envia?.fetch,
    });
    if (
      waitlistEnabled &&
      (!passwordHash || !/^https:\/\//.test(currentSettings.privacyUrl))
    )
      throw Error(
        "Completa ADMIN_PASSWORD y PRIVACY_URL HTTPS antes de abrir la lista VIP.",
      );
    // A brand-new database must never look like a running shop: the counters
    // would be zero and every past order would silently be missing.
    if (freshDatabase && production && currentSettings.enabled)
      throw Error(
        "La base de datos está recién creada y vacía: no se habilitan ventas reales sobre un esquema nuevo. Migra los pedidos existentes y compara los conteos antes de activar ORDERS_ENABLED.",
      );
  } catch (e) {
    await db.close().catch(() => {});
    throw e;
  }
  let { bank, whatsapp, privacyUrl, termsUrl, enabled } = currentSettings;
  let shippingConfig = {
    enabled: shipping.enabled,
    carrier: "FedEx",
    environment: shipping.environment,
  };
  let settingsFingerprint = createHash("sha256")
    .update(JSON.stringify(currentSettings))
    .digest("hex");
  const validPassword = (value) =>
    !!passwordHash &&
    typeof value === "string" &&
    value.length <= 256 &&
    timingSafeEqual(scryptSync(value, salt, 64), passwordHash);
  // A process interrupted during a purchase cannot know whether Envia charged it.
  await db.run("UPDATE shipping_jobs SET state='uncertain' WHERE state='pending'");
  const catalog = createCatalogStore(db);
  const orderAccess = createOrderAccess({ db, origin, production, now: orderClock, ttlMs: durations.accessMs,
    settingsKey: options.settingsKey ?? process.env.SETTINGS_ENCRYPTION_KEY ?? "", password });
  const email = await createEmailOutbox({
    ...options.email,
    contactUrl: new URL("/contacto.html", origin).href,
    databasePath,
    outboxDirectory:
      options.email?.outboxDirectory ??
      process.env.EMAIL_OUTBOX_DIR,
    recoveryUrl: orderAccess.recoveryUrl,
    listOrders: async () => (await db.all(`SELECT o.payload,a.expires,a.nonce,a.tag,a.sealed,a.origin
      FROM orders o LEFT JOIN order_access a ON a.order_id=o.id`)).map((row) => {
      const order = JSON.parse(row.payload);
      return { ...order, orderRecovery: row.expires === null ? null : orderAccess.envelope(row) };
    }),
  });
  async function captureEmail(order) {
    email.capture({ ...order, orderRecovery: await orderAccess.delivery(order.id) });
  }
  const expireQuotes = () =>
    db.run("DELETE FROM shipping_quotes WHERE expires<?", [Date.now()]);
  await expireQuotes();
  const quoteCleanup = setInterval(() => {
    expireQuotes().catch(() => {});
  }, 60e3);
  quoteCleanup.unref();
  const sessions = new Map(),
    limits = new Map();
  const limit = (key, max, window) => {
    const now = Date.now();
    if (limits.size > 10000) {
      for (const [k, v] of limits) if (v.until < now) limits.delete(k);
      if (limits.size > 10000) throw httpError(429, "Intenta más tarde.");
    }
    let record = limits.get(key);
    if (!record || record.until < now) {
      record = { until: now + window, n: 0 };
      limits.set(key, record);
    }
    if (++record.n > max)
      throw httpError(429, "Demasiados intentos; inténtalo más tarde.");
  };
  const send = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const labelJobOf = async (orderId) => {
    const job = await db.get("SELECT state,payload FROM shipping_jobs WHERE order_id=?", [orderId]);
    if (!job) return null;
    const value = JSON.parse(job.payload);
    return {
      state: job.state,
      environment: value.environment,
      result: value.result ?? null,
    };
  };
  const summary = async (row) => ({
    ...JSON.parse(row.payload),
    version: row.version,
    labelJob: await labelJobOf(row.id),
  });
  const getOrder = async (id) => {
    const row = await db.get("SELECT * FROM orders WHERE id=?", [id]);
    if (!row) throw httpError(404, "Pedido no encontrado.");
    return summary(row);
  };
  // Transitional verifier for historical tab-only credentials. New orders
  // always receive a server-random credential stored as a digest and envelope.
  const orderAccessToken = (id, requestKey) =>
    createHash("sha256")
      .update(`offcode-order-access-v1\n${id}\n${requestKey}`)
      .digest("base64url");
  const createdOrder = async (order) => {
    const credential = await orderAccess.forCreation(order.id);
    return {
      id: order.id,
      subtotalCents: order.subtotalCents,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
      status: order.status,
      statusLabel: order.cancellation?.reason === EXPIRATION_REASON ? "Vencido · cancelado" : labels[order.status] ?? order.status,
      cancellationReason: order.cancellation?.reason === EXPIRATION_REASON ? EXPIRATION_REASON : null,
      paymentMethod: order.paymentMethod ?? "bank_transfer",
      accessToken: credential.token,
      accessExpiresAt: new Date(credential.expires).toISOString(),
      reservationExpiresAt: order.reservationExpiresAt ?? null,
      transfer: transferInstructions(order),
    };
  };
  // What the buyer may see about their own order: no address, phone, internal
  // notes or history, and bank details only while a transfer is still due.
  const buyerOrder = (order) => ({
    id: order.id,
    createdAt: order.createdAt,
    status: order.status,
    statusLabel: order.cancellation?.reason === EXPIRATION_REASON ? "Vencido · cancelado" : labels[order.status] ?? order.status,
    reservationExpiresAt: order.reservationExpiresAt ?? null,
    cancellationReason: order.cancellation?.reason === EXPIRATION_REASON ? EXPIRATION_REASON : null,
    items: (Array.isArray(order.items) ? order.items : []).map(({ name, color, size, qty, unitCents }) => ({ name, color, size, qty, unitCents })),
    subtotalCents: order.subtotalCents,
    shippingCents: order.shippingCents,
    totalCents: order.totalCents,
    currency: "MXN",
    shippingService: order.shipping?.description ?? "",
    transfer: transferInstructions(order),
    transferReport: order.transferReport ? { at: order.transferReport.at } : null,
  });
  const orderAccessDenied = "No encontramos ese pedido con este acceso. Usa el enlace de tu correo o tu cuenta verificada.";
  // A guessed reference alone never reveals or changes an order: the caller
  // needs the creating tab's token or the verified account linked to it.
  async function buyerAccess(req, id, token) {
    const explicit = token !== undefined && token !== null && token !== "";
    token = explicit ? token : orderAccess.cookieToken(req);
    if (token) {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token))
        throw httpError(404, orderAccessDenied);
      const row = await db.get("SELECT * FROM orders WHERE id=?", [id]);
      const credential = await db.get("SELECT * FROM order_access WHERE order_id=?", [id]);
      if (row && orderAccess.valid(credential, token))
        return { order: await summary(row), channel: "order_link", credential, token };
      // Upgrade the old tab-only credential once, within a bounded lifetime.
      // Historical inventory is untouched; the replacement is server-random.
      if (row && !credential && Date.parse(JSON.parse(row.payload).createdAt) + durations.accessMs > orderClock() &&
          timingSafeEqual(Buffer.from(orderAccessToken(id, row.request_key)), Buffer.from(token))) {
        const upgraded = await db.tx(async (exec) => orderAccess.ensure(id, exec, Date.parse(JSON.parse(row.payload).createdAt) + durations.accessMs));
        return { order: await summary(row), channel: "order_link", credential: upgraded,
          token: orderAccess.open(id, orderAccess.envelope(upgraded)), upgraded: true };
      }
      if (explicit) throw httpError(404, orderAccessDenied);
    }
    const shopper = await accounts.current(req);
    if (!shopper?.verified_at)
      throw httpError(401, "Usa el enlace seguro de tu correo o inicia sesión en tu cuenta verificada.");
    const row = await db.get(
      "SELECT o.* FROM orders o JOIN customer_orders c ON c.order_id=o.id WHERE o.id=? AND c.customer_id=?",
      [id, shopper.id],
    );
    if (!row) throw httpError(404, orderAccessDenied);
    return { order: await summary(row), channel: "customer_account" };
  }
  const reportBlocked = {
    requested: "Este pedido todavía no tiene datos de transferencia. Espera la confirmación de OFFCODE antes de transferir.",
    paid: "El pago de este pedido ya fue verificado.",
    shipped: "El pago de este pedido ya fue verificado.",
    delivered: "El pago de este pedido ya fue verificado.",
    cancelled: "Este pedido fue cancelado. No transfieras; si ya lo hiciste, contacta a OFFCODE con tu referencia.",
  };
  const fingerprint = (customer, items) =>
    createHash("sha256")
      .update(JSON.stringify({ customer, items }))
      .digest("hex");
  // Writes the order payload only. Callers wrap it in catalog.tx() when stock
  // must change in the same transaction, and pass the scoped executor so the
  // write uses the connection that holds the locks.
  const persistOrder = async (order, exec = db) => {
    const { version, labelJob, ...value } = order;
    const result = await exec.run(
      "UPDATE orders SET payload=?,version=version+1 WHERE id=? AND version=?",
      [JSON.stringify(value), order.id, version],
    );
    if (!result.changes)
      throw httpError(409, "El pedido cambió. Actualiza el panel.");
    return value;
  };
  async function quoteShipping(customer, items, orderId = null) {
    const provider = shipping,
      revision = settingsFingerprint;
    const payload = await provider.payload(customer, items);
    const rates = await provider.rates(payload),
      expires = Date.now() + 15 * 60e3;
    if (revision !== settingsFingerprint)
      throw httpError(
        409,
        "La configuración cambió durante la consulta. Vuelve a cotizar.",
      );
    await db.run("DELETE FROM shipping_quotes WHERE expires<?", [Date.now()]);
    const quotes = [];
    for (const rate of rates) {
      const id = randomUUID();
      await db.run(
        "INSERT INTO shipping_quotes(id,fingerprint,order_id,expires,payload) VALUES(?,?,?,?,?)",
        [
          id,
          fingerprint(customer, items),
          orderId,
          expires,
          JSON.stringify({
            payload,
            rate,
            environment: provider.environment,
            settingsFingerprint: revision,
          }),
        ],
      );
      quotes.push({
        id,
        ...rate,
        carrier: "FedEx",
        subtotalCents: items.reduce((sum, item) => sum + item.qty * item.unitCents, 0),
        totalCents: items.reduce((sum, item) => sum + item.qty * item.unitCents, 0) + rate.shippingCents,
        currency: "MXN",
        expiresAt: new Date(expires).toISOString(),
      });
    }
    return quotes;
  }
  async function chosenQuote(id, customer, items, orderId = null, exec = db) {
    const row =
      typeof id === "string"
        ? await exec.get("SELECT * FROM shipping_quotes WHERE id=?", [id])
        : null;
    if (
      !row ||
      row.expires <= Date.now() ||
      row.order_id !== orderId ||
      row.fingerprint !== fingerprint(customer, items)
    )
      throw httpError(
        409,
        "Vuelve a cotizar FedEx: la cotización venció o cambió la dirección o la bolsa.",
      );
    const quote = JSON.parse(row.payload);
    if (quote.settingsFingerprint !== settingsFingerprint)
      throw httpError(409, "La configuración cambió. Vuelve a cotizar FedEx.");
    if (quote.environment !== shipping.environment)
      throw httpError(409, "Vuelve a cotizar en el entorno actual.");
    return quote;
  }
  function requireAcceptedTotal(data, totalCents) {
    if (data.totalAccepted !== true)
      throw httpError(400, "Revisa y acepta el total completo antes de enviar tu solicitud.");
    if (!Number.isSafeInteger(data.acceptedTotalCents) || data.acceptedTotalCents !== totalCents)
      throw httpError(409, "El total cambió. Vuelve a calcular el envío y acepta el total actualizado.");
  }
  const auth = (req) => {
    const token = req.headers.cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("offcode_session="))
      ?.slice(16);
    const expiry = token && sessions.get(token);
    if (!expiry || expiry < Date.now()) {
      if (token) sessions.delete(token);
      throw httpError(401, "Inicia sesión para continuar.");
    }
    return token;
  };
  const expiration = createOrderExpiration({ db, catalog, persistOrder, onExpired: captureEmail, now: orderClock,
    autoStart: options.orderLifecycle?.autoStart ?? true, logger: options.orderLifecycle?.logger ?? console.info });
  const accounts = createCustomerAccounts({ db, origin, production, body, send, limit, validateCustomer,
    ...options.customers,
    beforeOrders: (id) => id ? expiration.expireOne(id) : expiration.sweep(),
  });
  await expiration.start();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
    // Inline styles and blob workers support the local 3D renderer; scripts remain local.
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      const url = new URL(req.url, origin),
        route = url.pathname;
      if (route.startsWith("/api/")) {
        if (req.method !== "GET" && req.headers.origin !== origin)
          throw httpError(403, "Origen no autorizado.");
        const ip = clientIp(req, trustRenderProxy);
        if (["/api/config", "/api/shipping/rates"].includes(route)) expiration.kick();
        if (await accounts.handle(req, res, url, ip)) return;
        if (route === "/api/config" && req.method === "GET") {
          const product = await catalog.productPayload();
          return send(res, 200, {
            enabled,
            whatsapp: enabled ? whatsapp : "",
            support: {
              whatsapp: /^\d{10,15}$/.test(whatsapp) ? whatsapp : "",
              emailEnabled: accounts.emailEnabled,
            },
            privacyUrl,
            termsUrl,
            unitCents: product.priceCents ?? UNIT_CENTS,
            waitlistEnabled,
            vipConsentVersion: VIP_CONSENT_VERSION,
            product,
            catalog: await catalog.publicCatalog(),
            shipping: shippingConfig,
          });
        }
        if (route === "/api/catalog" && req.method === "GET")
          return send(res, 200, { products: await catalog.publicCatalog() });
        if (route === "/api/shipping/states" && req.method === "GET") {
          if (!enabled || !shipping.enabled)
            throw httpError(503, "Envíos todavía no habilitados.");
          limit("states:" + ip, 300, 3600e3);
          return send(res, 200, { states: await shipping.states() });
        }
        if (route === "/api/shipping/rates" && req.method === "POST") {
          if (!enabled || !shipping.enabled)
            throw httpError(503, "Envíos todavía no habilitados.");
          limit("rates:" + ip, 120, 3600e3);
          const data = await body(req);
          if (data.consent !== true)
            throw httpError(
              400,
              "Acepta el uso de tus datos para gestionar el pedido y el envío antes de cotizar.",
            );
          const items = await catalog.resolveItems(data.items);
          return send(res, 200, {
            rates: await quoteShipping(validateCustomer(data.customer), items),
            items,
          });
        }
        if (route === "/api/waitlist" && req.method === "POST") {
          if (!waitlistEnabled)
            throw httpError(503, "La lista VIP todavía no está abierta.");
          limit("vip:" + ip, 500, 3600e3);
          const data = await body(req);
          if (data.website) return send(res, 200, { ok: true });
          if (
            data.consent !== true ||
            data.consentVersion !== VIP_CONSENT_VERSION
          )
            throw httpError(
              400,
              "Confirma el consentimiento para recibir avisos de OFFCODE.",
            );
          const email = clean(
            data.email,
            5,
            150,
            "tu correo electrónico",
          ).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            throw httpError(400, "Escribe un correo electrónico válido.");
          const now = new Date().toISOString();
          // No enumeration, duplicate memberships or silent reactivation after an opt-out.
          await db.run(
            "INSERT OR IGNORE INTO vip_members(id,email,created_at,consent_at,privacy_url,consent_version,consent_text) VALUES(?,?,?,?,?,?,?)",
            [
              randomUUID(),
              email,
              now,
              now,
              privacyUrl,
              VIP_CONSENT_VERSION,
              VIP_CONSENT_TEXT,
            ],
          );
          return send(res, 200, { ok: true });
        }
        if (route === "/api/session" && req.method === "POST") {
          limit("login:" + ip, 8, 15 * 60e3);
          const data = await body(req);
          if (!validPassword(data.password))
            throw httpError(401, "Acceso no válido.");
          for (const [t, e] of sessions) if (e < Date.now()) sessions.delete(t);
          const token = randomBytes(32).toString("hex");
          sessions.set(token, Date.now() + 4 * 3600e3);
          res.setHeader(
            "Set-Cookie",
            `offcode_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400${production ? "; Secure" : ""}`,
          );
          return send(res, 200, { ok: true });
        }
        if (route === "/api/logout" && req.method === "POST") {
          sessions.delete(auth(req));
          res.setHeader(
            "Set-Cookie",
            `offcode_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? "; Secure" : ""}`,
          );
          return send(res, 200, { ok: true });
        }
        if (route === "/api/orders" && req.method === "POST") {
          if (ordersLockedByEnv || !enabled)
            throw httpError(503, "Los pedidos todavía no están habilitados.");
          limit("order:" + ip, 300, 3600e3);
          const data = await body(req);
          if (ordersLockedByEnv || !enabled)
            throw httpError(503, "Los pedidos todavía no están habilitados.");
          if (data.paymentMethod !== undefined && data.paymentMethod !== "bank_transfer")
            throw httpError(400, "El método de pago permitido es transferencia bancaria.");
          if (data.consent !== true)
            throw httpError(
              400,
              "Acepta el uso de tus datos para gestionar el pedido y el envío.",
            );
          if (
            typeof data.requestKey !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(data.requestKey)
          )
            throw httpError(400, "Falta la referencia de la solicitud.");
          const items = await catalog.resolveItems(data.items),
            customer = validateCustomer(data.customer);
          const prior = await db.get("SELECT * FROM orders WHERE request_key=?", [
            data.requestKey,
          ]);
          if (prior) {
            const saved = await summary(prior);
            if (
              JSON.stringify(saved.customer) !== JSON.stringify(customer) ||
              JSON.stringify(saved.items) !== JSON.stringify(items)
            )
              throw httpError(
                409,
                "Ya existe una solicitud con esta referencia y otros datos. Contacta a OFFCODE para corregirla antes de enviar otra.",
              );
            if (saved.shipping) requireAcceptedTotal(data, saved.totalCents);
            await expiration.expireOne(saved.id);
            return send(res, 200, await createdOrder(await getOrder(saved.id)));
          }
          if (!shipping.enabled && (data.shippingQuoteId || data.totalAccepted !== undefined || data.acceptedTotalCents !== undefined))
            throw httpError(409, "La cotización de envíos ya no está habilitada. Consulta con OFFCODE antes de continuar.");
          const quote = shipping.enabled
            ? await chosenQuote(data.shippingQuoteId, customer, items)
            : null;
          if (quote && data.paymentMethod !== "bank_transfer")
            throw httpError(400, "Selecciona transferencia bancaria antes de enviar tu solicitud.");
          if (quote) requireAcceptedTotal(data,
            items.reduce((sum, item) => sum + item.qty * item.unitCents, 0) + quote.rate.shippingCents);
          // A quoted order shows the transfer details as soon as it is saved,
          // so it cannot be created without a complete receiving account.
          const account = quote ? bankSnapshot(bank) : null;
          if (quote && !account)
            throw httpError(
              503,
              "No podemos recibir pedidos por transferencia en este momento: falta configurar la cuenta bancaria de OFFCODE. No se guardó tu pedido ni se reservó inventario.",
            );
          limit(
            "customer:" +
              createHash("sha256")
                .update(customer.email.toLowerCase())
                .digest("hex"),
            6,
            3600e3,
          );
          const id = "OF-" + randomBytes(6).toString("hex").toUpperCase(),
            now = new Date(orderClock()).toISOString(),
            subtotalCents = items.reduce((s, p) => s + p.qty * p.unitCents, 0);
          const order = {
            id,
            createdAt: now,
            updatedAt: now,
            reservationExpiresAt: new Date(orderClock() + durations.reservationMs).toISOString(),
            customer,
            // Snapshot: product name, SKU, size, color, unit price and quantity
            // are frozen here, so editing or archiving a product never rewrites
            // a past order.
            items,
            paymentMethod: "bank_transfer",
            subtotalCents,
            shippingCents: quote?.rate.shippingCents ?? null,
            totalCents: quote ? subtotalCents + quote.rate.shippingCents : null,
            shipping: quote
              ? {
                  provider: "envia",
                  carrier: "fedex",
                  service: quote.rate.service,
                  description: quote.rate.description,
                  // Server-validated amount; the browser value is never trusted.
                  quotedCents: quote.rate.shippingCents,
                  deliveryEstimate: quote.rate.deliveryEstimate || "",
                  environment: quote.environment,
                  quotedAt: now,
                }
              : null,
            // Stock is reserved atomically below, so a quoted order with an
            // accepted total goes straight to awaiting the transfer.
            status: quote ? "awaiting_transfer" : "requested",
            carrier: "",
            tracking: "",
            history: [
              quote
                ? { at: now, status: "awaiting_transfer", note: "Pedido creado con total aceptado e inventario reservado. Se mostraron los datos de transferencia; el pago sigue pendiente de verificar en el banco." }
                : { at: now, status: "requested" },
            ],
            consent: { at: now, privacyUrl, termsUrl },
            ...(quote ? { totalAcceptance: { at: now, quoteId: data.shippingQuoteId,
              totalCents: subtotalCents + quote.rate.shippingCents, currency: "MXN" },
              transferAccount: account, transferConcept: transferConcept(id) } : {}),
          };
          const shopper = await accounts.current(req);
          // Order row and stock reservation commit together or not at all.
          const duplicate = await catalog.tx(async (exec) => {
            // A concurrent retry may arrive after the preliminary lookup.
            const existing = await exec.get("SELECT payload FROM orders WHERE request_key=?", [data.requestKey]);
            if (existing) {
              const saved = JSON.parse(existing.payload);
              if (JSON.stringify(saved.customer) !== JSON.stringify(customer) || JSON.stringify(saved.items) !== JSON.stringify(items))
                throw httpError(409, "Ya existe una solicitud con esta referencia y otros datos.");
              if (saved.shipping) requireAcceptedTotal(data, saved.totalCents);
              return saved;
            }
            if (quote) {
              // Recheck after waiting for the transaction: expiry, configuration
              // or catalog edits must not silently change an accepted total.
              await chosenQuote(data.shippingQuoteId, customer, items, null, exec);
              for (const item of items) {
                const current = await exec.get("SELECT p.price_cents,p.status AS product_status,v.status FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?", [item.variantId]);
                if (!current || current.price_cents !== item.unitCents || current.product_status !== "published" || current.status !== "active")
                  throw httpError(409, "El producto cambió. Actualiza tu selección y vuelve a calcular el envío.");
              }
            }
            await exec.run(
              "INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)",
              [id, data.requestKey, now, JSON.stringify(order)],
            );
            await catalog.reserve(id, items, exec);
            await orderAccess.ensure(id, exec);
            if (shopper?.verified_at && customer.email.trim().toLowerCase() === shopper.email)
              await exec.run("INSERT INTO customer_orders(order_id,customer_id) VALUES(?,?)", [id, shopper.id]);
          });
          if (duplicate) return send(res, 200, await createdOrder(duplicate));
          await captureEmail(order);
          return send(res, 201, await createdOrder(order));
        }
        const buyerMatch = route.match(/^\/api\/orders\/(OF-[A-F0-9]{12})\/(access|transfer|transfer-report)$/);
        if (buyerMatch && req.method === "POST") {
          limit("order-access:" + ip, 120, 15 * 60e3);
          const data = await body(req);
          const access = await buyerAccess(req, buyerMatch[1], data.accessToken);
          if (access.credential && (buyerMatch[2] === "access" || access.upgraded))
            orderAccess.setCookie(res, access.order.id, access.token, access.credential.expires);
          await expiration.expireOne(access.order.id);
          if (["transfer", "access"].includes(buyerMatch[2]))
            return send(res, 200, { order: buyerOrder(await getOrder(access.order.id)),
              ...(access.upgraded ? { accessToken: access.token } : {}) });
          if (data.confirmed !== true)
            throw httpError(400, "Confirma que ya realizaste la transferencia antes de avisarnos.");
          // Serialized with every other order write: concurrent or repeated
          // notices leave exactly one report and never touch stock or totals.
          const result = await catalog.tx(async (exec) => {
            const row = await exec.get("SELECT * FROM orders WHERE id=?", [access.order.id]);
            const current = { ...JSON.parse(row.payload), version: row.version };
            if (access.credential && access.credential.expires <= orderClock()) throw orderAccess.denied();
            const expired = await expiration.expireCurrent(current, exec);
            if (expired) return { order: expired, expired: true };
            if (current.transferReport && current.status === "awaiting_transfer") return { order: current, repeated: true };
            if (!transferInstructions(current)) return { order: current, blocked: true };
            const at = new Date(orderClock()).toISOString();
            current.transferReport = { at, channel: access.channel };
            current.history.push({
              at,
              status: current.status,
              event: "transfer_reported",
              note: "El comprador avisó que realizó la transferencia. Pendiente de verificar el depósito en el banco; el aviso no confirma el pago.",
            });
            return { order: await persistOrder(current, exec), repeated: false };
          });
          if (result.expired) await captureEmail(result.order);
          if (result.expired || result.blocked) return send(res, 409, {
            error: result.order.cancellation?.reason === EXPIRATION_REASON
              ? "La reserva venció y el pedido fue cancelado. Inicia una nueva solicitud; si ya transferiste, contacta a OFFCODE."
              : reportBlocked[result.order.status] ?? "Este pedido no admite un aviso de transferencia en su estado actual.",
            order: buyerOrder(result.order),
          });
          if (!result.repeated) await captureEmail(result.order);
          return send(res, result.repeated ? 200 : 201, {
            reported: true,
            alreadyReported: result.repeated,
            message: result.repeated
              ? "Ya recibimos tu aviso de transferencia. Estamos verificando el depósito."
              : "Recibimos tu aviso. Revisaremos el depósito directamente en el banco. Este aviso no confirma que el pago haya sido recibido.",
            order: buyerOrder(result.order),
            ...(access.upgraded ? { accessToken: access.token } : {}),
          });
        }
        if (route.startsWith("/api/admin/")) {
          auth(req);
          if (["/api/admin/orders", "/api/admin/overview", "/api/admin/summary"].includes(route)) await expiration.sweep();
          if (route === "/api/admin/email-notifications" && req.method === "GET") {
            const orderId = new URL(req.url, origin).searchParams.get("orderId");
            await getOrder(orderId);
            return send(res, 200, { ...email.status(), notifications: email.list(orderId) });
          }
          const emailRetry = route.match(/^\/api\/admin\/email-notifications\/([a-f0-9]{64})\/retry$/);
          if (emailRetry && req.method === "POST") {
            limit("email-retry:" + ip, 10, 60e3);
            await body(req);
            if (!email.retry(emailRetry[1])) throw httpError(409, "Este correo no admite un reintento seguro. Revisa su estado y la ventana de idempotencia.");
            return send(res, 202, { queued: true });
          }
          // Dashboard: only real counters, computed from orders and inventory.
          if (route === "/api/admin/summary" && req.method === "GET") {
            limit("admin-summary:" + ip, 240, 60e3);
            return send(res, 200, {
              ...(await catalog.summary()),
              shipping: shippingConfig,
            });
          }
          if (route === "/api/admin/products" && req.method === "GET") {
            limit("admin-products:" + ip, 240, 60e3);
            return send(res, 200, { products: await catalog.listProducts() });
          }
          if (route === "/api/admin/products" && req.method === "POST") {
            limit("admin-products-write:" + ip, 60, 60e3);
            return send(res, 201, {
              product: await catalog.createProduct(await body(req)),
            });
          }
          const productMatch = route.match(/^\/api\/admin\/products\/([A-Za-z0-9-]{4,40})$/);
          if (productMatch && req.method === "PATCH") {
            limit("admin-products-write:" + ip, 60, 60e3);
            return send(res, 200, {
              product: await catalog.updateProduct(productMatch[1], await body(req)),
            });
          }
          const productStatus = route.match(
            /^\/api\/admin\/products\/([A-Za-z0-9-]{4,40})\/status$/,
          );
          if (productStatus && req.method === "POST") {
            limit("admin-products-write:" + ip, 60, 60e3);
            const data = await body(req);
            return send(res, 200, {
              product: await catalog.setProductStatus(productStatus[1], data.status),
            });
          }
          if (route === "/api/admin/inventory" && req.method === "GET") {
            limit("admin-inventory:" + ip, 240, 60e3);
            return send(res, 200, { variants: await catalog.listInventory() });
          }
          const inventoryMatch = route.match(
            /^\/api\/admin\/inventory\/([A-Za-z0-9-]{4,40})(\/movements)?$/,
          );
          if (inventoryMatch && req.method === "GET" && inventoryMatch[2]) {
            limit("admin-inventory:" + ip, 240, 60e3);
            return send(res, 200, {
              movements: await catalog.listMovements(inventoryMatch[1]),
            });
          }
          if (inventoryMatch && req.method === "POST" && inventoryMatch[2]) {
            limit("admin-inventory-write:" + ip, 120, 60e3);
            return send(res, 201, {
              variant: await catalog.recordMovement(inventoryMatch[1], await body(req)),
            });
          }
          if (inventoryMatch && req.method === "PATCH" && !inventoryMatch[2]) {
            limit("admin-inventory-write:" + ip, 120, 60e3);
            return send(res, 200, {
              variant: await catalog.updateInventorySettings(
                inventoryMatch[1],
                await body(req),
              ),
            });
          }
          if (route === "/api/admin/settings" && req.method === "GET")
            return send(res, 200, {
              settings: publicSettings(currentSettings),
              version: settingsVersion,
              updatedAt: settingsUpdatedAt,
              canSave: store.keyConfigured,
              production,
              ordersLockedByEnv,
              checks: readiness(currentSettings, {
                production,
                keyConfigured: store.keyConfigured,
                passwordConfigured: !!passwordHash,
                lockedByEnv: ordersLockedByEnv,
              }),
            });
          if (route === "/api/admin/settings" && req.method === "PATCH") {
            limit("settings:" + ip, 10, 15 * 60e3);
            const data = await body(req);
            if (!validPassword(data.currentPassword))
              throw httpError(
                401,
                "Confirma tu contraseña actual para guardar la configuración.",
              );
            if (data.version !== settingsVersion)
              throw httpError(
                409,
                "La configuración cambió. Recarga antes de guardar.",
              );
            if (
              await db.get(
                "SELECT 1 FROM shipping_jobs WHERE state='pending' LIMIT 1",
              )
            )
              throw httpError(
                409,
                "Espera a que termine la operación de guía antes de cambiar la configuración.",
              );
            const candidate = normalizeSettings(data.settings, currentSettings);
            if (ordersLockedByEnv && candidate.enabled)
              throw httpError(
                409,
                "La recepción de pedidos está bloqueada por ORDERS_ENABLED=false en el servidor. El panel no puede habilitarla; cambia esa variable en Render.",
              );
            const provider = validateActivation(candidate, {
              production,
              passwordConfigured: !!passwordHash,
              fetcher: options.envia?.fetch,
            });
            const saved = await store.save(candidate, data.version);
            currentSettings = candidate;
            settingsVersion = saved.version;
            settingsUpdatedAt = saved.updatedAt;
            ({ bank, whatsapp, privacyUrl, termsUrl, enabled } = candidate);
            shipping = provider;
            shippingConfig = {
              enabled: provider.enabled,
              carrier: "FedEx",
              environment: provider.environment,
            };
            settingsFingerprint = createHash("sha256")
              .update(JSON.stringify(candidate))
              .digest("hex");
            await db.run("DELETE FROM shipping_quotes");
            return send(res, 200, { ok: true, version: settingsVersion });
          }
          if (route === "/api/admin/password" && req.method === "PATCH") {
            limit("password:" + ip, 6, 15 * 60e3);
            const data = await body(req);
            if (!validPassword(data.currentPassword))
              throw httpError(401, "La contraseña actual no es correcta.");
            const next = clean(
              data.newPassword,
              16,
              256,
              "la nueva contraseña",
            );
            if (next !== data.confirmPassword)
              throw httpError(
                400,
                "La confirmación de contraseña no coincide.",
              );
            const nextSalt = randomBytes(32),
              nextHash = scryptSync(next, nextSalt, 64);
            await db.run(
              "INSERT INTO owner_auth(id,salt,hash,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,updated_at=excluded.updated_at",
              [nextSalt, nextHash, new Date().toISOString()],
            );
            salt = nextSalt;
            passwordHash = nextHash;
            sessions.clear();
            res.setHeader(
              "Set-Cookie",
              `offcode_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? "; Secure" : ""}`,
            );
            return send(res, 200, { ok: true, signInAgain: true });
          }
          if (route === "/api/admin/envia/check" && req.method === "POST") {
            limit("envia-check:" + ip, 10, 15 * 60e3);
            await body(req);
            const provider = shipping,
              revision = settingsVersion,
              states = await provider.states();
            if (revision !== settingsVersion)
              throw httpError(
                409,
                "La configuración cambió. Vuelve a comprobar la conexión.",
              );
            return send(res, 200, {
              states,
              environment: provider.environment,
              message:
                "Catálogo de estados consultado. Esto no confirma los permisos del token para cotizar ni genera guías. Consulta una tarifa con domicilio y empaque reales.",
            });
          }
          if (route === "/api/admin/envia/rates" && req.method === "POST") {
            limit("envia-preview:" + ip, 10, 15 * 60e3);
            const data = await body(req), revision = settingsVersion;
            if (data.version !== revision)
              throw httpError(409, "La configuración cambió. Recarga antes de cotizar.");
            // A private rate probe uses the saved configuration without changing
            // activation flags, creating checkout quotes or reserving inventory.
            const provider = validateActivation(
              { ...currentSettings, enabled: false, envia: { ...currentSettings.envia, enabled: true } },
              { production, passwordConfigured: !!passwordHash, fetcher: options.envia?.fetch },
            );
            const customer = validateCustomer(data.customer);
            const variant = typeof data.variantId === "string" ? await db.get(
              "SELECT p.price_cents FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=? AND v.status='active' AND p.status='published'",
              [data.variantId],
            ) : null;
            if (!variant || !Number.isInteger(data.qty) || data.qty < 1 || data.qty > 99)
              throw httpError(400, "Selecciona una prenda y una cantidad entre 1 y 99 para la cotización.");
            const payload = await provider.payload(customer, [{ qty: data.qty, unitCents: variant.price_cents }]);
            const rates = await provider.rates(payload);
            if (revision !== settingsVersion)
              throw httpError(409, "La configuración cambió durante la cotización. Vuelve a consultar.");
            return send(res, 200, {
              rates,
              environment: provider.environment,
              message: "Cotización privada de FedEx. No se creó pedido, reserva ni guía; no se realizó ningún cargo.",
            });
          }
          if (route === "/api/admin/overview" && req.method === "GET") {
            // Aggregate the confirmed order snapshots for the private overview.
            const rows = await db.all("SELECT payload FROM orders");
            const counts = Object.fromEntries(
              Object.keys(labels).map((k) => [k, 0]),
            );
            let total = 0,
              paidCount = 0,
              paidTotalCents = 0,
              transferReported = 0;
            for (const row of rows) {
              let value;
              try {
                value = JSON.parse(row.payload);
              } catch {
                continue;
              }
              total++;
              if (Object.hasOwn(counts, value.status)) counts[value.status]++;
              if (value.status === "awaiting_transfer" && value.transferReport) transferReported++;
              if (["paid", "shipped", "delivered"].includes(value.status)) {
                paidCount++;
                paidTotalCents += Number(value.totalCents) || 0;
              }
            }
            return send(res, 200, {
              counts,
              total,
              paidCount,
              paidTotalCents,
              transferReported,
              enabled,
            });
          }
          if (route === "/api/admin/waitlist" && req.method === "GET") {
            const page = Math.max(
              0,
              Math.min(
                10000,
                Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0,
              ),
            );
            const status =
              url.searchParams.get("status") === "withdrawn"
                ? "withdrawn"
                : "active";
            const members = await db.all(
              "SELECT id,email,created_at,consent_at,privacy_url,consent_version,status,withdrawn_at FROM vip_members WHERE status=? ORDER BY created_at DESC LIMIT 51 OFFSET ?",
              [status, page * 50],
            );
            const total = (
              await db.get("SELECT COUNT(*) AS n FROM vip_members WHERE status=?", [
                status,
              ])
            ).n;
            return send(res, 200, {
              members: members.slice(0, 50),
              more: members.length > 50,
              total,
              page,
              enabled: waitlistEnabled,
            });
          }
          if (route === "/api/admin/waitlist.csv" && req.method === "GET") {
            const csv = (value) =>
              '"' +
              (/^[=+@\-\t\r]/.test(String(value)) ? "'" : "") +
              String(value).replaceAll('"', '""') +
              '"';
            res.writeHead(200, {
              "Content-Type": "text/csv; charset=utf-8",
              "Cache-Control": "no-store",
              "Content-Disposition": 'attachment; filename="offcode-vip.csv"',
            });
            res.write(
              "\uFEFFemail,registered_at,consent_at,privacy_url,consent_version,email_verified\r\n",
            );
            // Paged reads instead of a driver cursor: LIMIT/OFFSET behaves the
            // on SQLite and keeps memory bounded.
            for (let offset = 0; !res.destroyed; offset += 200) {
              const rows = await db.all(
                "SELECT email,created_at,consent_at,privacy_url,consent_version FROM vip_members WHERE status='active' ORDER BY created_at DESC LIMIT 200 OFFSET ?",
                [offset],
              );
              for (const row of rows) {
                if (
                  !res.write(
                    [
                      row.email,
                      row.created_at,
                      row.consent_at,
                      row.privacy_url,
                      row.consent_version,
                      "false",
                    ]
                      .map(csv)
                      .join(",") + "\r\n",
                  )
                )
                  await new Promise((resolve) => {
                    const done = () => {
                      res.off("drain", done);
                      res.off("close", done);
                      resolve();
                    };
                    res.once("drain", done);
                    res.once("close", done);
                  });
                if (res.destroyed) break;
              }
              if (rows.length < 200) break;
            }
            return res.end();
          }
          const memberMatch = route.match(
            /^\/api\/admin\/waitlist\/([a-f0-9-]{36})$/i,
          );
          if (memberMatch && req.method === "PATCH") {
            const data = await body(req);
            if (data.status !== "withdrawn")
              throw httpError(400, "Solo se permite dar de baja un registro.");
            const row = await db.get("SELECT status FROM vip_members WHERE id=?", [
              memberMatch[1],
            ]);
            if (!row) throw httpError(404, "Registro no encontrado.");
            await db.run(
              "UPDATE vip_members SET status='withdrawn',withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=?",
              [new Date().toISOString(), memberMatch[1]],
            );
            return send(res, 200, { ok: true });
          }
          if (route === "/api/admin/orders" && req.method === "GET") {
            const page = Math.max(
              0,
              Math.min(
                10000,
                Number.parseInt(url.searchParams.get("page") ?? "0", 10) || 0,
              ),
            );
            const query = (url.searchParams.get("q") ?? "")
              .trim()
              .slice(0, 150)
              .toLowerCase();
            const filter = url.searchParams.get("status") ?? "";
            // Pseudo-filter: awaiting transfer with a buyer notice to check in the bank.
            const reportedOnly = filter === "transfer_reported";
            const status = reportedOnly ? "awaiting_transfer" : filter;
            if (status && !Object.hasOwn(labels, status))
              throw httpError(400, "Revisa el estado del filtro.");
            const condition = "(?='' OR json_extract(payload,'$.status')=?) AND (?=0 OR json_extract(payload,'$.transferReport.at') IS NOT NULL) AND (?='' OR instr(lower(id || ' ' || json_extract(payload,'$.customer.name')),?)>0)";
            const params = [status, status, reportedOnly ? 1 : 0, query, query];
            const total = (await db.get("SELECT COUNT(*) AS n FROM orders WHERE " + condition, params)).n;
            const rows = await db.all("SELECT * FROM orders WHERE " + condition + " ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET ?", [...params, page * 50]);
            return send(res, 200, {
              orders: await Promise.all(rows.slice(0, 50).map(summary)),
              more: rows.length > 50,
              page,
              total,
              bank,
              labels,
              shipping: shippingConfig,
            });
          }
          const shippingMatch = route.match(
            /^\/api\/admin\/orders\/(OF-[A-F0-9]{12})\/(shipping-rates|label|label-reconcile)$/,
          );
          if (shippingMatch && req.method === "POST") {
            const order = await getOrder(shippingMatch[1]),
              action = shippingMatch[2],
              data = await body(req);
            if (action === "label" && order.labelJob?.state === "generated")
              return send(res, 200, { order }); // A retry cannot buy a second label, even after restart.
            if (data.version !== order.version)
              throw httpError(409, "El pedido cambió. Actualiza el panel.");
            if (action === "label-reconcile") {
              if (
                order.labelJob?.state !== "uncertain" ||
                data.checkedInEnvia !== true ||
                order.status !== "paid"
              )
                throw httpError(
                  409,
                  "Revisa primero la guía de este pedido directamente en Envia.",
                );
              if (
                data.confirmNoShipment === true &&
                data.reference === order.id
              ) {
                order.history.push({
                  at: new Date().toISOString(),
                  status: order.status,
                  note: "El propietario verificó en Envia que el intento no creó guía ni cargo pendiente; habilitó una nueva compra.",
                });
                // Order payload and shipping job move together: either the
                // owner can buy again, or the lock stays exactly as it was.
                await catalog.tx(async (exec) => {
                  await persistOrder(order, exec);
                  await exec.run(
                    "DELETE FROM shipping_jobs WHERE order_id=? AND state='uncertain'",
                    [order.id],
                  );
                });
                return send(res, 200, { order: await getOrder(order.id) });
              }
              const result = {
                shipmentId: clean(
                  data.shipmentId,
                  1,
                  80,
                  "el identificador de Envia",
                ),
                tracking: clean(data.tracking, 4, 100, "el rastreo"),
                labelUrl: safeUrl(data.labelUrl),
                environment: order.labelJob.environment,
                reconciledAt: new Date().toISOString(),
              };
              if (!result.labelUrl)
                throw httpError(
                  400,
                  "La guía debe ser un enlace HTTPS válido.",
                );
              const priorJobRow = await db.get(
                "SELECT payload FROM shipping_jobs WHERE order_id=?",
                [order.id],
              );
              const priorJob = priorJobRow ? JSON.parse(priorJobRow.payload) : {};
              await db.run(
                "UPDATE shipping_jobs SET state='generated',payload=? WHERE order_id=? AND state='uncertain'",
                [JSON.stringify({ ...priorJob, result }), order.id],
              );
              return send(res, 200, { order: await getOrder(order.id) });
            }
            if (!shipping.enabled)
              throw httpError(
                503,
                "Configura Envia antes de cotizar o comprar guías.",
              );
            if (order.labelJob)
              throw httpError(
                409,
                "La guía ya se está procesando o necesita revisión en Envia. No se volverá a comprar.",
              );
            if (action === "shipping-rates") {
              if (!["requested", "paid"].includes(order.status))
                throw httpError(
                  409,
                  "No se puede cotizar este pedido en su estado actual.",
                );
              return send(res, 200, {
                rates: await quoteShipping(
                  order.customer,
                  order.items,
                  order.id,
                ),
              });
            }
            if (order.status !== "paid")
              throw httpError(
                409,
                "Primero verifica la transferencia en tu banco.",
              );
            if (data.confirmPurchase !== true)
              throw httpError(
                400,
                "Confirma la compra de la guía y su cargo en Envia.",
              );
            const quote = await chosenQuote(
              data.quoteId,
              order.customer,
              order.items,
              order.id,
            );
            if (data.expectedCents !== quote.rate.shippingCents)
              throw httpError(409, "Confirma el costo actual de la guía.");
            if (
              order.shipping?.service &&
              order.shipping.service !== quote.rate.service
            )
              throw httpError(
                409,
                "Conserva el servicio FedEx acordado con el cliente.",
              );
            const job = {
              environment: shipping.environment,
              at: new Date().toISOString(),
              quote,
            };
            // Durable lock precedes the charge. Timeouts/crashes never trigger an automatic retry.
            const lock = await db.run(
              "INSERT OR IGNORE INTO shipping_jobs(order_id,state,payload) VALUES(?,'pending',?)",
              [order.id, JSON.stringify(job)],
            );
            if (!lock.changes)
              throw httpError(
                409,
                "Ya existe una operación de guía para este pedido.",
              );
            try {
              const result = await shipping.generate(
                quote.payload,
                quote.rate,
                order.id,
              );
              await db.run(
                "UPDATE shipping_jobs SET state='generated',payload=? WHERE order_id=?",
                [JSON.stringify({ ...job, result }), order.id],
              );
              return send(res, 201, { order: await getOrder(order.id) });
            } catch {
              await db.run(
                "UPDATE shipping_jobs SET state='uncertain' WHERE order_id=?",
                [order.id],
              );
              throw httpError(
                502,
                "No se pudo confirmar la guía. Revisa este pedido en Envia antes de continuar; se bloqueó la recompra para evitar cargos duplicados.",
              );
            }
          }
          const match = route.match(
            /^\/api\/admin\/orders\/(OF-[A-F0-9]{12})$/,
          );
          if (match && req.method === "PATCH") {
            await expiration.expireOne(match[1]);
            const change = await body(req),
              order = await getOrder(match[1]);
            if (change.version !== order.version)
              throw httpError(
                409,
                "El pedido cambió. Actualiza el panel antes de guardar.",
              );
            if (order.labelJob && order.labelJob.state !== "generated")
              throw httpError(
                409,
                "La guía requiere revisión en Envia antes de cambiar el pedido.",
              );
            if (change.status === "cancelled" && order.labelJob)
              throw httpError(
                409,
                "Hay una guía comprada. Gestiona su cancelación y este pedido directamente con Envia y el cliente.",
              );
            const allowed = {
              requested: ["awaiting_transfer", "cancelled"],
              awaiting_transfer: ["paid", "cancelled"],
              paid: ["shipped", "cancelled"],
              shipped: ["delivered"],
              delivered: [],
              cancelled: [],
            };
            if (!allowed[order.status].includes(change.status))
              throw httpError(409, "Cambio de estado no permitido.");
            if (change.status === "awaiting_transfer") {
              if (change.stockConfirmed !== true)
                throw httpError(400, "Confirma antes la disponibilidad real.");
              if (shipping.enabled) {
                if (change.quoteId) {
                  const q = await chosenQuote(
                    change.quoteId,
                    order.customer,
                    order.items,
                    order.id,
                  );
                  order.shippingCents = q.rate.shippingCents;
                  order.shipping = {
                    provider: "envia",
                    carrier: "fedex",
                    service: q.rate.service,
                    description: q.rate.description,
                    quotedCents: q.rate.shippingCents,
                    deliveryEstimate: q.rate.deliveryEstimate || "",
                    environment: q.environment,
                    quotedAt: new Date().toISOString(),
                  };
                }
                if (
                  !order.shipping ||
                  order.shipping.environment !== shipping.environment
                )
                  throw httpError(
                    400,
                    "Cotiza FedEx antes de confirmar el total.",
                  );
                change.shippingCents = order.shippingCents;
              }
              if (
                !Number.isSafeInteger(change.shippingCents) ||
                change.shippingCents < 0 ||
                change.shippingCents > 1000000
              )
                throw httpError(400, "Indica el costo de envío en centavos.");
              const account = bankSnapshot(bank);
              if (!account)
                throw httpError(
                  400,
                  "Falta configurar la cuenta de transferencia.",
                );
              order.shippingCents = change.shippingCents;
              order.totalCents = order.subtotalCents + order.shippingCents;
              order.transferAccount = account;
              order.transferConcept = transferConcept(order.id);
            }
            if (change.status === "paid" && change.paymentVerified !== true)
              throw httpError(400, "Verifica el abono en la cuenta bancaria.");
            if (change.status === "shipped") {
              if (change.handedToCarrier !== true)
                throw httpError(
                  400,
                  "Confirma la entrega física del paquete a FedEx.",
                );
              if (shipping.enabled && order.labelJob?.state !== "generated")
                throw httpError(
                  400,
                  "Genera o concilia primero la guía de FedEx.",
                );
              if (!order.labelJob && change.carrier?.toLowerCase() !== "fedex")
                throw httpError(400, "Solo se permiten envíos por FedEx.");
              if (
                order.labelJob?.environment === "sandbox" &&
                shipping.environment === "production"
              )
                throw httpError(
                  409,
                  "Una guía de sandbox no sirve para enviar en producción.",
                );
              order.carrier = "FedEx";
              order.tracking =
                order.labelJob?.result?.tracking ??
                clean(change.tracking, 4, 100, "el número de rastreo");
            }
            if (change.status === "delivered" && change.deliveryConfirmed !== true)
              throw httpError(
                400,
                "Confirma la entrega con la paquetería o el cliente antes de marcar entregado.",
              );
            order.status = change.status;
            order.updatedAt = new Date().toISOString();
            if (change.status === "cancelled") order.cancellation = { reason: "owner_cancelled", at: order.updatedAt };
            order.history.push({ at: order.updatedAt, status: order.status });
            // Stock and order status move together: a failed write never leaves
            // the inventory discounted without the matching status.
            const value = await catalog.tx(async (exec) => {
              if (change.status === "paid") await catalog.sell(order.id, exec);
              if (change.status === "cancelled") await catalog.release(order.id, exec);
              return persistOrder(order, exec);
            });
            await captureEmail(value);
            return send(res, 200, { order: await getOrder(order.id) });
          }
        }
        throw httpError(404, "Ruta no encontrada.");
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw httpError(405, "Método no permitido.");
      // One canonical policy only. The retired standalone notice stays on disk
      // as a historical artifact but is never served: it described a different
      // platform and would contradict /privacidad.html. Temporary (302) until
      // the owner approves the canonical text, so no browser caches it forever.
      if (route === "/aviso-de-privacidad.html") {
        res.writeHead(302, { Location: "/privacidad.html", "Cache-Control": "no-store" });
        return res.end();
      }
      let filename =
        route === "/"
          ? "index.html"
          : decodeURIComponent(route).replace(/^\//, "");
      if (
        filename.includes("..") ||
        filename.includes("\\") ||
        filename.includes("\0")
      )
        throw httpError(404, "Archivo no encontrado.");
      filename = path.resolve(ROOT, filename);
      if (!filename.startsWith(ROOT + path.sep))
        throw httpError(404, "Archivo no encontrado.");
      let info;
      try {
        info = await stat(filename);
      } catch {
        throw httpError(404, "Archivo no encontrado.");
      }
      if (!info.isFile()) throw httpError(404, "Archivo no encontrado.");
      const mime =
        {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".webp": "image/webp",
          ".mp4": "video/mp4",
          ".glb": "model/gltf-binary",
        }[path.extname(filename)] ?? "application/octet-stream";
      res.setHeader("Content-Type", mime);
      const cache = staticPolicy(path.relative(ROOT, filename));
      res.setHeader("Cache-Control", cache);
      if (cache !== "no-store") {
        const etag = `W/"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
        res.setHeader("ETag", etag);
        if (
          !req.headers.range &&
          req.headers["if-none-match"]
            ?.split(",")
            .map((s) => s.trim())
            .includes(etag)
        ) {
          res.writeHead(304);
          return res.end();
        }
      }
      res.setHeader("Accept-Ranges", "bytes");
      let start = 0,
        end = info.size - 1,
        status = 200;
      if (req.headers.range) {
        const range = req.headers.range.match(/^bytes=(\d+)-(\d*)$/);
        if (!range || Number(range[1]) >= info.size) {
          res.writeHead(416, { "Content-Range": `bytes */${info.size}` });
          return res.end();
        }
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), end) : end;
        if (end < start) throw httpError(416, "Rango no válido.");
        status = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${info.size}`);
      }
      res.setHeader("Content-Length", end - start + 1);
      res.writeHead(status);
      if (req.method === "HEAD") return res.end();
      const stream = createReadStream(filename, { start, end });
      res.on("close", () => stream.destroy());
      stream.on("error", () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent)
        send(res, error.status ?? 500, {
          error: error.status
            ? error.message
            : "No se pudo completar la solicitud.",
        });
      else res.destroy();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  return {
    server,
    email,
    accounts,
    expiration,
    db,
    close: async () => {
      await expiration.close();
      await accounts.close();
      await email.close();
      return new Promise((resolve) => {
        clearInterval(quoteCleanup);
        server.close(async () => {
          await db.close().catch(() => {});
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let app;
  try {
    app = await createApp();
  } catch (error) {
    // Never keep serving with a database that was not configured correctly.
    console.error(`OFFCODE no pudo iniciar: ${error.message}`);
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8000);
  const host = process.env.HOST ?? "127.0.0.1";
  app.server.listen(port, host, () => {
    const info = app.db.describe();
    const target = `sqlite ${info.path}`;
    console.log(
      `OFFCODE: ${process.env.PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:" + port} · datos en ${target} · operación en /admin.html · configuración en /settings.html`,
    );
  });
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
