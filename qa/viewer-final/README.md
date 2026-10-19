# Visor final y footer — validación local

Cambios locales del 17 de octubre de 2026. Node **24.14.0**. No se ejecutaron commit, push, despliegue ni cambios de Render. Los cambios anteriores de cuentas, cabecera, portada y catálogo se conservaron.

## Cambios

- `dist/index.html`: encabezado del visor con LAAFRO × OFFCODE y cierre; se eliminó la barra superior de ampliación. Flechas reales a los lados de la zona de imagen y miniaturas dinámicas abajo. Instrucciones accesibles sin ocupar espacio visual.
- `dist/styles.css`: modal de ventana completa, tres filas limitadas al viewport, centro flexible con columnas independientes para flechas e imagen. Flechas de 44–48 px, contraste y foco; miniaturas con desplazamiento horizontal y formato compacto en ventanas bajas. No se posicionan flechas respecto al tamaño de la foto ni se recorta su contenedor. La apertura conserva el fundido pero no desplaza el modal fuera de la ventana.
- `dist/gallery.js`: reutiliza selección, apertura, cierre, zoom y gestos existentes. Sincroniza los dos selectores y contador; zoom al pulsar el punto seleccionado, cursor zoom-in/grab/grabbing, arrastre, pinch y swipe. Enter/espacio alternan zoom; + amplía y −/0 restablecen. Izquierda/derecha cambian de foto incluso después de ampliar; Mayúsculas + flechas desplaza la foto ampliada. Se respetan edición y atajos del navegador. Una sola foto deshabilita navegación.
- `dist/index.html` y `dist/app.js`: footer definitivo «OFFCODE™ · Hecho para salir del código.», también cuando la configuración permite pedidos. Marca, Contacto y Volver arriba conservados. No se retiraron advertencias operativas sobre ventas pendientes.
- `tests/gallery.test.mjs`: pruebas adaptadas al visor sin botón superior y dos regresiones nuevas para miniaturas/contador/navegación circular/una imagen/zoom por punto/atajos y footer.
- README.md, OPERACION.md y esta carpeta: resultados y documentación actualizados. qa/accounts/README.md identifica su informe como una etapa anterior.

No se modificaron recursos fotográficos, header negro, autenticación, checkout, rutas privadas, SQLite, DATABASE_PATH, claves o configuración de producción en esta corrección. No hay dependencias nuevas ni modelo 3D de la hoodie.

## Pruebas automáticas

- `node --test tests/gallery.test.mjs`: **5 aprobadas**. Incluye selección de seis imágenes, carga grande al abrir, vuelta de foco y scroll al cerrar, teclado, clic, arrastre, pinch/swipe simulados y cancelación de gesto.
- `npm test`: **73 aprobadas, 0 fallos, 0 omisiones**, Node 24.14.0. Se conservan las pruebas de pedidos, inventario, pagos, Envia, seguridad de cuentas y persistencia.
- `node --check`: **38 archivos JS/MJS** propios correctos.
- `git diff --check`: sin errores. Se revisaron el estado y el diff; no hay cambios en el índice.

## Chrome real en loopback

Servidor aislado en memoria, pedidos y correo desactivados. No se crearon pedidos ni se llamó a servicios de pago o envío.

- Ventana completa de 1440×900, móvil 390×844, móvil pequeño 320×568, horizontal 844×390 y ventana pequeña 640×360. Modal dentro de la ventana, sin desbordamiento horizontal.
- En los cinco tamaños, anterior, siguiente y cierre completamente dentro del viewport y accesibles al hit-test en su centro. Flechas de 44 o 48 px, centradas verticalmente con error máximo medido de 0.008 px. Mediciones: `layout.json`.
- Las cuatro fotos reales recorren ambas direcciones y el ciclo completo, con contador y miniaturas sincronizados. Clic en miniatura cambia la imagen. Las imágenes cuadradas de frente/espalda y verticales de detalle/empaque usan contain, sin deformación.
- Para verificar formato horizontal se utilizó **solo en otro servidor temporal en memoria** el monograma existente de 860×767 como fixture de layout, identificado expresamente como prueba, no como foto de producto. No se añadió al catálogo real ni se cambió un archivo. Resultado: `horizontal-fixture.json`; servidor temporal detenido al terminar.
- Zoom desde clic y Enter, restablecimiento desde espacio. Arrastre real del ratón: scrollLeft 872→742 y scrollTop 326→256 sin salir del zoom. Izquierda/derecha navegan después de ampliar. Las pruebas de pinch/swipe son simuladas; no se probó teléfono físico.
- Cierre desde botón y Escape; foco de vuelta a product-open. El visor mantiene la fotografía elegida. Bolsa y talla se conservan al cambiar de imagen; no se modifica su lógica.
- Footer visible con el texto definitivo. Búsqueda en dist sin apariciones de «Concepto web de demostración» ni de la antigua barra de zoom.
- Movimiento reducido simulado mediante el helper local: **PASS**, cero animaciones, transformaciones none y contenido visible. Visor abre, Enter amplía y espacio restablece. Resultado: `reduced-motion.json`. No se cambió la preferencia del sistema.
- Sin errores ni advertencias JavaScript en la tienda revisada.

Capturas: `desktop.png`, `mobile.png`, `landscape-window.png`. Las mediciones se repitieron sobre los estilos finales después de ampliar el espacio del foco en miniaturas.

## Pendiente

Revisión de gestos en un teléfono físico y comprobación en Safari/Firefox. No hay bloqueo local conocido. La publicación sigue siendo una decisión manual del propietario; ninguna prueba habilita ventas.


## Corrección adicional: flechas debajo de la fotografía

La captura posterior del propietario correspondía a los botones `photo-prev` y `photo-next` de la galería principal. Usaban caracteres de flecha que heredaban los 9 px del contador; no eran las flechas laterales del visor. Se reemplazaron por SVG de **22×22 px**, centrados en botones de **44×44 px**, con padding cero y sin contracción. IDs, etiquetas accesibles y navegación existentes conservados.

Archivos: dist/index.html, dist/styles.css y tests/gallery.test.mjs. Se amplió la regresión existente para comprobar también anterior/siguiente de la galería principal. **73/73 pruebas aprobadas**, incluyendo las cinco pruebas de galería; git diff --check correcto. Chrome a 1440 y 390 px: SVG completos, centrado exacto, navegación 01→02→01 y sin desbordamiento móvil. Captura: `gallery-arrows-fixed.png`. Corrección local, sin commit, push ni despliegue.
