// Envia calls stay on the server. No credentials or sender address reach the browser.
export const shippingError = (status, message) =>
  Object.assign(new Error(message), { status });
const fail = (message) => shippingError(502, message);
export function cents(value) {
  if (
    !["number", "string"].includes(typeof value) ||
    !/^\d+(\.\d{1,2})?$/.test(String(value))
  )
    return null;
  const n = Math.round(Number(value) * 100);
  return Number.isSafeInteger(n) && n > 0 && n <= 1000000 ? n : null;
}
export function safeUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "";
  } catch {
    return "";
  }
}
function jsonEnv(value, label) {
  try {
    return JSON.parse(value || "{}");
  } catch {
    throw Error(`Revisa ${label}: debe ser JSON válido.`);
  }
}
function short(value, min = 1, max = 150) {
  return (
    typeof value === "string" &&
    value.trim().length >= min &&
    value.length <= max &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
export function createEnvia(options = {}) {
  const enabled = options.enabled ?? process.env.ENVIA_ENABLED === "true";
  const environment =
    options.environment ?? process.env.ENVIA_ENVIRONMENT ?? "sandbox";
  if (!["sandbox", "production"].includes(environment))
    throw Error("ENVIA_ENVIRONMENT: sandbox o production.");
  const token = options.token ?? process.env.ENVIA_TOKEN ?? "";
  const sender =
    options.sender ??
    jsonEnv(process.env.ENVIA_ORIGIN_JSON, "ENVIA_ORIGIN_JSON");
  const profiles =
    options.profiles ??
    jsonEnv(process.env.ENVIA_PACKAGES_JSON, "ENVIA_PACKAGES_JSON");
  const printSize =
    options.printSize ?? process.env.ENVIA_PRINT_SIZE ?? "PAPER_4X6";
  const fetcher = options.fetch ?? globalThis.fetch;
  if (enabled) {
    if (!token || /\s/.test(token)) throw Error("Falta ENVIA_TOKEN privado.");
    const originIssues = [
      "name",
      "phone",
      "email",
      "street",
      "number",
      "district",
      "city",
      "state",
      "postalCode",
    ].filter((k) => !short(sender?.[k]));
    if (short(sender?.postalCode) && !/^\d{5}$/.test(sender.postalCode))
      originIssues.push("postalCode (5 dígitos)");
    if (short(sender?.state) && !/^[A-Z]{2}$/.test(sender.state))
      originIssues.push("state (2 letras mayúsculas del catálogo de Envia)");
    if (sender?.country !== "MX") originIssues.push("country (MX)");
    if (originIssues.length)
      throw Error(
        `Revisa el domicilio de origen en ${options.sender != null ? "la configuración privada (envia.sender)" : "ENVIA_ORIGIN_JSON"}: faltan campos o tienen formato incorrecto: ${originIssues.join(", ")}. Esto no comprueba cobertura ni tarifas.`,
      );
    if (
      !profiles ||
      !Object.keys(profiles).length ||
      Object.entries(profiles).some(
        ([qty, p]) =>
          !/^[1-9]\d?$/.test(qty) ||
          !p ||
          !Number.isFinite(p.weight) ||
          p.weight < 0.01 ||
          p.weight > 1000 ||
          ["length", "width", "height"].some(
            (k) =>
              !Number.isFinite(p.dimensions?.[k]) ||
              p.dimensions[k] < 0.1 ||
              p.dimensions[k] > 300,
          ),
      )
    )
      throw Error(
        "Configura ENVIA_PACKAGES_JSON por cantidad de prendas, con peso KG y dimensiones CM reales.",
      );
    if (
      !["PAPER_4X6", "PAPER_7X4.75", "STOCK_4X6", "PAPER_LETTER"].includes(
        printSize,
      )
    )
      throw Error("Revisa ENVIA_PRINT_SIZE.");
  }
  const shippingBase =
    environment === "production"
      ? "https://api.envia.com"
      : "https://api-test.envia.com";
  const queriesBase =
    environment === "production"
      ? "https://queries.envia.com"
      : "https://queries.test.envia.com";
  async function request(base, route, payload, lookup = false) {
    if ((!enabled && !lookup) || !token)
      throw shippingError(503, "Envia todavía no está configurado.");
    let response, data;
    try {
      response = await fetcher(base + route, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      data = await response.json();
    } catch {
      throw fail(
        "Envia no respondió correctamente. Intenta consultar de nuevo más tarde.",
      );
    }
    // Envia can return HTTP 200 with meta:error. Never expose its raw errors/PII/token.
    if (!response.ok || !data || data.meta === "error" || data.error)
      throw fail(
        "Envia no pudo completar la operación. Revisa cobertura, dirección, saldo y configuración en tu cuenta.",
      );
    return data;
  }
  let statesPromise;
  async function states() {
    if (!statesPromise)
      statesPromise = request(
        queriesBase,
        "/state?country_code=MX",
        undefined,
        true,
      )
        .then((result) => {
          const list = (Array.isArray(result.data) ? result.data : [])
            .filter(
              (s) =>
                short(s.name) &&
                /^[A-Z]{2}$/.test(s.code_2_digits) &&
                (!s.country_code || s.country_code === "MX"),
            )
            .map((s) => ({ name: s.name, code: s.code_2_digits }));
          if (!list.length)
            throw fail("No se pudieron consultar los estados de Envia.");
          return list.sort((a, b) => a.name.localeCompare(b.name, "es"));
        })
        .catch((e) => {
          statesPromise = undefined;
          throw e;
        });
    return statesPromise;
  }
  async function payload(customer, items) {
    const qty = items.reduce((s, p) => s + p.qty, 0),
      profile = profiles[qty];
    if (!profile)
      throw shippingError(
        422,
        "Contacta a OFFCODE: falta confirmar el empaque para esa cantidad.",
      );
    const list = await states();
    const code = list.find(
      (s) =>
        s.code === customer.state ||
        s.name.toLocaleLowerCase("es") ===
          customer.state.toLocaleLowerCase("es"),
    )?.code;
    if (!code || !list.some((s) => s.code === sender.state))
      throw shippingError(
        422,
        "Revisa el estado del domicilio con los códigos de Envia.",
      );
    return {
      origin: Object.fromEntries(
        [
          "name",
          "company",
          "email",
          "phone",
          "street",
          "number",
          "district",
          "city",
          "state",
          "country",
          "postalCode",
          "reference",
        ]
          .filter((k) => sender[k])
          .map((k) => [k, sender[k]]),
      ),
      destination: {
        name: customer.name,
        phone: customer.phone,
        email: customer.email,
        street: customer.street,
        ...(customer.number ? { number: customer.number } : {}),
        district: customer.neighborhood,
        city: customer.city,
        state: code,
        country: "MX",
        postalCode: customer.postalCode,
        reference: customer.notes,
      },
      packages: [
        {
          type: "box",
          content: "Ropa LA AFRO X OFFCODE",
          amount: 1,
          declaredValue:
            items.reduce((s, p) => s + p.qty * p.unitCents, 0) / 100,
          weight: profile.weight,
          dimensions: { ...profile.dimensions },
          lengthUnit: "CM",
          weightUnit: "KG",
        },
      ],
      shipment: { type: 1, carrier: "fedex" },
      settings: { currency: "MXN" },
    };
  }
  async function rates(payload) {
    const result = await request(shippingBase, "/ship/rate/", payload);
    if (result.meta !== "rate" || !Array.isArray(result.data))
      throw fail("Respuesta de cotización no válida de Envia.");
    const list = result.data
      .filter(
        (r) =>
          r.carrier?.toLowerCase() === "fedex" &&
          r.currency === "MXN" &&
          short(r.service, 1, 100) &&
          cents(r.totalPrice) !== null,
      )
      .map((r) => ({
        service: r.service,
        description: short(r.serviceDescription)
          ? r.serviceDescription
          : "FedEx",
        shippingCents: cents(r.totalPrice),
        deliveryEstimate: short(r.deliveryEstimate) ? r.deliveryEstimate : "",
      }));
    if (!list.length)
      throw shippingError(
        422,
        "FedEx no devolvió servicios cotizables para esta dirección y paquete. Contacta a OFFCODE.",
      );
    return list;
  }
  async function generate(payload, rate, orderId) {
    const result = await request(shippingBase, "/ship/generate/", {
      ...payload,
      shipment: {
        type: 1,
        carrier: "fedex",
        service: rate.service,
        orderReference: orderId,
      },
      settings: {
        currency: "MXN",
        printFormat: "PDF",
        printSize,
        comments: orderId,
      },
    });
    const row = result.data?.[0];
    if (
      result.meta !== "generate" ||
      result.data?.length !== 1 ||
      row?.carrier?.toLowerCase() !== "fedex" ||
      row.service !== rate.service ||
      !short(row.trackingNumber, 4, 100) ||
      !safeUrl(row.label) ||
      !row.shipmentId ||
      row.currency !== "MXN" ||
      cents(row.totalPrice) === null
    )
      throw fail(
        "La respuesta de la guía requiere revisión en Envia antes de continuar.",
      );
    return {
      shipmentId: String(row.shipmentId),
      tracking: row.trackingNumber,
      labelUrl: safeUrl(row.label),
      trackingUrl: safeUrl(row.trackUrl),
      chargedCents: cents(row.totalPrice),
      environment,
    };
  }
  return { enabled, environment, states, payload, rates, generate };
}
