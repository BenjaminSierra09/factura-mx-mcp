# Factura Clara 🧾

Una aplicación para ayudarte a **solicitar facturas mexicanas (CFDI 4.0) a partir de tickets**. Puedes usarla desde el navegador, instalarla en tu teléfono como PWA o conectar un agente mediante MCP. Subes una foto o PDF, revisas los datos detectados y la aplicación busca el portal del emisor para guiar el trámite. **No necesitas configurar MCP para usar el panel o la PWA.**

Cada comercio tiene un proceso distinto. Hay atajos para algunos emisores conocidos y un navegador adaptable que inspecciona los formularios de otros portales. **No se garantiza la emisión en todos los comercios**: algunos cambian su sitio, exigen una cuenta o requieren intervención humana.

## ✨ Qué puede hacer

- Leer texto y códigos QR de fotos y PDF. Con una API key personal de OpenAI, también puede usar visión para interpretar imágenes y buscar portales.
- Guardar un perfil fiscal por usuario: RFC, nombre o razón social, código postal, régimen, uso CFDI, correo y constancia de situación fiscal opcional.
- Explorar la primera pantalla del portal, identificar campos, completar datos disponibles y guardar archivos descargados.
- Solicitar una factura por correo cuando el emisor lo pide, usando el SMTP del usuario y un destinatario que éste haya revisado.
- Tomar la foto del ticket desde el teléfono, enviarlo desde la PWA, consultar el avance y atender acciones del portal desde la misma pantalla.
- Ofrecer herramientas MCP con tokens personales para consultar tickets y trabajos e iniciar trámites desde un agente.

**Tu intervención sigue siendo necesaria** cuando faltan datos, el destino no es confiable, el portal pide confirmar el envío final o aparece un CAPTCHA. La aplicación no intenta saltarse CAPTCHA.

## 🚀 Empezar

### Opción A: Docker

Prepara las credenciales de MariaDB antes del primer inicio. Copia el ejemplo, sustituye `DB_PASSWORD` y `DB_ROOT_PASSWORD` por **dos valores aleatorios distintos** (puedes generar cada uno con `openssl rand -hex 32`) y restringe el archivo:

```bash
cp .env.example .env
chmod 600 .env
# Edita .env y cambia DB_PASSWORD y DB_ROOT_PASSWORD por valores aleatorios distintos.
docker compose up --build -d
```

Abre [http://127.0.0.1:8787](http://127.0.0.1:8787), crea una cuenta y completa tu perfil fiscal. Los puertos del panel (`8787`) y MariaDB (`3307`) sólo se publican en `127.0.0.1`; dentro de Compose, la aplicación espera a que MariaDB esté lista. Las contraseñas llegan a ambos contenedores como secretos de Compose. El contenedor de la aplicación ejecuta Chromium sin privilegios, con sandbox y el [perfil seccomp publicado por Playwright](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json), cuya atribución está en [los avisos de terceros](THIRD_PARTY_NOTICES.md).

**Respalda juntos los volúmenes `mariadb_data` y `factura_data`, y conserva las credenciales.** MariaDB guarda usuarios, perfiles, tickets y trabajos; `factura_data` guarda los archivos cifrados y `master.key`. Sin esa clave no podrás recuperar tickets, constancias, claves o facturas guardadas. Cambiar las contraseñas en `.env` después de inicializar el volumen **no cambia** automáticamente las cuentas de MariaDB.

### Opción B: Node.js local

Requiere Node.js **22.13 o posterior**:

```bash
npm ci
npx playwright install chromium
cp .env.example .env
chmod 600 .env
# Edita .env y cambia DB_PASSWORD y DB_ROOT_PASSWORD por valores aleatorios distintos.
docker compose up -d mariadb
npm run dev
```

Antes de iniciar, cambia las dos contraseñas de ejemplo en `.env`. El proceso Node se conecta a MariaDB en `127.0.0.1:3307`; si ya tienes una instancia MariaDB, ajusta `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` y `DB_PASSWORD` y crea la base y el usuario con permisos sobre ella. Después abre [http://127.0.0.1:8787](http://127.0.0.1:8787). Cada usuario puede guardar su propia API key de OpenAI; es opcional para la lectura local y necesaria para las funciones de IA. Los modelos se pueden ajustar con `OPENAI_DISCOVERY_MODEL`, `FACTURADOR_VISION_MODEL` y `FACTURADOR_BROWSER_MODEL`.

### 🔑 Conectar una clave de OpenAI

En **Perfil fiscal → Lectura con IA** puedes pegar una clave existente o abrir [la página oficial de claves de OpenAI](https://platform.openai.com/api-keys) desde el botón del panel:

1. En la pestaña de OpenAI, elige tu proyecto, crea una clave y cópiala. [La clave completa sólo se muestra al crearla](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key).
2. Vuelve a Factura Clara y pulsa **Guardar clave copiada**. El navegador solicitará permiso para leer el portapapeles; si no lo permite, pega la clave en el campo y pulsa **Guardar clave**.
3. El indicador cambiará a **Clave guardada**. La aplicación envía la clave a su servidor y la cifra antes de guardarla; no vuelve a mostrarla.

La documentación oficial no describe un callback que devuelva una clave personal a sitios externos: [la clave sólo se muestra al crearla](https://help.openai.com/en/articles/4936850-where-do-i-find-my-openai-api-key) y [la API de administración no crea claves personales para otros usuarios](https://developers.openai.com/api/docs/guides/api-keys). Abrir la pestaña facilita la creación y el regreso, pero guardar la clave requiere la acción explícita del usuario. «Sign in with ChatGPT» usa OAuth para identidad o acceso autorizado a ciertos servicios, [sin entregar la API key personal](https://developers.openai.com/siwc/quickstart).

### Protección del acceso con reCAPTCHA

Registro e inicio de sesión aceptan **Google reCAPTCHA v2 (casilla «No soy un robot»)**. Crea un par de claves en [Google reCAPTCHA](https://www.google.com/recaptcha/admin/create), registra el dominio donde abrirás el panel y configura `RECAPTCHA_SITE_KEY` y `RECAPTCHA_SECRET_KEY`. Para pruebas locales con Node o Docker, añade `localhost` a una clave separada de desarrollo y guarda ambas variables en `.env`. La clave secreta se usa sólo en el servidor: cada respuesta se valida con Google y se comprueba que el dominio coincida con el de la solicitud. [Google indica que los tokens duran dos minutos y sólo se usan una vez](https://developers.google.com/recaptcha/docs/verify).

En local sin claves, el CAPTCHA queda desactivado. Un origen público configurado en `APP_PUBLIC_ORIGIN` o `APP_ALLOWED_HOSTS` **no arranca sin las dos claves**. Conserva además los límites de intentos del servidor; reCAPTCHA no los reemplaza.
La aplicación permite las [claves de prueba publicadas por Google](https://developers.google.com/recaptcha/docs/faq) sólo en desarrollo local y las rechaza al iniciar un despliegue público.

### Catálogos fiscales y forma de pago

El perfil ofrece selectores para **régimen fiscal** y **uso CFDI**. Las opciones de uso se ajustan al régimen y al tipo de RFC. Los datos corresponden al [catálogo CFDI 4.0 del SAT del 6 de noviembre de 2026](http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/catCFDI_V_4_20261106.xls). La clave **602** no aparece en ese catálogo vigente y por eso no se muestra.

La aplicación también conoce las 22 claves de **forma de pago** (`c_FormaPago`). Éstas son distintas del método de pago PUE/PPD. Lee el ticket y puede sugerir una forma de pago si hay evidencia explícita; también puedes añadir una nota breve, por ejemplo «pagué con tarjeta de débito». Una marca de tarjeta por sí sola no permite distinguir crédito de débito. La sugerencia puede corregirse cuando el trámite requiera revisión; la clave 99 no se asigna por falta de lectura.

## 🧾 Solicitar una factura paso a paso

1. **Completa el perfil fiscal.** Escribe RFC, nombre o razón social tal como aparecen ante el SAT, código postal fiscal, régimen y uso CFDI. Puedes subir tu constancia para completar campos vacíos, pero revisa el resultado.
2. **Sube el ticket.** Acepta foto o PDF. La aplicación lee texto y QR localmente y, si configuraste OpenAI, puede analizar la imagen. También puedes indicar cómo pagaste si el comprobante no lo deja claro.
3. **La aplicación intenta iniciar el trámite.** Detecta emisores conocidos como Primera Plus, OXXO, marcas de Alsea y La Comer, y busca un portal oficial para otros. La búsqueda envía sólo el nombre del emisor, sin RFC, ticket ni constancia. Un enlace de QR o un resultado sin respaldo del dominio oficial queda para revisión. No tienes que elegir manualmente emisor, canal ni token en el flujo normal.
4. **Atiende sólo lo que falte.** Si el perfil, un dato del ticket o el portal no están claros, el panel te pide la corrección necesaria. El navegador inspecciona campos; si cambia a otro dominio, te pide revisar el destino antes de compartir datos. **Pulsa personalmente el control final** de envío o emisión en la captura y luego continúa el trámite.
5. **Consulta el resultado.** `completed` indica que se guardó un XML con estructura CFDI 4.0, RFC y UUID, o un PDF con RFC y UUID. Esto **no verifica criptográficamente el sello ni consulta la vigencia ante el SAT**. `submitted` o `email_sent` indican que se envió una solicitud, no que el proveedor ya emitió la factura.

Si aparece un CAPTCHA, resuélvelo desde la captura del panel y continúa. Según el [SAT](https://www.sat.gob.mx/minisitio/Factura/solicita_consideraciones.htm), los datos generales para solicitar CFDI 4.0 son RFC, nombre o razón social, código postal fiscal, régimen y uso CFDI. La constancia y el correo no son requisitos fiscales generales, aunque algunos portales los pueden solicitar.

### 📱 Usar la aplicación en el teléfono (PWA)

La PWA usa **el mismo panel y la misma cuenta**, sin token ni cliente MCP. Abre el panel en un dominio HTTPS; para probarla en la computadora también funciona en `localhost`. En Android, toca **Agregar a pantalla de inicio** o usa la opción de instalar del navegador. En iPhone, abre la página en Safari, toca **Compartir** y después **Agregar a pantalla de inicio**. Si todavía no has publicado un dominio, puedes probar el panel en la misma computadora; la instalación como PWA fuera de `localhost` requiere HTTPS.

1. Inicia sesión y completa tu perfil fiscal. Guarda tu clave de OpenAI si quieres lectura con IA y exploración de portales nuevos.
2. Abre **Nuevo ticket** y toca **Tomar foto del ticket**. También puedes elegir una imagen o PDF. Al enviarlo, la aplicación intenta iniciar el trámite; si falta un dato, te mostrará qué revisar.
3. Abre **Mis facturas** para ver el estado. Si el portal requiere CAPTCHA, confirmación o datos adicionales, usa la captura interactiva, escribe o pulsa lo necesario y continúa.

La aplicación actualiza el estado mientras está abierta y vuelve a consultarlo al regresar. **Necesitas conexión para enviar tickets, consultar el avance y responder al portal.** La PWA sólo guarda recursos públicos de interfaz para mostrar la pantalla sin conexión; no guarda tickets, constancias, respuestas fiscales ni capturas en su caché y no envía fotos pendientes después. El servidor puede seguir con un trámite mientras cierras la aplicación; vuelve a abrir **Mis facturas** para comprobarlo.

### Solicitud por correo

Primera Plus publica un [portal de facturación](https://www.facturaelectronicagfa.mx/) y una [dirección para boletos manuales sin token](https://www.primeraplus.com.mx/facturacion/). Si configuras SMTP, la aplicación puede enviar el ticket y los datos fiscales a esa dirección; sólo adjunta la constancia si lo eliges. Para facturas ya emitidas, el portal ofrece recuperación mediante RFC y token.

Para otros emisores, la exploración puede mostrar correos publicados en su portal. **Comprueba que el destinatario sirva para facturación** antes de elegirlo; una dirección de contacto podría ser sólo de soporte. `email_sent` significa que el servidor SMTP aceptó el mensaje. La aplicación no lee automáticamente las respuestas de la bandeja de entrada.

## 🤖 Conectar un agente mediante MCP

La sección **Conectar MCP** del panel muestra el endpoint de tu instalación y una guía por cliente. Sigue estos pasos:

1. Inicia sesión en Factura Clara, abre **Conectar MCP** y crea una clave personal. **Cópiala en ese momento**: se muestra una sola vez. Puedes revocarla desde el mismo panel.
2. Elige tu cliente abajo y configura el endpoint junto con la clave. En local, el cliente debe ejecutarse en la **misma computadora** que la aplicación. Para un cliente en otro dispositivo o en la nube, publica primero un endpoint HTTPS, por ejemplo con [Cloudflare Tunnel](#-publicar-con-cloudflare-tunnel-opcional).
3. Comprueba la conexión en el cliente y pide, por ejemplo: «Lista mis tickets de Factura Clara». Si un trámite necesita CAPTCHA, confirmación o datos adicionales, abre **Mis facturas** en el panel o la PWA para responder.

Para uso local, los datos de conexión son:

```text
Endpoint: http://127.0.0.1:8787/mcp
Authorization: Bearer fxmcp_...
```

### Claude Code

Sustituye `TU_ENDPOINT_MCP` por la URL del panel y `TU_CLAVE_MCP` por la clave recién creada:

```bash
claude mcp add --transport http factura-clara --scope user TU_ENDPOINT_MCP \
  --header "Authorization: Bearer TU_CLAVE_MCP"
claude mcp list
```

Dentro de Claude Code, usa `/mcp` para revisar la conexión. `--scope user` mantiene la configuración para tu usuario; protege el archivo privado donde el cliente guarda la clave y no pegues ese comando en un repositorio. [Guía oficial de Claude Code](https://code.claude.com/docs/en/mcp).

### Codex CLI y extensión

Guarda la clave en una variable de entorno **local** llamada `FACTURA_MCP_TOKEN` mediante tu gestor de secretos o la configuración privada de tu equipo; no la añadas al repositorio. Después agrega esto a `~/.codex/config.toml`, sustituyendo la URL por el endpoint mostrado en el panel:

```toml
[mcp_servers.factura_clara]
url = "http://127.0.0.1:8787/mcp"
bearer_token_env_var = "FACTURA_MCP_TOKEN"
```

Reinicia Codex y ejecuta `codex mcp list`; en la interfaz de terminal también puedes usar `/mcp`. La variable debe estar disponible para el proceso de Codex. [Guía oficial de Codex MCP](https://learn.chatgpt.com/docs/extend/mcp).

### Otros clientes MCP HTTP

Usa transporte **Streamable HTTP**, la URL terminada en `/mcp` y el encabezado `Authorization: Bearer TU_CLAVE_MCP`. El cliente debe permitir encabezados personalizados o un token Bearer. Protege la clave y revócala desde el panel si se expone.

**ChatGPT como plugin:** la conexión directa con esta clave personal aún no está disponible. El flujo de autenticación de plugins de ChatGPT requiere OAuth 2.1 para datos privados y no acepta una API key personalizada suministrada por el usuario; Factura Clara todavía no implementa ese flujo. La PWA y los clientes anteriores sí usan las claves actuales. [Autenticación oficial de plugins de OpenAI](https://developers.openai.com/plugins/build/auth).

Herramientas disponibles: `perfil_fiscal`, `catalogos_fiscales`, `sugerir_forma_pago`, `cargar_y_facturar`, `cargar_ticket`, `listar_tickets`, `listar_portales`, `descubrir_portal`, `explorar_portal`, `iniciar_factura`, `consultar_trabajo` y `listar_trabajos`. **`cargar_y_facturar`** sube el ticket e intenta iniciar el trámite en una sola llamada; devuelve el trabajo o el dato que falta. `iniciar_factura` permite correcciones avanzadas en `ticketData`, una URL HTTPS revisada y un destinatario de correo revisado en `recipientEmail`.

El token MCP no devuelve la clave de OpenAI, la contraseña SMTP ni el contenido de la constancia. Si publicas el servicio en un subdominio, el panel mostrará automáticamente el endpoint HTTPS correspondiente.

## 🌐 Publicar con Cloudflare Tunnel (opcional)

El archivo `compose.tunnel.yaml` añade un servicio `cloudflared` para publicar el panel y MCP en un subdominio HTTPS, sin abrir un puerto público en el host. Cloudflare [explica cómo crear el túnel y su ruta](https://developers.cloudflare.com/tunnel/get-started/). Wrangler también puede crear y ejecutar túneles, aunque [sus comandos de Tunnel son experimentales](https://developers.cloudflare.com/workers/wrangler/commands/tunnel/); esta aplicación no necesita desplegarse como Worker.

1. **Prepara el acceso.** El registro público queda activado con reCAPTCHA y límites de intentos. Si sólo quieres cuentas invitadas, crea las cuentas en el panel local y configura `ALLOW_REGISTRATION=false` antes de activar el túnel.
2. **Configura Cloudflare.** Crea un túnel remoto y una ruta publicada para, por ejemplo, `facturas.tudominio.com` hacia `http://factura-mx:8787`. Verifica que el DNS del subdominio apunte al túnel. Conserva el encabezado `Host` público; si configuras `httpHostHeader`, usa el mismo subdominio.
3. **Guarda la configuración.** Copia `.env.tunnel.example` a `.env.tunnel`, escribe el subdominio exacto en `APP_TUNNEL_HOSTNAME`, pega el token del túnel en `CLOUDFLARE_TUNNEL_TOKEN` y las claves de reCAPTCHA v2 en `RECAPTCHA_SITE_KEY` y `RECAPTCHA_SECRET_KEY`. Añade también `DB_PASSWORD` y `DB_ROOT_PASSWORD`: si ya iniciabas con Compose, **usa los mismos valores de `.env`** para conservar el acceso al volumen de MariaDB. Registra ese mismo subdominio en Google reCAPTCHA. Ejecuta `chmod 600 .env.tunnel`. Compose monta los secretos en sus respectivos contenedores. No subas este archivo: [el token permite ejecutar una réplica del túnel](https://developers.cloudflare.com/tunnel/reference/tunnel-tokens/).
4. **Inicia los servicios:**

```bash
docker compose --env-file .env.tunnel -f compose.yaml -f compose.tunnel.yaml up --build -d
```

Prueba `https://facturas.tudominio.com/healthz` y entra al panel en ese mismo origen. La configuración activa cookies `Secure` y permite el subdominio elegido. El puerto local sigue ligado a `127.0.0.1`. Los intentos de acceso se limitan por correo y por IP del conector; antes de usar varias instancias hay que compartir el almacenamiento de límites. OCR y exploración deberán pasar a trabajos asíncronos para evitar tiempos de espera del proxy en un despliegue intensivo.

## 🔒 Datos, seguridad y límites

- Los archivos de tickets, constancias, facturas, capturas y secretos se cifran con AES-256-GCM. Usuarios, sesiones, perfil y trabajos se guardan en MariaDB; **los campos fiscales del perfil, los datos corregidos del ticket y el historial de trabajos permanecen en la base de datos sin ese cifrado de archivo**. Protege y respalda tanto `mariadb_data` como `factura_data`.
- El navegador sólo abre portales HTTPS públicos, bloquea redes privadas y desactiva service workers. La comprobación DNS previa no sustituye una política de salida de red del servidor ante cambios de DNS entre validación y conexión.
- Esta instalación está preparada para **una instancia de Node.js**. El navegador mantiene sesiones humanas en memoria. Para varios procesos o servidores hacen falta un worker, una cola persistente, sesiones compartidas y límites compartidos.
- Los portales pueden cambiar, requerir registro o impedir la automatización. El motor adaptable permite probar emisores nuevos, pero **no cubre de forma garantizada miles de negocios**. Las descargas tienen un límite de procesamiento de 30 MB y el contenedor limita `/tmp` a 512 MB.
- El envío de correo requiere SMTP personal con TLS. No incluye lectura automática de respuestas.

**Estado de las comprobaciones del 16 de noviembre de 2026:** se inspeccionó Primera Plus hasta la pantalla de boletos, sin emitir una factura real. OXXO mostró fecha, folio, ID de venta y total en su formulario inicial de solo lectura. La Comer bloqueó la exploración automática con su protección de acceso.

## 🧭 Próximas mejoras

1. Guardar el ticket antes de iniciar OCR y búsqueda, y procesar ambas tareas en segundo plano para resistir esperas y reinicios.
2. Usar una cola persistente y sesiones de navegador recuperables antes de ejecutar varias instancias.
3. Cifrar los campos fiscales guardados en MariaDB y ofrecer eliminación y retención configurable de tickets.
4. Mostrar desde MCP un enlace directo al panel cuando un trámite necesite una acción humana.
5. Comprobar la autenticidad y vigencia de cada CFDI ante fuentes oficiales antes de indicar que está verificado.

## 🛠️ Para desarrollar

La API HTTP y el MCP usan **Express 5, TypeScript estricto y Zod**. La interfaz web usa JavaScript sin framework. MariaDB guarda el estado; Chromium y Playwright controlan el navegador. Next.js podría servir para una futura interfaz React, pero no sustituye la cola de trabajos ni el servidor MCP.

Las operaciones costosas tienen límites por cuenta configurables: `API_EXPENSIVE_LIMIT` (60 por hora), `API_EXPENSIVE_CONCURRENCY` (2 simultáneas), `API_ACTION_LIMIT` (240 acciones de navegador por 15 minutos) y `API_MCP_LIMIT` (300 solicitudes HTTP por hora). MCP cuenta cada petición al endpoint, incluso `tools/list`.

```bash
npm run check
npm test
npm run build
npm audit --omit=dev
```

`npm test` crea y elimina bases temporales en MariaDB. Con la configuración de Compose usa `DB_PORT` y `DB_ROOT_PASSWORD` de `.env`; si usas otra instancia, configura `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER` y `TEST_DB_PASSWORD` con una cuenta que pueda crear bases de prueba. Nunca apuntes esas pruebas a una base con datos reales.

Las pruebas incluyen separación de cuentas, CSRF, subida y descarga protegidas, acceso MCP, PDF y QR locales, persistencia en MariaDB y actualizaciones simultáneas del perfil. Para servirlo detrás de un proxy HTTPS distinto de Cloudflare Tunnel, configura `APP_PUBLIC_ORIGIN` y `APP_ALLOWED_HOSTS`, restringe el registro si corresponde y conserva `data/master.key` o define `APP_MASTER_KEY` (64 caracteres hexadecimales). El proceso no debe exponerse directamente a Internet sin proxy TLS y política de salida de red.
