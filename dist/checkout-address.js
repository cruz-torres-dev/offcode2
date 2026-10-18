// Opt-in reuse of a saved shipping address. Nothing is copied until the person
// clicks: the form is never pre-filled silently, and the saved address is only
// read from the authenticated session on the server.
const form = document.querySelector("#order-form");
if (form) {
  (async () => {
    try {
      const session = await fetch("/api/customer/session", { credentials: "same-origin" });
      if (!session.ok) return;
      const account = await session.json();
      if (!account.user?.verified) return;
      const profile = await fetch("/api/customer/profile", { credentials: "same-origin" });
      if (!profile.ok) return;
      const { address } = await profile.json();
      if (!address) return;

      const block = document.createElement("div");
      block.className = "saved-address";
      const label = document.createElement("p");
      label.className = "saved-address-text";
      label.textContent = `Dirección guardada (${address.label || "Predeterminada"}): ${address.street} ${address.number}, ${address.neighborhood}, ${address.city}.`;
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Usar esta dirección";
      const hint = document.createElement("p");
      hint.className = "saved-address-text";
      hint.textContent = "Solo se copia a este formulario. Puedes editarla antes de enviar y no se guarda nada nuevo.";
      block.append(label, button, hint);
      form.prepend(block);

      button.addEventListener("click", () => {
        const write = (name, value) => {
          const field = form.elements[name];
          if (!field || value == null || value === "") return;
          if (field.tagName === "SELECT") {
            const plain = (text) => String(text).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            const option = [...field.options].find((o) => plain(o.value) === plain(value) || plain(o.textContent) === plain(value));
            if (!option) {
              hint.textContent = "Tu estado guardado no aparece en la lista de cobertura. Elígelo de nuevo.";
              return;
            }
            field.value = option.value;
          } else {
            field.value = value;
          }
          // Reusing the existing listener invalidates any FedEx quote.
          field.dispatchEvent(new Event("input", { bubbles: true }));
        };
        write("name", address.name);
        write("phone", address.phone);
        write("email", account.user.email);
        write("street", [address.street, address.number].filter(Boolean).join(" "));
        write("neighborhood", address.neighborhood);
        write("postalCode", address.postalCode);
        write("city", address.city);
        write("state", address.state);
        write("notes", address.notes);
        hint.textContent = "Dirección copiada. Revísala antes de enviar; el consentimiento sigue siendo tuyo.";
        button.disabled = true;
      });
    } catch {
      // A saved address is a convenience: any failure leaves checkout untouched.
    }
  })();
}
