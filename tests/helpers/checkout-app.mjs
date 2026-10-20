import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../../server/server.mjs";

export const customer = { name: "Persona Sintética QA", phone: "520000000000", email: "buyer@example.test",
  street: "Calle Ficticia 123", neighborhood: "Centro Sintético", city: "Ciudad Sintética", state: "GT", postalCode: "37000", notes: "" };
export const bag = [{ size: "M", qty: 1, productId: "PRD-HOODIE-0001", variantId: "VAR-HOODIE-M" }];

export async function checkoutApp({ shippingEnabled = true, ordersEnabled = true } = {}) {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = "http://127.0.0.1:" + port, password = randomBytes(24).toString("hex");
  const provider = { calls: [], generateCalls: 0, gate: null, noCoverage: false, failing: false };
  const app = await createApp({ origin, env: {}, production: false, databasePath: ":memory:",
    enabled: ordersEnabled, ordersEnabledEnv: ordersEnabled ? "true" : "false", waitlistEnabled: false, password, settingsKey: "",
    bank: { name: "BANCO SINTÉTICO QA", beneficiary: "PERSONA SINTÉTICA QA", clabe: "000000000000000000" },
    whatsapp: "520000000000", privacyUrl: "", termsUrl: "",
    email: { env: {}, autoStart: false, logger: () => {} }, customers: { env: {}, logger: () => {} },
    envia: { enabled: shippingEnabled, environment: "sandbox", token: "synthetic-qa-only",
      sender: { name: "Origen Sintético QA", phone: "520000000000", email: "origin@example.test", street: "Calle Ficticia", number: "1", district: "Centro Sintético", city: "Ciudad Sintética", state: "GT", country: "MX", postalCode: "37000" },
      profiles: { 1: { weight: 0.75, dimensions: { length: 30, width: 20, height: 10 } }, 2: { weight: 1.5, dimensions: { length: 35, width: 25, height: 15 } } },
      fetch: async (url, options) => {
        const path = new URL(url).pathname;
        provider.calls.push({ path });
        if (path.includes("generate")) { provider.generateCalls++; throw Error("Label generation forbidden"); }
        if (path === "/state") return Response.json({ data: [{ name: "Guanajuato", code_2_digits: "GT" }, { name: "Ciudad de México", code_2_digits: "CX" }] });
        if (path !== "/ship/rate/") throw Error("Unexpected provider request");
        if (provider.gate) await provider.gate;
        if (provider.failing) return Response.json({ meta: "error", error: "Synthetic provider unavailable" });
        return Response.json({ meta: "rate", data: provider.noCoverage ? [] : [
          { carrier: "fedex", currency: "MXN", service: "ground", serviceDescription: "FedEx Terrestre", totalPrice: 185.2, deliveryEstimate: "3 a 5 días hábiles (simulación QA)" },
          { carrier: "fedex", currency: "MXN", service: "express", serviceDescription: "FedEx Express", totalPrice: 260 },
        ] });
      } },
  });
  // Synthetic stock only, in the freshly created in-memory database.
  await app.db.run("UPDATE inventory SET on_hand=20,reserved=0,configured=1");
  await new Promise((resolve) => app.server.listen(port, "127.0.0.1", resolve));
  const call = async (route, data, method = data === undefined ? "GET" : "POST") => {
    const response = await fetch(origin + route, { method, headers: { Origin: origin, "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, data: await response.json() };
  };
  const quote = (items = bag, destination = customer) => call("/api/shipping/rates", { items, customer: destination, consent: true });
  const request = (rate, extra = {}) => ({ requestKey: randomUUID(), customer, items: bag, consent: true,
    shippingQuoteId: rate.id, totalAccepted: true, acceptedTotalCents: rate.totalCents, ...extra });
  const snapshot = async () => Object.fromEntries(await Promise.all(["orders", "order_reservations", "inventory", "inventory_movements", "shipping_jobs"].map(async (table) => [table, await app.db.all(`SELECT * FROM ${table}`)])));
  return { ...app, origin, call, quote, request, snapshot, provider };
}
