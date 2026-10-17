// Local UI preview only. No Envia/network calls, bank deposits, emails or valid labels.
import { createApp } from "../server/server.mjs";
import { randomBytes } from "node:crypto";
if (process.env.NODE_ENV === "production")
  throw Error("Esta vista ficticia es solo local.");
const app = await createApp({
  origin: "http://127.0.0.1:8013",
  production: false,
  email: { env: {}, autoStart: false, logger: () => {} },
  databasePath: ":memory:",
  settingsKey: randomBytes(32).toString("hex"),
  password: "solo-pruebas-fedex-ficticias",
  enabled: true,
  waitlistEnabled: false,
  bank: {
    name: "BANCO FICTICIO",
    beneficiary: "PERSONA FICTICIA",
    clabe: "000000000000000000",
  },
  whatsapp: "520000000000",
  privacyUrl: "https://example.test/privacy",
  termsUrl: "https://example.test/terms",
  envia: {
    enabled: true,
    environment: "sandbox",
    token: "synthetic-preview-only",
    sender: {
      name: "Origen ficticio",
      email: "origen@example.test",
      phone: "520000000000",
      street: "Calle Ficticia",
      number: "123",
      district: "Centro",
      city: "León",
      state: "GT",
      country: "MX",
      postalCode: "37000",
    },
    profiles: {
      1: { weight: 0.75, dimensions: { length: 30, width: 20, height: 10 } },
    },
    fetch: async (url, options) => {
      const data = url.endsWith("/state?country_code=MX")
        ? {
            data: [
              { name: "Guanajuato", code_2_digits: "GT", country_code: "MX" },
            ],
          }
        : url.endsWith("/ship/rate/")
          ? {
              meta: "rate",
              data: [
                {
                  carrier: "fedex",
                  service: "ground",
                  serviceDescription: "FedEx · Servicio de PRUEBA",
                  totalPrice: 185.2,
                  currency: "MXN",
                  deliveryEstimate: "Solo simulación",
                },
              ],
            }
          : url.endsWith("/ship/generate/")
            ? {
                meta: "generate",
                data: [
                  {
                    carrier: "fedex",
                    service: "ground",
                    shipmentId: 123,
                    trackingNumber: "PRUEBA00001",
                    label: "https://example.test/guia-ficticia.pdf",
                    currency: "MXN",
                    totalPrice: 185.2,
                  },
                ],
              }
            : null;
      if (
        !data ||
        options.headers.Authorization !== "Bearer synthetic-preview-only"
      )
        throw Error("Llamada de prueba no reconocida.");
      return new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      });
    },
  },
});
app.server.listen(8013, "127.0.0.1", () =>
  console.log(
    "Vista FICTICIA: http://127.0.0.1:8013/ · panel /admin.html · contraseña solo-pruebas-fedex-ficticias",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
