import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/server.mjs";

const origin = "http://127.0.0.1:9875",
  password = "vip-synthetic-test-password";
async function start(options = {}) {
  const app = await createApp({
    origin,
    password,
    enabled: false,
    waitlistEnabled: true,
    privacyUrl: "https://example.test/privacy",
    databasePath: ":memory:",
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  let cookie = "";
  const request = async (route, method = "GET", data, headers = {}) => {
    const response = await fetch(base + route, {
      method,
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...headers,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    if (response.headers.get("set-cookie"))
      cookie = response.headers.get("set-cookie").split(";")[0];
    return response;
  };
  const call = async (...args) => {
    const r = await request(...args);
    return { status: r.status, data: await r.json() };
  };
  return { ...app, call, request };
}
const subscription = (email) => ({
  email,
  consent: true,
  consentVersion: "vip-v1",
  website: "",
});

test("Lista VIP independiente: consentimiento, duplicados, acceso privado, baja y persistencia", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "offcode-vip-"));
  let app = await start({ databasePath: path.join(folder, "vip.sqlite") });
  try {
    const config = await app.call("/api/config");
    assert.equal(config.data.enabled, false);
    assert.equal(config.data.waitlistEnabled, true);
    assert.equal((await app.call("/api/admin/waitlist")).status, 401);
    assert.equal((await app.request("/api/admin/waitlist.csv")).status, 401);
    assert.equal(
      (
        await app.call(
          "/api/waitlist",
          "POST",
          subscription("vip@example.test"),
          { Origin: "https://other.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await app.call("/api/waitlist", "POST", {
          ...subscription("vip@example.test"),
          consent: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (await app.call("/api/waitlist", "POST", subscription("not-an-email")))
        .status,
      400,
    );
    assert.equal(
      (
        await app.call("/api/waitlist", "POST", {
          ...subscription("bot@example.test"),
          website: "bot-field",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await app.call(
          "/api/waitlist",
          "POST",
          subscription(" VIP@example.test "),
        )
      ).status,
      200,
    );
    const repeat = await app.call(
      "/api/waitlist",
      "POST",
      subscription("vip@example.test"),
    );
    assert.deepEqual(repeat.data, { ok: true });
    await app.call("/api/session", "POST", { password });
    let list = await app.call("/api/admin/waitlist");
    assert.equal(list.data.total, 1);
    assert.equal(list.data.members[0].email, "vip@example.test");
    assert.equal(list.data.members[0].consent_version, "vip-v1");
    const member = list.data.members[0];
    const csv = await app.request("/api/admin/waitlist.csv");
    assert.match(csv.headers.get("content-type"), /text\/csv/);
    assert.match(await csv.text(), /vip@example.test/);
    assert.equal(
      (
        await app.call("/api/admin/waitlist/" + member.id, "PATCH", {
          status: "withdrawn",
        })
      ).status,
      200,
    );
    await app.call("/api/waitlist", "POST", subscription("vip@example.test"));
    assert.equal((await app.call("/api/admin/waitlist")).data.total, 0);
    assert.doesNotMatch(
      await (await app.request("/api/admin/waitlist.csv")).text(),
      /vip@example.test/,
    );
    await app.close();
    app = await start({ databasePath: path.join(folder, "vip.sqlite") });
    await app.call("/api/session", "POST", { password });
    list = await app.call("/api/admin/waitlist?status=withdrawn");
    assert.equal(list.data.total, 1);
    assert.equal(list.data.members[0].status, "withdrawn");
  } finally {
    await app.close();
    const relative = path.relative(os.tmpdir(), path.resolve(folder));
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    );
    await rm(folder, { recursive: true, force: true });
  }
});
test("Exportación CSV neutraliza fórmulas en correos y requiere sesión", async () => {
  const app = await start();
  try {
    await app.call(
      "/api/waitlist",
      "POST",
      subscription("=formula@example.test"),
    );
    await app.call("/api/session", "POST", { password });
    const csv = await (await app.request("/api/admin/waitlist.csv")).text();
    assert.ok(csv.includes('"\'=formula@example.test"'));
    assert.match(csv, /email_verified/);
    assert.match(csv, /"false"/);
  } finally {
    await app.close();
  }
});
test("Registro cerrado por defecto y configuración VIP sin datos bancarios", async () => {
  const app = await start({ waitlistEnabled: false });
  try {
    assert.equal(
      (
        await app.call(
          "/api/waitlist",
          "POST",
          subscription("vip@example.test"),
        )
      ).status,
      503,
    );
  } finally {
    await app.close();
  }
  await assert.rejects(
    () =>
      createApp({
        enabled: false,
        waitlistEnabled: true,
        password: "",
        privacyUrl: "",
        databasePath: ":memory:",
      }),
    /ADMIN_PASSWORD/,
  );
});
