import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createEmailTransport, validEmail } from "./email.mjs";

const derive = promisify(scrypt);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (status, message) => Object.assign(new Error(message), { status });
const generic = "Si la dirección permite esta operación, se intentará enviar un enlace. La entrega no está confirmada; revisa también spam.";
const genericEmailChange = "Si esa dirección puede usarse, enviaremos un enlace de confirmación. La entrega no está confirmada; revisa también spam.";
const MARKETING_VERSION = "commercial-v1";
const MARKETING_TEXT =
  "Quiero recibir novedades, lanzamientos y avisos comerciales de OFFCODE por correo. Entiendo que puedo retirar este consentimiento cuando quiera desde mi cuenta.";

// Order states are derived only from what the owner actually persisted. There is
// no synthetic fallback: an unknown state stays unknown and is shown as such.
const ORDER_LABELS = Object.freeze({
  requested: "Por confirmar",
  awaiting_transfer: "Pendiente de transferencia",
  paid: "Pago verificado",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
});
const ORDER_STATE = Object.freeze({
  requested: ["pending", "pending"],
  awaiting_transfer: ["pending", "pending"],
  paid: ["paid", "preparing"],
  shipped: ["paid", "shipped"],
  delivered: ["paid", "delivered"],
  cancelled: ["cancelled", "cancelled"],
});
const PAYMENT_LABELS = Object.freeze({ pending: "Pago pendiente", paid: "Pagado", cancelled: "Cancelado", unknown: "Sin estado de pago" });
const SHIPPING_LABELS = Object.freeze({
  pending: "Envío por confirmar",
  preparing: "En preparación",
  shipped: "Enviado",
  delivered: "Entregado",
  cancelled: "Cancelado",
  unknown: "Sin estado de envío",
});
const money = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const text = (value) => (typeof value === "string" ? value.trim() : "");

export function normalizeCustomerEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  const [local, domain] = email.split("@");
  if (!validEmail(email) || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") ||
      domain.split(".").some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))
    throw fail(400, "Escribe un correo electrónico válido.");
  return email;
}
function password(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    throw fail(400, "Usa una contraseña de 12 a 128 caracteres.");
  return value;
}
async function passwordHash(value, salt = randomBytes(16).toString("hex")) {
  const hash = await derive(value, salt, 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$3$${salt}$${hash.toString("hex")}`;
}
async function verifyPassword(value, stored) {
  const parts = (stored ?? "").split("$");
  const valid = parts.length === 6 && parts.slice(0, 4).join("$") === "scrypt$32768$8$3" && /^[a-f0-9]{32}$/.test(parts[4]) && /^[a-f0-9]{64}$/.test(parts[5]);
  const candidate = await passwordHash(value, valid ? parts[4] : "0".repeat(32));
  return timingSafeEqual(Buffer.from(candidate.split("$")[5], "hex"), Buffer.from(valid ? parts[5] : "0".repeat(64), "hex")) && valid;
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// One backend-generated URL for the CTA, copyable fallback and plain text.
// Tables, explicit backgrounds and inline styles also work without head CSS.
function accountLinkMessage({ from, to, title, action, url, notice }) {
  const safeUrl = escapeHtml(url);
  return {
    from, to: [to], subject: `OFFCODE · ${title}`,
    text: `OFFCODE · ${title}\n\n${action}\n${url}\n\n${notice}`,
    html: `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body bgcolor="#080808" style="margin:0;padding:0;background-color:#080808;color:#f5f5f5;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#080808" style="width:100%;background-color:#080808"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#181818" style="width:100%;max-width:600px;table-layout:fixed;background-color:#181818;border:1px solid #454545"><tr><td style="padding:28px 20px">
<p style="margin:0 0 24px;color:#f5f5f5;font-size:14px;letter-spacing:3px">OFFCODE</p>
<h1 style="margin:0 0 24px;color:#f5f5f5;font-size:26px;line-height:1.3;font-weight:400">${escapeHtml(title)}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%"><tr><td align="center" bgcolor="#ffffff" style="background-color:#ffffff;border:2px solid #ffffff">
<a href="${safeUrl}" style="display:block;padding:16px 12px;background-color:#ffffff;border:1px solid #080808;color:#080808;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;font-weight:700;text-align:center;text-decoration:none">${escapeHtml(action)}</a>
</td></tr></table>
<p style="margin:24px 0 8px;color:#e0e0e0;font-size:14px;line-height:1.6">Si el botón no funciona, copia y pega este enlace completo en tu navegador:</p>
<p style="margin:0 0 24px;font-size:14px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere"><a href="${safeUrl}" style="color:#ffffff;text-decoration:underline;word-break:break-all;overflow-wrap:anywhere">${safeUrl}</a></p>
<p style="margin:0;border-top:1px solid #454545;padding-top:20px;color:#c7c7c7;font-size:13px;line-height:1.6">${escapeHtml(notice)}</p>
</td></tr></table></td></tr></table></body></html>`,
  };
}
const cookieValue = (req, name) => req.headers.cookie?.split(";").map((s) => s.trim()).find((s) => s.startsWith(name + "="))?.slice(name.length + 1) ?? "";

export function createCustomerAccounts({ db, origin, production, body, send, limit, validateCustomer,
  env = process.env, fetcher, now = Date.now, logger = console.info } = {}) {
  const mail = createEmailTransport({ env, fetcher });
  const pending = new Set();
  const cookieName = production ? "__Host-offcode_customer" : "offcode_customer";
  function cookie(res, name, value, seconds) {
    const existing = res.getHeader("Set-Cookie"), valueHeader = `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${production ? "; Secure" : ""}`;
    res.setHeader("Set-Cookie", existing ? [...(Array.isArray(existing) ? existing : [existing]), valueHeader] : valueHeader);
  }
  const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, verified: !!u.verified_at });
  async function current(req) {
    const token = cookieValue(req, cookieName);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return db.get("SELECT c.* FROM customers c JOIN customer_sessions s ON s.customer_id=c.id WHERE s.token_hash=? AND s.expires>?", [digest(token), now()]);
  }
  async function requireUser(req, verified = true) {
    const user = await current(req);
    if (!user) throw fail(401, "Inicia sesión en tu cuenta de cliente.");
    if (verified && !user.verified_at) throw fail(403, "Verifica tu correo antes de acceder a tus datos.");
    return user;
  }
  async function newSession(req, res, user) {
    const token = secret();
    await db.tx(async (tx) => {
      await tx.run("DELETE FROM customer_sessions WHERE token_hash=? OR expires<=?", [digest(cookieValue(req, cookieName)), now()]);
      await tx.run("INSERT INTO customer_sessions VALUES(?,?,?)", [digest(token), user.id, now() + 7 * 86400e3]);
    });
    cookie(res, cookieName, token, 7 * 86400);
  }
  function requireMail(message = "El correo de cuentas aún no está habilitado. No podemos enviar enlaces de verificación o recuperación.") {
    if (!mail.enabled) throw fail(503, message);
  }
  async function sendToken(user, purpose) {
    const token = secret();
    await db.tx(async (tx) => {
      await tx.run("DELETE FROM customer_tokens WHERE customer_id=? AND purpose=? OR expires<=?", [user.id, purpose, now()]);
      await tx.run("INSERT INTO customer_tokens VALUES(?,?,?,?)", [digest(token), user.id, purpose, now() + (purpose === "reset" ? 30 * 60e3 : 86400e3)]);
    });
    // Fragment tokens are never sent in the page URL request or Referer header.
    const url = `${origin}/cuenta.html#${purpose}=${token}`;
    const title = purpose === "reset" ? "Restablece tu contraseña" : "Verifica tu correo";
    const result = await mail.send(accountLinkMessage({ from: mail.from, to: user.email, title, url,
      action: purpose === "reset" ? "RESTABLECER MI CONTRASEÑA" : "VERIFICAR MI CORREO",
      notice: `Este enlace es de un solo uso y vence en ${purpose === "reset" ? "30 minutos" : "24 horas"}. Si no lo solicitaste, ignóralo.`,
    }), `account/${digest(token)}`);
    // Allowlisted metadata only: no recipient, body, token or provider error.
    try { logger(JSON.stringify({ component: "customer_email", state: result.state, code: result.code })); } catch {}
    if (result.state !== "accepted") throw fail(503, "No pudimos confirmar el envío del correo. Intenta solicitar otro enlace más tarde.");
  }
  async function consumeToken(value, purpose, fn) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw fail(400, "El enlace no es válido o ha vencido.");
    return db.tx(async (tx) => {
      const token = await tx.get("SELECT * FROM customer_tokens WHERE token_hash=? AND purpose=? AND expires>?", [digest(value), purpose, now()]);
      if (!token) throw fail(400, "El enlace no es válido o ha vencido.");
      await tx.run("DELETE FROM customer_tokens WHERE token_hash=?", [digest(value)]);
      return fn(tx, token.customer_id);
    });
  }

  // ---- Addresses -----------------------------------------------------------
  const addressOf = (row) => ({
    id: row.id,
    label: row.label,
    name: row.name,
    phone: row.phone,
    street: row.street,
    number: row.number,
    neighborhood: row.neighborhood,
    city: row.city,
    state: row.state,
    postalCode: row.postal_code,
    notes: row.notes,
    isDefault: !!row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  // Server-side validation reuses the checkout validator, so a saved address
  // can never hold a value the checkout would reject. The account email is
  // always taken from the session, never from the request body.
  function addressInput(data, user) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw fail(400, "Revisa la dirección de envío.");
    const label = text(data.label);
    if (label.length > 40 || /[\u0000-\u001f]/.test(label)) throw fail(400, "La etiqueta debe tener 40 caracteres como máximo.");
    const value = validateCustomer({ ...data, email: user.email });
    return { label, value };
  }
  async function defaultAddress(userId, exec = db) {
    const row = await exec.get("SELECT * FROM customer_addresses WHERE customer_id=? AND is_default=1 LIMIT 1", [userId]);
    return row ? addressOf(row) : null;
  }
  async function ensureDefault(tx, userId) {
    const row = await tx.get("SELECT id FROM customer_addresses WHERE customer_id=? AND is_default=1", [userId]);
    if (row) return;
    const next = await tx.get("SELECT id FROM customer_addresses WHERE customer_id=? ORDER BY created_at, rowid LIMIT 1", [userId]);
    if (next) await tx.run("UPDATE customer_addresses SET is_default=1 WHERE id=?", [next.id]);
  }

  // ---- Orders --------------------------------------------------------------
  function customerOrder(order, detail = false) {
    const [payment, shipping] = ORDER_STATE[order.status] ?? ["unknown", "unknown"];
    const carrier = text(order.carrier), tracking = text(order.tracking);
    const result = {
      id: order.id,
      createdAt: order.createdAt,
      status: order.status,
      statusLabel: ORDER_LABELS[order.status] ?? order.status,
      payment: { status: payment, label: PAYMENT_LABELS[payment] },
      shipping: {
        status: shipping,
        label: SHIPPING_LABELS[shipping],
        carrier,
        // Tracking is only exposed when the owner actually recorded it.
        tracking,
        trackingUrl: carrier.toLowerCase() === "fedex" && /^[A-Za-z0-9]{4,40}$/.test(tracking)
          ? `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tracking)}`
          : "",
        service: text(order.shipping?.service),
        description: text(order.shipping?.description),
        estimate: text(order.shipping?.deliveryEstimate),
      },
      items: (Array.isArray(order.items) ? order.items : []).map((item) => ({
        name: text(item?.name),
        color: text(item?.color),
        size: text(item?.size),
        qty: Number.isSafeInteger(item?.qty) ? item.qty : 0,
        unitCents: money(item?.unitCents),
      })),
      subtotalCents: money(order.subtotalCents),
      shippingCents: money(order.shippingCents),
      totalCents: money(order.totalCents),
      currency: "MXN",
    };
    if (detail) {
      const c = order.customer ?? {};
      result.address = {
        name: text(c.name), phone: text(c.phone), street: text(c.street), number: text(c.number),
        neighborhood: text(c.neighborhood), city: text(c.city), state: text(c.state),
        postalCode: text(c.postalCode), notes: text(c.notes),
      };
      // Only real recorded transitions; internal owner notes stay private.
      result.history = (Array.isArray(order.history) ? order.history : [])
        .filter((entry) => entry && typeof entry.status === "string")
        .map((entry) => ({ at: entry.at, status: entry.status, label: ORDER_LABELS[entry.status] ?? entry.status }));
    }
    return result;
  }

  async function sendEmailChange(user, newEmail) {
    const token = secret();
    const at = new Date(now()).toISOString();
    await db.tx(async (tx) => {
      await tx.run("DELETE FROM customer_email_changes WHERE customer_id=? OR expires<=?", [user.id, now()]);
      await tx.run("INSERT INTO customer_email_changes(token_hash,customer_id,new_email,expires,created_at) VALUES(?,?,?,?,?)",
        [digest(token), user.id, newEmail, now() + 3600e3, at]);
    });
    const url = `${origin}/cuenta.html#email=${token}`;
    const result = await mail.send(accountLinkMessage({ from: mail.from, to: newEmail,
      title: "Confirma tu nueva dirección", action: "CONFIRMAR MI NUEVO CORREO", url,
      notice: "Este enlace es de un solo uso y vence en 60 minutos. Tu correo actual sigue activo hasta que lo confirmes. Si no lo solicitaste, ignóralo.",
    }), `email-change/${digest(token)}`);
    try { logger(JSON.stringify({ component: "customer_email", state: result.state, code: result.code })); } catch {}
    if (result.state !== "accepted") throw fail(503, "No pudimos confirmar el envío del correo. Intenta solicitar otro enlace más tarde.");
  }

  async function handle(req, res, url, ip) {
    const route = url.pathname, method = req.method;
    if (!route.startsWith("/api/customer/") && route !== "/api/contact") return false;
    limit("customer-api:" + ip, 240, 60e3);
    if (route === "/api/customer/session" && method === "GET") {
      const user = await current(req);
      send(res, 200, { user: user ? publicUser(user) : null, emailEnabled: mail.enabled }); return true;
    }
    if (route === "/api/customer/register" && method === "POST") {
      limit("customer-register:" + ip, 5, 3600e3); requireMail();
      const data = await body(req), email = normalizeCustomerEmail(data.email);
      const hash = await passwordHash(password(data.password));
      const user = await db.tx(async (tx) => {
        if (await tx.get("SELECT id FROM customers WHERE email=?", [email])) return null;
        const user = { id: randomUUID(), email };
        await tx.run("INSERT INTO customers(id,email,password_hash,created_at) VALUES(?,?,?,?)", [user.id, email, hash, new Date(now()).toISOString()]);
        return user;
      });
      if (user) await sendToken(user, "verify");
      send(res, 200, { message: generic }); return true;
    }
    if (route === "/api/customer/login" && method === "POST") {
      limit("customer-login:" + ip, 8, 15 * 60e3);
      const data = await body(req), email = normalizeCustomerEmail(data.email);
      if (typeof data.password !== "string" || data.password.length > 128) throw fail(401, "Correo o contraseña incorrectos.");
      const user = await db.get("SELECT * FROM customers WHERE email=?", [email]);
      if (!(await verifyPassword(data.password, user?.password_hash))) throw fail(401, "Correo o contraseña incorrectos.");
      await newSession(req, res, user);
      send(res, 200, { user: publicUser(user) }); return true;
    }
    if (route === "/api/customer/logout" && method === "POST") {
      await body(req);
      await db.run("DELETE FROM customer_sessions WHERE token_hash=?", [digest(cookieValue(req, cookieName))]);
      cookie(res, cookieName, "", 0); send(res, 200, { ok: true }); return true;
    }
    if (["/api/customer/recover", "/api/customer/verification"].includes(route) && method === "POST") {
      limit("customer-links:" + ip, 4, 3600e3); requireMail();
      const data = await body(req), email = normalizeCustomerEmail(data.email);
      limit("customer-links-email:" + digest(email), 3, 3600e3);
      const user = await db.get("SELECT * FROM customers WHERE email=?", [email]);
      const purpose = route.endsWith("recover") ? "reset" : "verify";
      if (user && (purpose === "verify" ? !user.verified_at : true)) {
        // Same public response and no provider wait for known or unknown email.
        const task = sendToken(user, purpose).catch(() => {});
        pending.add(task); task.finally(() => pending.delete(task));
      }
      send(res, 200, { message: generic }); return true;
    }
    if (route === "/api/customer/verify" && method === "POST") {
      limit("customer-token:" + ip, 12, 3600e3);
      const data = await body(req);
      await consumeToken(data.token, "verify", async (tx, id) => {
        await tx.run("UPDATE customers SET verified_at=COALESCE(verified_at,?) WHERE id=?", [new Date(now()).toISOString(), id]);
      });
      send(res, 200, { message: "Correo verificado. Ya puedes iniciar sesión." }); return true;
    }
    if (route === "/api/customer/reset" && method === "POST") {
      limit("customer-token:" + ip, 12, 3600e3);
      const data = await body(req), hash = await passwordHash(password(data.password));
      await consumeToken(data.token, "reset", async (tx, id) => {
        await tx.run("UPDATE customers SET password_hash=? WHERE id=?", [hash, id]);
        await tx.run("DELETE FROM customer_sessions WHERE customer_id=?", [id]);
        await tx.run("DELETE FROM customer_tokens WHERE customer_id=? AND purpose='reset'", [id]);
      });
      cookie(res, cookieName, "", 0); send(res, 200, { message: "Contraseña actualizada. Inicia sesión de nuevo." }); return true;
    }

    // ---- Profile ---------------------------------------------------------
    if (route === "/api/customer/profile" && ["GET", "PATCH"].includes(method)) {
      const user = await requireUser(req);
      if (method === "PATCH") {
        const data = await body(req);
        if (typeof data.name !== "string" || data.name.trim().length < 3 || data.name.length > 100 || /[\x00-\x1f]/.test(data.name)) throw fail(400, "Escribe tu nombre (3–100 caracteres).");
        await db.run("UPDATE customers SET name=? WHERE id=?", [data.name.trim(), user.id]);
      }
      const fresh = await db.get("SELECT * FROM customers WHERE id=?", [user.id]);
      send(res, 200, { user: publicUser(fresh), address: await defaultAddress(user.id) }); return true;
    }

    // ---- Orders ----------------------------------------------------------
    if (route === "/api/customer/orders" && method === "GET") {
      const user = await requireUser(req);
      const rows = await db.all("SELECT o.id,o.payload FROM orders o JOIN customer_orders c ON c.order_id=o.id WHERE c.customer_id=? ORDER BY o.created_at DESC LIMIT 100", [user.id]);
      send(res, 200, {
        orders: rows.map((r) => customerOrder(JSON.parse(r.payload))),
      }); return true;
    }
    const orderMatch = route.match(/^\/api\/customer\/orders\/(OF-[A-F0-9]{12})$/);
    if (orderMatch && method === "GET") {
      const user = await requireUser(req);
      // Ownership is enforced in the query itself, so a guessed id can never
      // reveal whether somebody else's order exists.
      const row = await db.get("SELECT o.payload FROM orders o JOIN customer_orders c ON c.order_id=o.id WHERE o.id=? AND c.customer_id=?", [orderMatch[1], user.id]);
      if (!row) throw fail(404, "Pedido no encontrado.");
      send(res, 200, { order: customerOrder(JSON.parse(row.payload), true) }); return true;
    }

    // ---- Addresses -------------------------------------------------------
    if (route === "/api/customer/addresses" && ["GET", "POST"].includes(method)) {
      const user = await requireUser(req);
      if (method === "GET") {
        const rows = await db.all("SELECT * FROM customer_addresses WHERE customer_id=? ORDER BY is_default DESC, created_at, rowid", [user.id]);
        send(res, 200, { addresses: rows.map(addressOf) }); return true;
      }
      limit("customer-address:" + user.id, 60, 3600e3);
      const data = await body(req), { label, value } = addressInput(data, user);
      const at = new Date(now()).toISOString(), id = randomUUID();
      const created = await db.tx(async (tx) => {
        const count = (await tx.get("SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id=?", [user.id])).n;
        const isDefault = data.isDefault === true || count === 0;
        if (isDefault) await tx.run("UPDATE customer_addresses SET is_default=0 WHERE customer_id=?", [user.id]);
        await tx.run(
          `INSERT INTO customer_addresses(id,customer_id,label,name,phone,street,number,neighborhood,city,state,postal_code,notes,is_default,created_at,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, user.id, label, value.name, value.phone, value.street, value.number ?? "", value.neighborhood, value.city, value.state, value.postalCode, value.notes ?? "", isDefault ? 1 : 0, at, at],
        );
        return tx.get("SELECT * FROM customer_addresses WHERE id=?", [id]);
      });
      send(res, 201, { address: addressOf(created) }); return true;
    }
    const addressMatch = route.match(/^\/api\/customer\/addresses\/([a-f0-9-]{36})(\/default)?$/i);
    if (addressMatch) {
      const user = await requireUser(req), id = addressMatch[1];
      const owned = await db.get("SELECT * FROM customer_addresses WHERE id=? AND customer_id=?", [id, user.id]);
      if (!owned) throw fail(404, "Dirección no encontrada.");
      if (addressMatch[2] && method === "POST") {
        limit("customer-address:" + user.id, 60, 3600e3);
        await body(req);
        await db.tx(async (tx) => {
          await tx.run("UPDATE customer_addresses SET is_default=0 WHERE customer_id=? AND is_default=1", [user.id]);
          await tx.run("UPDATE customer_addresses SET is_default=1,updated_at=? WHERE id=? AND customer_id=?", [new Date(now()).toISOString(), id, user.id]);
        });
        const fresh = await db.get("SELECT * FROM customer_addresses WHERE id=?", [id]);
        send(res, 200, { address: addressOf(fresh) }); return true;
      }
      if (method === "PATCH") {
        limit("customer-address:" + user.id, 60, 3600e3);
        const data = await body(req);
        const merged = {
          label: data.label === undefined ? owned.label : data.label,
          name: data.name === undefined ? owned.name : data.name,
          phone: data.phone === undefined ? owned.phone : data.phone,
          street: data.street === undefined ? owned.street : data.street,
          number: data.number === undefined ? owned.number : data.number,
          neighborhood: data.neighborhood === undefined ? owned.neighborhood : data.neighborhood,
          city: data.city === undefined ? owned.city : data.city,
          state: data.state === undefined ? owned.state : data.state,
          postalCode: data.postalCode === undefined ? owned.postal_code : data.postalCode,
          notes: data.notes === undefined ? owned.notes : data.notes,
        };
        const { label, value } = addressInput(merged, user);
        const at = new Date(now()).toISOString();
        await db.tx(async (tx) => {
          if (data.isDefault === true) await tx.run("UPDATE customer_addresses SET is_default=0 WHERE customer_id=?", [user.id]);
          await tx.run(
            `UPDATE customer_addresses SET label=?,name=?,phone=?,street=?,number=?,neighborhood=?,city=?,state=?,postal_code=?,notes=?,is_default=?,updated_at=?
             WHERE id=? AND customer_id=?`,
            [label, value.name, value.phone, value.street, value.number ?? "", value.neighborhood, value.city, value.state, value.postalCode, value.notes ?? "",
              data.isDefault === true || !!owned.is_default ? 1 : 0, at, id, user.id],
          );
          await ensureDefault(tx, user.id);
        });
        const fresh = await db.get("SELECT * FROM customer_addresses WHERE id=?", [id]);
        send(res, 200, { address: addressOf(fresh) }); return true;
      }
      if (method === "DELETE") {
        limit("customer-address:" + user.id, 60, 3600e3);
        await body(req);
        // Deleting a saved address never touches past orders: their shipping
        // data is a snapshot inside the order payload.
        await db.tx(async (tx) => {
          await tx.run("DELETE FROM customer_addresses WHERE id=? AND customer_id=?", [id, user.id]);
          await ensureDefault(tx, user.id);
        });
        send(res, 200, { ok: true }); return true;
      }
    }

    // ---- Email change ----------------------------------------------------
    if (route === "/api/customer/email" && method === "POST") {
      const user = await requireUser(req);
      limit("customer-email-change:" + user.id, 6, 3600e3); requireMail();
      const data = await body(req);
      if (!(await verifyPassword(data.password, user.password_hash))) throw fail(401, "La contraseña no es correcta.");
      const email = normalizeCustomerEmail(data.email);
      if (email === user.email) throw fail(400, "Ese ya es el correo de tu cuenta.");
      // Same response whether the address is free or already registered.
      if (!(await db.get("SELECT id FROM customers WHERE email=?", [email]))) await sendEmailChange(user, email);
      send(res, 200, { message: genericEmailChange }); return true;
    }
    if (route === "/api/customer/email/confirm" && method === "POST") {
      limit("customer-token:" + ip, 12, 3600e3);
      const data = await body(req);
      if (typeof data.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.token)) throw fail(400, "El enlace no es válido o ha vencido.");
      const email = await db.tx(async (tx) => {
        const row = await tx.get("SELECT * FROM customer_email_changes WHERE token_hash=? AND expires>?", [digest(data.token), now()]);
        if (!row) throw fail(400, "El enlace no es válido o ha vencido.");
        await tx.run("DELETE FROM customer_email_changes WHERE token_hash=?", [digest(data.token)]);
        if (await tx.get("SELECT id FROM customers WHERE email=? AND id<>?", [row.new_email, row.customer_id]))
          throw fail(409, "Esa dirección ya no está disponible. Solicita otro cambio desde tu cuenta.");
        await tx.run("UPDATE customers SET email=?,verified_at=? WHERE id=?", [row.new_email, new Date(now()).toISOString(), row.customer_id]);
        // Consent is tied to an address: a new address starts with no marketing
        // choice recorded, and every existing session is revoked.
        await tx.run("DELETE FROM customer_preferences WHERE customer_id=?", [row.customer_id]);
        await tx.run("DELETE FROM customer_sessions WHERE customer_id=?", [row.customer_id]);
        await tx.run("DELETE FROM customer_tokens WHERE customer_id=?", [row.customer_id]);
        await tx.run("DELETE FROM customer_email_changes WHERE customer_id=?", [row.customer_id]);
        return row.new_email;
      });
      cookie(res, cookieName, "", 0);
      send(res, 200, { email, message: "Correo actualizado y verificado. Inicia sesión con tu nueva dirección." }); return true;
    }

    // ---- Commercial preferences -----------------------------------------
    if (route === "/api/customer/preferences" && ["GET", "PATCH"].includes(method)) {
      const user = await requireUser(req);
      if (method === "PATCH") {
        limit("customer-preferences:" + user.id, 20, 3600e3);
        const data = await body(req);
        if (typeof data.marketing !== "boolean") throw fail(400, "Indica si autorizas comunicaciones comerciales.");
        if (data.marketing && data.consentVersion !== MARKETING_VERSION)
          throw fail(400, "Confirma el texto de consentimiento vigente.");
        const at = new Date(now()).toISOString();
        await db.tx(async (tx) => {
          await tx.run(
            `INSERT INTO customer_preferences(customer_id,marketing_consent,consent_version,consent_text,updated_at)
             VALUES(?,?,?,?,?) ON CONFLICT(customer_id) DO UPDATE SET marketing_consent=excluded.marketing_consent,
             consent_version=excluded.consent_version,consent_text=excluded.consent_text,updated_at=excluded.updated_at`,
            [user.id, data.marketing ? "granted" : "withdrawn", MARKETING_VERSION, MARKETING_TEXT, at],
          );
          // Withdrawal must reach the only commercial list that exists today.
          if (!data.marketing)
            await tx.run("UPDATE vip_members SET status='withdrawn',withdrawn_at=COALESCE(withdrawn_at,?) WHERE email=? AND status='active'", [at, user.email]);
        });
      }
      const row = await db.get("SELECT * FROM customer_preferences WHERE customer_id=?", [user.id]);
      send(res, 200, {
        marketing: row ? row.marketing_consent : "unset",
        consentVersion: MARKETING_VERSION,
        consentText: MARKETING_TEXT,
        updatedAt: row ? row.updated_at : null,
        emailEnabled: mail.enabled,
      }); return true;
    }

    // ---- Sessions --------------------------------------------------------
    if (route === "/api/customer/sessions/revoke-all" && method === "POST") {
      const user = await requireUser(req, false);
      limit("customer-sessions:" + user.id, 10, 3600e3);
      await body(req);
      // SQLite sessions are server-side rows, so every device can be revoked.
      await db.run("DELETE FROM customer_sessions WHERE customer_id=?", [user.id]);
      cookie(res, cookieName, "", 0);
      send(res, 200, { ok: true, message: "Cerramos la sesión en todos los dispositivos." }); return true;
    }

    if (route === "/api/contact" && method === "POST") {
      limit("contact:" + ip, 3, 3600e3);
      const data = await body(req);
      if (data.website) { send(res, 200, { message: "Solicitud recibida." }); return true; }
      requireMail("El correo de Contacto aún no está habilitado. No se envió tu consulta; intenta más tarde.");
      const email = normalizeCustomerEmail(data.email);
      if (data.consent !== true || typeof data.message !== "string" || data.message.trim().length < 10 || data.message.length > 2000)
        throw fail(400, "Escribe un mensaje de 10–2000 caracteres y acepta compartirlo para recibir atención.");
      const result = await mail.send({ from: mail.from, to: [mail.owner], reply_to: email, subject: "OFFCODE · Consulta desde Contacto",
        text: data.message.trim(), html: `<html lang="es"><body style="background:#080808;color:#f5f5f5;padding:32px;font-family:Arial"><h1>OFFCODE · Contacto</h1><p style="white-space:pre-wrap">${escapeHtml(data.message.trim())}</p></body></html>` }, "contact/" + randomUUID());
      if (result.state !== "accepted") throw fail(503, "No pudimos confirmar el envío. Intenta más tarde.");
      send(res, 200, { message: "El proveedor aceptó tu mensaje. La recepción final todavía no está confirmada." }); return true;
    }
    throw fail(404, "Ruta no encontrada.");
  }
  return { handle, current, async close() { await Promise.allSettled([...pending]); } };
}
