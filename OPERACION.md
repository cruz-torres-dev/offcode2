# OFFCODE — Tienda, transferencias y FedEx mediante Envia

## Alcance de esta versión

La tienda normal está en `/` e `/index.html`, con campaña, monograma Of 3D original, colección, galería, video y bolsa. `/tienda.html` y `/teaser.html` redirigen a la tienda conservando anclas y parámetros. La landing y el panel VIP se archivaron fuera de `dist/`, en `archive/vip/`. Se conservan las APIs privadas y los registros existentes para gestión de datos; deja WAITLIST_ENABLED=false. No se exige contraseña ni lista VIP para ver o solicitar el producto.

La administración de pedidos en `/admin.html` sigue requiriendo contraseña. Las ventas y Envia permanecen desactivados hasta configurar los datos reales. Los pagos son exclusivamente por transferencia; no se añadieron tarjetas.

El flujo implementado es:

1. El cliente elige talla y cantidad en la colección.
2. Si la recepción de pedidos está habilitada, completa contacto y dirección en México.
3. Con Envia configurado, el cliente consulta servicios exclusivamente FedEx, elige una tarifa y ve prendas, envío y total. Antes de consultar acepta compartir datos de entrega según el aviso. El servidor guarda una solicitud con referencia única y recalcula $1,650 MXN por prenda; no acepta precios ni servicios inventados desde el navegador. Un reintento con la misma referencia no duplica la solicitud.
4. El propietario entra al panel y verifica existencia de las tallas antes de confirmar el total. Puede volver a cotizar FedEx. Sin Envia configurado captura el costo de una guía FedEx cotizada fuera del sistema.
5. El panel prepara el total y los datos de transferencia para compartir por WhatsApp. El propietario revisa y envía el mensaje; no se envía automáticamente.
6. El propietario comprueba el abono en su banco y marca el pago verificado. Un comprobante o una captura no se procesa como confirmación automática.
7. Tras verificar la transferencia, el propietario consulta una tarifa vigente del servicio acordado y autoriza comprar la guía con saldo de Envia. La guía PDF y el rastreo aparecen en su panel. Comprar la guía no marca el pedido como enviado: debe confirmar que entregó físicamente el paquete a FedEx. Sin integración configurada registra una guía FedEx comprada por separado.
8. Tras confirmar la entrega, marca el pedido como entregado. El historial conserva los cambios de estado.

**Solo FedEx, mediante la API de Envia.** La cuenta todavía requiere credenciales y datos reales del propietario. No se compra una guía al recibir un pedido ni por marcar el pago; la compra requiere una acción separada. No se reserva inventario ni se descuentan existencias de un catálogo; la disponibilidad se confirma por pedido.

## Configurar Envia y FedEx

La vía recomendada es `/settings.html`, descrita abajo: el propietario puede introducir el token él mismo después, sin compartirlo contigo. Las variables siguientes son una alternativa de configuración inicial; después del primer guardado en el panel, prevalece la configuración cifrada de la base.

1. El propietario obtiene un token de **sandbox** desde su cuenta de Envia. Configúralo como ENVIA_TOKEN en `.env` local o como variable privada de Render. No lo pegues en el chat, HTML, Git ni capturas. El código no envía el token al navegador.
2. Conserva ENVIA_ENVIRONMENT=sandbox. Completa ENVIA_ORIGIN_JSON en una sola línea con `name`, `phone`, `email`, `street`, `number`, `district`, `city`, `state`, `country` y `postalCode` reales. `country` debe ser MX. Obtén el código de estado de dos caracteres desde [Estados de Envia](https://docs.envia.com/reference/states-by-country); no lo deduzcas de los códigos ISO. El checkout carga este catálogo desde el servidor.
3. Pesa y mide el paquete FINAL con la ropa y el empaque. ENVIA_PACKAGES_JSON relaciona la cantidad TOTAL de prendas con UN paquete: `{"1":{"weight":0.75,"dimensions":{"length":30,"width":20,"height":10}}}` es únicamente un ejemplo FICTICIO de formato, no una medida de OFFCODE. Sustituye los números por los medidos. Peso en KG; dimensiones en CM. Agrega perfiles separados para 2, 3, etc. prendas. Una cantidad sin perfil se bloquea para confirmar el empaque, sin inventar peso o costo. Esta versión no genera varios bultos en un mismo pedido.
4. ENVIA_PRINT_SIZE admite PAPER_4X6 (predeterminado), STOCK_4X6, PAPER_7X4.75 o PAPER_LETTER. El formato es PDF; verifica el tamaño admitido por el servicio FedEx y tu impresora en sandbox.
5. Activa ENVIA_ENABLED=true y reinicia el servidor. También necesitas habilitar pedidos con su configuración bancaria y políticas. En local, sandbox muestra un aviso de PRUEBAS. **No recibas transferencias reales con tarifas simuladas.**
6. Prueba dirección, cantidades, servicios FedEx, costo y guía de prueba. Las cotizaciones duran 15 minutos y quedan ligadas a los datos y artículos originales. Cambiar dirección o bolsa requiere cotizar de nuevo. No se muestran otros transportistas aunque aparezcan en una respuesta.
7. Cuando la cuenta esté validada, configura su token de **producción**, ENVIA_ENVIRONMENT=production y revisa tarifas reales y saldo. El servidor rechaza abrir ventas en producción con Envia en sandbox. Las tarifas dependen de cuenta, ruta, servicio y empaque; la integración no garantiza cobertura ni precios universales.

El total del cliente utiliza la cotización guardada; el panel vuelve a consultar antes de comprar la guía porque el costo puede cambiar mientras llega la transferencia. El propietario revisa y acepta el cargo actual. Una diferencia no cambia silenciosamente el total del cliente ni genera una transferencia adicional. El cargo reportado por Envia queda visible en el panel. Peso, volumen o condiciones reales pueden ocasionar ajustes del proveedor: revisa sus condiciones y mide correctamente.

La guía se abre desde un enlace HTTPS privado mostrado después de iniciar sesión. No se envía automáticamente por correo. El enlace de rastreo y el PDF contienen datos del envío: no los publiques. No se programan recolecciones, no se comprueba automáticamente la entrega, no se conectan tarjetas y no se cancelan guías desde esta versión. Coordina la entrega o recolección con FedEx/Envia.

### Reintentos y conciliación de guías

Antes de contactar Envia para comprar una guía, el servidor registra un bloqueo persistente por pedido. Repetir el clic o reiniciar el proceso no compra otra guía. Si falla la red, Envia devuelve un error o el proceso se interrumpe, el resultado queda **sin confirmar**, porque pudo existir un cargo aunque no llegara la respuesta.

Revisa la referencia OFFCODE directamente en tu cuenta de Envia. Si existe la guía, usa “Registrar la guía que verifiqué en Envia” para guardar su identificador, rastreo FedEx y enlace PDF. Si Envia confirma que NO existe guía ni cargo pendiente, usa la opción separada, escribe la referencia y confirma esa revisión para habilitar una nueva compra. Esta liberación queda en el historial; no compra nada por sí misma. No la uses solo porque apareció un error en pantalla.

Un pedido con guía comprada no puede cancelarse desde el panel; gestiona primero con Envia y el cliente la guía, el saldo y cualquier devolución. Ningún cambio de estado devuelve dinero. En producción no se acepta marcar enviado con una guía de sandbox.

El aviso de privacidad y las condiciones reales deben explicar el uso de datos de entrega por Envia/FedEx antes de habilitar la cotización. Referencias oficiales: [cotización](https://docs.envia.com/reference/get-shipping-rates), [crear guía](https://docs.envia.com/reference/create-shipping-label), [flujo y entornos](https://docs.envia.com/docs/envia-shipping-api-introduction).

## Ficha de la prenda

La ficha pública usa solo datos comerciales confirmados por la marca: **hoodie oversize**, color **negro**, **100% algodón**, **420 g/m²** y temporada **SS 2026**. Se muestran en "Ficha de la prenda", dentro de la sección del producto, y salen de `server/catalog.mjs`, que también alimenta `/api/config` (`product`).

El TECH PACK es confidencial. **No se copió al repositorio, a `dist/`, a Git ni al despliegue**; solo se extrajeron los datos comerciales anteriores. No se publican cantidades de inventario, costos, ubicaciones de estampado, medidas de aplicación ni instrucciones de confección.

### Sin guía de tallas ni promesas de plazo

La marca confirmó que **no entregará la tabla de medidas de la prenda ni un tiempo de preparación**, así que ya no se publican: la tienda no muestra guía de tallas, tabla de centímetros ni promesa de preparación o entrega. Tampoco se inventan medidas ni tallas corporales.

- **Seis tallas contempladas** (XS, S, M, L, XL, XXL); el selector de la tienda solo ofrece las habilitadas para venta.
- **Habilitadas para venta hoy: S, M, L, XL.** XS y XXL no tienen variante, no son seleccionables y el servidor las rechaza con 400.

Configuración, sin tocar HTML ni CSS:

- Habilitar una talla: crear o reactivar su variante en `Productos` del panel. El selector, la bolsa, el checkout y la validación del servidor se actualizan solos. `server/catalog.mjs` solo declara las seis tallas contempladas.
- El tiempo de tránsito lo devuelve únicamente la cotización real de FedEx; no se completa a mano ni se promete una fecha de entrega.

Si la marca confirma medidas o plazos más adelante, habría que añadirlos como datos nuevos y verificados; hoy la tienda (y su API) no incluyen campos para ellos.

### Envío exclusivamente FedEx

La integración existente ya trabaja solo con FedEx mediante Envia: la cotización envía `shipment.carrier = "fedex"`, descarta cualquier servicio de otro transportista, ignora monedas distintas de MXN y rechaza importes inválidos. El comprador elige el servicio antes de confirmar y el servidor vuelve a validar la cotización guardada; el importe que envíe el navegador nunca se usa.

Cada pedido guarda `shipping: { provider, carrier, service, description, quotedCents, deliveryEstimate, environment, quotedAt }`. `deliveryEstimate` es la estimación que devuelve FedEx para esa cotización y puede venir vacía: no se completa a mano. El número de rastreo se guarda solo cuando Envia genera realmente una guía, y marcar "enviado" exige confirmar la entrega física del paquete.

Pendiente para operar FedEx de verdad:

1. `ENVIA_TOKEN` de la cuenta real, primero en sandbox.
2. `ENVIA_ORIGIN_JSON` con el domicilio de origen y el código de estado de Envia.
3. `ENVIA_PACKAGES_JSON` con peso y medidas **medidos** por cantidad de prendas.
4. Validar cobertura, tarifas y una guía de prueba en sandbox.

La **consulta automática de seguimiento no está implementada**: esta integración no consulta el estado de entrega, y no se añadió un endpoint sin verificarlo antes con la cuenta. El rastreo se registra en el panel y se consulta en el sitio de FedEx. No se promete ningún plazo de entrega: el checkout muestra únicamente lo que devuelve la cotización, y tampoco se promete un tiempo de preparación.

## Catálogo administrable, inventario y migraciones

El panel `/admin.html` administra el catálogo y el inventario reales. La tienda deja de depender de tallas escritas a mano: el selector, la bolsa y el checkout se alimentan de la base de datos.

### Productos y variantes

- Tablas: `products`, `product_images`, `variants` e `inventory`. Cada variante es una combinación de **talla + color** con su propio SKU.
- Estados del producto: `draft` (borrador), `published` (visible en la tienda) y `archived` (fuera de la tienda, sin borrar nada). Transiciones válidas: borrador ⇄ publicado, cualquiera → archivado, archivado → borrador. Cualquier otro cambio responde 409.
- Un producto publicado necesita al menos una variante activa; el servidor lo exige.
- **El SKU es único por variante a nivel de base de datos** (`UNIQUE`), no solo en la interfaz. Un duplicado responde 409 con el SKU en el mensaje.
- Despublicar o archivar **no altera los pedidos anteriores**: cada pedido guarda su propia copia de nombre, talla, SKU y precio del momento de la compra.
- Fotografías: se registran como rutas internas (`assets/...`) con texto alternativo. El servidor rechaza rutas con `..`, rutas absolutas y URLs externas. No hay subida de archivos; si algún día se añade, debe validar tipo, tamaño y nombre antes de escribir en disco.
- El TECH PACK sigue siendo confidencial: no se copió a `dist/`, a Git ni al despliegue, y el inventario **no se sembró** con sus cantidades.

La prenda publicada hoy es la hoodie oversize negra (S, M, L, XL). XS y XXL existen como tallas contempladas pero no tienen variante: la tienda no las ofrece.

### Inventario por variante

- `disponible = existencias físicas − unidades reservadas`, nunca negativo (`MAX(0, …)` en SQLite).
- Cada variante tiene su **umbral de stock bajo**, configurable desde el panel. El resumen cuenta las variantes que están en o por debajo del umbral.
- **El control de stock se activa por variante con la primera entrada.** Mientras una variante siga sin configurar, `disponible` es `null` y los pedidos se aceptan sin reservar nada, igual que antes de esta versión: no se inventan existencias.
- Movimientos registrados, siempre con actor y fecha: `entry` (entrada), `adjustment` (ajuste, puede restar), `correction` (corrección administrativa), `reserve`, `sale` y `release`. Las entradas y ajustes manuales **exigen motivo** y no pueden dejar el inventario en negativo.
- Todo el inventario se modifica **solo en el servidor**. El panel no calcula cantidades: envía el movimiento y vuelve a leer.

### Reserva, pago y deducción

1. Al crear el pedido, el servidor valida variante, precio y stock, y **reserva** las unidades dentro de una transacción: `BEGIN IMMEDIATE` en SQLite con un ejecutor propio; las peticiones ajenas esperan al commit o rollback. Dos solicitudes simultáneas por la última unidad: una recibe 201 y la otra 409.
2. **Reservar no es cobrar ni descontar.** Las unidades reservadas siguen siendo físicas.
3. Al marcar `paid`, la reserva se convierte en venta **una sola vez** y ahí se descuentan las unidades físicas.
4. Al cancelar, se **libera** la reserva. Cancelar después de pagar no devuelve stock automáticamente: la devolución es un movimiento manual con motivo.
5. Estados no válidos se rechazan con 409 y las transiciones repetidas no mueven el stock dos veces.

**La caducidad de reservas no está implementada.** No se inventó un plazo: una solicitud sin pagar mantiene sus unidades reservadas hasta que el propietario la cancele o la marque pagada. Las reservas pendientes se ven en `Inventario` (columna "Reservado") y en los movimientos de cada variante; el resumen muestra el total de unidades reservadas. Si se define un plazo comercial, debe implementarse como una tarea aparte con su propia decisión de negocio.

### Migraciones

- Versionadas con `PRAGMA user_version` y `SCHEMA_VERSION = 2`. El esquema SQLite vive en `server/schema.mjs` y la migración en `server/db.mjs`.
- Idempotentes: arrancar dos veces no duplica productos, variantes ni movimientos. La prueba correspondiente crea el esquema, lo vuelve a migrar y comprueba que los pedidos y productos existentes siguen intactos.
- DDL, siembra y cambio de versión comparten una transacción SQLite. Una versión futura se rechaza sin alterar tablas. Solo se siembra al actualizar desde la versión 0 si `products` está vacía y la siembra está habilitada; nunca se inventan existencias.
- **La ruta de la base de datos no cambió** (`DATABASE_PATH` o `./data/offcode.sqlite`). Las claves son estables: `PRD-…`, `VAR-…`, `MOV-…` y los pedidos conservan `OF-…`.
- Integridad referencial activada (`PRAGMA foreign_keys=ON`) y restricciones `CHECK` para cantidades y estados.

### Pasos manuales para activar el sistema en producción

1. **Respalda** el archivo de `DATABASE_PATH` (y su carpeta `.email-outbox/`) antes de desplegar.
2. Despliega. Al arrancar, la migración se aplica sola y no borra datos.
3. Entra a `/admin.html` → **Inventario** y registra una **entrada con el conteo físico real** de cada variante. Ese primer movimiento activa el control de stock de esa talla.
4. Ajusta el **umbral de stock bajo** por variante según tu operación.
5. En **Productos**, publica o despublica lo que corresponda y confirma que los SKU son los definitivos.
6. Revisa la tienda: las tallas agotadas aparecen deshabilitadas con la leyenda "Agotado" y no se pueden añadir a la bolsa.
7. Repite el conteo cada vez que haya devoluciones o mermas; queda registrado con fecha y motivo.

## SQLite y persistencia en Render

El único motor es `node:sqlite`, integrado en **Node 24.14.0**. La API de acceso sigue siendo asíncrona para conservar las funciones existentes, con un ejecutor por transacción y cola para las operaciones ajenas. No hay dependencias de otro motor, ORM ni scripts de copia entre motores.

Según el propietario, la aplicación ya está desplegada en el **Web Service Node offcode2**, repositorio **cruz-torres-dev/offcode2**, rama **main**, dominio **https://offcode.mx**. Esto identifica el servicio que debe revisarse; **esta tarea no comprobó el disco, las variables ni la conexión de producción**.

Comprobaciones manuales del propietario antes de publicar el commit:

1. Revisar el servicio **existente** `offcode2`; no crear otro servicio ni aplicar un blueprint para reemplazarlo. Confirmar una instancia Node y un disco persistente montado en `/var/data`.
2. Confirmar `DATABASE_PATH=/var/data/offcode.sqlite`. Localmente el valor predeterminado sigue siendo `./data/offcode.sqlite`. En Render el arranque normal rechaza una ruta ausente o diferente; no selecciona otra base silenciosamente. Si hay datos en otra ruta, detenerse y revisar el respaldo y su traslado manual antes de cambiar la variable. El código no importa datos de otro servicio ni mueve archivos.
3. Con la aplicación detenida, respaldar la base, los archivos `-wal`/`-shm` si existen y el journal `<DATABASE_PATH>.email-outbox/`. Conservarlos juntos y fuera de Git; no borrar ni truncar archivos para forzar el arranque. Si existe `EMAIL_OUTBOX_DIR`, conservar ese journal también y confirmar que su ruta está en el disco persistente; no iniciar uno nuevo perdiendo la deduplicación.
4. Mantener **la misma** `SETTINGS_ENCRYPTION_KEY`, la contraseña y las variables privadas de Envia y Resend. El repositorio no modifica el dashboard. Eliminar manualmente cualquier selector de motor incompatible solo después de confirmar la ruta SQLite; `DB_DRIVER=sqlite` también se acepta por compatibilidad. Las demás variables de conexión antiguas no son utilizadas por la aplicación.
5. Revisar `NODE_VERSION=24.14.0`, `NODE_ENV=production`, `HOST=0.0.0.0`, el `PORT` asignado por Render y `PUBLIC_ORIGIN=https://offcode.mx`. Mantener los pedidos desactivados hasta validar los datos y existencias reales. Si el panel ya tiene configuración guardada, su interruptor de pedidos prevalece sobre la variable inicial; no cambiar claves para eludirlo.
6. Instalar/validar con `npm ci`, iniciar con `npm start`; no hay compilación. Las migraciones se aplican al arrancar en la base **seleccionada**, sin borrar datos. No ejecutarlas contra producción durante esta tarea.
7. Tras decidir publicar y revisar el despliegue, comprobar `/api/config`, acceso privado, catálogo, conteos de inventario/reservas y pedidos existentes. Reiniciar en una ventana de mantenimiento y confirmar que persisten. La inicialización no crea pedidos ficticios ni configura existencias.

No se deben reemplazar las credenciales existentes por valores de `.env.example`. El código crea únicamente el directorio y las estructuras que faltan, rechaza la ubicación pública `dist/` y no habilita ventas automáticamente. El propietario indica que aún no hay pedidos reales, pero eso no autoriza borrar la base.

## Correo transaccional (Resend)

El envío de correos es **opcional y está desactivado por defecto**. Sin configuración, la tienda, el checkout, el panel y Envia funcionan exactamente igual que antes: la solicitud se guarda, los estados cambian y no se intenta ningún envío. Al iniciar, el servidor registra `{"component":"email","code":"disabled"}` (o `configuration_missing` si faltan valores). No existe ningún modo que simule envíos correctos.

El código vive en `server/email.mjs` (transporte y plantillas) y `server/email-outbox.mjs` (cola durable). No hay dependencias nuevas: usa `fetch` de Node 24.

### Variables privadas

- `EMAIL_ENABLED`: `false` por defecto. Solo el valor exacto `true` habilita el envío; es independiente de `ORDERS_ENABLED`. Añadir la clave no activa nada por sí solo.
- `RESEND_API_KEY`: clave privada de Resend. Solo la usa el proceso del servidor.
- `EMAIL_FROM`: **una sola** dirección del dominio verificado en Resend (remitente).
- `ORDER_NOTIFICATION_EMAIL`: buzón real del propietario que recibirá los avisos de pedido.

La clave nunca aparece en `dist/`, en respuestas de la API, en el journal ni en los registros. `.env.example` solo contiene valores vacíos; `.env` sigue excluido por `.gitignore`.

### Qué correos se envían

Al recibir una solicitud de pedido:

- **Propietario**: aviso de nuevo pedido con la referencia y un resumen mínimo (tallas y cantidades). No incluye nombre, teléfono, domicilio ni notas del cliente.
- **Comprador**: confirmación de que la solicitud fue recibida, solo si su dirección es válida. Aclara que recibir la solicitud no confirma disponibilidad, pago ni envío.

Al cambiar el estado, únicamente cuando el servidor acepta una transición válida:

- `awaiting_transfer`: instrucciones de transferencia con el total confirmado y la referencia. **No incluye CLABE ni datos bancarios**: remite al canal de atención acordado.
- `paid`: pago verificado, sin afirmar que el paquete ya salió.
- `shipped`: pedido enviado con el rastreo real registrado en el panel. Si el pedido no tiene rastreo, el correo se omite en lugar de inventarlo.
- `delivered`: entrega confirmada.
- `cancelled`: cancelación confirmada, sin prometer ni ejecutar un reembolso.

Las repeticiones y las transiciones inválidas responden 409 y no generan correo. Cada mensaje tiene versión HTML (identidad oscura y editorial) y alternativa de texto plano, en español. Nunca se incluyen: datos bancarios, domicilio completo, teléfono, notas, importes sin confirmar, fechas de entrega ni números de guía inventados. Un estado histórico que ya fue superado se marca `superseded` y no se envía.

### Fiabilidad, duplicados y reintentos

El registro vive en un journal aparte junto a la base: `<DATABASE_PATH>.email-outbox/` (por ejemplo `data/offcode.sqlite.email-outbox/`), o en `EMAIL_OUTBOX_DIR` si ya se define (debe estar también en almacenamiento persistente), excluido de Git. No cambia el esquema ni las tablas de pedidos y guías.

- Cada notificación se identifica con un hash de referencia + estado + destinatario. Repetir la solicitud, recargar el panel o reiniciar el proceso no duplica el envío.
- El trabajo se escribe en disco **antes** de llamar a Resend. El reintento reutiliza la misma `Idempotency-Key` y el mismo cuerpo, así que el proveedor no crea un segundo mensaje.
- La ventana de idempotencia de Resend es de 24 horas; la aplicación la corta en 23 por margen. Pasado ese plazo el trabajo pasa a `review` y no se reintenta automáticamente.
- Estados posibles: `pending`, `sending`, `accepted`, `failed`, `uncertain`, `review`, `skipped`, `superseded`. **`accepted` significa que Resend aceptó el mensaje, no que llegó al buzón.**
- Timeout de 5 segundos y una petición por ciclo: el proceso de compra no espera al proveedor. Un pedido responde 201 aunque el correo falle.
- Error HTTP, timeout, excepción de red o respuesta sin identificador válido quedan como `failed` o `uncertain`, nunca como enviados. El pedido no se pierde ni se duplica y el comprador no necesita reenviarlo.
- Un trabajo que quedó en `sending` al arrancar (proceso interrumpido) pasa a `uncertain` y se reintenta con la misma clave y el mismo contenido.
- Reintento manual: en el panel, bloque "Correos transaccionales" → "Reintentar con la misma referencia". Equivale a `POST /api/admin/email-notifications/:id/retry`, exige sesión, mismo origen y solo se permite dentro de la ventana y si el envío no fue aceptado. La consulta de estado es `GET /api/admin/email-notifications?orderId=...`, privada y con `no-store`.
- El journal guarda solo datos de plantilla (referencia, tallas, cantidades, total confirmado, rastreo). El cuerpo completo se descarta al aceptarse y la clave API nunca se escribe.

### Verificar el dominio en Resend sin tocar el correo actual

`offcode.mx` ya tiene buzones en Solucionix y su zona publica: MX `offcode.mx.`, SPF `v=spf1 a mx ip4:192.145.235.74 ~all`, DKIM en `default._domainkey` y DMARC `v=DMARC1; p=none`. **No sobrescribas ni elimines esos registros**: el correo existente dejaría de funcionar.

1. Verifica un **subdominio**, no la raíz. Resend lo recomienda para separar reputación; además mantiene sus registros en nombres distintos de los actuales. El propietario elige el nombre (por ejemplo uno dedicado a envíos); no se ha creado ni verificado ninguno.
2. En Resend → Domains → Add Domain escribe ese subdominio y elige la región más cercana a los destinatarios.
3. Abre la pestaña **Records** y copia **exactamente** lo que genera Resend: TXT de SPF, TXT de DKIM (con su nombre propio, del tipo `resend._domainkey.<subdominio>`) y el MX o CNAME del Return-Path, que por defecto es `send.<subdominio>`. No adaptes ni inventes valores.
4. Añádelos en el panel DNS de Solucionix. No borres `default._domainkey`, no cambies el MX `offcode.mx.` ni el TXT SPF del `@`. Los registros nuevos del subdominio no compiten con ellos.
5. **SPF**: solo puede existir un TXT SPF por nombre. Mientras el envío salga del subdominio, el SPF del dominio raíz no se toca. Si en el futuro se quisiera enviar desde la raíz, no se debe crear un segundo registro: hay que integrar el mecanismo de Resend dentro del registro existente, antes de `~all`, conservando `a mx ip4:192.145.235.74` y sin superar 10 búsquedas DNS. Dos TXT SPF en el mismo nombre hacen fallar la autenticación.
6. **DMARC**: la política del dominio raíz (`p=none`) cubre también los subdominios, así que no hace falta otro registro. No la subas a `quarantine` o `reject` sin revisar antes los informes: afectaría igualmente al correo existente de Solucionix.
7. Confirma la propagación con la herramienta de Resend ([dns.email](https://dns.email/)) o `dig` antes de dar el dominio por verificado. Suele tardar minutos y puede llegar a 72 horas; usa "Restart verification" solo después de comprobar los registros.
8. `EMAIL_FROM` debe ser una dirección de ese subdominio ya verificado; el propietario decide el buzón y no se ha creado ninguno. `ORDER_NOTIFICATION_EMAIL` debe ser un buzón que realmente lea: puede seguir siendo el actual de Solucionix, porque solo recibe.

### Configurar en Render

1. Web Service → Environment: añade las cuatro variables como secretos. No las escribas en `render.yaml` ni en el repositorio; `.env.example` solo lleva nombres con valores vacíos.
2. Despliega primero con `EMAIL_ENABLED=false` y el resto vacío: el servicio arranca sin enviar nada. Después de verificar el dominio, carga la clave y las direcciones y cambia a `true`. Guardar variables reinicia el servicio.
3. Revisa los Logs al arrancar: debe aparecer `{"component":"email","code":"enabled"}`. Si aparece `disabled` o `configuration_missing`, no se enviará nada.
4. El journal se guarda en el disco persistente junto a `DATABASE_PATH`. **No lo borres entre despliegues**: es lo que evita duplicados. No hay que cambiar el servicio, el disco, el checkout, SQLite ni la integración FedEx/Envia.

### Prueba controlada de envío (manual)

Solo después de tener el dominio verificado y las cuatro variables reales:

```
npm run email:smoke -- --send-to-owner <uuid-nuevo>
```

Envía **un** correo de prueba al propietario, con asunto "OFFCODE · Prueba controlada de correo" y texto que aclara que no corresponde a un pedido. No crea ni modifica pedidos, no usa las plantillas de pedido y no se ejecuta en `npm test` ni en el arranque. Imprime `{"state":"accepted"}` o el código de fallo. Genera un UUID nuevo cada vez (`node -e "console.log(crypto.randomUUID())"`); repetir el mismo devuelve el resultado idempotente en lugar de un segundo correo. Si responde `disabled`, `failed` o `uncertain`, no lo repitas a ciegas: revisa Resend y los logs.

Después de recibirlo, comprueba en las cabeceras que SPF y DKIM pasan (`Authentication-Results`) y que no cae en spam. **Esta prueba no se ha ejecutado**: no hay credenciales reales en el repositorio.

### Fuera de alcance

Campañas masivas, mensajes automáticos de WhatsApp, envío del PDF de la guía, plantillas editables desde el panel y confirmación de entrega por webhook. No están implementados y no deben añadirse a este flujo sin consentimiento y configuración propios.

## Ejecutar sin publicar

Necesitas Node.js **24.14.x**. No hay proceso de compilación. El visor 3D ya está incluido localmente. SQLite forma parte de Node y emite el aviso de API experimental en esta versión. El acceso de clientes usa correo y contraseña, sin dependencias externas de autenticación. Ejecuta npm ci para validar el lockfile antes de iniciar.

1. Copia `.env.example` a `.env` y edita la copia en tu equipo.
2. Define ADMIN_PASSWORD, con al menos 16 caracteres. No existe una contraseña predeterminada. No compartas esa clave con compradores.
   Genera una vez SETTINGS_ENCRYPTION_KEY con `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` y copia el resultado a la variable privada de `.env`. No publiques su salida ni la incluyas en capturas. Respalda esa clave separadamente: hace falta la misma para abrir los datos guardados.
3. Conserva ORDERS_ENABLED=false mientras preparas los datos reales.
4. Ejecuta `npm start` desde la raíz del repositorio.
5. Abre http://localhost:8000 para la tienda y http://localhost:8000/admin.html para el panel.
6. Abre http://localhost:8000/settings.html para preparar la configuración del propietario. No requiere instalar dependencias.

Con la configuración predeterminada las ventas están desactivadas. El panel puede abrir sesión si configuraste su contraseña, pero no se aceptan direcciones ni solicitudes nuevas.

PUBLIC_ORIGIN debe coincidir exactamente con la dirección utilizada en el navegador, sin una barra final. Por ejemplo, si configuras http://localhost:8000, no uses http://127.0.0.1:8000 para enviar formularios. Esto evita solicitudes desde otros sitios.

En el primer despliegue de Render puedes dejar PUBLIC_ORIGIN sin definir: el servidor reconoce RENDER=true y usa la RENDER_EXTERNAL_URL HTTPS que el proveedor asigna. Cuando conectes y verifiques el dominio propio, define PUBLIC_ORIGIN con su origen HTTPS exacto y usa esa dirección para tienda y panel. No importes la configuración localhost de `.env.example` en Render.

## Datos que faltan para habilitar ventas

Completa estos valores privados en `.env` o en el panel del proveedor de hosting:

- ADMIN_PASSWORD: contraseña de administración.
- SALES_WHATSAPP: número real de ventas con código de país, solo dígitos.
- BANK_NAME: banco receptor.
- BANK_BENEFICIARY: titular real de la cuenta.
- BANK_CLABE: CLABE real de 18 dígitos.
- PRIVACY_URL y TERMS_URL: direcciones HTTPS de las páginas reales de privacidad y condiciones de compra de la marca. No se han inventado políticas.
- PUBLIC_ORIGIN: URL exacta de la tienda; debe ser HTTPS en producción.
- DATABASE_PATH: ubicación privada del archivo SQLite en almacenamiento persistente.

Confirma también precios, existencias, origen de los envíos, procedimiento para cotizarlos y condiciones de cambios y devoluciones. No actives ventas con datos de ejemplo. Las páginas de privacidad y condiciones deben estar publicadas y revisadas por el propietario.

Cuando todo esté verificado, habilita la recepción en `/settings.html`. Si usas exclusivamente variables iniciales, establece ORDERS_ENABLED=true y reinicia. Si falta la configuración requerida, el servidor rechaza la activación. La bolsa de la página principal permite solicitar pedidos. Mantén WAITLIST_ENABLED=false; la portada VIP ya no se publica.

La raíz siempre muestra `index.html` como tienda, incluso si un hosting antiguo conserva HOME_PAGE=teaser. HOME_PAGE=store permanece en los ejemplos para identificar el modo actual.

## Panel privado

La ruta `/admin.html` contiene la pantalla de acceso; los datos se obtienen únicamente después de iniciar sesión. No se guardan pedidos ni credenciales en localStorage. La cookie de sesión es HttpOnly, SameSite=Strict, dura cuatro horas y es Secure con NODE_ENV=production. Reiniciar el servidor cierra las sesiones activas.

Puedes buscar por referencia o nombre y filtrar por estado en todos los pedidos, incluidos los que están en otras páginas. Los pedidos se muestran de 50 en 50; el resumen cuenta todos los registros por estado. Cada actualización valida la versión para evitar sobrescribir cambios de otra sesión. La autorización se comprueba en el servidor.

Cancelar un pedido no devuelve dinero. Si ya estaba pagado, acuerda y realiza cualquier devolución por separado con el cliente. El panel no ejecuta movimientos bancarios.

### Configuración del propietario

`/settings.html` comparte la misma sesión del panel. Permite guardar WhatsApp, banco, titular, CLABE, enlaces de privacidad y condiciones, token y entorno de Envia, domicilio de origen y perfiles medidos de empaque. También permite cerrar o abrir la recepción de pedidos. El servidor valida los cambios, exige la contraseña actual y cifra la configuración con AES-256-GCM usando SETTINGS_ENCRYPTION_KEY; no guarda esa clave en SQLite. El token no vuelve en las respuestas de lectura y su campo aparece vacío. El propietario y quien administra el servidor tienen acceso técnico a los datos; no existe un sistema de licencias comerciales ni registro abierto de administradores.

Para preparar Envia desde el panel:

1. Mantén pedidos y Envia desactivados. Guarda el token de sandbox en el campo privado, confirmando la contraseña actual.
2. Pulsa “Consultar estados y comprobar acceso a Envia”. Solo consulta el catálogo: no compra guías ni confirma cobertura o saldo.
3. Completa el remitente, selecciona el estado del catálogo y añade los pesos/medidas reales por cantidad de prendas. Guarda y habilita Envia para probar localmente.
4. Comprueba el flujo con sandbox. Para ventas reales cambia a producción y escribe el token de ese entorno; el sistema impide reutilizar silenciosamente el token anterior al cambiar de entorno.
5. Completa cuenta bancaria, contacto y políticas publicadas, valida la cuenta real y habilita pedidos. Las casillas de preparación verifican campos, no certifican la cuenta ni las condiciones.

Los cambios se aplican sin reiniciar. Guardar invalida cotizaciones anteriores para que se consulten otra vez. Los pedidos cuyo total ya se confirmó conservan la cuenta de transferencia acordada. El token vacío conserva el anterior; retirarlo requiere la casilla correspondiente y desactivar primero Envia. No cambies de cuenta de Envia con guías pendientes de revisión; resuélvelas en la cuenta que las creó.

La sección “Mi acceso” permite cambiar la contraseña y cierra todas las sesiones. Se guarda únicamente un hash scrypt con sal aleatoria; la contraseña inicial ADMIN_PASSWORD deja de ser válida después del cambio, incluso tras reiniciar. Cambiar solo esa variable no sobrescribe una contraseña cambiada en el panel.

Recuperación administrativa si se pierde la contraseña: quien controla el hosting debe detener la aplicación, respaldar la base y la clave original, definir una nueva ADMIN_PASSWORD privada de al menos 16 caracteres y eliminar únicamente la fila de `owner_auth` en una consola local del servidor: `DELETE FROM owner_auth WHERE id=1;`. Al reiniciar usa la contraseña inicial nueva. No borres pedidos, owner_settings ni la clave de cifrado. Esta recuperación requiere acceso técnico al servidor y no está expuesta en una ruta pública. No se ha ejecutado contra datos reales.

La configuración guardada en el panel prevalece sobre las variables iniciales BANK__, ENVIA__, SALES_WHATSAPP, PRIVACY_URL, TERMS_URL y ORDERS_ENABLED. Cambia esos valores desde el panel después de su primer guardado. PUBLIC_ORIGIN, DATABASE_PATH, la clave de cifrado y las opciones de hosting siguen siendo variables del servidor. Conserva juntas las copias de la base y, por separado, la clave; perder esta última impide recuperar la configuración cifrada.

## Publicación y almacenamiento

El servicio existente es `offcode2`, según el propietario. `render-orders.yaml` es una referencia para una instancia y un disco; no se ha aplicado desde esta tarea ni se verificó el plan contratado. El dominio pertenece al propietario. Revisar el plan y la facturación actual en Render antes de cualquier cambio; esta tarea no modifica recursos contratados.

En el servicio Node de pago activa Settings → Edge Caching → **All files**, porque la lista de tipos comunes no incluye GLB ni HTML. El código permite cachear solamente la portada y los recursos públicos; API, checkout, panel y errores responden `no-store`. No fuerces caché sobre rutas privadas. Comprueba el encabezado CF-Cache-Status al solicitar una imagen o el modelo por segunda vez. La CDN se activa en el dashboard, no mediante este cambio local. Referencia: [Render: caché para Web Services](https://render.com/docs/web-service-caching).

TRUST_RENDER_PROXY=true se configura únicamente en el servicio de Render para identificar al cliente con su encabezado saneado X-Forwarded-For. Así los límites no se comparten entre todos los compradores que llegan por el proxy. En local o un servidor accesible directamente conserva false. Si cambias la cadena de proxies, revisa esta confianza antes de activarla. Referencia: [Render: IP del cliente detrás del proxy](https://render.com/articles/how-render-handles-ddos-attacks).

La caché reduce carga del proceso, pero el ancho de banda sigue contando. Revisa Billing y Metrics antes del anuncio, el método de pago y los avisos de consumo. Si no hay método de pago y se agota el tráfico incluido, los servicios pueden suspenderse. Referencia: [Render: outbound bandwidth](https://render.com/docs/outbound-bandwidth).

Con SQLite y disco hay una sola instancia; Render no permite añadir réplicas a ese servicio. El escalado horizontal exigiría un rediseño de la persistencia compartida, sesiones y coordinación de guías; no forma parte de esta aplicación SQLite. Cambiar el plan de una instancia con disco implica una interrupción breve: ajusta y prueba antes del evento. No se ha validado una capacidad de visitantes simultáneos en Render.

`render.yaml` conserva la presentación estática. Subir los archivos Node a un Static Site no ejecuta la API ni guarda solicitudes.

`render-orders.yaml` documenta la referencia de configuración del servicio Node existente con disco persistente. **No se ha aplicado desde esta tarea.** El servicio y el disco son recursos de pago; no corresponden al alojamiento estático gratuito.

Verifica estos valores en el servicio existente, sin sobrescribir su configuración privada:

- Node 24.14.0, Build Command `npm ci`, Start Command `npm start`.
- HOST=0.0.0.0, NODE_ENV=production y PUBLIC_ORIGIN=https://offcode.mx.
- Disco persistente montado en `/var/data` y DATABASE_PATH=/var/data/offcode.sqlite.
- Conservar ADMIN_PASSWORD y SETTINGS_ENCRYPTION_KEY existentes, ambas privadas; no reemplazar la clave que cifra los ajustes guardados.
- Las demás variables indicadas arriba; las ventas continúan desactivadas hasta completar todo.
- Una sola instancia de aplicación con este disco SQLite. Las sesiones viven en memoria: escalar a varias instancias requeriría rediseñar la persistencia compartida, sesiones y coordinación de guías; no está implementado.

### Desplegar esta versión (catálogo e inventario)

1. **Respalda antes de desplegar.** Con el servicio detenido, copia `/var/data/offcode.sqlite` y la carpeta `/var/data/offcode.sqlite.email-outbox/`. No copies una base activa como si fuera un archivo estático.
2. El despliegue debe usar el **Web Service Node**, no el sitio estático. `render.yaml` describe el sitio estático (`offcode-demo`, publica `./dist`) y no ejecuta la API: en él la tienda se ve, pero los pedidos, el panel y Envia no funcionan. `render-orders.yaml` describe el servicio Node con disco; Render solo lee `render.yaml` por defecto, así que ese archivo **no crea nada por sí solo**.
3. Confirma antes de desplegar: `DATABASE_PATH=/var/data/offcode.sqlite`, disco montado en `/var/data`, `HOST=0.0.0.0`, `NODE_ENV=production`, `NODE_VERSION=24.14.0`, `ADMIN_PASSWORD` y `SETTINGS_ENCRYPTION_KEY` definidas en el panel (nunca en el repositorio).
4. Mantén `ORDERS_ENABLED=false` y `ENVIA_ENABLED=false` en el primer arranque.
5. Al arrancar, la migración crea las tablas de catálogo e inventario si no existen y deja `PRAGMA user_version = 2`. **No borra pedidos ni productos**. La hoodie se siembra solo al migrar desde la versión 0, con siembra habilitada y tabla `products` vacía, **sin existencias** (`configured = 0`).
6. Revisa los registros de arranque: deben indicar la URL y la ruta SQLite seleccionada, sin credenciales. Un ciclo de reinicios suele indicar que falta `ADMIN_PASSWORD`, que `PUBLIC_ORIGIN` no es un origen HTTPS exacto o que `validateActivation` rechazó la configuración.
7. Confirma `PUBLIC_ORIGIN=https://offcode.mx` en el servicio existente antes de publicar la actualización. Si el dominio no coincide, las peticiones `POST` del panel y del checkout responden 403 (protección de origen), que es el comportamiento correcto.
8. Comprueba `/api/config` (200, JSON, `Cache-Control: no-store`), `/admin.html` (200, `no-store`) y `/api/admin/summary` sin sesión (401). No marques pedidos como pagados ni generes guías para "probar".
9. Cuando el inventario físico esté contado y la cuenta de Envia validada, registra las entradas reales en el panel y solo entonces activa las ventas.

No uses el disco efímero de un servicio gratuito para pedidos reales: los datos pueden perderse al reiniciar o desplegar. Referencias: [Render: discos persistentes](https://render.com/docs/disks), [Node.js 24: SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).

Las direcciones de clientes se guardan en el archivo SQLite privado y no se publican desde `dist/`. El propietario debe conservar copias de respaldo fuera del repositorio y definir la conservación de esos datos en su aviso de privacidad. Para una copia manual local, detén el servidor antes de copiar el directorio de datos; no copies una base activa como si fuera un archivo estático.

`.gitignore` excluye `.env`, `data/` y archivos SQLite. Revisa siempre `git status` antes de subir cambios.

## Pruebas y límites

`npm run check:load` ejecuta un ejercicio LOCAL con base temporal y datos ficticios: 600 solicitudes de catálogo/recursos con concurrencia 50, 120 pedidos con concurrencia 20 y sus 120 reintentos. Comprueba cero errores y ausencia de duplicados; guarda el reporte sin datos personales en `qa/load-local.json`. No usa credenciales ni llama a Envia. No es un ensayo contra Render ni garantiza ese número de compradores en producción.

Ejecuta `npm test`. Las pruebas usan datos ficticios y comprueban el ciclo completo, totales del servidor, persistencia tras reinicio, reintentos sin duplicados, control de versiones, acceso privado, rechazo de cambios de estado inválidos y bloqueo de ventas sin configurar.

La suite tiene 73 pruebas aprobadas con Node 24.14.0, sin omisiones. Además del flujo de pedidos, configuración cifrada, token oculto, persistencia de credenciales, cierre de sesiones al cambiar contraseña, invalidación de tarifas al editar datos, cuenta bancaria acordada, búsqueda de pedidos fuera de la primera página y URL automática de Render con prioridad del dominio explícito, cubre el catálogo y el inventario:

- Migraciones versionadas e idempotentes que conservan productos y pedidos.
- Crear, editar, publicar, despublicar y archivar sin perder referencias; SKU duplicado rechazado al crear y al editar.
- Inventario por talla y color con entradas, ajustes con motivo obligatorio y sin cantidades negativas.
- Reserva → pago → cancelación que mueve el stock una sola vez; cancelar antes del pago libera.
- Dos solicitudes concurrentes por la última unidad: una gana con 201 y la otra recibe 409.
- Stock agotado y variante archivada bloquean la venta; una variante sin configurar no inventa stock.
- La tienda marca las tallas agotadas como deshabilitadas y las excluye de la lista vendible; el precio sale del catálogo.
- Un pedido histórico no cambia al editar o archivar el producto.
- Sin sesión o desde otro origen no se administra catálogo ni inventario; precios negativos y rutas de imagen con `..` se rechazan.
- Una solicitud duplicada y un fallo de correo no reservan dos veces ni filtran secretos.

`tests/database.test.mjs` comprueba SQLite real en bases temporales: esquema completo, índices y restricciones, migraciones repetidas sobre esquema anterior sin perder pedidos, rechazo de una versión futura sin tocar tablas, creación del directorio privado y persistencia de inventario/reservas/movimientos al reabrir. Verifica que las operaciones externas esperen al rollback de una transacción pausada, además de última unidad, rollback, cobro/cancelación y acceso privado. `tests/catalog.test.mjs` también prueba ocho reintentos HTTP concurrentes idénticos: un pedido y una reserva, sin errores ni duplicados.

La UI de configuración y el flujo hasta una guía ficticia se revisaron en escritorio de 1440 px y móvil de 390 px; la configuración también se comprobó a 320 px, sin desplazamiento horizontal. El panel nuevo se revisó en escritorio de 1280 px y móvil de 390 px: las seis secciones, la tabla de inventario convertida en fichas apiladas, el diálogo de producto y el de movimientos. Capturas en `qa/configuracion-desktop.jpg`, `qa/configuracion-mobile-portada.jpg` y `qa/panel-actualizado-desktop.jpg` (todos sus datos son ficticios).

Las siete pruebas de `tests/email.test.mjs` usan un proveedor simulado y datos ficticios: no envían correos reales ni llaman a Resend. Cubren configuración ausente y desactivada por defecto, envío correcto al propietario y al comprador, error y timeout del proveedor, respuesta HTTP 200 sin identificador válido, pedido duplicado sin segundo envío, transición válida, transición inválida, fallo de correo sin pérdida ni duplicación del pedido, reinicio del proceso sin duplicar, ventana de idempotencia vencida, direcciones inválidas, estados superados, pedido que responde sin esperar al proveedor y ausencia de la clave o de datos personales en respuestas, registros y journal. Falta la prueba controlada contra Resend real descrita arriba; no se ejecutó.

Las pruebas de `tests/product.test.mjs` comprueban la ficha pública (seis tallas contempladas, cuatro habilitadas, sin guía de tallas ni medidas inventadas), el rechazo de tallas no habilitadas y que un fallo de correo o la ausencia del proveedor de envío no pierdan el pedido. `tests/shipping.test.mjs` verifica además que el pedido guarda la tarifa validada, el servicio y el estimado devuelto por FedEx, y que el importe enviado por el navegador se ignora.

Las pruebas Envia sustituyen el transporte HTTP por respuestas sintéticas compatibles con su documentación: no requieren token ni hacen llamadas a la cuenta del propietario. Comprueban FedEx exclusivo, consentimiento, cotización ligada a dirección y prendas, caducidad, total del servidor, acceso privado, pago previo, doble clic, respuesta HTTP200 con error, bloqueo durable, conciliación y persistencia tras reinicio. Las cotizaciones guardadas con datos de entrega se eliminan al vencer, con limpieza cada minuto y al iniciar el servidor; los pedidos conservan su historial según la política del propietario. Falta validar con sandbox real y con las tarifas/cobertura de su cuenta; sin el acceso del propietario no se puede comprobar esa parte.

Para revisar la interfaz sin cuenta ni datos reales, ejecuta `npm run preview:shipping` y abre http://127.0.0.1:8013/tienda.html. El panel está en /admin.html, con contraseña **solo-pruebas-fedex-ficticias** (únicamente para esta vista sintética). La base está en memoria y desaparece al detener el proceso. Este helper solo escucha en loopback y no se permite con NODE_ENV=production. No consulta la API real. Su enlace PDF es ficticio y no descarga una guía; el PDF real se valida después con sandbox de Envia. No uses este comando para abrir ventas.

La revisión del navegador usa una base de pruebas en memoria separada. No se hicieron depósitos, no se compraron guías reales, no se enviaron mensajes por WhatsApp y no se envió ningún correo real. El correo transaccional está implementado y desactivado por defecto; las campañas masivas, los mensajes automáticos de WhatsApp, la validación bancaria automática y la gestión de inventario no están implementadas.

La etapa SQLite anterior creó el commit local solicitado. La etapa actual de cuentas no crea otro commit. No hace push, despliegue, cambios del dashboard ni migraciones contra producción.


Validación local de la etapa SQLite anterior (17 de octubre de 2026): `npm ci` sin dependencias externas ni vulnerabilidades informadas; `npm test` con 58/58 aprobadas; sintaxis de 31 archivos JS/MJS correcta y `git diff --check` sin errores. `npm run check:load`: 600 consultas de recursos, 120 pedidos y 120 reintentos, cero errores y 120 pedidos únicos en SQLite temporal. Reporte: `qa/load-local.json`. No certifica capacidad ni persistencia del servicio de Render. Los helpers de carga y vista ficticia deshabilitan explícitamente el transporte de correo, incluso si el entorno contiene credenciales.


## Cuentas de clientes y Contacto

La migración 2 añade cuentas de cliente sin resembrar el catálogo de versión 1, sin cambiar la ruta ni activar ventas. El acceso de cliente está separado del propietario. Registro, verificación, recuperación, perfil/dirección y pedidos propios se documentan en [CUENTAS.md](CUENTAS.md), incluidas las variables privadas, límites y pruebas pendientes. Instalar con npm ci antes de iniciar; el dashboard de Render no se cambia desde el repositorio. La entrega de correos reales en producción queda pendiente. La etapa actual queda sin commit, push ni despliegue.
