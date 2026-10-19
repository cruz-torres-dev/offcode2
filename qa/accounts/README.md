# Validación local — cuentas por correo y galería

> Esta es la validación de la etapa anterior. El visor final sin barra de zoom, sus flechas laterales y las pruebas actuales se documentan en [../viewer-final/README.md](../viewer-final/README.md).

17 de octubre de 2026. Node.js **24.14.0**, compatible con `>=24.14.0 <25`. Sin clientes, pedidos, correos o credenciales reales. Sin commit, push ni despliegue. El cambio SQLite previo sigue siendo HEAD; se conservaron los cambios locales anteriores de cabecera, portada, cuentas y Contacto.

## Resultado de pruebas

- `npm ci`: correcto, un paquete auditado (el proyecto), cero vulnerabilidades informadas. Se retiraron openid-client y sus dependencias exclusivas; package.json, lockfile y .env.example vuelven a coincidir con la base de Git tras retirar la configuración anterior.
- `npm test`: **71 aprobadas, cero fallos, cero omisiones**. Nueve pruebas de cuentas, tres del controlador de galería con DOM/eventos simulados y una prueba HTTP adicional de catálogo. También pasan las pruebas existentes de pedidos, inventario, reservas, SQLite, correo de pedidos, administración y Envia.
- Las cuentas cubren registro/verificación, contraseña errónea, scrypt, cookies seguras, rotación/revocación de sesiones, recuperación indistinguible, expiración y uso único de tokens, acceso privado, aislamiento entre titulares, límites, persistencia y correo fallido sin exposición de claves. Las rutas retiradas devuelven 404. Una cuenta previa sin contraseña puede recuperarse acreditando acceso al correo; no se duplican registros.
- Catálogo: seis imágenes ordenadas se publican correctamente sin cambiar precio, tallas o producto; las doce variantes WebP responden 200 como imágenes. No se generan pedidos en esa prueba.
- Controlador de galería: selección dinámica y vacía, rechazo de fuentes externas, carga grande diferida, cierre con foco/desplazamiento conservado, teclado, zoom 2×/1×, arrastre, swipe, pinch y cancelación de gesto. Los gestos de estas pruebas son **simulados**, no una comprobación en teléfono físico.
- Sintaxis: `node --check` correcto en **38 archivos JS/MJS** propios de server, dist, tests y scripts; se excluye el proveedor 3D empaquetado de assets.
- `git diff --check`: correcto. Revisión de `git status --short`, diferencias de archivos versionados y fuentes nuevas. No hay cambios en el índice.

## Revisión real de interfaz en Chrome

Servidor separado en memoria en loopback, ventas y correo desactivados. No se utilizó el servicio de producción.

- Visor sin desbordamiento a **320, 390, 768 y 1440 px**. A 320 px: modal de 631.98 px de alto en ventana de 740 px, sin desbordamiento interno horizontal. Cierre de 44×44 px y zoom de 46 px de alto comprobados a 390 px.
- Las cuatro fotografías cargan con dimensiones naturales correctas: frente/espalda 960×960, detalle/empaque 960×1280; todas usan object-fit:contain. Resultado en `gallery-browser-images.json`.
- Apertura con foco en Cerrar foto; Escape cierra y devuelve el foco a product-open, manteniendo selección y desplazamiento (1624 px en la comprobación). Navegación anterior/siguiente y flechas de teclado, zoom desde botón, teclado y clic sobre foto.
- Arrastre real de ratón: scrollLeft pasó de 564 a 434 px manteniendo zoom activo. Flechas desplazan la vista ampliada.
- Cambiar las cuatro fotos mantuvo talla L y contador 2. La bolsa existente mostró dos prendas L, subtotal $3,300 MXN. No se envió una solicitud ni se entró en un cobro.
- Panel de cuenta sin botón ni separador del proveedor retirado; conserva login, registro y recuperación. Sin Resend, el registro informa explícitamente que no se puede completar el envío de enlaces.
- Sin errores ni advertencias en la consola de la tienda revisada.
- Movimiento reducido: **PASS**, cero animaciones y transformaciones none; galería abre y amplía. Puntero táctil: **PASS**, seis efectos editoriales de entrada y sin transformaciones de cursor. Se simulan preferencias mediante el helper local, sin modificar las del sistema. Resultados actuales: `motion-reduced-current.json` y `motion-touch-current.json`. Los JSON sin sufijo current corresponden a la etapa anterior.

Capturas actuales: `gallery-desktop.png`, `gallery-mobile.png`, `account-desktop.png` y `account-email-mobile.png`. Las capturas previas del header se conservan como evidencia de esa etapa.

## Fotografías inspeccionadas y elegidas

Se recorrió la carpeta local `C:\Users\gatoi\Downloads\LA AFRO X OFFCODE – offcode_files` y todas sus subcarpetas. Se encontraron **12 archivos raster**, agrupados visualmente en cuatro fotos. No se copiaron HTML, estilos ni scripts de Shopify. No se descargaron recursos.

- Frente: `D297342C-CDE2-4260-B3F1-DDF5D31BDB08.png`, **1080×1080**. La variante `(2)` es un duplicado exacto; las otras variantes son 120, 500 y 1024 px. Se eligió la resolución nativa mayor sin ampliarla artificialmente.
- Espalda: `D0A32C0B-78AD-4045-8836-469A19C47200.png`, **1080×1080**; descartadas versiones 500/1024 px.
- Detalle de capucha y gráficos: `29056067-BEA6-4AFB-8A65-BBDBBFB93616.jpg`, **3024×4032**; descartada copia 1024×1365. Aporta mayor detalle que product-detail.jpg (1125×1500) y hoodie-detail.png (1200×1600).
- Prenda y empaque: `FC9F60E7-C9D4-493C-B40D-14607295CA5B.jpg`, **3840×5120**; descartada versión 1024×1365. Añade una vista de producto real distinta, sin reemplazarla por campaña.

Frente y espalda muestran las mismas vistas que product-front/back.jpg y hoodie-front/back.png (1080×1080) existentes. Se conservan esos archivos y se generan derivados desde los PNG locales. Inventario de tamaños, hashes SHA-256 y duplicados: `source-inventory.json`; contacto visual: `source-images.jpg`; selección, tamaños y pesos de derivados: `product-media.json`.

Las miniaturas pesan aproximadamente **1.4–4.2 KB**, a 160 px; principales a 960 px; visor a 1080 px nativos para frente/espalda y 2048 px para detalle/empaque. La máxima resolución solo se asigna al abrir o cambiar la imagen dentro del visor. El manifiesto público `dist/assets/product-media.json` solo contiene rutas, tamaños y derivados públicos.

## Archivos de esta revisión

- Galería: dist/gallery.js (nuevo), dist/app.js, dist/index.html, dist/styles.css, server/catalog-store.mjs, server/db.mjs y server/http-policy.mjs; doce WebP, product-packaging.jpg y manifiesto de medios.
- Cuenta: dist/account.js, dist/account.css, server/customer-accounts.mjs; se retiró el módulo exclusivo del proveedor anterior. Se conservaron sus tablas históricas inertes para no borrar registros.
- Pruebas: tests/gallery.test.mjs, tests/customer-accounts.test.mjs, tests/catalog.test.mjs y tests/product.test.mjs.
- Guías: CUENTAS.md, README.md, OPERACION.md y este directorio QA. Los demás cambios que muestra Git pertenecen también al trabajo local anterior y se preservaron.

## Pendiente manual

1. Configurar y comprobar la entrega real de verificación/recuperación mediante Resend. Nunca se simula una entrega real.
2. Retirar del dashboard, si existen, las variables antiguas indicadas en CUENTAS.md. No se cambiaron variables reales.
3. En bases existentes se conserva la lista administrada de fotografías. Para mostrar la cuarta vista, añadir desde Productos `assets/product-packaging.jpg`, texto alternativo “Sudadera y empaque original LA AFRO × OFFCODE”, y conservar el orden deseado. Las bases nuevas de prueba ya incluyen cuatro; no se resembra la base existente.
4. Probar pinch/swipe en un teléfono físico y revisar Safari/Firefox. Las comprobaciones táctiles actuales son simuladas; Chrome de escritorio sí se probó con ratón y teclado.
5. Publicar solo por decisión del propietario. DATABASE_PATH sigue siendo `/var/data/offcode.sqlite`; no se tocó el servicio Render ni se activaron ventas.
