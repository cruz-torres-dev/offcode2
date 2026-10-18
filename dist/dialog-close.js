/* Private panel: closes a <dialog> from its own X button or from the backdrop.
   Escape handling, focus restoration and scroll restoration stay native to
   <dialog>; nothing here cancels or prevents them. Wiring is idempotent. */
const wired = new WeakSet();

const outsideContent = (dialog, event) => {
  const rect = dialog.getBoundingClientRect();
  return (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  );
};

export function wireDialogClose(root = document) {
  if (wired.has(root)) return;
  wired.add(root);
  for (const dialog of root.querySelectorAll("dialog")) {
    dialog.addEventListener("click", (event) => {
      // The dialog element itself is the backdrop area; any child is content.
      if (event.target !== dialog) return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY))
        return;
      if (outsideContent(dialog, event)) dialog.close();
    });
  }
  root.addEventListener("click", (event) => {
    const button = event.target?.closest?.(".close");
    if (button) button.closest("dialog")?.close();
  });
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () =>
      wireDialogClose(document),
    );
  else wireDialogClose(document);
}
