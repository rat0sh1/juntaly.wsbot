# Juntaly WhatsApp Bot — piloto por QR

Asistente en español para propietarios de condominios y nuevos interesados en Juntaly.
Usa Baileys para WhatsApp, OpenRouter para IA y SQLite para documentos, conversaciones y pendientes.
La base está implementada; la validación con WhatsApp real, un modelo real y los manuales de Juntaly queda pendiente de configurar la cuenta y aportar los documentos.

## Comportamiento

- **Soporte:** consulta los documentos aprobados, pide información cuando hace falta y deriva cuando no puede resolver. Las referencias al archivo y página/diapositiva se muestran en el simulador local y se conservan en el historial interno; no se agregan a los mensajes de WhatsApp. No ejecuta controles de acceso, aperturas, domótica o cambios de permisos.
- **Ventas:** usa el deck para explicar beneficios, módulos, planes y proceso de implementación. Preguntar cómo instalar Juntaly en otro condominio no pausa el chat: primero informa y consulta la necesidad. Deriva cuando se pide contacto humano, agendar una demo/visita, cotización personalizada o avanzar con la contratación. Los precios y plazos del deck se presentan como referencias sujetas a confirmación, no como cotización definitiva.
- Preguntas de propietarios sobre pagos, recibos, cuotas, reservas o quejas («¿cómo pago la mensualidad?») se tratan como soporte aunque mencionen precios o mensualidad. La conversación conserva su contexto comercial en SQLite, incluso para respuestas cortas como «tiene como 100». Cantidades, datos de contacto y consultas de precio no autorizan una derivación. Si la IA intenta derivar prematuramente, se solicita una corrección; si insiste, el chat permanece activo y pide aclaración. Una consulta técnica explícita cambia al flujo de soporte.
- **Persona:** una solicitud explícita o una decisión de la IA crea un pendiente y pausa el chat. El propietario puede seguir dejando información mientras está pausado.
- **Operador:** responde desde el mismo WhatsApp vinculado (teléfono u otro dispositivo). El bot se pausa al detectar su intervención, incluso si el operador escribió mientras el bot estaba desconectado. Los mensajes de clientes recibidos durante la desconexión no se responden automáticamente. `!pausa` pausa; `!bot` reactiva y cierra los pendientes del chat. Estos comandos se escriben en el chat del cliente y son visibles para él. Para administrar sin enviarlos, usa la CLI local.
- **Fallas de equipos físicos:** un reporte de falla del portón, antenas, luz, agua o vigilancia del edificio («estoy frente al portón y no abre») se deriva de inmediato a atención técnica, sin consultar la IA ni preguntar por la app. Si el mensaje menciona la app o el celular, se trata como consulta de la app con los manuales. Las preguntas hipotéticas («¿qué pasa si se va la luz?») no se derivan.
- **Multimedia entrante:** audios, fotos y archivos del cliente se derivan a una persona. No se agregan a la base de conocimiento ni se envían a la IA.

Los pendientes se consultan localmente con `npm run tickets`. **Este piloto no notifica automáticamente a otro número, no asigna operadores y no tiene bandeja web.** El equipo debe revisar WhatsApp y la lista de pendientes. Antes de atender público real, definir responsables y horarios. Si habrá varios operadores, la siguiente etapa puede integrar una bandeja de atención.

## Inicio en Windows

Requisito: Node.js 24 o superior. Dependencias fijadas en `package-lock.json`.

```powershell
npm.cmd ci
Copy-Item .env.example .env
```

Edita `.env`:

1. Completa `OPENROUTER_API_KEY` con una clave de tu cuenta con saldo/límite de gasto.
2. Configura `OPENROUTER_MODEL` con un modelo de chat disponible que admita respuestas JSON. El ejemplo conserva el identificador usado en el bot anterior; no se ha evaluado todavía con los manuales de Juntaly.
3. Mantén `TEST_MODE=true`. Completa `ALLOWED_JIDS`, por ejemplo `584121234567@s.whatsapp.net`, con tus contactos de prueba. Sin identificadores autorizados puede vincularse por QR, pero no responderá a nadie.

```powershell
npm.cmd start
```

Abre `auth_info/qr.png` y escanéalo desde WhatsApp → Dispositivos vinculados. El archivo se actualiza al renovarse el QR y se elimina al conectar. Si prueba un contacto no autorizado, la consola muestra sus identificadores: puedes agregarlos a `ALLOWED_JIDS` y reiniciar. No conviertas un `@lid` en número de teléfono: son identificadores distintos.

No iniciar dos instancias con la misma sesión o base. El bloqueo de proceso evita dos instancias sobre la misma carpeta de autenticación. Si la sesión se invalida, el bot se detiene (código de salida 0) y conserva los archivos. Revisa los dispositivos vinculados; para una sesión nueva configura otra carpeta `AUTH_DIR`. No borres las credenciales para resolver una desconexión transitoria.

## Cargar manuales y presentaciones

Coloca documentos aprobados para propietarios/clientes en `knowledge/` (puedes usar subcarpetas). No incluyas credenciales ni procedimientos internos que no deban compartirse.

Formatos: PDF con texto, PPTX, Markdown y TXT. Para `.ppt`, exporta a PPTX o PDF.

```powershell
npm.cmd run ingest
```

La indexación reemplaza el índice completo únicamente si todos los archivos se procesan correctamente. Al retirar o modificar un archivo, vuelve a indexar; no hay vigilancia automática de la carpeta. Si queda vacía, se conserva el índice anterior y se muestra un error. No hace falta reiniciar el bot tras una indexación exitosa.

- Sin `OPENROUTER_EMBEDDING_MODEL`, la búsqueda es local por coincidencias de palabras normalizadas. No consume API al cargar documentos.
- Con un modelo de embeddings configurado, la indexación envía los fragmentos a OpenRouter y cada búsqueda envía la consulta. Combina semejanza semántica con coincidencias de palabras. Configura la clave antes de indexar y vuelve a indexar cada vez que cambies el modelo.
- Se recuperan hasta cuatro fragmentos y se envían con los últimos doce mensajes a la IA. El umbral semántico inicial es heurístico: calibrarlo con preguntas reales antes de producción.
- Se conserva la página del PDF y el orden real de las diapositivas del PPTX. **No hay OCR, interpretación de capturas, diagramas, imágenes ni notas del presentador.** Las páginas sin texto generan un aviso; un archivo completamente vacío provoca error y conserva el índice anterior. Revisa la calidad del texto extraído y añade transcripciones cuando sea necesario.
- Para páginas escaneadas revisadas visualmente, un archivo adjunto `nombre.pdf.index.json` puede contener `sha256` del PDF y `pages` (número de página → transcripción). Solo completa páginas sin texto. También admite `exclude: true` y `reason` para un documento incorrecto. Si cambia el PDF, la carga exige revisar ese adjunto antes de indexar. Conserva estos archivos junto a los manuales.
- La búsqueda local pondera términos poco frecuentes y títulos, y distingue móvil/escritorio cuando se indica en la consulta. Incluye un vocabulario pequeño para expresiones como celular/móvil y precio/costo; sigue sin equivaler a búsqueda semántica.
- Límite del piloto: 30 MB por archivo y 10.000 fragmentos. SQLite carga estos fragmentos en memoria para buscar; migrar a una base vectorial si el volumen supera el piloto.

Sin manuales puede explicar los módulos conocidos y solicitar datos; no dispone de procedimientos técnicos de Juntaly. Las validaciones exigen referencias para una respuesta técnica marcada como solución y rechazan IDs inventados; no prueban que cada afirmación esté sustentada. La exactitud debe evaluarse con casos reales.

## Prueba local y administración

```powershell
npm.cmd run chat
npm.cmd run tickets
npm.cmd run admin -- history "123@lid"
npm.cmd run admin -- pause "123@lid"
npm.cmd run admin -- resume "123@lid"
npm.cmd test
```

Usa el JID canónico mostrado por `tickets`. El chat local comienza en `local-demo`: escribe `/new` para iniciar una conversación limpia sin borrar las anteriores, `/salir` para cerrar y `!bot` para reactivar después de una derivación. Comparte la base de datos del entorno y puede consumir OpenRouter, pero no conecta ni envía mensajes por WhatsApp.

`MAX_DAILY_AI_TURNS` limita los turnos que intentan consultar la IA, por día UTC, compartidos entre chats. Al agotarse, el bot envía un único aviso, crea un pendiente y **no pausa** el chat: al día siguiente vuelve a responder solo. Un turno puede realizar una llamada de embeddings y una o dos de chat (el reintento ante una derivación comercial prematura también cuenta); la indexación no cuenta en ese límite y también puede consumir saldo. Configura además un límite monetario en la cuenta de OpenRouter.

El historial y los pendientes se guardan en `data/juntaly.sqlite`. Los mensajes duplicados y ecos del propio bot se reconocen por ID persistente. Las conversaciones se procesan en orden y la intervención de una persona invalida respuestas de IA todavía no enviadas. Un envío que ya salió a WhatsApp no puede cancelarse. Si el proceso termina en mitad de una respuesta, al reiniciar deja ese chat pausado con un pendiente para revisar; no reenvía automáticamente un mensaje de resultado incierto.

Respalda `data/` y `auth_info/` con el bot detenido (incluidos archivos SQLite auxiliares, si existen). No hay política automática de borrado ni cifrado de disco en este piloto; protege el servidor y define retención antes de producción. Estas carpetas, `.env` y los documentos quedan fuera de Git y de la imagen Docker.

## Docker en un VPS (Producción)

El proyecto incluye configuración lista para producción en VPS Linux (Ubuntu/Debian) mediante Docker Compose:
- **Aislamiento total:** Contenedor `juntaly-wsbot`, proyecto `juntalywsbot` y red interna `juntaly_net` para convivir sin conflictos con otros servicios y bots.
- **Sin colisión de puertos:** No mapea puertos al host (la conexión a WhatsApp y OpenRouter es por WebSocket/HTTPS saliente).
- **Límites de recursos:** Protege el VPS limitando la memoria a `350M` y `0.75` vCPUs.
- **Persistencia en el host:** `./auth_info` (sesión Baileys) y `./data` (base SQLite con historial y tickets).
- **Reinicio automático ante caídas:** `restart: on-failure`. Si WhatsApp cierra o reemplaza la sesión, el bot sale con código 0 y **queda detenido** para revisión, en lugar de reintentar sin fin con credenciales inválidas. Revisa `docker compose logs bot` y vuelve a vincular.
- **Código QR directo en terminal:** Los logs muestran el código QR en caracteres ASCII para escanearlo directamente desde la consola SSH sin necesidad de descargar imágenes. Los QR expiran en segundos; no sirven una vez vinculada la sesión.

### Despliegue automático (GitHub Actions)

Cada push a `main` que no sea solo documentación ejecuta `.github/workflows/deploy.yml`: pruebas → imagen en GHCR (`latest` y `sha-<commit>`) → por SSH en el VPS, `git reset --hard` al commit, `docker compose pull` y `up -d` con `IMAGE_TAG=sha-<commit>`.

Requisitos:
- Secrets del repositorio: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `DEPLOY_PATH` (y opcional `VPS_PORT`).
- `DEPLOY_PATH` debe ser un clon de git de este repositorio (paso 1). `.env`, `data/`, `auth_info/` y `knowledge/` están en `.gitignore` y el deploy no los toca.
- El VPS debe tener sesión en GHCR con un token con `read:packages`: `docker login ghcr.io -u rat0sh1`.

Para volver a una versión anterior en el VPS: `IMAGE_TAG=sha-<commit> docker compose up -d --no-build bot`.

### Instalación inicial paso a paso

1. Clona el proyecto en una carpeta dedicada (ej. `/opt/juntalywsbot`):
   ```bash
   sudo git clone https://github.com/rat0sh1/juntaly.wsbot.git /opt/juntalywsbot
   cd /opt/juntalywsbot
   ```

2. Crea las carpetas de persistencia y asigna permisos para el usuario `node` (UID 1000):
   ```bash
   sudo mkdir -p auth_info data knowledge
   sudo chown -R 1000:1000 auth_info data knowledge
   sudo chmod -R 755 auth_info data knowledge
   ```

3. Configura el archivo `.env`:
   ```bash
   cp .env.example .env
   nano .env
   ```

4. Descarga la imagen e indexa manuales (si colocaste archivos en `knowledge/`):
   ```bash
   docker compose pull bot
   docker compose run --rm bot node src/cli.js ingest
   ```

5. Inicia el bot y vincula WhatsApp escaneando el QR en los logs:
   ```bash
   docker compose up -d --no-build
   docker compose logs -f bot
   ```
   *(Escanea el QR desde WhatsApp en tu móvil > Dispositivos vinculados > Vincular un dispositivo).*

### Comandos de administración en Docker

- **Ver logs en tiempo real:**
  ```bash
  docker compose logs -f bot
  ```
- **Consultar tickets o chats derivados a humano:**
  ```bash
  docker compose exec bot node src/cli.js tickets
  ```
- **Reindexar nuevos manuales sin reiniciar el contenedor:**
  ```bash
  docker compose exec bot node src/cli.js ingest
  ```
- **Pausar / reactivar bot en un chat:**
  ```bash
  docker compose exec bot node src/cli.js pause "NUMERO@s.whatsapp.net"
  docker compose exec bot node src/cli.js resume "NUMERO@s.whatsapp.net"
  ```
- **Monitorear uso de recursos (RAM / CPU):**
  ```bash
  docker stats juntaly-wsbot
  ```

## Verificación y origen

Las pruebas usan una API simulada; cubren persistencia, deduplicación, pausa durante una respuesta, reanudación autorizada, límite diario, derivación, extracción de PDF/PPTX, búsqueda y conservación del índice ante errores. No sustituyen una prueba en WhatsApp real ni una evaluación de calidad del modelo.

Diseño basado en los componentes útiles de [cjgWsBot](https://github.com/rat0sh1/cjgWsBot): conexión Baileys, cliente OpenRouter, atención humana y Docker. La implementación separa transporte, conversación y documentos; no incorpora información, números ni credenciales de la otra empresa.

Referencias: [Baileys](https://github.com/WhiskeySockets/Baileys), [OpenRouter RAG](https://openrouter.ai/docs/cookbook/evaluate-and-optimize/rag), [privacidad de proveedores](https://openrouter.ai/docs/guides/privacy/provider-logging).
