# OFFCODE — preparación independiente de Envia

Cambios locales para revisión. No se modificaron variables, credenciales, datos bancarios ni la configuración de producción. No se compraron guías, no se realizaron cargos y no se habilitaron pedidos. Los documentos legales continúan como borradores hasta que el propietario pueda completar y aprobar sus datos.

## Qué bloqueaba cada operación

La implementación anterior ya permitía guardar una configuración incompleta con pedidos y Envia desactivados, y consultar el catálogo desde `/api/admin/envia/check` con el token guardado. Las URL legales no eran obligatorias para esas dos operaciones. Sin embargo, el checklist agrupaba contacto, transferencia y páginas legales en un único estado, y la cotización de checkout exigía tener abiertos los pedidos.

Ahora se muestran por separado acceso, cifrado, datos de transferencia, enlaces legales, datos de Envia, entorno y recepción de pedidos. Las URL se conservan porque las utilizan el pie y el checkout. No se completan automáticamente con los borradores ni con enlaces ficticios. Su ausencia no bloquea el guardado de preparación, el catálogo ni la nueva prueba privada de tarifas.

La nueva ruta autenticada `POST /api/admin/envia/rates` usa la configuración guardada y se puede probar desde el panel con `ORDERS_ENABLED=false` e incluso con la integración pública de Envia desactivada. Solo consulta estados y `/ship/rate/`. No crea cotizaciones utilizables por el checkout, pedidos, reservas, movimientos de inventario o trabajos de guía. El destino no se guarda en OFFCODE; sí se transmite a Envia para cotizar. El precio declarado se obtiene del catálogo, nunca de un importe proporcionado por el navegador. Un cambio concurrente de configuración invalida el resultado.

Se mantienen la autenticación del propietario, la protección de origen, el límite de solicitudes y las validaciones del domicilio y del empaque. La ruta pública de tarifas y la recepción de pedidos conservan sus bloqueos. Guardar o cotizar no cambia `ORDERS_ENABLED`, las casillas de activación ni la confirmación manual de transferencias.

## Una sola fuente de origen

En el arranque, el servidor lee la fila cifrada de configuración del propietario. Si existe, utiliza su configuración completa, incluido `envia.sender`, su entorno, token y empaques. Solo cuando no existe esa fila utiliza las variables iniciales, entre ellas `ENVIA_ORIGIN_JSON` y `ENVIA_PACKAGES_JSON`.

Por tanto, si la clave ya se guardó en el panel, se conserva dejando vacío el campo de nuevo token. El domicilio debe completarse en ese mismo panel y guardarse allí; no es necesario duplicarlo en las variables de Render. Modificar `ENVIA_ORIGIN_JSON` no sustituiría un domicilio de la configuración cifrada ya guardada. No se borra ni se sincroniza automáticamente ninguna de las dos fuentes, y no se crea una configuración adicional de origen para la prueba.

## Formato exacto de ENVIA_ORIGIN_JSON

Es un objeto JSON, no un arreglo ni un objeto con una propiedad exterior `origin`. Se utiliza únicamente como configuración inicial si todavía no hay una configuración cifrada guardada. Esta es su estructura, con valores vacíos deliberados; **no es un domicilio válido ni debe copiarse como configuración de producción**:

```json
{
  "name": "",
  "phone": "",
  "email": "",
  "street": "",
  "number": "",
  "district": "",
  "city": "",
  "state": "",
  "country": "MX",
  "postalCode": "",
  "company": "",
  "reference": ""
}
```

Campos obligatorios para cotizar:

- `name`: nombre real del remitente; no se infiere la identidad legal del responsable a partir de este campo.
- `phone`: teléfono real con código de país, entre 10 y 15 dígitos; el panel admite `+` inicial.
- `email`: correo real del remitente.
- `street`: calle de origen.
- `number`: número exterior e interior cuando corresponda.
- `district`: colonia.
- `city`: ciudad o municipio.
- `state`: código de dos letras mayúsculas devuelto por el catálogo de estados de **Envia** para México. No se debe inventar ni deducir de un código ISO de tres letras.
- `country`: `MX`.
- `postalCode`: código postal real de cinco dígitos, coherente con el domicilio.

`company` y `reference` son opcionales. El panel limita los campos a 150 caracteres y las referencias a 300. Para una variable inicial, el JSON se guarda en una sola línea válida, sin valores ficticios. No se cambió esa variable en esta tarea.

El empaque se guarda en `envia.profiles` del mismo panel. Solo sin configuración cifrada se utiliza `ENVIA_PACKAGES_JSON`: un objeto cuyas claves son cantidades totales de prendas entre `1` y `99`; cada valor contiene `weight` numérico en kg y `dimensions` con `length`, `width`, `height` numéricos en cm. El peso admite de 0.01 a 1000 kg y cada dimensión de 0.1 a 300 cm. Deben ser medidas reales del paquete cerrado. No se supone que dos prendas tengan el doble de dimensiones o peso de una; una cantidad sin perfil no se cotiza.

## Entorno y credenciales

- `production` selecciona `https://api.envia.com` y `https://queries.envia.com`.
- `sandbox` selecciona `https://api-test.envia.com` y `https://queries.test.envia.com`.
- Envia documenta tokens separados para cada entorno. El servidor conserva su protección: cambiar de entorno no reutiliza silenciosamente el token del anterior. Esta tarea no cambia el entorno ni sustituye la clave existente.
- La consulta del catálogo identifica el entorno consultado, pero no se presenta como prueba suficiente de autenticación para tarifas. Una tarifa satisfactoria verifica que el token y esa ruta pueden cotizar ese paquete en ese momento; no acredita toda la cobertura ni prueba la compra de guías.
- La prueba muestra expresamente si son tarifas de producción o de sandbox. Ningún resultado de sandbox se declara validación de producción.

## Diagnóstico de acceso real y datos pendientes

En este workspace no hay `.env` privado. El proceso de esta sesión no dispone de `ENVIA_TOKEN`, `ENVIA_ENVIRONMENT`, `ENVIA_ORIGIN_JSON`, `ENVIA_PACKAGES_JSON`, `SETTINGS_ENCRYPTION_KEY` ni `DATABASE_PATH`. La única base local encontrada es `data/preview.sqlite`; se inspeccionó en modo de solo lectura y no tiene tabla de configuración del propietario. No se abrió mediante el servidor ni se migró. Esto no demuestra que falten la clave o el domicilio en Render: su configuración privada no está disponible aquí.

**No se ejecutó una cotización real.** No hay origen, empaque ni destino reales disponibles en esta sesión y no puede verificarse desde aquí la correspondencia del token guardado con producción. No se solicitó otra clave ni se utilizó una dirección sintética contra la API real. Las pruebas interceptan todas las solicitudes de Envia con respuestas simuladas.

Para realizar la cotización real, todavía debe comprobarse en la configuración guardada del servidor:

1. Origen: nombre, teléfono, correo, calle, número, colonia, ciudad/municipio, estado del catálogo de Envia y código postal. Ninguno de sus valores reales es verificable desde esta copia local; no se afirma que todos estén vacíos en producción.
2. Paquete de la cantidad que se probará: peso y tres medidas reales del bulto listo para entregar.
3. Destino real autorizado de prueba: nombre, teléfono, correo, calle y número, colonia, ciudad/municipio, estado del catálogo y código postal.
4. Prenda y cantidad para obtener del catálogo el valor declarado, y perfil correspondiente a esa cantidad. La prueba privada no exige contar o modificar el inventario.
5. Entorno guardado `production` y que el token **ya guardado** sea el correspondiente. No volver a pedirlo ni copiarlo a logs. Si el entorno no coincide, revisar la configuración existente antes de intentar una consulta; no eludir la protección de cambio de entorno.

No se necesitan la identidad legal del responsable, el RFC o las URL legales para esta prueba. Su aprobación sigue pendiente para el lanzamiento comercial.

Una vez disponible el acceso al panel con esta versión y completados esos datos, consultar el catálogo, guardar el origen y empaque en su configuración actual y ejecutar «Consultar tarifa privada de FedEx». Mantener los pedidos cerrados. No utilizar acciones de compra de guía ni el flujo de pedidos para esta comprobación.

## Fuentes oficiales

- [Cotización de tarifas y requisitos de origen, destino y paquete](https://docs.envia.com/reference/shipping-rates).
- [Entornos, autenticación y separación entre cotizar y comprar una guía](https://docs.envia.com/docs/envia-shipping-api-introduction).
- [Códigos de estado y comprobación de direcciones](https://docs.envia.com/docs/faqs).

## Archivos de esta entrega local

Desacoplamiento de Envia:

- `dist/settings.html`
- `dist/settings.js`
- `server/owner-settings.mjs`
- `server/server.mjs`
- `tests/envia-preparation.test.mjs`
- `tests/envia-preparation-browser.mjs`
- `ENVIA-PREPARACION.md`

Preparación legal conservada como borrador de la petición anterior:

- `dist/index.html`
- `dist/checkout.html`
- `dist/aviso-de-privacidad.html`
- `dist/condiciones-de-compra.html`
- `dist/legal.css`
- `tests/legal-pages.test.mjs`
- `tests/legal-browser.mjs`
- `LEGAL-PARA-APROBACION.md`

Los cambios anteriores en `qa/load-local.json` y las carpetas `qa/account-views/`, `qa/accounts/`, `qa/auth-final/` y `qa/viewer-final/` son preexistentes y no forman parte de esta implementación. Se conservaron sin modificación. Las evidencias nuevas se guardaron fuera del repositorio, en una carpeta temporal de esta tarea.

## Pruebas

`tests/envia-preparation.test.mjs` cubre separación de estados; guardado sin URL y conservación del token/origen; permisos y origen; versiones; tarifas con pedidos e integración pública cerrados; precio del catálogo; ausencia de escrituras; datos faltantes; protección de entorno y requisitos de compra; errores sin secretos; y cambios concurrentes. Las direcciones y claves de estas pruebas son sintéticas, en bases aisladas.

`tests/envia-preparation-browser.mjs` comprueba el formulario real, el token guardado sin volver a introducirlo, el origen único guardado, tarifas y pantalla sin desbordamiento a 320, 360, 390, 430 y 1280 px. Se complementa con la suite existente y las pruebas de páginas legales. Los resultados finales se entregan junto con esta revisión; estas pruebas no equivalen a una cotización real ni a validación en Render.

Resultados finales locales:

- `npm test`: 114 aprobadas, 0 fallidas, 0 omitidas.
- Navegador, preparación de Envia: 6 aprobadas, 0 fallidas; tarifas interceptadas y simuladas.
- Navegador, páginas legales y guardado de URL: 8 aprobadas, 0 fallidas.
- Sin errores de JavaScript ni desbordamiento horizontal en los anchos comprobados. Las sondas iniciales sin sesión reciben el 401 previsto.
- Sintaxis y `git diff --check`: correctos. Los 46 archivos pendientes de QA incluidos en la captura inicial conservan su hash SHA-256, incluido `qa/load-local.json`.
- Rama `main`, HEAD `01ef0cbd2fccc0816d176aab3130c6a0871f8fd3`, sin nuevos commits ni archivos preparados para commit.
