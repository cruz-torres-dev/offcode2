const $ = (selector) => document.querySelector(selector);
let page = 0;
async function api(route, options = {}) {
  const response = await fetch(route, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 401) {
    $("#login").hidden = false;
    $("#member-panel").hidden = true;
    $("#logout").hidden = true;
    $("#members").replaceChildren();
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw Error("La lista VIP no está conectada en esta vista.");
  }
  if (!response.ok)
    throw Error(result.error || "No se pudo completar la solicitud.");
  return result;
}
function text(tag, value, className) {
  const el = document.createElement(tag);
  el.textContent = value;
  if (className) el.className = className;
  return el;
}
async function load() {
  const result = await api(
    "/api/admin/waitlist?page=" + page + "&status=" + $("#member-status").value,
  );
  $("#login").hidden = true;
  $("#member-panel").hidden = false;
  $("#logout").hidden = false;
  $("#collection-status").textContent = result.enabled
    ? "Recepción de nuevos registros habilitada."
    : "Recepción de nuevos registros desactivada.";
  const active = $("#member-status").value === "active";
  $("#member-count").textContent =
    result.total +
    " " +
    (result.total === 1
      ? active
        ? "registro activo"
        : "registro dado de baja"
      : active
        ? "registros activos"
        : "registros dados de baja");
  $("#members").replaceChildren();
  if (!result.members.length)
    $("#members").append(
      text("p", "Todavía no hay registros en esta sección.", "empty"),
    );
  for (const member of result.members) {
    const row = document.createElement("article");
    row.className = "member-row";
    const content = document.createElement("div");
    content.append(
      text("h2", member.email),
      text(
        "p",
        "Registro: " + new Date(member.created_at).toLocaleString("es-MX"),
        "fine",
      ),
      text(
        "p",
        "Consentimiento: " + member.consent_version + " · Correo no verificado",
        "fine",
      ),
    );
    row.append(content);
    if (member.status === "active") {
      const button = text("button", "Dar de baja");
      button.onclick = async () => {
        if (
          !confirm(
            "¿Dar de baja este correo y excluirlo de futuras exportaciones?",
          )
        )
          return;
        button.disabled = true;
        try {
          await api("/api/admin/waitlist/" + member.id, {
            method: "PATCH",
            body: JSON.stringify({ status: "withdrawn" }),
          });
          $("#vip-admin-message").textContent =
            "Correo dado de baja y excluido del CSV.";
          await load();
        } catch (error) {
          $("#vip-admin-message").textContent = error.message;
          button.disabled = false;
        }
      };
      row.append(button);
    } else
      row.append(
        text(
          "span",
          "Baja: " + new Date(member.withdrawn_at).toLocaleString("es-MX"),
          "fine",
        ),
      );
    $("#members").append(row);
  }
  $("#previous").disabled = page === 0;
  $("#next").disabled = !result.more;
  $("#page-number").textContent = "Página " + (page + 1);
}
function report(error) {
  $("#vip-admin-message").textContent = error.message;
}
$("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  try {
    await api("/api/session", {
      method: "POST",
      body: JSON.stringify({ password: $("#password").value }),
    });
    $("#password").value = "";
    $("#vip-admin-message").textContent = "";
    await load();
  } catch (error) {
    report(error);
  } finally {
    button.disabled = false;
  }
};
$("#logout").onclick = async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
    $("#members").replaceChildren();
    $("#login").hidden = false;
    $("#member-panel").hidden = true;
    $("#logout").hidden = true;
    $("#vip-admin-message").textContent = "Sesión cerrada.";
  } catch (error) {
    report(error);
  }
};
$("#refresh").onclick = () => load().catch(report);
$("#member-status").onchange = () => {
  page = 0;
  load().catch(report);
};
$("#previous").onclick = () => {
  page = Math.max(0, page - 1);
  load().catch(report);
};
$("#next").onclick = () => {
  page++;
  load().catch(report);
};
load().catch((error) => {
  if (!error.message.includes("Inicia sesión")) report(error);
});
