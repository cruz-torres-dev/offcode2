# OFFCODE — LA AFRO × OFFCODE

Tienda normal para **cruz-torres-dev/offcode2**. La raíz `/` e `index.html` muestran directamente campaña, monograma Of 3D original, galería, producto, tallas, cantidades y bolsa. Precio de referencia: **$1,650 MXN**, anterior **$2,099 MXN**; tallas S/M/L/XL.

La landing VIP se retiró del sitio publicado. Sus fuentes están en `archive/vip/`, fuera de `dist/`. No se eliminaron registros existentes de la base. `/tienda.html` y `/teaser.html` redirigen a la tienda y conservan parámetros y anclas. La compra no exige registro VIP ni contraseña; `/admin.html` sigue protegido.

**Las ventas siguen desactivadas hasta configurar los datos reales del propietario.** La tienda estática permite probar galería y bolsa; los pedidos persistentes y la integración Envia requieren el servidor Node. Pagos exclusivamente por transferencia, verificados manualmente. FedEx es la única paquetería.

## Probar localmente

- Presentación: `python -m http.server 8000 --directory dist`; abrir http://localhost:8000.
- Servidor: copiar `.env.example` a `.env`, configurar la contraseña privada y ejecutar `npm start`. Node.js **24.14.0** y SQLite integrado en Node (aviso experimental). Ejecutar `npm ci` para validar el lockfile; no hay dependencias externas ni compilación.
- Flujo ficticio completo: `npm run preview:shipping`; abrir http://127.0.0.1:8013. Contraseña del panel de esta vista: **solo-pruebas-fedex-ficticias**. Datos en memoria, sin llamadas a Envia ni guías reales. Detener con Ctrl+C.
- Pruebas: `npm test`.
- Correo transaccional opcional: desactivado por defecto (`EMAIL_ENABLED=false`). Configuración, DNS y prueba controlada en [OPERACION.md](OPERACION.md#correo-transaccional-resend).
- Ejercicio de carga exclusivamente local: `npm run check:load`; reporte en `qa/load-local.json`.

Sigue [OPERACION.md](OPERACION.md) antes de habilitar ventas. El propietario puede configurar ENVIA_TOKEN directamente en las variables privadas del hosting; no necesita compartirlo por chat ni subirlo al repositorio.

## Archivos principales

- `dist/index.html`, `styles.css`, `app.js`, `logo.js`: tienda, campaña, galería, bolsa y monograma.
- `dist/checkout.html` / `checkout.js`: dirección, consentimiento, cotización FedEx y solicitud.
- `dist/admin.html` / `admin.js`: panel con seis secciones (resumen, pedidos, productos, inventario, envíos y configuración).
- `dist/admin.css`: tema oscuro editorial del panel; no afecta a la tienda ni a la configuración.
- `server/server.mjs`: API, sesiones y arranque del servidor.
- `server/database.mjs`: acceso SQLite con cola asíncrona, transacciones aisladas y validación de la ruta privada.
- `server/schema.mjs`: DDL real por motor —tablas, índices, restricciones y claves foráneas— y orden de tablas.
- `server/db.mjs`: esquema versionado y migraciones idempotentes de catálogo e inventario.
- `server/catalog-store.mjs`: productos, variantes, inventario, reservas y pedidos en una transacción.
- `server/catalog.mjs`: datos comerciales confirmados de la prenda, tallas contempladas y estructura de medidas.
- `server/email.mjs` y `server/email-outbox.mjs`: transporte privado de Resend, plantillas y cola durable de notificaciones.
- `scripts/email-smoke.mjs`: prueba de envío real, manual y opcional.
- `server/envia.mjs`: estados, cotizaciones y guías FedEx mediante Envia.
- `server/http-policy.mjs`: caché pública y reconocimiento del cliente detrás de Render.
- `tests/`: integración, acceso, importes, estados, catálogo, inventario, idempotencia, caché y prueba local de carga.
- `.env.example`, `render.yaml`, `render-orders.yaml`: configuración local, estática y alternativa Node.
- `archive/vip/`: respaldo de la landing anterior; no se publica.
- `qa/`: capturas e informes de pruebas, fuera del sitio publicado.

## Ficha de la prenda y guía de tallas (17 de octubre de 2026)

La ficha publica solo datos comerciales confirmados: **hoodie oversize**, **negro**, **100% algodón**, **420 g/m²** y temporada **SS 2026**. El documento de confección del cliente es confidencial y no se copió al repositorio, a `dist/`, a Git ni al despliegue.

El botón "Guía de tallas y medidas" abre un diálogo con las seis tallas contempladas (XS–XXL) y su disponibilidad real, que ahora sale del catálogo administrado: hoy S, M, L y XL; XS y XXL aparecen como "Por confirmar" y el servidor las rechaza, y una talla agotada se muestra como "Agotado". **No hay tabla de centímetros** porque el documento no incluye medidas y no se inventan. La estructura para añadirlas y publicar el tiempo de preparación sigue en `server/catalog.mjs`, sin tocar HTML ni CSS. Ver [OPERACION.md](OPERACION.md#ficha-de-la-prenda-y-guía-de-tallas).

El envío sigue siendo exclusivamente FedEx a través de Envia: cotización filtrada por transportista, selección antes de confirmar, tarifa validada en el servidor y estimado de entrega solo si FedEx lo devuelve. El pedido guarda transportista, servicio, tarifa y estimado; el rastreo se guarda al generar una guía real. La consulta automática de seguimiento y cualquier promesa de plazo siguen pendientes de confirmar con la cuenta real.

## Catálogo administrable e inventario (17 de octubre de 2026)

El panel `/admin.html` tiene seis secciones —Resumen, Pedidos, Productos, Inventario, Envíos y Configuración— y muestra solo cifras reales del servidor. Envíos sigue operándose desde la tarjeta de cada pedido con la integración de Envia; Configuración enlaza a la pantalla privada existente, sin duplicarla.

Los productos se crean, editan, publican, despublican y archivan desde el panel. Cada variante (talla + color) tiene un SKU único garantizado por la base de datos. Despublicar o archivar no borra nada: los pedidos anteriores conservan nombre, SKU y precio del momento de la compra.

El inventario es por variante: `disponible = existencias físicas − reservadas`, con umbral de stock bajo configurable y registro de movimientos con actor, fecha y motivo obligatorio en las entradas y ajustes manuales. El control de stock se activa con el primer conteo real de cada talla; mientras no se configure, la tienda se comporta como antes y no se inventan existencias.

Al crear un pedido el servidor valida variante, precio y stock, y reserva las unidades dentro de una transacción SQLite. Reservar no es cobrar ni descontar: el descuento ocurre una sola vez al marcar el pago, y cancelar libera la reserva. Dos compradores por la última unidad no pueden quedarse ambos con ella. La caducidad de reservas no está implementada y no se inventó un plazo.

La tienda consume el catálogo administrado: solo se ofrecen las tallas con variante activa, las agotadas aparecen deshabilitadas con la leyenda "Agotado" y el precio sale del catálogo. La guía de tallas muestra la disponibilidad real y la bolsa se vuelve a validar en el servidor.

Migraciones versionadas con `PRAGMA user_version`, idempotentes y transaccionales; la ruta de la base de datos no cambia. Detalle de tablas, estados, movimientos, límites y pasos de activación: [OPERACION.md](OPERACION.md#catálogo-administrable-inventario-y-migraciones).

## SQLite y disco persistente en Render

SQLite es la única base de datos, mediante `node:sqlite`. La interfaz asíncrona de `server/database.mjs` conserva catálogo, variantes, inventario, reservas, pedidos y configuración cifrada. Cada transacción usa `BEGIN IMMEDIATE`; las consultas ajenas esperan al commit o rollback. La creación del pedido y la reserva son atómicas, al igual que el pago o cancelación y sus movimientos de inventario.

Localmente se usa `DATABASE_PATH=./data/offcode.sqlite`. En Render debe ser `/var/data/offcode.sqlite`, con disco persistente montado en `/var/data`. El servidor crea el directorio privado si falta y rechaza rutas dentro de `dist/`. En el arranque normal de Render exige la ruta explícita: no elige una base local vacía silenciosamente. Un selector de motor antiguo incompatible se rechaza antes de abrir la base; no se cambia ninguna variable privada desde este repositorio.

Las migraciones SQLite conservan `PRAGMA user_version=1`, crean las estructuras que falten y no duplican productos ni movimientos. Solo si la versión anterior es menor y `products` está vacía se siembra la hoodie, sin existencias configuradas. Un esquema más reciente se rechaza sin modificar tablas. No se borra ni reemplaza una base existente.

Comprobaciones locales: `npm ci`, `npm test`, `npm run check:load`. El servidor existente es **offcode2**, rama **main**, dominio **https://offcode.mx**, según el propietario. El disco y la configuración real no se comprobaron desde esta tarea. Pasos manuales: [OPERACION.md](OPERACION.md#sqlite-y-persistencia-en-render).

## Correo transaccional (17 de octubre de 2026)

Integración opcional con Resend, desactivada por defecto y sin dependencias nuevas. Si falta configuración, la tienda, el checkout, el panel y Envia siguen funcionando igual y el servidor registra que los correos no están habilitados; no se simula ningún envío.

Al recibir una solicitud se avisa al propietario (referencia y resumen mínimo) y se confirma la recepción al comprador si su dirección es válida. Al cambiar de estado se notifican solo transiciones confirmadas: instrucciones de transferencia sin datos bancarios, pago verificado, envío con el rastreo real, entrega y cancelación. Cada mensaje tiene versión HTML y texto plano en español, y nunca incluye CLABE, domicilio completo, teléfono ni datos inventados.

La cola se guarda en `<DATABASE_PATH>.email-outbox/`, fuera de SQLite y excluida de Git. Un hash de pedido, estado y destinatario evita duplicados; los reintentos reutilizan la misma clave de idempotencia; un fallo o timeout queda como resultado incierto y el pedido no se pierde ni se duplica. El panel muestra el estado por correo y permite reintentar cuando es seguro. La clave de Resend nunca llega al navegador, a las respuestas ni a los registros.

Guía completa de variables, verificación del dominio sin alterar los registros MX/SPF/DKIM existentes de Solucionix, configuración en Render y prueba controlada: [OPERACION.md](OPERACION.md#correo-transaccional-resend).

## Movimiento de la tienda (17 de octubre de 2026)

`dist/motion.js` y `dist/motion.css` añaden una entrada de unos 2 segundos, con el monograma original, fotografías y titular escalonados. Se ejecuta una vez por sesión de pestaña, sin bloquear la tienda; se omite en enlaces a secciones y al regresar con desplazamiento restaurado. No hay recursos nuevos de imagen ni dependencias. El pequeño desenfoque inicial se limita al monograma.

Las secciones, galería y fotografías editoriales aparecen con IntersectionObserver y vuelven a animarse al entrar desde arriba o abajo. El contenido base siempre es visible: no necesita una clase JavaScript para mostrarse. Las animaciones nativas son temporales y se cancelan si un control recibe el foco. La portada desplaza sus capas como máximo 4 y 7 px; la foto plana de la prenda se inclina como máximo 3,5° por eje. Solo se actualiza con movimientos del ratón, agrupados por requestAnimationFrame, sin un bucle permanente ni listeners de scroll.

Con movimiento reducido se eliminan estos efectos; con puntero táctil se desactivan parallax, inclinación y el zoom por hover. Los listeners se limpian en pagehide y se reconstruyen al restaurar desde la caché de navegación. El carrito, checkout, API, persistencia y modelo GLB existente conservan su implementación.

Validación y capturas: [qa/motion.md](qa/motion.md). El helper opcional `node tests/preview-motion.mjs`, junto con `npm run preview:shipping`, permite inspeccionar un fotograma de entrada y simular preferencias reducidas, puntero táctil o ausencia de scripts de la tienda en http://127.0.0.1:8014/?qaMode=normal. Solo escucha en loopback, queda fuera de `dist/` y no modifica las preferencias del sistema. No es una prueba en un teléfono físico. Esta etapa es exclusivamente local, sin publicación.

## Tema oscuro editorial (17 de octubre de 2026)

La tienda pasa a un tema negro: fondo `#080808`, secciones alternas `#111111`, superficies elevadas `#181818`, texto principal `#F5F5F5` y secundario `#A6A6A6`, bordes `#303030`. El encabezado usa negro translúcido con desenfoque. Las fotografías de producto (frente, espalda, detalle, miniaturas y ampliación) conservan su fondo blanco para que la silueta se distinga; el monograma estático se invierte por CSS y el modelo GLB usa el acabado `silver` que `dist/logo.js` ya contemplaba.

El cambio de vista de la galería añade una transición breve: la foto anterior se desvanece sobre la nueva una vez decodificada. Vive en `dist/motion.js` como observador del atributo `src` de `#gallery-main`; `dist/app.js` y la lógica comercial no cambian. La bolsa y la ampliación abren y cierran con una transición de opacidad y posición basada en `@starting-style`; en navegadores sin soporte abren al instante, como antes. Navegación, tallas, cantidad, miniaturas y botones ganan estados hover y active discretos. Todo lo anterior respeta el movimiento reducido y los punteros táctiles.

Validación y capturas: [qa/dark-theme.md](qa/dark-theme.md).

## Monograma original

El HTML de Shopify entregado contiene un enlace al modelo original:

https://cdn.shopify.com/3d/models/30593d6cc20d6c12/logo.glb

Se descargó como `dist/assets/offcode-original.glb`, conservando su geometría con volumen. No es texto de una fuente, una moneda ni una tarjeta CSS. `monogram-static.png` es una proyección transparente de la misma geometría, no una aproximación tipográfica.

El visor gira el monograma centrado alrededor del eje vertical, sin órbita ni borde circular. Se usa la velocidad declarada en el HTML de referencia: **60°/s (6 segundos por vuelta)**. Esto reproduce su configuración; no supone una comparación visual cuadro a cuadro con una grabación animada de la referencia. La iluminación es neutral, sin sombra de suelo; el material original recibe rugosidad 0.32 y metalicidad 0.85 para moderar los reflejos.

El botón del encabezado pausa y reanuda el giro. Con `prefers-reduced-motion: reduce` se muestra la silueta estática. Si falla el módulo, WebGL o la carga del modelo, permanece la alternativa estática. El movimiento se detiene al ocultar la pestaña. Si el usuario llega con movimiento reducido, no se descarga el visor 3D ni el GLB; al desactivar esa preferencia se carga el visor.

## Fotografías y video

Se inspeccionó el ZIP `offcode images.zip`, la carpeta `referencias`, ambos HTML descargados y los recursos locales de Shopify. El segundo HTML es una página de error de Chrome, sin contenido útil de diseño. Los HTML se leyeron como texto: no se ejecutaron ni se incorporaron scripts de sesiones, seguimiento, Shopify o pagos.

Recursos empleados:

- Portada frontal: original `820085121_…jpg` del ZIP.
- Portada de espalda: `820024557_…jpg` del ZIP.
- Editorial: `821281917_…jpg` y `833122506_…jpg` del ZIP.
- Frente y espalda de producto: originales Shopify `D297342C-…png` y `D0A32C0B-…png`, exportados como JPEG de alta calidad.
- Detalle: original Shopify `29056067-…jpg`, reducido a un máximo de 1500 px para la web.
- Video: MP4 `AQPQ9PI7…mp4` del ZIP, copiado sin alterar a `campaign.mp4`; poster extraído de su primer fotograma.

El clip se inspeccionó mediante fotogramas distribuidos por su duración y reproducción en Chrome. Es una toma de campaña de **3.53 s, 720 × 960, sin pista de audio**. Se presenta en proporción 3:4, con reproducción por acción del usuario, controles nativos, botón adicional reproducir/pausar, `muted` y `playsinline`. Se pausa al salir de pantalla o al ocultar la pestaña. No hay autoplay de video.

La portada incluye variantes WebP de 640 y 1170 px con selección por ancho de pantalla y respaldo JPEG. La segunda fotografía no se descarga en móvil. Las fotos visibles de la portada cargan de inmediato; las imágenes de producto y editoriales usan carga diferida. Las capturas antiguas permanecen en assets para conservar los recursos previos, pero la página ya no las referencia.

## Render para la campaña

El propietario confirma que el Web Service Node **offcode2**, conectado a **cruz-torres-dev/offcode2**, rama **main**, ya está desplegado y usa **https://offcode.mx**. Esta entrega prepara una actualización local; no crea servicios ni verifica el estado del alojamiento. `render-orders.yaml` sirve de referencia para una instancia con disco; no se ha aplicado desde esta tarea.

Antes de publicar, confirma en el dashboard el disco `/var/data`, `DATABASE_PATH=/var/data/offcode.sqlite` y `PUBLIC_ORIGIN=https://offcode.mx`. Conserva las credenciales y la clave de cifrado existentes. No importes el ejemplo localhost ni cambies la ruta de una base existente sin revisar y respaldar los datos.

Activa **Settings → Edge Caching → All files** en el servicio de pago para que también el modelo GLB y el HTML público puedan servirse desde la CDN. El servidor identifica qué respuestas son públicas: catálogo y recursos sí; API, checkout, administración y errores siempre `no-store`. No configures reglas que fuercen caché de `/api/*`. Valida `CF-Cache-Status` después del despliegue. Esta opción del dashboard no se activa solo por editar el YAML. [Documentación de caché](https://render.com/docs/web-service-caching).

Las imágenes y el MP4 originales permanecen locales, con caché y revalidación ETag. El video solo carga al reproducirlo. Con movimiento reducido no se descarga el visor/modelo 3D. La CDN reduce carga en el servidor, pero el tráfico servido al visitante cuenta en la facturación: [bandwidth de Render](https://render.com/docs/outbound-bandwidth).

Un Static Site sigue siendo viable para presentar la colección mediante CDN; **por sí solo no ejecuta pedidos ni Envia**. El Web Service gratuito duerme tras inactividad y no admite el disco persistente necesario para esta base local. No lo recomiendo para recibir pedidos durante el concierto. [Limitaciones del servicio gratuito](https://render.com/docs/free).

Esta versión utiliza SQLite y una instancia en Render. Un servicio con disco no puede escalar a varias instancias en Render; para ello habría que migrar a una base compartida, sesiones compartidas y coordinación de guías. Las sesiones del panel viven en memoria del proceso, así que **varias instancias no comparten sesión** aunque compartan base. [Escalado de Render](https://render.com/docs/scaling). No hay una cifra garantizada de visitantes: hace falta probar la instancia real, observar CPU/RAM/latencias y revisar los límites de Envia antes del anuncio. No cambies el tamaño ni despliegues durante el pico: los cambios con disco tienen una interrupción breve.

## Verificación actual

**58 pruebas automáticas aprobadas con Node 24.14.0, sin omisiones.** Incluyen pedidos, catálogo administrable, inventario y reservas, VIP archivado/API de datos conservada, FedEx exclusivo, bloqueo de compra duplicada, recuperación tras reinicio, raíz de tienda, caché pública, configuración cifrada, token oculto, cambio de contraseña, invalidación de tarifas, búsqueda de pedidos en todas las páginas, URL inicial automática de Render, esquema completo e idempotente, dos compradores simultáneos por la última unidad, reversión de transacciones, ciclo reserva–cobro–cancelación, rutas privadas, aislamiento de transacciones pausadas y rechazo de motores incompatibles sin filtrar credenciales. No se realizaron pagos ni compras de guías reales.

Prueba de carga local del 17 de octubre de 2026: 600 peticiones al catálogo y recursos con concurrencia 50, 120 solicitudes de pedido con concurrencia 20 y 120 reintentos. Cero respuestas de error y exactamente 120 pedidos únicos guardados. El reporte identifica tiempos y alcance. **Son solicitudes HTTP en loopback, no visitantes ni capacidad certificada de Render.** No incluye tiempos ni límites reales de Envia, CDN, conexión móvil o carga de renderizado 3D en teléfonos.

La revisión visual usa el navegador integrado en escritorio de 1440 px y móviles de 390 y 320 px, sin desplazamiento horizontal. Se comprobaron la raíz sin VIP, menú móvil, galería y ampliación de espalda, dos prendas L con subtotal $3,300 MXN, navegación a checkout y regreso a la tienda, video vertical 720 × 960 silenciado y giro del monograma. Capturas: `qa/tienda-normal-desktop.jpg` y `qa/tienda-normal-mobile.jpg`. No se verificó en teléfono físico, Safari o Firefox.

Para abrir ventas faltan los datos bancarios y de contacto, políticas reales, token de Envia, origen y perfiles medidos del paquete. El propietario debe contar y registrar las existencias por variante; las reservas y descuentos se aplican después según el estado del pedido. La transferencia sigue verificándose manualmente. No se añadió publicidad sobre un artista ni sobre un concierto que no fuera contenido entregado para publicar.

El propietario puede completar esos datos desde `/settings.html`, con su sesión privada y confirmación de contraseña. El token se guarda cifrado en el servidor y no se devuelve al leer los ajustes. Antes configura ADMIN_PASSWORD y SETTINGS_ENCRYPTION_KEY en las variables privadas; respalda la clave original. El panel permite cambiar su contraseña, comprobar el catálogo de Envia y habilitar pedidos cuando los datos están completos. El detalle de configuración, recuperación, límites y pruebas reales pendientes está en `OPERACION.md`. Las políticas publicadas y los datos del propietario no se generan ni se inventan.

Cambios principales de esta etapa: `dist/settings.html`, `dist/settings.js`, navegación/resumen de `dist/admin.*`, estilos móviles en `dist/operations.css`, enlaces configurables del pie en `dist/index.html` y `dist/app.js`, cifrado en `server/owner-settings.mjs`, APIs en `server/server.mjs`, comprobación de cuenta en `server/envia.mjs`, `tests/settings.test.mjs`, `.env.example` y `render-orders.yaml`.

## Revisión antes de publicar

La entrega incluye un commit local con el mensaje `Use SQLite with persistent Render storage`. No ejecuta push ni despliegue. Revisa `git status`, `git show --stat HEAD` y `git remote -v` antes de decidir publicarlo; el remoto esperado es `https://github.com/cruz-torres-dev/offcode2.git`.

Un push a main puede activar el despliegue automático del servicio existente. Verifica primero las comprobaciones de almacenamiento descritas en OPERACION.md. No subas `.env`, claves, datos bancarios completados, bases SQLite/WAL/SHM, journals, exportaciones, TECH PACK confidencial ni ZIP de despliegue.
