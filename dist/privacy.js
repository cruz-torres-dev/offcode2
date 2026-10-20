(() => {
  let documentPromise, dialog, opener, opening = false;
  async function policy() {
    if (!documentPromise) documentPromise = fetch("privacidad.html", { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw Error("No se pudo cargar la política.");
      const parsed = new DOMParser().parseFromString(await response.text(), "text/html");
      const content = parsed.querySelector("[data-privacy-document]");
      if (!content) throw Error("Documento de privacidad no disponible.");
      return content;
    }).catch((error) => { documentPromise = null; throw error; });
    return documentPromise;
  }
  function create(content) {
    dialog = document.createElement("dialog"); dialog.className = "privacy-modal";
    dialog.setAttribute("role", "dialog"); dialog.setAttribute("aria-modal", "true"); dialog.setAttribute("aria-labelledby", "privacy-modal-title");
    const header = document.createElement("div"); header.className = "privacy-modal-header";
    const title = document.createElement("h2"); title.id = "privacy-modal-title"; title.textContent = "Política de privacidad";
    const close = document.createElement("button"); close.type = "button"; close.className = "privacy-modal-close";
    close.textContent = "×"; close.setAttribute("aria-label", "Cerrar política de privacidad"); close.autofocus = true;
    close.addEventListener("click", () => dialog.close());
    const body = document.createElement("div"); body.className = "privacy-modal-body"; body.tabIndex = 0;
    body.setAttribute("aria-label", "Contenido de la política de privacidad"); body.append(content.cloneNode(true));
    header.append(title, close); dialog.append(header, body); document.body.append(dialog);
    dialog.addEventListener("click", (event) => {
      const box = dialog.getBoundingClientRect();
      if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
    });
    dialog.addEventListener("close", () => {
      document.documentElement.classList.remove("privacy-is-open");
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusable = [...dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0], last = focusable.at(-1);
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    });
    // showModal makes the background inert; Tab wraps explicitly at both ends.
    // Native Escape dispatches cancel and closes this dialog.
  }
  document.addEventListener("click", async (event) => {
    const link = event.target.closest("a[data-privacy-link]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || typeof HTMLDialogElement === "undefined") return;
    event.preventDefault(); if (opening || dialog?.open) return;
    opening = true;
    try {
      const content = await policy(); if (!dialog) create(content);
      opener = link; document.documentElement.classList.add("privacy-is-open");
      dialog.showModal(); dialog.querySelector(".privacy-modal-body").scrollTop = 0;
      dialog.querySelector("button").focus({ preventScroll: true });
    } catch { window.location.assign(link.href); }
    finally { opening = false; }
  });
})();
