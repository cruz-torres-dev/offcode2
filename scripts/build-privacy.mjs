import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

// Canonical source. The historical document is kept as a backup only and must
// never feed the public page: it describes a platform this store does not use.
const source = new URL("../docs/politica-privacidad.md", import.meta.url);
const target = new URL("../dist/privacidad.html", import.meta.url);
const escape = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
function inline(text) {
  return text.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\)|https:\/\/[^\s]+|\*\*[^*]+\*\*|brandoffcode@gmail\.com|\+52 477 161 0537)/g).map((part) => {
    const link = part.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/);
    if (link) return `<a href="${escape(link[2])}" target="_blank" rel="noopener noreferrer">${escape(link[1])}</a>`;
    if (part.startsWith("https://")) {
      const url = part.replace(/[.,;]+$/, "");
      return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(url)}</a>${escape(part.slice(url.length))}`;
    }
    if (/^\*\*[^*]+\*\*$/.test(part)) return `<strong>${escape(part.slice(2, -2))}</strong>`;
    if (part === "brandoffcode@gmail.com") return `<a href="mailto:${part}">${part}</a>`;
    if (part === "+52 477 161 0537") return `<a href="tel:+524771610537">${part}</a>`;
    return escape(part);
  }).join("");
}
export function privacyPage(markdown) {
  // The public policy describes the store that actually runs. A reference to a
  // third-party commerce platform would be false here, so it fails the build.
  if (/shopify|shop pay/i.test(markdown))
    throw Error("La política pública no puede mencionar Shopify: describe la plataforma propia de OFFCODE.");
  const blocks = markdown.trim().split(/\r?\n\s*\r?\n/);
  if (!blocks[0]?.startsWith("# Política de privacidad"))
    throw Error("La fuente de privacidad debe conservar su título.");
  if (!/^Última actualización: \d{1,2} de [a-záéíóúñ]+ de \d{4}$/i.test(blocks[1] ?? ""))
    throw Error("La fuente de privacidad debe indicar la fecha con el formato «Última actualización: 20 de octubre de 2026».");
  const content = blocks.map((block) => {
    if (block.startsWith("# ")) return `<h1>${inline(block.slice(2))}</h1>`;
    if (block.startsWith("## ")) return `<h2>${inline(block.slice(3))}</h2>`;
    if (block.startsWith("- ")) return `<ul>${block.split(/\r?\n/).map((line) => {
      if (!line.startsWith("- ")) throw Error("Lista Markdown no válida.");
      return `<li>${inline(line.slice(2))}</li>`;
    }).join("\n")}</ul>`;
    return `<p>${inline(block.replace(/\r?\n/g, " "))}</p>`;
  });
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="robots" content="noindex,nofollow" /><title>Política de privacidad — OFFCODE</title>
<link rel="icon" href="assets/monogram-static.png" /><link rel="stylesheet" href="privacy.css" /></head>
<body class="privacy-page"><header class="privacy-page-header"><a class="privacy-wordmark" href="index.html">OFFCODE™</a><a href="checkout.html">Volver al checkout ↗</a></header>
<main class="privacy-document" data-privacy-document>${content.join("\n")}</main>
<footer class="privacy-page-footer"><a href="index.html">← Volver a la tienda</a></footer></body></html>\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(target, privacyPage(await readFile(source, "utf8")));
  console.log("Página de privacidad generada desde docs/politica-privacidad.md.");
}
