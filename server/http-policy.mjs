import { isIP } from "node:net";
import path from "node:path";

// Render sets the first forwarded IP to the real client. Trust it only behind
// that managed ingress; a direct local client must never choose its own bucket.
export function clientIp(req, trustRenderProxy = false) {
  if (trustRenderProxy) {
    const candidate = String(req.headers["x-forwarded-for"] ?? "")
      .split(",")[0]
      .trim();
    if (isIP(candidate)) return candidate;
  }
  return req.socket.remoteAddress ?? "unknown";
}

// Only public storefront documents/assets are cacheable. Never cache API data,
// login, addresses, checkout, administration, errors or responses with cookies.
export function staticPolicy(relativePath) {
  const file = relativePath.replaceAll(path.sep, "/");
  if (file.startsWith("assets/"))
    return "public, max-age=3600, s-maxage=86400, stale-while-revalidate=60";
  if (["index.html", "tienda.html", "teaser.html"].includes(file))
    return "public, max-age=0, s-maxage=60, must-revalidate";
  if (["styles.css", "app.js", "gallery.js", "logo.js", "store-redirect.js", "motion.css", "motion.js", "account.css", "account.js", "contact.js", "public-header.js"].includes(file))
    return "public, max-age=0, s-maxage=300, must-revalidate";
  return "no-store";
}
