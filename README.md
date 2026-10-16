# OFFCODE — tienda de prueba

Propuesta visual con fotografías proporcionadas por el usuario. Incluye emblema Of con giro de 360° sobre su eje vertical, cinta animada, catálogo, selector de tallas, ampliación de foto y bolsa de demostración. El emblema es una interpretación tipográfica con profundidad CSS, no un modelo 3D de la prenda. Los originales conservan algunos controles de Instagram visibles.

## Ver en tu computadora
Abre `dist/index.html` en Chrome, Edge, Firefox o Safari. No requiere instalar paquetes. También puedes ejecutar `python -m http.server 8000 --directory dist` desde esta carpeta y visitar http://localhost:8000.

## Publicar en Render
1. Descomprime este proyecto y sube el contenido de la carpeta OFFCODE a un repositorio de GitHub: `dist/`, este README y `render.yaml` deben quedar en la raíz del repositorio.
2. En Render elige New > Static Site y conecta ese repositorio.
3. Branch: la rama donde subiste los archivos (normalmente main).
4. Build Command: `echo Static site ready`
5. Publish Directory: `dist`
6. Crea el sitio y espera la URL de Render.

También se incluye render.yaml para la opción de despliegue mediante Blueprint. Documentación: https://render.com/docs/static-sites

## Editar
- `dist/index.html`: textos, enlaces, contenido y productos.
- `dist/styles.css`: colores, tamaños, diseño adaptable y giro 360°.
- `dist/app.js`: tallas y bolsa temporal (se vacía al recargar).
- `dist/assets/`: fotografías originales de la marca.

## Antes de vender
Esta prueba no incluye cobros, pedidos persistentes, base de datos ni inventario real. Precio tomado del HTML proporcionado: $1,650 MXN, precio anterior $2,099 MXN; debe reconfirmarse antes de vender. Tallas S/M/L/XL tomadas del catálogo; disponibilidad pendiente de confirmar. Hace falta confirmar precios, tallas, materiales, políticas de cambios/envíos y conectar servicios de comercio antes de aceptar ventas.

## Verificación
Se verificaron la sintaxis JavaScript, las rutas de los recursos y la estructura HTML. No se realizó una prueba visual en navegador en el entorno de creación. El proyecto no se ha desplegado en Render.

## Actualización de galería
Se añadieron fotos de frente, espalda y detalle con miniaturas, flechas y ampliación. Selector de cantidad de 1 a 99 y subtotal de bolsa calculado a $1,650 MXN por unidad. Se conserva el giro del emblema.

Para actualizar una instalación existente: copia el contenido de esta carpeta sobre la carpeta local OFFCODE y acepta reemplazar archivos. Desde la terminal de OFFCODE ejecuta `git add dist README.md`, luego `git commit -m "Agrega galeria y precio de la sudadera"` y finalmente `git push`. Render actualizará el sitio si el despliegue automático está activado.
