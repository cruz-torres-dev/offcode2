# OFFCODE — tema oscuro editorial

Fecha: 17 de octubre de 2026. Node 24.14.0. No se realizó push ni despliegue. Se conservaron los cambios locales previos (etapa de movimiento) y no se modificaron `.env`, la base de datos, el servidor, el checkout, el panel ni `dist/app.js` / `dist/logo.js`.

## Cambios

- `dist/styles.css`: paleta oscura completa (fondo `#080808`, secciones `#111111`, superficie `#181818`, textos `#F5F5F5`/`#A6A6A6`, bordes `#303030` y `#5F5F5F` para controles), encabezado negro translúcido con desenfoque, diálogos y toast oscuros, estados hover/active en navegación, botones, tallas, miniaturas, cantidad y cierre, transición de apertura/cierre de diálogos con `@starting-style`. Las superficies de las fotografías de producto (principal, miniaturas y zoom) se mantienen blancas.
- `dist/index.html`: metas `theme-color`/`color-scheme` oscuros y `data-finish="silver"` en el `model-viewer` (acabado ya previsto por `logo.js`).
- `dist/motion.css`: capa `.gallery-ghost` para el fundido de la galería.
- `dist/motion.js`: entrada reordenada (~2 s: fondo, monograma, fotografías, titular y botón), revelaciones de sección ligeramente más lentas, inclinación de producto limitada a 3,5° por eje y fundido cruzado de la galería observando el cambio de `src` de `#gallery-main`.

## Comprobaciones ejecutadas

- `npm test`: 21 pruebas aprobadas, cero fallos.
- `node --check dist/motion.js`, `node --check dist/app.js` y `git diff --check`.
- Navegador local (Chromium, `npm run preview:shipping` en el puerto 8013 con datos ficticios): escritorio 1440 px y móvil emulado 390 px. Capturas en `qa/dark/`.
- Galería: al cambiar de vista aparece la capa saliente, la nueva foto entra con opacidad/escala y la capa se elimina al terminar; clics rápidos consecutivos no dejan capas residuales.
- Compra ficticia local: talla L, cantidad 1 y 2, bolsa con subtotal correcto ($1,650.00 / $3,300.00 MXN), apertura y cierre de la bolsa (vuelve a `display: none` y el scroll se restaura), navegación a `checkout.html` con la selección en `sessionStorage` y regreso a la tienda con la bolsa conservada. No se crearon pedidos reales ni se contactó Envia.
- Harness de movimiento (`tests/preview-motion.mjs`, puerto 8014): normal PASS (9 efectos de entrada, duración máxima 1980 ms; 24 efectos tras recorrer la página y volver), touch PASS (sin transformaciones de cursor), reduced PASS (cero efectos, contenido visible) y nojs PASS (contenido visible sin scripts de tienda).
- Movimiento reducido nativo (emulación del navegador): cero animaciones, la galería cambia sin fundido y la bolsa abre al instante.
- Auditoría axe-core 4.12.1 (WCAG 2 AA): 0 violaciones. 11 nodos quedaron en "revisión manual" de contraste por estar sobre fotografías o bajo el encabezado con desenfoque; se verificaron visualmente (texto claro sobre fondos oscuros; flechas de galería `#F5F5F5` sobre `#080808`).
- Sin desbordamiento horizontal en 1440 px ni 390 px (`scrollWidth` igual al ancho de ventana).

## Evidencias y límites

- `qa/dark/`: `desktop-hero.png`, `desktop-collection.png`, `desktop-gallery-sizes.png`, `desktop-bag.png`, `desktop-editorial.png`, `desktop-closing-footer.png`, `desktop-reduced-bag.png`, `mobile-hero.png`, `mobile-menu.png`, `mobile-product.png`.
- El puntero táctil y el movimiento reducido se simularon; no se probaron teléfonos físicos, Safari ni Firefox, ni rendimiento en red móvil real.
- El fundido de diálogos depende de `@starting-style` y transiciones discretas: navegadores sin soporte abren y cierran al instante (comportamiento anterior, sin cambios funcionales).
- Al volver desde el checkout con la bolsa abierta, la caché de navegación restaura la página con la bolsa visible: comportamiento ya existente de `app.js`, no introducido por esta etapa.
- La captura de página completa con encabezado adhesivo deformó el encadenado de imágenes y se descartó como evidencia; se usaron capturas por sección.
