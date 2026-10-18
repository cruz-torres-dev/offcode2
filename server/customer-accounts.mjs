import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { createEmailTransport, validEmail } from "./email.mjs";

const derive = promisify(scrypt);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (status, message) => Object.assign(new Error(message), { status });
const generic = "Si la dirección permite esta operación, se intentará enviar un enlace. La entrega no está confirmada; revisa también spam.";
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
    const text = `OFFCODE · ${title}\n\n${url}\n\nEste enlace es de un solo uso y vence en ${purpose === "reset" ? "30 minutos" : "24 horas"}. Si no lo solicitaste, ignóralo.`;
    const result = await mail.send({ from: mail.from, to: [user.email], subject: `OFFCODE · ${title}`, text,
      html: `<html lang="es"><body style="background:#080808;color:#f5f5f5;font-family:Arial;padding:32px"><h1>OFFCODE</h1><h2>${title}</h2><p><a style="color:#fff" href="${escapeHtml(url)}">${title}</a></p><p>Enlace de un solo uso. Vence en ${purpose === "reset" ? "30 minutos" : "24 horas"}. Si no lo solicitaste, ignóralo.</p></body></html>` }, `account/${digest(token)}`);
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
    if (route === "/api/customer/profile" && ["GET", "PATCH"].includes(method)) {
      const user = await requireUser(req);
      if (method === "PATCH") {
        const data = await body(req);
        if (typeof data.name !== "string" || data.name.trim().length < 3 || data.name.length > 100 || /[\x00-\x1f]/.test(data.name)) throw fail(400, "Escribe tu nombre (3–100 caracteres).");
        const address = data.address ? validateCustomer({ ...data.address, name: data.name, email: user.email }) : null;
        await db.run("UPDATE customers SET name=?,address=? WHERE id=?", [data.name.trim(), address ? JSON.stringify(address) : null, user.id]);
      }
      const fresh = await db.get("SELECT * FROM customers WHERE id=?", [user.id]);
      send(res, 200, { user: publicUser(fresh), address: fresh.address ? JSON.parse(fresh.address) : null }); return true;
    }
    if (route === "/api/customer/orders" && method === "GET") {
      const user = await requireUser(req);
      const rows = await db.all("SELECT o.id,o.payload FROM orders o JOIN customer_orders c ON c.order_id=o.id WHERE c.customer_id=? ORDER BY o.created_at DESC LIMIT 100", [user.id]);
      const orders = rows.map((r) => { const o = JSON.parse(r.payload); return { id: r.id, status: o.status, items: o.items,
        totalCents: o.totalCents, subtotalCents: o.subtotalCents, tracking: o.tracking || "", createdAt: o.createdAt }; });
      send(res, 200, { orders }); return true;
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
