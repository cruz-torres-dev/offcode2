import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createEnvia, safeUrl } from "./envia.mjs";

const error = (message) => Object.assign(new Error(message), { status: 400 });
const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v, label, max = 150) => {
  if (v === undefined || v === null) return "";
  if (
    typeof v !== "string" ||
    v.length > max ||
    /[\u0000-\u001f\u007f]/.test(v)
  )
    throw error(`Revisa ${label}.`);
  return v.trim();
};
const parse = (value, label) => {
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw error(`Revisa ${label}: JSON no válido.`);
  }
};
export function initialSettings(options) {
  return {
    enabled:
      options.enabled ??
      (options.ordersEnabledEnv ?? process.env.ORDERS_ENABLED) === "true",
    whatsapp: options.whatsapp ?? process.env.SALES_WHATSAPP ?? "",
    privacyUrl: options.privacyUrl ?? process.env.PRIVACY_URL ?? "",
    termsUrl: options.termsUrl ?? process.env.TERMS_URL ?? "",
    bank: options.bank ?? {
      name: process.env.BANK_NAME ?? "",
      beneficiary: process.env.BANK_BENEFICIARY ?? "",
      clabe: process.env.BANK_CLABE ?? "",
    },
    envia: {
      enabled: options.envia?.enabled ?? process.env.ENVIA_ENABLED === "true",
      environment:
        options.envia?.environment ??
        process.env.ENVIA_ENVIRONMENT ??
        "sandbox",
      token: options.envia?.token ?? process.env.ENVIA_TOKEN ?? "",
      sender:
        options.envia?.sender ??
        parse(process.env.ENVIA_ORIGIN_JSON, "el origen"),
      profiles:
        options.envia?.profiles ??
        parse(process.env.ENVIA_PACKAGES_JSON, "los paquetes"),
      printSize:
        options.envia?.printSize ?? process.env.ENVIA_PRINT_SIZE ?? "PAPER_4X6",
    },
  };
}
export function normalizeSettings(input, previous) {
  if (
    !object(input) ||
    !object(input.bank) ||
    !object(input.envia) ||
    !object(input.envia.sender) ||
    !object(input.envia.profiles)
  )
    throw error("Revisa la configuración enviada.");
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.envia.enabled !== "boolean"
  )
    throw error("Indica si los pedidos y Envia están habilitados.");
  const value = {
    enabled: input.enabled,
    whatsapp: text(input.whatsapp, "el WhatsApp", 15),
    privacyUrl: text(input.privacyUrl, "el aviso de privacidad", 2048),
    termsUrl: text(input.termsUrl, "las condiciones", 2048),
    bank: {
      name: text(input.bank.name, "el banco", 100),
      beneficiary: text(input.bank.beneficiary, "el titular", 150),
      clabe: text(input.bank.clabe, "la CLABE", 18),
    },
    envia: {
      enabled: input.envia.enabled,
      environment: input.envia.environment,
      printSize: input.envia.printSize,
      token: previous.envia.token,
      sender: { country: "MX" },
      profiles: {},
    },
  };
  if (value.whatsapp && !/^\d{10,15}$/.test(value.whatsapp))
    throw error("WhatsApp requiere entre 10 y 15 dígitos con código de país.");
  if (value.bank.clabe && !/^\d{18}$/.test(value.bank.clabe))
    throw error("La CLABE requiere 18 dígitos.");
  for (const u of [value.privacyUrl, value.termsUrl])
    if (u && !safeUrl(u))
      throw error(
        "Las páginas de privacidad y condiciones deben usar HTTPS y no incluir credenciales.",
      );
  if (!["sandbox", "production"].includes(value.envia.environment))
    throw error("Selecciona Sandbox o producción para Envia.");
  if (
    !["PAPER_4X6", "STOCK_4X6", "PAPER_7X4.75", "PAPER_LETTER"].includes(
      value.envia.printSize,
    )
  )
    throw error("Revisa el tamaño de la guía.");
  const newToken = text(input.envia.token, "el token de Envia", 4096);
  if (input.envia.clearToken === true && newToken)
    throw error("Elige sustituir o retirar el token.");
  if (input.envia.clearToken === true) value.envia.token = "";
  else if (newToken) {
    if (/\s/.test(newToken))
      throw error("El token de Envia no puede contener espacios.");
    value.envia.token = newToken;
  }
  // Changing environment must not silently reuse the other environment's token.
  if (
    value.envia.environment !== previous.envia.environment &&
    !newToken &&
    previous.envia.token &&
    input.envia.clearToken !== true
  )
    throw error(
      "Al cambiar de entorno introduce el token correspondiente de Envia.",
    );
  for (const k of [
    "name",
    "company",
    "email",
    "phone",
    "street",
    "number",
    "district",
    "city",
    "state",
    "postalCode",
    "reference",
  ])
    value.envia.sender[k] = text(
      input.envia.sender[k],
      `el origen (${k})`,
      k === "reference" ? 300 : 150,
    );
  const s = value.envia.sender;
  if (s.state && !/^[A-Z]{2}$/.test(s.state))
    throw error("Selecciona el estado de origen con su código de Envia.");
  if (s.postalCode && !/^\d{5}$/.test(s.postalCode))
    throw error("El código postal de origen requiere 5 dígitos.");
  if (s.phone && !/^\+?\d{10,15}$/.test(s.phone))
    throw error("Revisa el teléfono de origen, con código de país.");
  if (s.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email))
    throw error("Revisa el correo de origen.");
  for (const [qty, p] of Object.entries(input.envia.profiles)) {
    if (
      !/^[1-9]\d?$/.test(qty) ||
      !object(p) ||
      !Number.isFinite(p.weight) ||
      p.weight < 0.01 ||
      p.weight > 1000 ||
      ["length", "width", "height"].some(
        (k) =>
          !Number.isFinite(p.dimensions?.[k]) ||
          p.dimensions[k] < 0.1 ||
          p.dimensions[k] > 300,
      )
    )
      throw error(
        "Cada empaque requiere cantidad (1–99), peso en kg y tres medidas en cm mayores que cero.",
      );
    value.envia.profiles[qty] = {
      weight: p.weight,
      dimensions: Object.fromEntries(
        ["length", "width", "height"].map((k) => [k, p.dimensions[k]]),
      ),
    };
  }
  return value;
}
export function validateActivation(
  value,
  { passwordConfigured, production, fetcher },
) {
  if (
    value.enabled &&
    (!passwordConfigured ||
      !value.bank.name ||
      !value.bank.beneficiary ||
      !/^\d{18}$/.test(value.bank.clabe) ||
      !/^\d{10,15}$/.test(value.whatsapp))
  )
    throw error(
      "Completa contraseña, banco, beneficiario, CLABE y WhatsApp antes de habilitar pedidos.",
    );
  if (
    production &&
    value.enabled &&
    value.envia.enabled &&
    value.envia.environment !== "production"
  )
    throw error(
      "No abras ventas reales con cotizaciones simuladas de Sandbox: selecciona producción en Envia.",
    );
  try {
    return createEnvia({ ...value.envia, fetch: fetcher });
  } catch (e) {
    throw error(e.message);
  }
}
export function readiness(
  value,
  { production, keyConfigured, passwordConfigured, lockedByEnv = false },
) {
  const salesReady = !!value.bank.name && !!value.bank.beneficiary &&
    /^\d{18}$/.test(value.bank.clabe) && /^\d{10,15}$/.test(value.whatsapp);
  const legalReady = [value.privacyUrl, value.termsUrl].every((u) => safeUrl(u));
  let shippingError = "";
  try {
    createEnvia({ ...value.envia, enabled: true });
  } catch (e) {
    shippingError = e.message;
  }
  return [
    {
      id: "owner",
      label: "Acceso privado del propietario",
      ok: passwordConfigured,
      detail: passwordConfigured
        ? "Contraseña configurada."
        : "Configura la contraseña inicial en el servidor.",
    },
    {
      id: "encryption",
      label: "Guardado cifrado de configuración",
      ok: keyConfigured,
      detail: keyConfigured
        ? "Clave privada disponible en el servidor."
        : "Falta SETTINGS_ENCRYPTION_KEY para guardar desde este panel.",
    },
    {
      id: "sales",
      label: "Datos para pedidos y transferencias",
      ok: salesReady,
      detail: salesReady
        ? "Contacto y cuenta receptora presentes. El pago se confirma manualmente al verificar el abono."
        : "Faltan contacto o datos de transferencia. No impiden preparar ni consultar Envia.",
    },
    {
      id: "legal",
      label: "Privacidad y condiciones (opcional)",
      ok: legalReady,
      optional: true,
      detail: legalReady
        ? "URLs HTTPS guardadas. Verifica que las páginas sean reales, completas y aprobadas; el panel no valida su contenido."
        : "Puedes añadir estos enlaces cuando estén disponibles. Su ausencia no bloquea los pedidos ni los envíos.",
    },
    {
      id: "shipping",
      label: "Configuración de FedEx mediante Envia",
      ok: !shippingError,
      detail:
        shippingError ||
        "Token, origen y empaques presentes. Puedes consultar tarifas en privado con los pedidos cerrados; esto aún no acredita credenciales ni cobertura.",
    },
    {
      id: "mode",
      label: "Entorno de Envia",
      ok: value.envia.environment === "production",
      detail:
        value.envia.environment === "production"
          ? "Producción seleccionada. Esto no confirma que el token o las tarifas sean válidos."
          : "Sandbox: las guías no sirven para entregar paquetes.",
    },
    {
      id: "orders",
      label: "Recepción de pedidos",
      ok: value.enabled && !lockedByEnv,
      detail: lockedByEnv
        ? "Bloqueada por ORDERS_ENABLED=false en el servidor. Las consultas privadas de Envia no abren pedidos."
        : value.enabled
          ? "Habilitada. Inventario y depósitos siguen verificándose manualmente."
          : "La recepción de pedidos está cerrada.",
    },
  ];
}
export function publicSettings(value) {
  const { token, ...envia } = value.envia;
  return { ...value, envia: { ...envia, tokenConfigured: !!token } };
}
// Encrypted single-row settings. The SQLite migration preserves existing rows.
export function settingsStore(db, keyText = "") {
  if (keyText && !/^[a-f0-9]{64}$/i.test(keyText))
    throw Error(
      "SETTINGS_ENCRYPTION_KEY debe ser una clave aleatoria de 64 caracteres hexadecimales.",
    );
  const key = keyText ? Buffer.from(keyText, "hex") : null;
  // SQLite blobs may be Uint8Array; normalize them for authenticated decryption.
  const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value));
  async function read() {
    const row = await db.get("SELECT * FROM owner_settings WHERE id=1");
    if (!row) return null;
    if (!key)
      throw Error(
        "La configuración guardada requiere su SETTINGS_ENCRYPTION_KEY original.",
      );
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes(row.nonce));
      decipher.setAAD(Buffer.from(`offcode-settings-v1:${row.version}`));
      decipher.setAuthTag(bytes(row.tag));
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(bytes(row.payload)),
          decipher.final(),
        ]).toString("utf8"),
      );
      return { value, version: Number(row.version), updatedAt: row.updated_at };
    } catch {
      throw Error(
        "No se pudo abrir la configuración cifrada. Revisa la clave original y el respaldo antes de continuar.",
      );
    }
  }
  async function save(value, version) {
    if (!key)
      throw error(
        "Configura SETTINGS_ENCRYPTION_KEY en el servidor antes de guardar datos privados.",
      );
    return db.tx(async (exec) => {
      const current =
        Number((await exec.get("SELECT version FROM owner_settings WHERE id=1"))?.version) || 0;
      if (version !== current)
        throw Object.assign(
          new Error("La configuración cambió. Recarga antes de guardar."),
          { status: 409 },
        );
      const next = version + 1,
        nonce = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`offcode-settings-v1:${next}`));
      const payload = Buffer.concat([
          cipher.update(JSON.stringify(value), "utf8"),
          cipher.final(),
        ]),
        tag = cipher.getAuthTag(),
        now = new Date().toISOString();
      await exec.run(
        "INSERT INTO owner_settings(id,version,nonce,tag,payload,updated_at) VALUES(1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,nonce=excluded.nonce,tag=excluded.tag,payload=excluded.payload,updated_at=excluded.updated_at",
        [next, nonce, tag, payload, now],
      );
      return { version: next, updatedAt: now };
    });
  }

  return { read, save, keyConfigured: !!key };
}
