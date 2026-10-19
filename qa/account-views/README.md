# Revisión visual de la cuenta de cliente

Capturas generadas contra una instancia local real (`createApp`) con una base
SQLite temporal y datos sintéticos. Chrome headless vía CDP; nada se ejecutó
contra producción y no se creó ningún pedido, correo ni usuario real.

## Qué se comprobó a mano

| Captura | Vista | Comprobación |
| --- | --- | --- |
| `00-invitado.png` | Entrar | Formulario de acceso, sin estado de cuenta filtrado |
| `01-cuenta-escritorio.png` | Tu cuenta | Correo verificado y menú Pedidos/Perfil/Direcciones/Preferencias/Seguridad |
| `02-pedidos-escritorio.png` | Mis pedidos | Solo el pedido del titular: número, fecha, prendas, pago, envío, importe |
| `03-pedido-detalle.png` | Pedido | Artículos con talla y cantidad, importes, guía FedEx real, dirección e historial |
| `04-perfil.png` | Mi perfil | Nombre editable, correo verificado, acceso a cambio de correo y direcciones |
| `05-direcciones.png` | Direcciones | Dos direcciones, una sola predeterminada, acciones Editar/Predeterminada/Eliminar |
| `06-preferencias.png` | Preferencias | Consentimiento comercial separado de los correos transaccionales |
| `07-seguridad.png` | Seguridad | Cierre de sesión y revocación de todas las sesiones (el backend sí las invalida) |
| `08-pedidos-movil.png` | Mis pedidos (390×844) | Cabecera y tarjeta adaptadas sin desbordes |
| `09-direcciones-movil.png` | Direcciones (390×844) | Acciones apiladas y legibles |
| `10-pedidos-vacio.png` | Estado vacío | Mensaje elegante y acceso de vuelta a la tienda |
| `11-dialogo-tienda.png` | Diálogo en la tienda | El menú de cuenta existente sigue funcionando; enlaza a las vistas completas |
| `12-formulario-direccion.png` | Alta de dirección | Formulario completo, foco en el primer campo, validación en servidor |
| `13-checkout-direccion.png` | Checkout | Bloque «Usar esta dirección» solo con sesión verificada y dirección guardada |
| `14-checkout-relleno.png` | Checkout | Tras el clic: campos copiados, consentimiento sin marcar y cotización invalidada |

## Lo que no se comprobó a mano

- Lectores de pantalla reales (solo se verificó estructura, foco y `aria-live`).
- Navegación por teclado con un usuario real (los controles son nativos:
  `a`, `button`, `input`, `form`).
- Envío real de correo: el proveedor está simulado en todas las pruebas.

## Notas

- El 404 de `/favicon.ico` que registra Chrome es previo a este trabajo: el
  sitio no publica un icono.
- Las capturas se regeneran con el arnés local; no forman parte del despliegue.
