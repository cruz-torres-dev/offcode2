# OFFCODE — revisión local de movimiento

Fecha: 17 de octubre de 2026. Node 24.14.0. No se realizó push ni despliegue.

## Cambios

- `dist/index.html`: carga diferida del módulo visual y su hoja de estilos.
- `dist/motion.js`: entrada de 2.1 s, revelaciones repetibles, profundidad de portada y foto de producto inclinable hasta 4°. La entrada se recuerda por sesión de pestaña; no se repite al navegar a secciones o regresar del checkout.
- `dist/motion.css`: transformaciones de imágenes, recorte dentro de sus contenedores y movimiento reducido.
- `dist/styles.css`: limita el zoom por hover existente a ratón y movimiento permitido.
- `tests/preview-motion.mjs`: servidor auxiliar local de verificación, fuera de los archivos publicados. Requiere el servidor de pruebas `npm run preview:shipping`. Usa los mismos HTML, CSS y JS del proyecto; simula las consultas de medios en JS y CSS para comprobar las ramas de accesibilidad, sin cambiar Windows. El modo nojs omite los scripts de la tienda; el pequeño controlador de pruebas permanece activo.
- `README.md`: comportamiento y reproducción de la revisión.

La prenda sigue siendo una fotografía; solo el monograma utiliza el GLB existente. No se descargaron imágenes, videos ni librerías. Los cambios no modifican la lógica comercial ni el servidor.

## Comprobaciones ejecutadas

- `npm test`: 21 pruebas aprobadas, cero fallos.
- `npm run check:load`: 600 solicitudes de catálogo, 120 solicitudes nuevas y 120 reintentos, cero errores, 120 pedidos únicos; reporte actualizado `qa/load-local.json`. Es loopback y transporte ficticio, no capacidad real de Render.
- `node --check dist/motion.js` y `git diff --check`.
- `package.json` no define build ni lint: este proyecto no requiere compilación.
- Navegador integrado: portada de escritorio de 1440 px, portada móvil de 390 px y colección/campaña a 320 px. Sin desbordamiento horizontal en las comprobaciones del documento.
- Galería: seleccionar Espalda y abrir/cerrar ampliación conserva la foto y el texto alternativo correcto.
- Compra local sintética: talla L, cantidad 2, bolsa de $3,300 MXN, navegación a checkout con la misma selección y regreso a la tienda. No se enviaron pedidos reales ni se compraron guías.
- Consola del servidor de prueba en el navegador: sin errores ni advertencias observados.
- Harness normal: PASS; 9 efectos iniciales, duración máxima 2100 ms; desplazamiento de la primera capa 4/-2.4 px e inclinación dentro de ±4°, vuelta neutral al salir.
- Harness táctil: PASS; sin transformaciones de cursor. El registro pasó de 9 efectos de entrada a 20 tras bajar y 29 tras volver a subir: los bloques vuelven a animarse al entrar en pantalla.
- Harness reducido (escritorio y móvil): PASS; cero efectos, imágenes sin transformación, contenido visible.
- Harness sin scripts de tienda: PASS; cero efectos y contenido visible. El carrito y la galería interactiva ya dependían de JavaScript; esta comprobación valida la presentación, no compras sin JavaScript.

## Evidencias y límites

- `motion-intro-600ms.png`: fotograma pausado a 600 ms mediante el helper, no pantalla de carga real.
- `motion-reduced-desktop.png`: portada con preferencia reducida simulada.
- `motion-mobile.png`: portada a 390 px; la fotografía secundaria se mantiene oculta como en el diseño original.
- `motion-touch-result.json` y `motion-reduced-result.json`: resultados del controlador local.

Las preferencias y eventos de puntero se simularon en el navegador local. No se probaron teléfonos físicos, Safari, Firefox ni rendimiento real de una conexión móvil. Algunas capturas del navegador integrado dejaron de reflejar el desplazamiento de una pestaña; no se usaron esas capturas como evidencia. La revisión de estados comerciales se realizó también mediante el árbol de accesibilidad. No se certifica rendimiento de producción.

## Repetir

1. Ejecutar `npm run preview:shipping`.
2. En otra terminal ejecutar `node tests/preview-motion.mjs`.
3. Abrir http://127.0.0.1:8014/?qaMode=normal y pulsar Comprobar movimiento.
4. Revisar las opciones intro, reduced, touch y nojs. Para revisar el desplazamiento, recorrer las secciones y repetir la comprobación.
5. Detener ambos procesos con Ctrl+C. La base de pruebas es temporal y no contacta Envia.
