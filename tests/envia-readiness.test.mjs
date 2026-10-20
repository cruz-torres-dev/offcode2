import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";
import { initialSettings, readiness, settingsStore } from "../server/owner-settings.mjs";
import { createEnvia } from "../server/envia.mjs";

const sender = { name: "Prueba", phone: "520000000000", email: "test@example.test",
  street: "Calle ficticia", number: "1", district: "Centro", city: "Ciudad ficticia",
  state: "GT", country: "MX", postalCode: "37000" };
const profiles = { 1: { weight: 1, dimensions: { length: 20, width: 20, height: 10 } } };
const shippingCheck = (value) => readiness(value, {
  production: false, keyConfigured: true, passwordConfigured: true,
}).find((c) => c.id === "shipping");

test("El diagnóstico del origen privado identifica campos sin publicar sus valores", () => {
  const value = initialSettings({ enabled: false, envia: { enabled: false,
    token: "synthetic-token", sender: { ...sender, street: "", state: "GTO", postalCode: "1234" }, profiles } });
  const check = shippingCheck(value);
  assert.equal(check.ok, false);
  assert.match(check.detail, /configuración privada \(envia.sender\)/);
  assert.match(check.detail, /street/);
  assert.match(check.detail, /state \(2 letras/);
  assert.match(check.detail, /postalCode \(5 dígitos\)/);
  assert.doesNotMatch(check.detail, /ENVIA_ORIGIN_JSON|GTO|1234|synthetic-token|example.test/);
  assert.throws(() => createEnvia({ enabled: true, token: "synthetic-token", sender: null, profiles }),
    /ENVIA_ORIGIN_JSON/);
  value.envia.sender = sender;
  assert.equal(shippingCheck(value).ok, true);
  value.envia.profiles = {};
  assert.equal(shippingCheck(value).ok, false, "un domicilio completo no sustituye los empaques");
});

test("El checklist restaura la configuración cifrada antes de validar, sin depender del JSON inicial ni llamar Envia", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-readiness-"));
  const databasePath = path.join(folder, "test.sqlite");
  const origin = "http://127.0.0.1:9876", password = "synthetic-readiness-password";
  const envKeys = ["ENVIA_ORIGIN_JSON", "ENVIA_TOKEN", "ENVIA_PACKAGES_JSON"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let app, calls = 0;
  const options = { databasePath, origin, password, settingsKey: "ab".repeat(32),
    enabled: false, ordersEnabledEnv: "false", waitlistEnabled: false, production: false,
    email: { env: {}, autoStart: false, logger: () => {} }, customers: { env: {}, logger: () => {} },
    envia: { enabled: false, environment: "sandbox", token: "synthetic-token", sender: {}, profiles: {},
      fetch: async () => { calls++; throw Error("No se permiten solicitudes externas"); } } };
  try {
    app = await createApp(options);
    const saved = initialSettings(options);
    saved.envia.sender = sender;
    saved.envia.profiles = profiles;
    await settingsStore(app.db, options.settingsKey).save(saved, 0);
    await app.close(); app = null;
    // A persisted row must bypass missing and even invalid bootstrap values.
    for (const key of envKeys) delete process.env[key];
    const restartOptions = { ...options, envia: { fetch: options.envia.fetch } };
    app = await createApp(restartOptions);
    await app.close(); app = null;
    process.env.ENVIA_ORIGIN_JSON = "invalid-bootstrap-json";
    process.env.ENVIA_PACKAGES_JSON = "invalid-bootstrap-json";
    process.env.ENVIA_TOKEN = "invalid bootstrap token";
    app = await createApp(restartOptions);
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const login = await fetch(base + "/api/session", { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
    assert.equal(login.status, 200);
    const response = await fetch(base + "/api/admin/settings", {
      headers: { Cookie: login.headers.get("set-cookie").split(";")[0] } });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.version, 1);
    assert.deepEqual(result.settings.envia.sender, sender);
    assert.deepEqual(result.settings.envia.profiles, profiles);
    assert.equal(result.settings.envia.tokenConfigured, true);
    const check = result.checks.find((c) => c.id === "shipping");
    assert.equal(check.ok, true);
    assert.match(check.detail, /aún no acredita credenciales ni cobertura/);
    assert.equal(result.checks.find((c) => c.id === "orders").ok, false);
    assert.equal(result.settings.envia.enabled, false);
    assert.equal(calls, 0);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-token/);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    if (app) await app.close();
    const relative = path.relative(os.tmpdir(), folder);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    await rm(folder, { recursive: true, force: true });
  }
});
