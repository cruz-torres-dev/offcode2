# OFFCODE — LA AFRO × OFFCODE

Tienda estática de demostración para el repositorio **cruz-torres-dev/offcode2**. No procesa cobros, pedidos, inventario ni envíos. La bolsa vive en memoria y se vacía al recargar. Precio de referencia: **$1,650 MXN**, precio anterior **$2,099 MXN**; tallas S, M, L y XL como selección de prueba.

## Probar localmente

Desde esta carpeta en PowerShell:

```powershell
python -m http.server 8000 --directory dist
```

Visita http://localhost:8000. Detén el servidor con Ctrl+C. Usa HTTP local: abrir directamente `index.html` con `file://` puede impedir la carga del módulo 3D. La silueta estática seguirá disponible.

No se necesita npm, instalación de dependencias ni compilación para servir o publicar el sitio. Requiere un navegador moderno con soporte para módulos y dialog; el 3D usa WebGL.

## Archivos

- `dist/index.html`: portada, galería, producto, video, navegación y diálogos accesibles.
- `dist/styles.css`: composición editorial, paleta neutra, diseño adaptable y alternativa de movimiento reducido.
- `dist/app.js`: galería, ampliación, menú móvil, tallas, cantidad de 1 a 99, bolsa y controles de video.
- `dist/logo.js`: carga del modelo original, acabado metálico suavizado, pausa/reanudación, manejo de errores y prefers-reduced-motion.
- `dist/assets/`: recursos locales; no depende de enlaces temporales de Instagram.
- `dist/assets/vendor/model-viewer.min.js`: biblioteca oficial `@google/model-viewer` **4.1.0**, incluida localmente, con licencia Apache 2.0 en `model-viewer.LICENSE`.
- `render.yaml`: configuración estática existente, conservada.
- `qa/`: capturas de revisión, fuera del directorio publicado.

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

## Verificación realizada

Chrome de escritorio y vistas adaptables de **390 × 844** y **320 × 740**:

- Portada y logo original visibles, giro con volumen y botón de pausa/reanudación.
- Menú móvil abre, navega y cierra; enlace de marca vuelve al inicio.
- Miniaturas, flechas y ampliación frente/espalda/detalle.
- Selección de talla y límites de cantidad 1–99.
- Dos prendas L → $3,300 MXN; dos S más una XL → $4,950 MXN.
- Quitar productos → subtotal correcto; bolsa vacía → $0 y botón desactivado.
- Prueba de pedido muestra aviso de que no se creó un pedido ni se realizó un cobro.
- Reproducción y pausa del video, dimensiones nativas correctas y modo silencioso.
- Sin desbordamiento horizontal en los anchos revisados; recursos locales sin rutas faltantes.
- `node --check dist/app.js`, `node --check dist/logo.js` y `git diff --check`.

La preferencia de movimiento reducido y el manejo de fallos están implementados y revisados en código; no se cambió la configuración del sistema ni se simuló la pérdida de WebGL. No se probó en dispositivos físicos, Safari ni Firefox. No se realizó despliegue.

## Subir a offcode2 cuando lo decidas

El remoto existente es `https://github.com/cruz-torres-dev/offcode2.git`. Esta entrega no ejecuta commit, push ni despliegue.

Revisa primero:

```powershell
git status
git diff --stat
git remote -v
```

Para guardar y subir después de tu revisión:

```powershell
git add dist README.md qa
git commit -m "Mejora tienda OFFCODE con monograma 3D original y campaña local"
git push origin HEAD
```

**Si Render ya tiene despliegue automático conectado a la rama actual, ese push puede publicar el sitio.** Revisa esa configuración antes de ejecutarlo.

Render conserva estos valores: tipo Static Site, Build Command `echo Static site ready`, Publish Directory `dist`. No agregues comandos npm. También puede usarse el `render.yaml` existente como Blueprint. Para revisar sin desplegar, mantén los cambios localmente o súbelos a una rama sin despliegue automático.

## Última pasada de acabado

- Encuadre superior de las dos fotografías de portada para conservar completas las cabezas en escritorio; se mantiene el encuadre específico de móvil.
- Video de campaña a todo el ancho útil en móvil, después de las dos fotos editoriales, con botón de al menos 44 px de alto.
- Portada WebP: frente 640 px ≈ 57 KB / 1170 px ≈ 152 KB; espalda ≈ 46 KB / 97 KB. Los JPEG originales se conservan como alternativa.
- Revisión adicional en Chrome de escritorio y vistas móviles; reproducción y pausa verificadas de nuevo. No se midió rendimiento en una red móvil real ni se revisó en un teléfono físico.
