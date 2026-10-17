# OFFCODE — LA AFRO × OFFCODE

Tienda normal para **cruz-torres-dev/offcode2**. La raíz `/` e `index.html` muestran directamente campaña, monograma Of 3D original, galería, producto, tallas, cantidades y bolsa. Precio de referencia: **$1,650 MXN**, anterior **$2,099 MXN**; tallas S/M/L/XL.

La landing VIP se retiró del sitio publicado. Sus fuentes están en `archive/vip/`, fuera de `dist/`. No se eliminaron registros existentes de la base. `/tienda.html` y `/teaser.html` redirigen a la tienda y conservan parámetros y anclas. La compra no exige registro VIP ni contraseña; `/admin.html` sigue protegido.

**Las ventas siguen desactivadas hasta configurar los datos reales del propietario.** La tienda estática permite probar galería y bolsa; los pedidos persistentes y la integración Envia requieren el servidor Node. Pagos exclusivamente por transferencia, verificados manualmente. FedEx es la única paquetería.

## Probar localmente

- Presentación: `python -m http.server 8000 --directory dist`; abrir http://localhost:8000.
- Servidor: copiar `.env.example` a `.env`, configurar la contraseña privada y ejecutar `npm start`. Node.js **24.14.x**, sin instalar paquetes ni compilar. SQLite viene incluido y emite un aviso experimental.
- Flujo ficticio completo: `npm run preview:shipping`; abrir http://127.0.0.1:8013. Contraseña del panel de esta vista: **solo-pruebas-fedex-ficticias**. Datos en memoria, sin llamadas a Envia ni guías reales. Detener con Ctrl+C.
- Pruebas: `npm test`.
- Ejercicio de carga exclusivamente local: `npm run check:load`; reporte en `qa/load-local.json`.

Sigue [OPERACION.md](OPERACION.md) antes de habilitar ventas. El propietario puede configurar ENVIA_TOKEN directamente en las variables privadas del hosting; no necesita compartirlo por chat ni subirlo al repositorio.

## Archivos principales

- `dist/index.html`, `styles.css`, `app.js`, `logo.js`: tienda, campaña, galería, bolsa y monograma.
- `dist/checkout.html` / `checkout.js`: dirección, consentimiento, cotización FedEx y solicitud.
- `dist/admin.html` / `admin.js`: pedidos, transferencias, compra y conciliación de guías.
- `server/server.mjs`: API, sesiones y persistencia SQLite.
- `server/envia.mjs`: estados, cotizaciones y guías FedEx mediante Envia.
- `server/http-policy.mjs`: caché pública y reconocimiento del cliente detrás de Render.
- `tests/`: integración, acceso, importes, estados, idempotencia, caché y prueba local de carga.
- `.env.example`, `render.yaml`, `render-orders.yaml`: configuración local, estática y alternativa Node.
- `archive/vip/`: respaldo de la landing anterior; no se publica.
- `qa/`: capturas e informes de pruebas, fuera del sitio publicado.

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

El plan de entrada elegido es el Web Service **0.5c-512mb (0.5 CPU / 512 MB RAM)** y un disco persistente de 1 GB. Está propuesto en `render-orders.yaml`; **no se ha contratado ni desplegado**. Referencia consultada el 16 de octubre de 2026: $7 USD/mes de cómputo y $0.25 USD/mes por 1 GB de disco ($7.25 de base), más impuestos y tráfico adicional si aplica. El dominio ya pertenece al propietario. El plan `1c-2g` de $25 es una alternativa si las mediciones indican que hace falta más capacidad. Revisa [precios de Render](https://render.com/pricing) antes de contratar. El workspace puede permanecer en Hobby sin cuota; su plan es distinto del tamaño del servidor.

Para el primer despliegue deja PUBLIC_ORIGIN sin definir: en Render el servidor usa su RENDER_EXTERNAL_URL HTTPS automática. Al verificar y conectar el dominio propio, define PUBLIC_ORIGIN con ese origen exacto, sin barra final, y utiliza esa dirección para tienda y panel. No importes la URL localhost de `.env.example` en producción.

Activa **Settings → Edge Caching → All files** en el servicio de pago para que también el modelo GLB y el HTML público puedan servirse desde la CDN. El servidor identifica qué respuestas son públicas: catálogo y recursos sí; API, checkout, administración y errores siempre `no-store`. No configures reglas que fuercen caché de `/api/*`. Valida `CF-Cache-Status` después del despliegue. Esta opción del dashboard no se activa solo por editar el YAML. [Documentación de caché](https://render.com/docs/web-service-caching).

Las imágenes y el MP4 originales permanecen locales, con caché y revalidación ETag. El video solo carga al reproducirlo. Con movimiento reducido no se descarga el visor/modelo 3D. La CDN reduce carga en el servidor, pero el tráfico servido al visitante cuenta en la facturación: [bandwidth de Render](https://render.com/docs/outbound-bandwidth).

Un Static Site sigue siendo viable para presentar la colección mediante CDN; **por sí solo no ejecuta pedidos ni Envia**. El Web Service gratuito duerme tras inactividad y no admite el disco persistente necesario para esta base local. No lo recomiendo para recibir pedidos durante el concierto. [Limitaciones del servicio gratuito](https://render.com/docs/free).

Esta versión utiliza SQLite y una instancia. Un servicio con disco no puede escalar a varias instancias en Render; para ello habría que migrar a una base compartida, sesiones compartidas y coordinación de guías. [Escalado de Render](https://render.com/docs/scaling). No hay una cifra garantizada de visitantes: hace falta probar la instancia real, observar CPU/RAM/latencias y revisar los límites de Envia antes del anuncio. No cambies el tamaño ni despliegues durante el pico: los cambios con disco tienen una interrupción breve.

## Verificación actual

**21 pruebas automáticas aprobadas.** Incluyen pedidos, VIP archivado/API de datos conservada, FedEx exclusivo, bloqueo de compra duplicada, recuperación tras reinicio, raíz de tienda, caché pública, configuración cifrada, token oculto, cambio de contraseña, invalidación de tarifas, búsqueda de pedidos en todas las páginas y URL inicial automática de Render. No se realizaron pagos ni compras de guías reales.

Prueba de carga local del 16 de octubre de 2026: 600 peticiones al catálogo y recursos con concurrencia 50, 120 solicitudes de pedido con concurrencia 20 y 120 reintentos. Cero respuestas de error y exactamente 120 pedidos únicos guardados. El reporte identifica tiempos y alcance. **Son solicitudes HTTP en loopback, no visitantes ni capacidad certificada de Render.** No incluye tiempos ni límites reales de Envia, CDN, conexión móvil o carga de renderizado 3D en teléfonos.

La revisión visual usa el navegador integrado en escritorio de 1440 px y móviles de 390 y 320 px, sin desplazamiento horizontal. Se comprobaron la raíz sin VIP, menú móvil, galería y ampliación de espalda, dos prendas L con subtotal $3,300 MXN, navegación a checkout y regreso a la tienda, video vertical 720 × 960 silenciado y giro del monograma. Capturas: `qa/tienda-normal-desktop.jpg` y `qa/tienda-normal-mobile.jpg`. No se verificó en teléfono físico, Safari o Firefox.

Para abrir ventas faltan los datos bancarios y de contacto, políticas reales, token de Envia, origen y perfiles medidos del paquete. La disponibilidad de tallas y la transferencia siguen siendo verificaciones del propietario; no hay inventario automático. No se añadió publicidad sobre un artista ni sobre un concierto que no fuera contenido entregado para publicar.

El propietario puede completar esos datos desde `/settings.html`, con su sesión privada y confirmación de contraseña. El token se guarda cifrado en el servidor y no se devuelve al leer los ajustes. Antes configura ADMIN_PASSWORD y SETTINGS_ENCRYPTION_KEY en las variables privadas; respalda la clave original. El panel permite cambiar su contraseña, comprobar el catálogo de Envia y habilitar pedidos cuando los datos están completos. El detalle de configuración, recuperación, límites y pruebas reales pendientes está en `OPERACION.md`. Las políticas publicadas y los datos del propietario no se generan ni se inventan.

Cambios principales de esta etapa: `dist/settings.html`, `dist/settings.js`, navegación/resumen de `dist/admin.*`, estilos móviles en `dist/operations.css`, enlaces configurables del pie en `dist/index.html` y `dist/app.js`, cifrado en `server/owner-settings.mjs`, APIs en `server/server.mjs`, comprobación de cuenta en `server/envia.mjs`, `tests/settings.test.mjs`, `.env.example` y `render-orders.yaml`.

## Subir a offcode2 cuando lo decidas

Esta entrega no ejecuta commit, push ni despliegue. Revisa `git status`, `git diff --stat` y `git remote -v` antes de subir. El remoto existente es `https://github.com/cruz-torres-dev/offcode2.git`.

```powershell
git add dist server tests archive package.json .gitignore .env.example render.yaml render-orders.yaml README.md OPERACION.md qa
git commit -m "Restaura tienda OFFCODE e integra pedidos y FedEx con Envia"
git push origin HEAD
```

Si Render tiene despliegue automático sobre esa rama, el push puede publicar la versión. Revisa primero su configuración. No subas `.env`, tokens, datos bancarios completados, bases SQLite, exportaciones o datos de clientes.
