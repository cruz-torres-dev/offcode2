import { randomBytes, createHash, createCipheriv, createDecipheriv, scryptSync, timingSafeEqual } from "node:crypto";

const digest = (value) => createHash("sha256").update(value).digest();
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const denied = () => Object.assign(new Error("No encontramos ese pedido con este acceso. Usa el enlace de tu correo o tu cuenta verificada."), { status: 404 });

export function orderDurations({ env = process.env, reservationHours, accessHours } = {}) {
  function hours(value, fallback, min, max, name) {
    if (value === undefined) return fallback;
    if ((typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) ||
        !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max)
      throw Error(`${name} debe ser un número entero entre ${min} y ${max} horas.`);
    return Number(value);
  }
  const reservation = hours(reservationHours ?? env.ORDER_RESERVATION_TTL_HOURS, 48, 1, 168, "ORDER_RESERVATION_TTL_HOURS");
  const access = hours(accessHours ?? env.ORDER_ACCESS_TTL_HOURS, 720, 24, 2160, "ORDER_ACCESS_TTL_HOURS");
  if (access < reservation) throw Error("ORDER_ACCESS_TTL_HOURS debe cubrir al menos el plazo de reserva.");
  return { reservationMs: reservation * 3600e3, accessMs: access * 3600e3 };
}

// One credential for the creating tab, recovery link and scoped HttpOnly cookie.
// Authentication uses only its SHA-256 digest. The sealed delivery copy lets
// the existing durable mail queue retry identical links without storing a raw
// bearer in the database or journal. Keys reuse private server configuration.
export function createOrderAccess({ db, origin, production, settingsKey = "", password = "", ttlMs, now = Date.now }) {
  const key = settingsKey ? digest(Buffer.concat([Buffer.from("offcode-order-access-key-v1"), Buffer.from(settingsKey, "hex")]))
    : password ? scryptSync(password, "offcode-order-access-key-v1", 32) : null;
  const cookieName = production ? "__Secure-offcode_order" : "offcode_order";
  const aad = (id, expires, linkOrigin) => Buffer.from(`offcode-order-access-v1/${id}/${expires}/${linkOrigin}`);
  const envelope = (row) => row ? { expires: row.expires, nonce: Buffer.from(row.nonce).toString("base64"),
    tag: Buffer.from(row.tag).toString("base64"), sealed: Buffer.from(row.sealed).toString("base64"), origin: row.origin } : null;
  function open(id, sealed) {
    if (!key) throw Error("order_access_delivery_key_unavailable");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
    decipher.setAAD(aad(id, sealed.expires, sealed.origin)); decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.sealed, "base64")), decipher.final()]).toString("utf8");
  }
  async function ensure(id, exec, expires = now() + ttlMs) {
    const prior = await exec.get("SELECT * FROM order_access WHERE order_id=?", [id]);
    if (prior) return prior;
    if (!key) throw Object.assign(new Error("Falta una clave privada estable para preparar el acceso seguro al pedido."), { status: 503 });
    const token = randomBytes(32).toString("base64url"), nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(id, expires, origin));
    const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    await exec.run("INSERT INTO order_access(order_id,token_hash,expires,nonce,tag,sealed,origin) VALUES(?,?,?,?,?,?,?)",
      [id, digest(token), expires, nonce, cipher.getAuthTag(), sealed, origin]);
    return exec.get("SELECT * FROM order_access WHERE order_id=?", [id]);
  }
  function valid(row, token) {
    const candidate = typeof token === "string" && tokenPattern.test(token) ? token : "";
    const expected = row ? Buffer.from(row.token_hash) : Buffer.alloc(32);
    return timingSafeEqual(digest(candidate), expected) && !!candidate && !!row && row.expires > now();
  }
  const delivery = async (id) => envelope(await db.get("SELECT * FROM order_access WHERE order_id=?", [id]));
  function recoveryUrl(id, sealed) {
    const url = new URL("/checkout.html", sealed.origin);
    url.searchParams.set("pedido", id); url.hash = "access=" + open(id, sealed); return url.href;
  }
  function cookieToken(req) {
    return req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(cookieName + "="))?.slice(cookieName.length + 1) ?? "";
  }
  function setCookie(res, id, token, expires) {
    const seconds = Math.max(0, Math.floor((expires - now()) / 1000));
    res.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/api/orders/${id}/; Max-Age=${seconds}${production ? "; Secure" : ""}`);
  }
  return { ensure, valid, delivery, recoveryUrl, cookieToken, setCookie, denied, open, envelope,
    async forCreation(id) {
      const row = await db.tx((exec) => ensure(id, exec));
      return { token: open(id, envelope(row)), expires: row.expires };
    },
  };
}
