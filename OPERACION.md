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

## Ejecutar sin publicar

Necesitas Node.js **24.14.x**. No hay paquetes npm que instalar ni proceso de compilación. El visor 3D ya está incluido localmente. SQLite forma parte de Node y emite el aviso de API experimental en esta versión.

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

Recuperación administrativa si se pierde la contraseña: quien controla el hosting debe detener la aplicación, respaldar la base y la clave original, definir una nueva ADMIN_PASSWORD privada de al menos 16 caracteres y eliminar únicamente la fila de `owner_auth` en una consola SQLite local del servidor: `DELETE FROM owner_auth WHERE id=1;`. Al reiniciar usa la contraseña inicial nueva. No borres pedidos, owner_settings ni la clave de cifrado. Esta recuperación requiere acceso técnico al servidor y no está expuesta en una ruta pública. No se ha ejecutado contra datos reales.

La configuración guardada en el panel prevalece sobre las variables iniciales BANK__, ENVIA__, SALES_WHATSAPP, PRIVACY_URL, TERMS_URL y ORDERS_ENABLED. Cambia esos valores desde el panel después de su primer guardado. PUBLIC_ORIGIN, DATABASE_PATH, la clave de cifrado y las opciones de hosting siguen siendo variables del servidor. Conserva juntas las copias de la base y, por separado, la clave; perder esta última impide recuperar la configuración cifrada.

## Publicación y almacenamiento

El plan de entrada elegido es `0.5c-512mb` (0.5 CPU / 512 MB RAM) en `render-orders.yaml`, con una instancia y 1 GB de disco. La configuración sigue sin aplicarse. Referencia consultada el 16 de octubre de 2026: $7 USD/mes de servicio más $0.25 USD por 1 GB de disco ($7.25 de base), impuestos y tráfico adicional si aplica. El dominio ya pertenece al propietario. Conserva el workspace Hobby sin cuota si sus funciones son suficientes. `1c-2g` (1 CPU / 2 GB RAM, $25/mes de servicio) es una alternativa si las mediciones indican que hace falta. El propietario contrata esos servicios en su cuenta; todavía no se ha contratado este Web Service.

En el servicio Node de pago activa Settings → Edge Caching → **All files**, porque la lista de tipos comunes no incluye GLB ni HTML. El código permite cachear solamente la portada y los recursos públicos; API, checkout, panel y errores responden `no-store`. No fuerces caché sobre rutas privadas. Comprueba el encabezado CF-Cache-Status al solicitar una imagen o el modelo por segunda vez. La CDN se activa en el dashboard, no mediante este cambio local. Referencia: [Render: caché para Web Services](https://render.com/docs/web-service-caching).

TRUST_RENDER_PROXY=true se configura únicamente en el servicio de Render para identificar al cliente con su encabezado saneado X-Forwarded-For. Así los límites no se comparten entre todos los compradores que llegan por el proxy. En local o un servidor accesible directamente conserva false. Si cambias la cadena de proxies, revisa esta confianza antes de activarla. Referencia: [Render: IP del cliente detrás del proxy](https://render.com/articles/how-render-handles-ddos-attacks).

La caché reduce carga del proceso, pero el ancho de banda sigue contando. Revisa Billing y Metrics antes del anuncio, el método de pago y los avisos de consumo. Si no hay método de pago y se agota el tráfico incluido, los servicios pueden suspenderse. Referencia: [Render: outbound bandwidth](https://render.com/docs/outbound-bandwidth).

Con SQLite y disco hay una sola instancia; Render no permite añadir réplicas a ese servicio. Para escalado horizontal harían falta base de datos y sesiones compartidas y coordinación de operaciones de guía. Cambiar el plan de una instancia con disco implica una interrupción breve: ajusta y prueba antes del evento. No se ha validado una capacidad de visitantes simultáneos en Render.

`render.yaml` conserva la presentación estática. Subir los archivos Node a un Static Site no ejecuta la API ni guarda solicitudes.

`render-orders.yaml` es una configuración opcional para un Web Service Node con disco persistente. **No está aplicada ni desplegada.** El servicio y el disco son recursos de pago; no corresponden al alojamiento estático gratuito.

Para usar esa alternativa, configura en Render:

- Node 24.14.0, Build Command `echo No build required`, Start Command `npm start`.
- HOST=0.0.0.0 y NODE_ENV=production. Al inicio omite PUBLIC_ORIGIN para usar la URL de Render; después define el dominio HTTPS real ya verificado.
- Disco persistente montado en `/var/data` y DATABASE_PATH=/var/data/offcode.sqlite.
- ADMIN_PASSWORD inicial y SETTINGS_ENCRYPTION_KEY aleatoria, ambas privadas. Después el propietario completa sus datos y token desde `/settings.html`.
- Las demás variables indicadas arriba; las ventas continúan desactivadas hasta completar todo.
- Una sola instancia de aplicación con este disco SQLite. Para varias instancias habrá que migrar a una base de datos compartida.

No uses el disco efímero de un servicio gratuito para pedidos reales: los datos pueden perderse al reiniciar o desplegar. Referencias: [Render: discos persistentes](https://render.com/docs/disks), [Node.js 24: SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html).

Las direcciones de clientes se guardan en el archivo SQLite privado y no se publican desde `dist/`. El propietario debe conservar copias de respaldo fuera del repositorio y definir la conservación de esos datos en su aviso de privacidad. Para una copia manual local, detén el servidor antes de copiar el directorio de datos; no copies una base activa como si fuera un archivo estático.

`.gitignore` excluye `.env`, `data/` y archivos SQLite. Revisa siempre `git status` antes de subir cambios.

## Pruebas y límites

`npm run check:load` ejecuta un ejercicio LOCAL con base temporal y datos ficticios: 600 solicitudes de catálogo/recursos con concurrencia 50, 120 pedidos con concurrencia 20 y sus 120 reintentos. Comprueba cero errores y ausencia de duplicados; guarda el reporte sin datos personales en `qa/load-local.json`. No usa credenciales ni llama a Envia. No es un ensayo contra Render ni garantiza ese número de compradores en producción.

Ejecuta `npm test`. Las pruebas usan datos ficticios y comprueban el ciclo completo, totales del servidor, persistencia tras reinicio, reintentos sin duplicados, control de versiones, acceso privado, rechazo de cambios de estado inválidos y bloqueo de ventas sin configurar.

La suite tiene 21 pruebas aprobadas. También comprueba configuración cifrada y autenticada, token oculto, persistencia de credenciales, cierre de sesiones al cambiar contraseña, rechazo de claves incorrectas, invalidación de tarifas al editar datos, cuenta bancaria acordada, búsqueda de pedidos fuera de la primera página y URL automática de Render con prioridad del dominio explícito. La UI de configuración y el flujo hasta una guía ficticia se revisaron en escritorio de 1440 px y móvil de 390 px; la configuración también se comprobó a 320 px, sin desplazamiento horizontal. Capturas en `qa/configuracion-desktop.jpg`, `qa/configuracion-mobile-portada.jpg` y `qa/panel-actualizado-desktop.jpg` (todos sus datos son ficticios).

Las pruebas Envia sustituyen el transporte HTTP por respuestas sintéticas compatibles con su documentación: no requieren token ni hacen llamadas a la cuenta del propietario. Comprueban FedEx exclusivo, consentimiento, cotización ligada a dirección y prendas, caducidad, total del servidor, acceso privado, pago previo, doble clic, respuesta HTTP200 con error, bloqueo durable, conciliación y persistencia tras reinicio. Las cotizaciones guardadas con datos de entrega se eliminan al vencer, con limpieza cada minuto y al iniciar el servidor; los pedidos conservan su historial según la política del propietario. Falta validar con sandbox real y con las tarifas/cobertura de su cuenta; sin el acceso del propietario no se puede comprobar esa parte.

Para revisar la interfaz sin cuenta ni datos reales, ejecuta `npm run preview:shipping` y abre http://127.0.0.1:8013/tienda.html. El panel está en /admin.html, con contraseña **solo-pruebas-fedex-ficticias** (únicamente para esta vista sintética). La base está en memoria y desaparece al detener el proceso. Este helper solo escucha en loopback y no se permite con NODE_ENV=production. No consulta la API real. Su enlace PDF es ficticio y no descarga una guía; el PDF real se valida después con sandbox de Envia. No uses este comando para abrir ventas.

La revisión del navegador usa una base de pruebas en memoria separada. No se hicieron depósitos, no se compraron guías reales y no se enviaron mensajes por WhatsApp. Las notificaciones automáticas, validación bancaria automática y gestión de inventario no están implementadas.

No se ha hecho push ni despliegue durante esta implementación.
