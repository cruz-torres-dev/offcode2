# OFFCODE — información necesaria para aprobar las páginas legales

Las rutas `/aviso-de-privacidad.html` y `/condiciones-de-compra.html` están preparadas para revisión local. Ambas muestran ese estado y usan `noindex,nofollow`; no se presentan como documentos definitivos. No se publicaron ni se habilitaron pedidos.

## Datos que debe proporcionar o confirmar el propietario

1. **Responsable y proveedor:** nombre completo de la persona física o razón social que opera OFFCODE y confirmación de que puede identificarse públicamente. La marca, el beneficiario bancario y el nombre del remitente de paquetería no permiten inferir por sí solos esa identidad.
2. **Domicilio para notificaciones y reclamaciones:** dirección completa autorizada para aparecer en ambos documentos. Confirmar si coincide o no con el domicilio fiscal, de recolección o de devoluciones; no se ha reutilizado ninguno como sustituto.
3. **Contacto:** correo de atención, teléfono de atención y correo o medio directo para privacidad/ARCO. Confirmar quién los atiende y que el formulario Contacto recibe efectivamente sus mensajes. Un remitente de correo automático no se ha asumido como buzón de atención.
4. **Atención de datos personales:** persona o área responsable; procedimiento seguro para acreditar identidad y representación; forma de responder y entregar datos; proceso de rectificación, bloqueo, cancelación, oposición y revocación. El formulario actual inicia una consulta y no automatiza estos derechos ni admite adjuntos de identificación.
5. **Conservación y proveedores:** periodos justificados por categoría de datos y obligación legal, eliminación/bloqueo y respaldos; entidades contratadas, ubicaciones del tratamiento, papel de cada proveedor y transferencias necesarias. El código identifica Render, Resend y Envia/FedEx, pero no acredita sus contratos, regiones o prácticas privadas efectivas.
6. **Condiciones comerciales:** tiempo de preparación confirmado; zonas y restricciones reales de cobertura; comunicación de fechas y costos antes de pagar; incidencias, devolución del producto y domicilio autorizado; cambios voluntarios de talla o preferencia, si se ofrecerán; procedimiento y plazos legalmente aplicables de reintegro y de reclamación. No se han inventado ventanas comerciales, penalizaciones ni garantías adicionales.
7. **Precios e información fiscal:** confirmar cómo se muestran los impuestos y el total final; datos fiscales, RFC y procedimiento para comprobantes o CFDI según corresponda. No existe un módulo de facturación automática en la implementación revisada. No hace falta publicar información fiscal distinta de la que legalmente corresponda.
8. **Aprobación y vigencia:** validar el texto final, su fecha efectiva y el medio para notificar cambios. Después de completar y aprobar los documentos, retirar el aviso de revisión y revisar `noindex`; hacerlo mediante una modificación explícita, sin habilitar pedidos como efecto secundario.

## Funcionamiento reflejado en los textos

- Cuenta por correo/contraseña, verificación, recuperación, perfil, direcciones y preferencias comerciales separadas; publicidad sin consentimiento por defecto.
- Pedidos con productos, tallas, cantidades, datos de contacto/entrega e importes. Una solicitud no es pago; la transferencia se confirma manualmente tras verificar el abono.
- FedEx mediante Envia cuando la integración esté habilitada, cobertura y tarifa por cotización, estimación de transporte diferenciada de preparación y guía diferenciada de entrega a paquetería.
- Contacto por correo interceptado en pruebas; cookies de sesión y almacenamiento de pestaña realmente presentes; sin inventar analítica ni publicidad de terceros.
- Conservación y solicitudes de derechos como obligaciones y procedimientos a aprobar, sin prometer un borrado automático inexistente.

## Integración existente y URLs para el panel

El pie público y los enlaces base de checkout apuntan a las rutas locales nuevas. El controlador existente sigue respetando las URLs HTTPS que el propietario haya guardado; una URL configurada prevalece sobre el respaldo local. `app.js` y `checkout.js` conservan ese comportamiento.

El propietario confirmó que por ahora no proporcionará los datos legales. Los documentos permanecen como borradores; las URL no se completan automáticamente. El panel distingue los datos comerciales, las páginas legales, la configuración de Envia y la recepción de pedidos. Mantiene los campos de enlaces porque los usa el checkout; no son requisitos para guardar Envia, consultar estados ni realizar la prueba privada de tarifas. Abrir pedidos sigue sujeto a las validaciones previas y al bloqueo de `ORDERS_ENABLED=false`.

Una vez aprobadas y publicadas, las direcciones que el propietario podrá guardar en los campos existentes son:

- `https://offcode.mx/aviso-de-privacidad.html`
- `https://offcode.mx/condiciones-de-compra.html`

No se guardaron en la configuración real ni se cambió ninguna variable. La prueba automatizada las guarda únicamente en una base aislada de prueba, manteniendo banco y token de Envia y con recepción de pedidos cerrada. Que el formulario acepte una URL no comprueba que su contenido sea jurídicamente suficiente ni autoriza abrir ventas.

## Fuentes oficiales consultadas

- [LFPDPPP, texto vigente, última reforma DOF 14 de noviembre de 2025](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf): contenido mínimo del aviso en el artículo 15 y reglas de derechos, seguridad y comunicación de datos.
- [Decreto de expedición del 20 de marzo de 2025](https://sidof.segob.gob.mx/notas/docFuente/5752569): se usa el régimen vigente; no se atribuye la competencia al extinto INAI.
- [LFPC, texto vigente, última reforma DOF 12 de diciembre de 2025](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf): información de compra a distancia y comercio electrónico, revocación y reclamaciones. El plazo del artículo 56 citado en la página es legal, no una ventana comercial inventada por OFFCODE.
- [Orientación de Profeco para compras en línea](https://www.gob.mx/profeco/articulos/compra-en-linea-sin-problemas?idiom=es).

Los datos y políticas propios de OFFCODE siguen sujetos a confirmación. No se declara que los documentos incompletos estén listos para producción o que basten para acreditar cumplimiento legal.
