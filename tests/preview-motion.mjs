// Local-only visual harness. Run alongside npm run preview:shipping.
// Media preferences and pointer events are simulated, never applied to the OS.
import { createServer } from "node:http";
const qaPort = Number(process.env.OFFCODE_QA_PORT ?? 8014);
const upstreamPort = Number(process.env.OFFCODE_QA_UPSTREAM_PORT ?? 8013);
if (![qaPort, upstreamPort].every((p) => Number.isInteger(p) && p > 0 && p < 65536))
  throw Error("Puerto local QA inválido.");

const setup = (mode) => `
(() => {
  const mode = ${JSON.stringify(mode)};
  const nativeMedia = window.matchMedia.bind(window);
  window.matchMedia = (query) => {
    if (query.includes('prefers-reduced-motion') || query.includes('pointer: fine')) {
      const result = new EventTarget();
      result.media = query;
      result.matches = query.includes('prefers-reduced-motion')
        ? (query.includes('no-preference') ? mode !== 'reduced' : mode === 'reduced')
        : mode !== 'touch';
      return result;
    }
    return nativeMedia(query);
  };
  sessionStorage.removeItem('offcode-intro-seen-v1');
  const nativeAnimate = Element.prototype.animate;
  const effects = [];
  Element.prototype.animate = function (...args) {
    const effect = nativeAnimate.apply(this, args);
    effects.push(effect);
    if (mode === 'intro') { effect.pause(); effect.currentTime = 600; }
    return effect;
  };
  addEventListener('DOMContentLoaded', () => {
    const bar = document.createElement('aside');
    bar.setAttribute('aria-label', 'Pruebas locales de animación');
    bar.style.cssText = 'position:fixed;bottom:0;left:0;z-index:1000;background:#fff;color:#111;padding:8px;font:12px monospace;max-width:100%;border:1px solid #999';
    for (const value of ['normal','intro','reduced','touch','nojs']) {
      const a = document.createElement('a');
      a.href = '/?qaMode=' + value;
      a.textContent = value + ' · ';
      bar.append(a);
    }
    const button = document.createElement('button');
    button.textContent = 'Comprobar movimiento';
    const output = document.createElement('output');
    output.id = 'motion-test-result';
    output.style.cssText = 'display:block;max-width:600px;max-height:130px;overflow:auto;white-space:pre-wrap';
    bar.append(button, output);
    document.body.append(bar);
    button.onclick = async () => {
      const check = (ok, message) => { if (!ok) throw Error(message); };
      try {
        if (mode !== 'intro') await Promise.all(effects.map(effect => effect.finished.catch(() => {})));
        const hero = document.querySelector('.hero');
        const photo = hero.querySelector('picture');
        const product = document.querySelector('.product-image');
        const move = (el) => {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new PointerEvent('pointermove', {pointerType:'mouse', clientX:r.right, clientY:r.top}));
        };
        move(hero); move(product);
        await new Promise(r => setTimeout(r, 800));
        const pointer = mode === 'normal' || mode === 'intro';
        check(Boolean(photo.style.getPropertyValue('--depth-x')) === pointer, 'Capas de campaña');
        check(Boolean(product.style.getPropertyValue('--tilt-y')) === pointer, 'Inclinación de producto');
        if (pointer) check(Math.abs(parseFloat(product.style.getPropertyValue('--tilt-y'))) <= 4, 'Límite de inclinación');
        const transforms = {campaign:getComputedStyle(photo.querySelector('img')).transform, product:getComputedStyle(product.querySelector('img')).transform};
        hero.dispatchEvent(new PointerEvent('pointerleave'));
        product.dispatchEvent(new PointerEvent('pointerleave'));
        check(!product.style.getPropertyValue('--tilt-y') && !photo.style.getPropertyValue('--depth-x'), 'Restablecer al salir');
        if (mode === 'reduced' || mode === 'nojs') check(!effects.length, 'Animaciones desactivadas');
        const visible = [...document.querySelectorAll('.hero h1, .section-heading, .product-gallery, .editorial-grid figure')].every(e => getComputedStyle(e).opacity === '1');
        if (mode !== 'intro') check(visible, 'Contenido visible');
        check(document.documentElement.scrollWidth <= innerWidth, 'Desbordamiento horizontal');
        output.textContent = JSON.stringify({result:'PASS',mode,effects:effects.length,maxDuration:Math.max(0,...effects.map(a=>a.effect.getComputedTiming().endTime)),transforms,visible}, null, 2);
      } catch (error) { output.textContent = 'FAIL: ' + error.message; }
    };
  });
})();`;

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${qaPort}`);
    const mode = url.searchParams.get("qaMode") || "normal";
    if (url.pathname === "/__qa-setup.js") {
      res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
      return res.end(setup(mode));
    }
    const upstream = await fetch(`http://127.0.0.1:${upstreamPort}` + url.pathname);
    const type = upstream.headers.get("content-type") || "application/octet-stream";
    let body = Buffer.from(await upstream.arrayBuffer());
    if (url.pathname === "/") {
      let html = body.toString();
      if (mode === "nojs") html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      html = html.replace('<link rel="stylesheet" href="styles.css"', `<script src="/__qa-setup.js?qaMode=${mode}"></script><link rel="stylesheet" href="styles.css?qaMode=${mode}"`)
        .replace('href="motion.css"', `href="motion.css?qaMode=${mode}"`);
      body = Buffer.from(html);
    } else if (url.pathname.endsWith(".css")) {
      body = Buffer.from(body.toString()
        .replaceAll("(prefers-reduced-motion: reduce)", mode === "reduced" ? "all" : "not all")
        .replaceAll("(prefers-reduced-motion: no-preference)", mode === "reduced" ? "(width: 0px)" : "(min-width: 0px)")
        .replaceAll("(hover: hover) and (pointer: fine)", mode === "touch" ? "(width: 0px)" : "(min-width: 0px)"));
    }
    res.writeHead(upstream.status, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(502);
    res.end("Inicia npm run preview:shipping antes de esta prueba local.");
  }
});
server.listen(qaPort, "127.0.0.1", () => console.log(`Pruebas visuales LOCALES: http://127.0.0.1:${qaPort}/?qaMode=normal`));
