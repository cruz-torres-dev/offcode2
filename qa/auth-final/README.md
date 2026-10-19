# Auditoría final local de autenticación, correo y cuenta de OFFCODE

18 de octubre de 2026 · Node 24.14.0 · base Git `90ee320`.

**Resultado: validación local aprobada. Validación final de producción y Gmail pendiente.**
Sin commit, push, despliegue, compras reales, pagos, guías reales ni correos reales enviados durante esta revisión. No se modificaron secretos, variables, datos de producción ni `ORDERS_ENABLED`. Los cambios anteriores de `qa/load-local.json`, `qa/accounts/`, `qa/account-views/` y `qa/viewer-final/` se conservaron y quedan fuera de esta entrega.

## Fallos encontrados y corregidos

1. **Acción poco identificable en los correos de verificación y recuperación.** El HTML anterior solo presentaba un enlace de texto. Ahora usa un botón blanco con texto negro, las acciones exactas «VERIFICAR MI CORREO» y «RESTABLECER MI CONTRASEÑA», y la URL completa subrayada y copiable debajo. Incluye tablas de presentación, fondos explícitos y estilos en línea. No necesita imágenes, JavaScript, hojas CSS externas ni estilos del encabezado.
2. **El cambio de dirección de correo tenía el mismo defecto visual.** Reutiliza la misma plantilla con «CONFIRMAR MI NUEVO CORREO». Mantiene sus 60 minutos, uso único y aviso de que el correo anterior continúa activo hasta confirmar.
3. **La lista de direcciones quedaba desactualizada al guardar.** Reproducido en navegador: aparecía «Dirección guardada» junto a «Todavía no guardas direcciones». La base sí conservaba el registro. Se cambió una llamada para volver a consultar la lista después de crear o editar; ahora aparece inmediatamente y persiste al recargar.
4. **Preferencias prometía que los correos transaccionales “se envían siempre”.** El texto ahora dice que no dependen de la preferencia comercial; no garantiza una entrega que puede fallar en el proveedor.

No se modificaron los algoritmos de contraseña, generación/validación de tokens, sesiones, permisos, estados de pedidos ni transporte de correo.

## Dónde están los flujos

- `server/customer-accounts.mjs`: `accountLinkMessage` genera HTML y texto plano; `sendToken` genera las URL de verificación/recuperación; `consumeToken` valida y consume dentro de una transacción. `sendEmailChange` conserva su flujo independiente y usa el mismo diseño visual.
- `dist/account.js`: extrae el fragmento del enlace, lo retira de la barra de dirección y muestra el formulario o la confirmación. Abrir el enlace no consume el token; la acción POST explícita sí lo consume.
- `server/email.mjs`: transporte Resend y plantilla transaccional de pedidos v1.
- `server/email-outbox.mjs`: journal, deduplicación, estados y reintentos de correos de pedidos.
- `server/server.mjs`: origen canónico, protección de origen, cabeceras, eventos reales de pedidos y cola transaccional.

## Autenticación y enlaces

- Tokens de 32 bytes aleatorios, representados con 43 caracteres base64url. SQLite almacena únicamente SHA-256, junto con titular, propósito y caducidad.
- Verificación: 24 horas. Recuperación: 30 minutos. Cambio de correo: 60 minutos. Una nueva solicitud reemplaza el token anterior del mismo propósito.
- Validación por formato, hash, propósito y `expires > now`; consumo atómico. Se rechazaron tokens ausentes, alterados, de otro propósito, reemplazados, ya usados y vencidos. Las pruebas de caducidad incluyen el instante exacto de 24 horas y 30 minutos, con un reloj inyectado únicamente en la instancia de prueba.
- Una sola variable URL alimenta botón, alternativa visible y texto plano. Las pruebas arrancan una aplicación local en modo producción con `origin=https://offcode.mx`, capturan la llamada al proveedor y comprueban el dominio, `/cuenta.html`, el fragmento correcto y su correspondencia con el hash almacenado. Después consumen esos mismos tokens contra el backend local. No se escribieron URL de autenticación ni tokens de ejemplo en las plantillas.
- Contraseñas con scrypt; no se guardan en texto plano. Recuperación devuelve la misma respuesta pública para cuentas existentes y ausentes, incluso ante fallos del proveedor.
- Flujo integrado probado con el controlador real y HTTP real: solicitud de recuperación, URL emitida, lectura del fragmento, formulario, envío al backend, cambio de contraseña e inicio de sesión con la nueva contraseña. La anterior se rechaza y reutilizar el enlace muestra el error esperado. El DOM está simulado en estas pruebas; no se presenta como una prueba de Gmail ni de teléfono físico.

## Cuenta, persistencia y sesiones

- Perfil, direcciones y preferencias: pasan lecturas nuevas y reinicio con el mismo archivo SQLite temporal. Navegador local: se comprobó guardar y recargar nombre, dirección y consentimiento concedido/retirado.
- Direcciones: validación del servidor, titular tomado de la sesión, una sola predeterminada y aislamiento entre cuentas. Editar una dirección no reescribe pedidos anteriores.
- Preferencias: sin consentimiento por defecto; registro de versión y texto. Retirar consentimiento también retira al correo de la lista VIP activa. No bloquea los correos transaccionales.
- Sesión: cookie HttpOnly, SameSite=Lax, siete días; en producción Secure, Path=/, sin Domain y prefijo `__Host-`. Solo el hash persiste en SQLite. Se probó el límite exacto de siete días.
- Logout invalida la sesión actual en el servidor: reintroducir la cookie anterior no restaura el acceso. Otras sesiones siguen activas, que es el comportamiento previsto. Revocar todas o restablecer contraseña invalida todas las sesiones del titular; se comprobó con dos dispositivos simulados.
- Las cuentas sin verificar no acceden a datos privados. Cambiar contraseña no sustituye la verificación de correo. Las consultas de pedidos y direcciones se limitan al titular.

## Correos de pedidos

La suite existente se ejecutó con pedidos sintéticos, SQLite temporal y transporte interceptado. No se cambió la plantilla v1 ni sus cuerpos, preservando la identidad de los reintentos ya registrados.

- Solicitud: solo confirma recepción; aclara que no confirma disponibilidad, pago ni envío. Un mensaje al propietario y otro al comprador, sin duplicados por reintentar el pedido.
- Transferencia: solo después de confirmar existencias e importe.
- Pago: solo tras la transición persistida con pago verificado. No afirma que el paquete se haya enviado.
- Envío: solo tras confirmar entrega a la paquetería, con FedEx y rastreo registrados. Intentar saltar desde solicitud a envío se rechaza y no crea un correo de envío.
- Se omiten pedidos históricos al instalar la cola. Eventos superados no se notifican tardíamente como si fueran el estado actual.
- Se comprobaron duplicados, reinicio, timeout, errores HTTP, respuesta malformada, reintentos con mismo cuerpo/clave y bloqueo al superar la ventana segura de idempotencia de 23 horas.

Esto valida generación y condiciones de envío. No acredita entrega real de confirmaciones, pagos o envíos de pedidos de producción. No se generaron esos eventos reales para probar correo.

## Configuración, registros y proveedor

- Datos aportados por el propietario: Render; `EMAIL_ENABLED=true`; remitente `no-reply@mail.offcode.mx`; destinatario del propietario configurado; prueba previa aceptada por el proveedor y recibida en Gmail; registro y verificación previos funcionales. Esa entrega previa no se atribuye a esta ejecución ni al HTML nuevo.
- Consulta pública inicial de solo lectura: `/cuenta.html` 200 y `Cache-Control: no-store`; `/account.js` 200; `/api/customer/session` 200, usuario nulo y `emailEnabled=true`; `/api/config` 200, `enabled=false`; API de notificaciones administrativas 401 sin sesión. Se observó `Referrer-Policy: no-referrer`.
- El servidor rechaza orígenes no exactos y exige HTTPS en producción. **El valor privado actual de `PUBLIC_ORIGIN` y el código backend efectivamente desplegado no pudieron inspeccionarse desde las rutas públicas.** Debe confirmarse el valor existente `https://offcode.mx` en Render antes del despliegue, sin cambiarlo durante esta auditoría.
- El transporte exige habilitación explícita, clave y direcciones válidas. Configuración incompleta desactiva correo; no simula aceptación. Se probaron HTTP 401/503, timeout y respuestas inválidas.
- “Aceptado” exige una respuesta válida del proveedor, no solo HTTP 2xx, y no significa entrega en bandeja de entrada. Recuperación/verificación asíncronas mantienen respuesta pública genérica; si fallan, el registro conserva estado/código y el usuario puede solicitar otro enlace respetando límites. No existe una cola durable de reintentos de autenticación equivalente a la de pedidos; no se añadió una para este cambio visual.
- Registros de cuentas: solo componente, estado y código. Se inyectó una respuesta de error con una clave, contraseña y cuerpo que contenía el token, y se comprobó que no se filtraran a los registros. La cola de pedidos registra metadatos permitidos y no imprime errores crudos del proveedor.
- **Pendiente:** logs privados actuales de Render, actividad de Resend, rebotes, quejas, aceptación y entrega real de los nuevos mensajes. No hay una sesión conectada de Render/Gmail/Resend disponible en esta ejecución. No se afirmaron resultados de esos registros.

## Pruebas ejecutadas

- Suite inicial `npm test`: **91 aprobadas**, 0 fallos, 0 omitidas.
- Pruebas focalizadas de cuentas y correo, tras el primer cambio: **27 aprobadas**, 0 fallos.
- Nuevo archivo de pruebas del controlador: **3 aprobadas** en su última ejecución. Durante su construcción se corrigió una limitación del doble DOM; no fue un fallo del flujo de contraseña de la aplicación.
- Suite completa final `npm test`: **98 aprobadas**, 0 fallos, 0 canceladas, 0 omitidas; 14.383 segundos. Salida conservada en `test-results.txt`.
- `node --check`: **44 archivos JS/MJS propios**, sin errores.
- `git diff --check`: sin errores. Git avisa de normalización LF/CRLF en archivos del checkout; no son errores de prueba.
- No existe un paso de compilación adicional en `package.json`: el servidor publica directamente `dist/`.
- Aviso conocido del runtime: SQLite todavía figura como experimental en Node 24.14.0; no hubo fallos asociados en esta suite.

## Navegador local y evidencia

Instancia en loopback, base en memoria, ventas cerradas, proveedor reemplazado por un transporte de prueba. Se usaron los mensajes y enlaces generados por esa instancia, sin imprimir los tokens.

- Ambas plantillas comprobadas a **320, 390 y 1280 px**. Cero desbordamiento horizontal; alternativa completa dentro del ancho disponible; botón y alternativa apuntan al mismo enlace. CTA de 56 px de alto; recuperación a 320 px ocupa dos líneas y 78 px de alto. Fondos blancos y texto `#080808`. Mediciones en `email-layout.json`.
- Botón de verificación → página de confirmación → correo verificado. La barra de dirección queda sin token.
- Enlace alternativo de recuperación → formulario de nueva contraseña. Captura en `reset-form-local-320.jpg`.
- Persistencia de perfil, edición de dirección y consentimiento comercial después de recargar. Cierre de sesión confirmado después de recargar.
- `verified-local-320.jpg` muestra el resultado real de la verificación local. Las capturas omiten tokens; son de navegador local, **no de Gmail**.

## Pasos exactos pendientes en producción y Gmail

1. Revisar esta entrega. Solo después de autorización explícita, realizar commit y desplegar en el servicio Render existente. No cambiar variables, secretos, base, disco, estados de pedidos o interruptor de ventas para publicar este parche. Confirmar el commit que Render desplegó y que el servicio continúa sano.
2. El propietario debe identificar el correo de prueba ya controlado; su dirección exacta no aparece en este chat. Para obtener **un solo correo de verificación**, la cuenta debe estar sin verificar. Si la cuenta anterior ya está verificada, el backend no reenvía: usar una cuenta de prueba nueva con una dirección/alias del mismo buzón que el propietario confirme, o una cuenta de prueba existente sin verificar. No revertir `verified_at` ni manipular tokens en la base. El propietario introduce las contraseñas de producción.
3. Solicitar la verificación una sola vez. Conservar el mensaje nuevo y revisarlo en Gmail de escritorio y en la app Gmail del teléfono: asunto, remitente, CTA blanco con texto negro «VERIFICAR MI CORREO», URL completa subrayada, plazo de 24 horas y aviso de seguridad. Revisar tema claro y oscuro, ampliación de texto, ausencia de recortes y que pueda seleccionarse/copiarse la URL completa. No compartir capturas que expongan el token.
4. Antes de confirmar, revisar que tanto el botón como la alternativa tengan el origen canónico `https://offcode.mx`, la página de cuenta y el fragmento de verificación emitido por el backend. No construir ni editar enlaces. Abrir la alternativa para comprobar la página sin confirmar; abrir también el CTA desde el otro dispositivo y confirmar **solo una vez**. Comprobar inicio de sesión y estado verificado; intentar confirmar de nuevo con el mismo enlace y comprobar rechazo.
5. Solicitar **un solo correo de recuperación** para esa misma cuenta. Revisar en ambos Gmail «RESTABLECER MI CONTRASEÑA», URL completa copiable, 30 minutos y aviso de seguridad. Abrir el enlace alternativo sin enviar el formulario y comprobar también el CTA. El propietario introduce y envía la contraseña nueva antes de vencer. Comprobar acceso con la nueva, rechazo de la anterior, cierre de sesiones previas y rechazo al volver a enviar el token usado. No copiar tokens o contraseñas a este informe, logs o chat.
6. Verificar en la cuenta de producción nombre, dirección de prueba y preferencias después de recargar; cerrar sesión y confirmar que recargar o volver a la sección privada exige autenticación. Estas operaciones no requieren pedidos ni pagos.
7. Revisar Render y Resend para esos **dos mensajes únicamente**: aceptación, entrega/rebote, errores, remitente y ausencia de secretos en logs. No usar “reenviar” repetidamente ni disparar el correo de prueba adicional.
8. La caducidad independiente de producción queda pendiente: un token que ya se consumió no permite distinguir rechazo por uso de rechazo por expiración. Con el límite de un correo de cada tipo, no es posible demostrar a la vez éxito y vencimiento independiente de cada flujo. Esa caducidad ya pasa localmente en el límite exacto. Para probarla después en producción se necesita autorizar mensajes adicionales y dejar sus tokens sin consumir hasta vencer; no cambiar relojes, expiraciones ni base de producción para forzar el resultado.
9. Los correos reales de pago y envío solo deben inspeccionarse cuando existan pedidos con esos eventos reales. No crear pedidos ni registrar pagos/envíos ficticios para obtener esos mensajes.

## Archivos de esta entrega y estado Git

- Modificados: `server/customer-accounts.mjs`, `dist/account.js`, `tests/customer-accounts.test.mjs`, `tests/customer-account-views.test.mjs`.
- Nuevo: `tests/account-token-views.test.mjs`.
- Evidencia nueva: este `README.md`, `test-results.txt`, `email-layout.json`, `verified-local-320.jpg`, `reset-form-local-320.jpg` en `qa/auth-final/`.
- Sin dependencias nuevas ni migraciones. Índice Git sin cambios preparados; ningún commit, push o despliegue realizado. Código y pruebas listos para revisión antes de seleccionar estos archivos para commit.
