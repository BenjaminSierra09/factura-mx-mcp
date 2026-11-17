# Factura MX MCP 🧾

Una aplicación para ayudarte a **solicitar facturas mexicanas (CFDI 4.0) a partir de tickets**. Puedes usar el panel web o conectar un agente mediante MCP. Subes una foto o PDF, revisas los datos detectados y la aplicación busca el portal del emisor para guiar el trámite.

Cada comercio tiene un proceso distinto. Hay atajos para algunos emisores conocidos y un navegador adaptable que inspecciona los formularios de otros portales. **No se garantiza la emisión en todos los comercios**: algunos cambian su sitio, exigen una cuenta o requieren intervención humana.

## ✨ Qué puede hacer

- Leer texto y códigos QR de fotos y PDF. Con una API key personal de OpenAI, también puede usar visión para interpretar imágenes y buscar portales.
- Guardar un perfil fiscal por usuario: RFC, nombre o razón social, código postal, régimen, uso CFDI, correo y constancia de situación fiscal opcional.
- Explorar la primera pantalla del portal, identificar campos, completar datos disponibles y guardar archivos descargados.
- Solicitar una factura por correo cuando el emisor lo pide, usando el SMTP del usuario y un destinatario que éste haya revisado.
- Ofrecer herramientas MCP con tokens personales para consultar tickets y trabajos e iniciar trámites desde un agente.

**Tu intervención sigue siendo necesaria** para revisar datos y destinos, pulsar el control final de envío o emisión y resolver un CAPTCHA si aparece. La aplicación no intenta saltarse CAPTCHA.

## 🚀 Empezar

### Opción A: Docker

```bash
docker compose up --build -d
```

Abre [http://127.0.0.1:8787](http://127.0.0.1:8787), crea una cuenta y completa tu perfil fiscal. El puerto sólo se publica en `127.0.0.1`. El contenedor ejecuta Chromium sin privilegios, con sandbox y el [perfil seccomp publicado por Playwright](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json), cuya atribución está en [los avisos de terceros](THIRD_PARTY_NOTICES.md).

**Respalda el volumen `factura_data` completo.** Contiene la base de datos, los archivos cifrados y `master.key`. Sin esa clave no podrás recuperar tickets, constancias, claves o facturas guardadas.

### Opción B: Node.js local

Requiere Node.js **22.13 o posterior**:

```bash
npm ci
npx playwright install chromium
cp .env.example .env
npm run dev
```

Después abre [http://127.0.0.1:8787](http://127.0.0.1:8787). Cada usuario puede guardar su propia API key de OpenAI; es opcional para la lectura local y necesaria para las funciones de IA. Los modelos se pueden ajustar con `OPENAI_DISCOVERY_MODEL`, `FACTURADOR_VISION_MODEL` y `FACTURADOR_BROWSER_MODEL`.

## 🧾 Solicitar una factura paso a paso

1. **Completa el perfil fiscal.** Escribe RFC, nombre o razón social tal como aparecen ante el SAT, código postal fiscal, régimen y uso CFDI. Puedes subir tu constancia para completar campos vacíos, pero revisa el resultado.
2. **Sube el ticket.** Acepta foto o PDF. La aplicación lee texto y QR localmente y, si configuraste OpenAI, puede analizar la imagen. Corrige cualquier folio, fecha, monto u otro dato mal leído.
3. **Revisa el portal sugerido.** Hay emisores conocidos como Primera Plus, OXXO, marcas de Alsea y La Comer. Para otros, la búsqueda envía sólo el nombre del emisor, sin RFC, ticket ni constancia. Un enlace de QR o un resultado sin respaldo del dominio oficial queda para revisión.
4. **Explora e inicia el trámite.** El navegador inspecciona campos y puede pedir más datos del ticket. Si el portal cambia a otro dominio, te pide revisar el destino antes de compartir datos. **Pulsa personalmente el control final** de envío o emisión en la captura y luego continúa el trámite.
5. **Consulta el resultado.** `completed` indica que se guardó un XML con estructura CFDI 4.0, RFC y UUID, o un PDF con RFC y UUID. Esto **no verifica criptográficamente el sello ni consulta la vigencia ante el SAT**. `submitted` o `email_sent` indican que se envió una solicitud, no que el proveedor ya emitió la factura.

Si aparece un CAPTCHA, resuélvelo desde la captura del panel y continúa. Según el [SAT](https://www.sat.gob.mx/minisitio/Factura/solicita_consideraciones.htm), los datos generales para solicitar CFDI 4.0 son RFC, nombre o razón social, código postal fiscal, régimen y uso CFDI. La constancia y el correo no son requisitos fiscales generales, aunque algunos portales los pueden solicitar.

### Solicitud por correo

Primera Plus publica un [portal de facturación](https://www.facturaelectronicagfa.mx/) y una [dirección para boletos manuales sin token](https://www.primeraplus.com.mx/facturacion/). Si configuras SMTP, la aplicación puede enviar el ticket y los datos fiscales a esa dirección; sólo adjunta la constancia si lo eliges. Para facturas ya emitidas, el portal ofrece recuperación mediante RFC y token.

Para otros emisores, la exploración puede mostrar correos publicados en su portal. **Comprueba que el destinatario sirva para facturación** antes de elegirlo; una dirección de contacto podría ser sólo de soporte. `email_sent` significa que el servidor SMTP aceptó el mensaje. La aplicación no lee automáticamente las respuestas de la bandeja de entrada.

## 🤖 Conectar un agente mediante MCP

En el panel, abre **Conectar MCP**, crea un token y cópialo: se muestra una sola vez. Puedes revocarlo después. Para uso local:

```text
Endpoint: http://127.0.0.1:8787/mcp
Authorization: Bearer fxmcp_...
```

Herramientas disponibles: `perfil_fiscal`, `cargar_ticket`, `listar_tickets`, `listar_portales`, `descubrir_portal`, `explorar_portal`, `iniciar_factura`, `consultar_trabajo` y `listar_trabajos`. `iniciar_factura` acepta detección automática del emisor (`provider: "auto"`), una URL HTTPS revisada, correcciones en `ticketData` y un destinatario de correo revisado en `recipientEmail`.

El token MCP no devuelve la clave de OpenAI, la contraseña SMTP ni el contenido de la constancia. Si publicas el servicio en un subdominio, el panel mostrará automáticamente el endpoint HTTPS correspondiente.

## 🌐 Publicar con Cloudflare Tunnel (opcional)

El archivo `compose.tunnel.yaml` añade un servicio `cloudflared` para publicar el panel y MCP en un subdominio HTTPS, sin abrir un puerto público en el host. Cloudflare [explica cómo crear el túnel y su ruta](https://developers.cloudflare.com/tunnel/get-started/). Wrangler también puede crear y ejecutar túneles, aunque [sus comandos de Tunnel son experimentales](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/); esta aplicación no necesita desplegarse como Worker.

1. **Prepara el acceso.** Crea tu cuenta en el panel local primero. Al activar el túnel, el registro de cuentas nuevas queda desactivado por defecto (`ALLOW_REGISTRATION=false`).
2. **Configura Cloudflare.** Crea un túnel remoto y una ruta publicada para, por ejemplo, `facturas.tudominio.com` hacia `http://factura-mx:8787`. Verifica que el DNS del subdominio apunte al túnel. Conserva el encabezado `Host` público; si configuras `httpHostHeader`, usa el mismo subdominio.
3. **Guarda la configuración.** Copia `.env.tunnel.example` a `.env.tunnel`, escribe el subdominio exacto en `APP_TUNNEL_HOSTNAME`, pega el token del túnel en `CLOUDFLARE_TUNNEL_TOKEN` y ejecuta `chmod 600 .env.tunnel`. Compose lo monta como secreto para el usuario del contenedor. No subas este archivo: [el token permite ejecutar una réplica del túnel](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/).
4. **Inicia los servicios:**

```bash
docker compose --env-file .env.tunnel -f compose.yaml -f compose.tunnel.yaml up --build -d
```

Prueba `https://facturas.tudominio.com/healthz` y entra al panel en ese mismo origen. La configuración activa cookies `Secure` y permite el subdominio elegido. El puerto local sigue ligado a `127.0.0.1`. En un despliegue con muchos usuarios, hay que revisar el límite de inicio de sesión por IP tras el conector y mover OCR y exploración a trabajos asíncronos para evitar tiempos de espera del proxy.

## 🔒 Datos, seguridad y límites

- Los archivos de tickets, constancias, facturas, capturas y secretos se cifran con AES-256-GCM. Usuarios, sesiones, perfil y trabajos se guardan en SQLite; **los campos fiscales del perfil, los datos corregidos del ticket y el historial de trabajos permanecen en la base de datos sin ese cifrado de archivo**. Protege y respalda el volumen o directorio de datos completo.
- El navegador sólo abre portales HTTPS públicos, bloquea redes privadas y desactiva service workers. La comprobación DNS previa no sustituye una política de salida de red del servidor ante cambios de DNS entre validación y conexión.
- Esta instalación está preparada para **una instancia de Node.js**. El navegador mantiene sesiones humanas en memoria. Para varios procesos o servidores hacen falta un worker, una cola persistente, sesiones compartidas y límites compartidos.
- Los portales pueden cambiar, requerir registro o impedir la automatización. El motor adaptable permite probar emisores nuevos, pero **no cubre de forma garantizada miles de negocios**. Las descargas tienen un límite de procesamiento de 30 MB y el contenedor limita `/tmp` a 512 MB.
- El envío de correo requiere SMTP personal con TLS. No incluye lectura automática de respuestas.

**Estado de las comprobaciones del 16 de noviembre de 2026:** se inspeccionó Primera Plus hasta la pantalla de boletos, sin emitir una factura real. OXXO mostró fecha, folio, ID de venta y total en su formulario inicial de solo lectura. La Comer bloqueó la exploración automática con su protección de acceso.

## 🧭 Próximas mejoras

1. Guardar el ticket antes de iniciar OCR y búsqueda, y procesar ambas tareas en segundo plano para resistir esperas y reinicios.
2. Usar una cola persistente y sesiones de navegador recuperables antes de ejecutar varias instancias.
3. Cifrar los campos fiscales guardados en SQLite y ofrecer eliminación y retención configurable de tickets.
4. Mostrar desde MCP un enlace directo al panel cuando un trámite necesite una acción humana.
5. Comprobar la autenticidad y vigencia de cada CFDI ante fuentes oficiales antes de indicar que está verificado.

## 🛠️ Para desarrollar

La API HTTP y el MCP usan **Express 5, TypeScript estricto y Zod**. La interfaz web usa JavaScript sin framework. SQLite guarda el estado; Chromium y Playwright controlan el navegador. Next.js podría servir para una futura interfaz React, pero no sustituye la cola de trabajos ni el servidor MCP.

Las operaciones costosas tienen límites por cuenta configurables: `API_EXPENSIVE_LIMIT` (60 por hora), `API_EXPENSIVE_CONCURRENCY` (2 simultáneas), `API_ACTION_LIMIT` (240 acciones de navegador por 15 minutos) y `API_MCP_LIMIT` (300 solicitudes HTTP por hora). MCP cuenta cada petición al endpoint, incluso `tools/list`.

```bash
npm run check
npm test
npm run build
npm audit --omit=dev
```

Las pruebas incluyen separación de cuentas, CSRF, subida y descarga protegidas, acceso MCP, PDF y QR locales. Para servirlo detrás de un proxy HTTPS distinto de Cloudflare Tunnel, configura `APP_PUBLIC_ORIGIN` y `APP_ALLOWED_HOSTS`, restringe el registro si corresponde y conserva `data/master.key` o define `APP_MASTER_KEY` (64 caracteres hexadecimales). El proceso no debe exponerse directamente a Internet sin proxy TLS y política de salida de red.
