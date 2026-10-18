const menu = document.querySelector("#menu-toggle"), nav = document.querySelector("#main-nav");
menu.onclick = () => { const open = nav.classList.toggle("open"); menu.setAttribute("aria-expanded", String(open)); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { nav.classList.remove("open"); menu.setAttribute("aria-expanded","false"); } });
// Display the existing checkout bag; never create a second cart implementation.
try {
  const items = JSON.parse(sessionStorage.getItem("offcode-bag") || "[]");
  const count = Array.isArray(items) && items.every((i) => Number.isInteger(i.qty) && i.qty > 0 && i.qty <= 99)
    ? Math.min(99, items.reduce((n, i) => n + i.qty, 0)) : 0;
  document.querySelector("[data-bag-count]").textContent = String(count);
} catch {}
