import http from "node:http";
import { createReadStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  randomBytes,
  randomUUID,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { safeUrl } from "./envia.mjs";
import { clientIp, staticPolicy } from "./http-policy.mjs";
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
function validateItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 4)
    throw httpError(400, "La bolsa no es válida.");
  const sizes = new Set();
  const result = items.map((p) => {
    if (
      !p ||
      !["S", "M", "L", "XL"].includes(p.size) ||
      sizes.has(p.size) ||
      !Number.isInteger(p.qty) ||
      p.qty < 1 ||
      p.qty > 99
    )
      throw httpError(400, "Revisa tallas y cantidades (1–99 por talla).");
    sizes.add(p.size);
    return { size: p.size, qty: p.qty, unitCents: UNIT_CENTS };
  });
  if (result.reduce((s, p) => s + p.qty, 0) > 99)
    throw httpError(400, "Máximo 99 prendas por solicitud.");
  return result;
}
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
  const databasePath =
    options.databasePath ??
    process.env.DATABASE_PATH ??
    "./data/offcode.sqlite";
  if (databasePath !== ":memory:")
    await mkdir(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  let store, currentSettings, settingsVersion, settingsUpdatedAt, shipping;
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS owner_auth (id INTEGER PRIMARY KEY CHECK(id=1),salt BLOB NOT NULL,hash BLOB NOT NULL,updated_at TEXT NOT NULL);",
    );
    const credentials = db
      .prepare("SELECT salt,hash FROM owner_auth WHERE id=1")
      .get();
    if (credentials) {
      salt = Buffer.from(credentials.salt);
      passwordHash = Buffer.from(credentials.hash);
    }
    store = settingsStore(
      db,
      options.settingsKey ?? process.env.SETTINGS_ENCRYPTION_KEY ?? "",
    );
    const stored = store.read();
    currentSettings = stored?.value ?? initialSettings(options);
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
  } catch (e) {
    db.close();
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
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL);",
  );
  db.exec(
    "CREATE TABLE IF NOT EXISTS vip_members (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, consent_at TEXT NOT NULL, privacy_url TEXT NOT NULL, consent_version TEXT NOT NULL, consent_text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', withdrawn_at TEXT);",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS shipping_quotes (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, order_id TEXT, expires INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS shipping_jobs (order_id TEXT PRIMARY KEY, state TEXT NOT NULL, payload TEXT NOT NULL);`);
  // A process interrupted during a purchase cannot know whether Envia charged it.
  db.exec("UPDATE shipping_jobs SET state='uncertain' WHERE state='pending'");
  const expireQuotes = () =>
    db.prepare("DELETE FROM shipping_quotes WHERE expires<?").run(Date.now());
  expireQuotes();
  const quoteCleanup = setInterval(expireQuotes, 60e3);
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
  const summary = (row) => ({
    ...JSON.parse(row.payload),
    version: row.version,
    labelJob: (() => {
      const job = db
        .prepare("SELECT state,payload FROM shipping_jobs WHERE order_id=?")
        .get(row.id);
      if (!job) return null;
      const value = JSON.parse(job.payload);
      return {
        state: job.state,
        environment: value.environment,
        result: value.result ?? null,
      };
    })(),
  });
  const getOrder = (id) => {
    const row = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
    if (!row) throw httpError(404, "Pedido no encontrado.");
    return summary(row);
  };
  const fingerprint = (customer, items) =>
    createHash("sha256")
      .update(JSON.stringify({ customer, items }))
      .digest("hex");
  const saveOrder = (order) => {
    const { version, labelJob, ...value } = order;
    const result = db
      .prepare(
        "UPDATE orders SET payload=?,version=version+1 WHERE id=? AND version=?",
      )
      .run(JSON.stringify(value), order.id, version);
    if (!result.changes)
      throw httpError(409, "El pedido cambió. Actualiza el panel.");
    return getOrder(order.id);
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
    db.prepare("DELETE FROM shipping_quotes WHERE expires<?").run(Date.now());
    return rates.map((rate) => {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO shipping_quotes(id,fingerprint,order_id,expires,payload) VALUES(?,?,?,?,?)",
      ).run(
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
      );
      return {
        id,
        ...rate,
        carrier: "FedEx",
        expiresAt: new Date(expires).toISOString(),
      };
    });
  }
  function chosenQuote(id, customer, items, orderId = null) {
    const row =
      typeof id === "string" &&
      db.prepare("SELECT * FROM shipping_quotes WHERE id=?").get(id);
    if (
      !row ||
      row.expires < Date.now() ||
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
        if (route === "/api/config" && req.method === "GET")
          return send(res, 200, {
            enabled,
            whatsapp: enabled ? whatsapp : "",
            privacyUrl,
            termsUrl,
            unitCents: UNIT_CENTS,
            waitlistEnabled,
            vipConsentVersion: VIP_CONSENT_VERSION,
            shipping: shippingConfig,
          });
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
              "Acepta el aviso de privacidad antes de cotizar el envío.",
            );
          return send(res, 200, {
            rates: await quoteShipping(
              validateCustomer(data.customer),
              validateItems(data.items),
            ),
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
          db.prepare(
            "INSERT OR IGNORE INTO vip_members(id,email,created_at,consent_at,privacy_url,consent_version,consent_text) VALUES(?,?,?,?,?,?,?)",
          ).run(
            randomUUID(),
            email,
            now,
            now,
            privacyUrl,
            VIP_CONSENT_VERSION,
            VIP_CONSENT_TEXT,
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
          if (!enabled)
            throw httpError(503, "Los pedidos todavía no están habilitados.");
          limit("order:" + ip, 300, 3600e3);
          const data = await body(req);
          if (!enabled)
            throw httpError(503, "Los pedidos todavía no están habilitados.");
          if (data.consent !== true)
            throw httpError(
              400,
              "Confirma el aviso de privacidad y las condiciones.",
            );
          if (
            typeof data.requestKey !== "string" ||
            !/^[a-f0-9-]{36}$/i.test(data.requestKey)
          )
            throw httpError(400, "Falta la referencia de la solicitud.");
          const items = validateItems(data.items),
            customer = validateCustomer(data.customer);
          const prior = db
            .prepare("SELECT * FROM orders WHERE request_key=?")
            .get(data.requestKey);
          if (prior) {
            const saved = summary(prior);
            if (
              JSON.stringify(saved.customer) !== JSON.stringify(customer) ||
              JSON.stringify(saved.items) !== JSON.stringify(items)
            )
              throw httpError(
                409,
                "Ya existe una solicitud con esta referencia y otros datos. Contacta a OFFCODE para corregirla antes de enviar otra.",
              );
            return send(res, 200, {
              id: saved.id,
              subtotalCents: saved.subtotalCents,
              status: saved.status,
            });
          }
          const quote = shipping.enabled
            ? chosenQuote(data.shippingQuoteId, customer, items)
            : null;
          limit(
            "customer:" +
              createHash("sha256")
                .update(customer.email.toLowerCase())
                .digest("hex"),
            6,
            3600e3,
          );
          const id = "OF-" + randomBytes(6).toString("hex").toUpperCase(),
            now = new Date().toISOString();
          const order = {
            id,
            createdAt: now,
            updatedAt: now,
            customer,
            items,
            subtotalCents: items.reduce((s, p) => s + p.qty * UNIT_CENTS, 0),
            shippingCents: quote?.rate.shippingCents ?? null,
            totalCents: quote
              ? items.reduce((s, p) => s + p.qty * UNIT_CENTS, 0) +
                quote.rate.shippingCents
              : null,
            shipping: quote
              ? {
                  provider: "envia",
                  carrier: "fedex",
                  service: quote.rate.service,
                  description: quote.rate.description,
                  environment: quote.environment,
                  quotedAt: now,
                }
              : null,
            status: "requested",
            carrier: "",
            tracking: "",
            history: [{ at: now, status: "requested" }],
            consent: { at: now, privacyUrl, termsUrl },
          };
          db.prepare(
            "INSERT INTO orders(id,request_key,created_at,payload) VALUES(?,?,?,?)",
          ).run(id, data.requestKey, now, JSON.stringify(order));
          return send(res, 201, {
            id,
            subtotalCents: order.subtotalCents,
            status: order.status,
          });
        }
        if (route.startsWith("/api/admin/")) {
          auth(req);
          if (route === "/api/admin/settings" && req.method === "GET")
            return send(res, 200, {
              settings: publicSettings(currentSettings),
              version: settingsVersion,
              updatedAt: settingsUpdatedAt,
              canSave: store.keyConfigured,
              production,
              checks: readiness(currentSettings, {
                production,
                keyConfigured: store.keyConfigured,
                passwordConfigured: !!passwordHash,
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
              db
                .prepare(
                  "SELECT 1 FROM shipping_jobs WHERE state='pending' LIMIT 1",
                )
                .get()
            )
              throw httpError(
                409,
                "Espera a que termine la operación de guía antes de cambiar la configuración.",
              );
            const candidate = normalizeSettings(data.settings, currentSettings);
            const provider = validateActivation(candidate, {
              production,
              passwordConfigured: !!passwordHash,
              fetcher: options.envia?.fetch,
            });
            const saved = store.save(candidate, data.version);
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
            db.prepare("DELETE FROM shipping_quotes").run();
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
            db.prepare(
              "INSERT INTO owner_auth(id,salt,hash,updated_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt,hash=excluded.hash,updated_at=excluded.updated_at",
            ).run(nextSalt, nextHash, new Date().toISOString());
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
              message:
                "Envia respondió al consultar sus estados. Todavía falta validar cobertura, tarifas y una guía para tus paquetes.",
            });
          }
          if (route === "/api/admin/overview" && req.method === "GET") {
            const rows = db
              .prepare(
                "SELECT json_extract(payload,'$.status') AS status,COUNT(*) AS count FROM orders GROUP BY json_extract(payload,'$.status')",
              )
              .all();
            const counts = Object.fromEntries(
              Object.keys(labels).map((k) => [k, 0]),
            );
            for (const row of rows) counts[row.status] = row.count;
            const paid = db
              .prepare(
                "SELECT COUNT(*) AS count,COALESCE(SUM(json_extract(payload,'$.totalCents')),0) AS total FROM orders WHERE json_extract(payload,'$.status') IN ('paid','shipped','delivered')",
              )
              .get();
            return send(res, 200, {
              counts,
              total: rows.reduce((s, r) => s + r.count, 0),
              paidCount: paid.count,
              paidTotalCents: paid.total,
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
            const members = db
              .prepare(
                "SELECT id,email,created_at,consent_at,privacy_url,consent_version,status,withdrawn_at FROM vip_members WHERE status=? ORDER BY created_at DESC LIMIT 51 OFFSET ?",
              )
              .all(status, page * 50);
            const total = db
              .prepare("SELECT COUNT(*) AS n FROM vip_members WHERE status=?")
              .get(status).n;
            return send(res, 200, {
              members: members.slice(0, 50),
              more: members.length > 50,
              total,
              page,
              enabled: waitlistEnabled,
            });
          }
          if (route === "/api/admin/waitlist.csv" && req.method === "GET") {
            const rows = db
              .prepare(
                "SELECT email,created_at,consent_at,privacy_url,consent_version FROM vip_members WHERE status='active' ORDER BY created_at DESC",
              )
              .iterate();
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
            return res.end();
          }
          const memberMatch = route.match(
            /^\/api\/admin\/waitlist\/([a-f0-9-]{36})$/i,
          );
          if (memberMatch && req.method === "PATCH") {
            const data = await body(req);
            if (data.status !== "withdrawn")
              throw httpError(400, "Solo se permite dar de baja un registro.");
            const row = db
              .prepare("SELECT status FROM vip_members WHERE id=?")
              .get(memberMatch[1]);
            if (!row) throw httpError(404, "Registro no encontrado.");
            db.prepare(
              "UPDATE vip_members SET status='withdrawn',withdrawn_at=COALESCE(withdrawn_at,?) WHERE id=?",
            ).run(new Date().toISOString(), memberMatch[1]);
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
            const status = url.searchParams.get("status") ?? "";
            if (status && !Object.hasOwn(labels, status))
              throw httpError(400, "Revisa el estado del filtro.");
            const condition =
              "(?='' OR json_extract(payload,'$.status')=?) AND (?='' OR instr(lower(id || ' ' || json_extract(payload,'$.customer.name')),?)>0)";
            const params = [status, status, query, query];
            const total = db
              .prepare(
                "SELECT COUNT(*) AS count FROM orders WHERE " + condition,
              )
              .get(...params).count;
            const rows = db
              .prepare(
                "SELECT * FROM orders WHERE " +
                  condition +
                  " ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET ?",
              )
              .all(...params, page * 50);
            return send(res, 200, {
              orders: rows.slice(0, 50).map(summary),
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
            const order = getOrder(shippingMatch[1]),
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
                db.exec("BEGIN IMMEDIATE");
                try {
                  saveOrder(order);
                  db.prepare(
                    "DELETE FROM shipping_jobs WHERE order_id=? AND state='uncertain'",
                  ).run(order.id);
                  db.exec("COMMIT");
                } catch (e) {
                  db.exec("ROLLBACK");
                  throw e;
                }
                return send(res, 200, { order: getOrder(order.id) });
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
              const priorJob = JSON.parse(
                db
                  .prepare("SELECT payload FROM shipping_jobs WHERE order_id=?")
                  .get(order.id).payload,
              );
              db.prepare(
                "UPDATE shipping_jobs SET state='generated',payload=? WHERE order_id=? AND state='uncertain'",
              ).run(JSON.stringify({ ...priorJob, result }), order.id);
              return send(res, 200, { order: getOrder(order.id) });
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
            const quote = chosenQuote(
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
            const lock = db
              .prepare(
                "INSERT OR IGNORE INTO shipping_jobs(order_id,state,payload) VALUES(?,'pending',?)",
              )
              .run(order.id, JSON.stringify(job));
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
              db.prepare(
                "UPDATE shipping_jobs SET state='generated',payload=? WHERE order_id=?",
              ).run(JSON.stringify({ ...job, result }), order.id);
              return send(res, 201, { order: getOrder(order.id) });
            } catch {
              db.prepare(
                "UPDATE shipping_jobs SET state='uncertain' WHERE order_id=?",
              ).run(order.id);
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
            const change = await body(req),
              order = getOrder(match[1]);
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
                  const q = chosenQuote(
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
              if (
                !bank.name ||
                !bank.beneficiary ||
                !/^\d{18}$/.test(bank.clabe)
              )
                throw httpError(
                  400,
                  "Falta configurar la cuenta de transferencia.",
                );
              order.shippingCents = change.shippingCents;
              order.totalCents = order.subtotalCents + order.shippingCents;
              order.transferAccount = { ...bank };
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
                  "Una guía de prueba no sirve para enviar en producción.",
                );
              order.carrier = "FedEx";
              order.tracking =
                order.labelJob?.result?.tracking ??
                clean(change.tracking, 4, 100, "el número de rastreo");
            }
            order.status = change.status;
            order.updatedAt = new Date().toISOString();
            order.history.push({ at: order.updatedAt, status: order.status });
            return send(res, 200, { order: saveOrder(order) });
          }
        }
        throw httpError(404, "Ruta no encontrada.");
      }
      if (!["GET", "HEAD"].includes(req.method))
        throw httpError(405, "Método no permitido.");
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
    close: () =>
      new Promise((resolve) => {
        clearInterval(quoteCleanup);
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const port = Number(process.env.PORT ?? 8000);
  app.server.listen(port, process.env.HOST ?? "127.0.0.1", () =>
    console.log(
      `OFFCODE: ${process.env.PUBLIC_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? "http://localhost:" + port} · operación en /admin.html · configuración en /settings.html`,
    ),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
