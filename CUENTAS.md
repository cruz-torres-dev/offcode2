# Cuentas por correo y Contacto — OFFCODE

Implementación local para revisión, sin commit, push ni despliegue. Node 24.14.0 y SQLite. No se cambia DATABASE_PATH, ADMIN_PASSWORD, SETTINGS_ENCRYPTION_KEY, credenciales de Envia ni variables reales de Render. Crear una cuenta no habilita ventas.

## Preparación manual

1. Revisar los cambios antes de publicar. El servicio existente puede seguir usando `npm ci` y `npm start`; ya no hay dependencias externas de autenticación.
2. Configurar Resend y un remitente verificado siguiendo OPERACION.md. RESEND_API_KEY, EMAIL_FROM y ORDER_NOTIFICATION_EMAIL son privados. EMAIL_ENABLED sigue desactivado por defecto y solo debe habilitarse conscientemente después de configurar el proveedor.
3. Comprobar PUBLIC_ORIGIN con el origen HTTPS exacto de la tienda. La administración conserva sus credenciales y su sesión independiente.
4. El propietario puede retirar manualmente de Render las antiguas variables GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET y GOOGLE_REDIRECT_URI. El código ya no las utiliza. No se modificó el dashboard.
5. Después de una publicación autorizada, comprobar verificación, recuperación, inicio y cierre con una cuenta propia de prueba. La aceptación del proveedor no prueba recepción en el buzón. No capturar claves, cookies ni enlaces privados.

## Seguridad y continuidad

- Contraseñas de 12–128 caracteres con scrypt N32768/r8/p3, sal aleatoria y comparación constante. Nunca se guardan en texto plano.
- Cookies HttpOnly, SameSite=Lax, Path=/, duración de siete días; en producción Secure y prefijo __Host-. Los tokens de sesión se guardan solo como SHA-256. Al iniciar se rota la sesión; al salir se revoca; cambiar contraseña revoca todas las sesiones del titular.
- Tokens aleatorios de 32 bytes, guardados solo como hash: verificación 24 horas, recuperación 30 minutos, un solo uso. Se consumen transaccionalmente. Los enlaces usan un fragmento que se limpia del historial, sin enviarlo en la petición HTML ni en Referer.
- Límites por IP y por hash de correo; las respuestas de recuperación son iguales para cuentas existentes y ausentes. No se registran destinatarios, contraseñas, tokens ni cuerpo de correo.
- Las rutas retiradas del proveedor anterior devuelven 404 y no redirigen ni crean sesiones. Las tablas históricas de identidades y estados temporales se conservan por compatibilidad del esquema, sin lectores ni escritores activos. No se borran cuentas, sesiones válidas, perfiles o pedidos.
- Un titular antiguo sin contraseña puede usar Recuperar contraseña para acreditar acceso al mismo correo antes de establecerla. No hay contraseña por defecto ni vinculación por coincidencia con pedidos históricos.
- Perfil, dirección y pedidos exigen sesión verificada y se consultan por el ID de esa sesión. Un ID o correo ajeno enviado por el navegador no cambia al titular. El registro no reclama compras invitadas anteriores.
- Solo se vinculan pedidos nuevos creados dentro de la transacción existente con sesión verificada y el mismo correo de compra. Listado limitado a los 100 más recientes, sin CLABE, dirección ni notas privadas. Checkout invitado intacto.

## Correo y Contacto

Registro, verificación y recuperación requieren el transporte Resend existente. Sin configuración se devuelve un error claro; no se simulan entregas. Una cuenta sin verificar puede solicitar otro enlace. Los mensajes son transaccionales y no crean suscripciones comerciales. El outbox de pedidos permanece independiente.

`/contacto.html` recoge correo, mensaje y consentimiento; `/api/contact` valida, escapa HTML, aplica honeypot y limita tres consultas por hora/IP. Destino: ORDER_NOTIFICATION_EMAIL. No se inventan correos oficiales, teléfonos ni horarios.

## Interfaz y datos

Se conserva el header negro, monograma 3D, bolsa existente y panel oscuro de cuenta, sin acceso administrativo en el escaparate. Cuenta ofrece registro, inicio, verificación, recuperación, perfil, pedidos y cierre de sesión exclusivamente por correo.

La migración 2 sigue siendo aditiva e idempotente; no resembra catálogos existentes ni cambia `/var/data/offcode.sqlite`. Revisar el aviso de privacidad y política de conservación de perfiles/direcciones antes de habilitar el uso real. Ninguna prueba usa datos de clientes existentes.

Resultados, galería y recursos: [qa/accounts/README.md](qa/accounts/README.md). La entrega real de correos y la revisión en dispositivos físicos quedan pendientes; las pruebas locales usan Resend simulado y bases temporales.
