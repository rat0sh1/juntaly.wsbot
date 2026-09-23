import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, generateMessageIDV2, normalizeMessageContent } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { config } from './config.js';
import { Store } from './store.js';
import { OpenRouter } from './ai.js';
import { Engine } from './engine.js';
import { isDirect, normalizeJid, allowedMessage, messageText, isMedia, acceptUpsert } from './transport.js';
import { acquireLock } from './lock.js';

const settings = config();
if (!settings.apiKey || !settings.model) throw new Error('Configura OPENROUTER_API_KEY y OPENROUTER_MODEL en .env antes de iniciar WhatsApp.');
fs.mkdirSync(settings.dataDir, { recursive: true });
fs.mkdirSync(settings.authDir, { recursive: true });
process.on('exit', acquireLock(path.join(settings.authDir, 'bot.lock')));
const store = new Store(path.join(settings.dataDir, 'juntaly.sqlite'));
const engine = new Engine(store, settings, new OpenRouter(settings));
const recovered = store.recover();
if (recovered) console.log(`${recovered} chats interrumpidos quedaron pendientes para revisión humana.`);
if (settings.testMode) console.log(`MODO PRUEBA: ${settings.allowed.size} identificadores autorizados. Los demás no recibirán respuestas.`);
if (!store.chunks().length) console.log('Sin manuales indexados: solo orientación comercial básica; el soporte sin evidencia se deriva.');
const qrPath = path.join(settings.authDir, 'qr.png');
let socket;
let stopped = false;
let retry;
let delay = 3000;
const incomingTasks = new Set();
let identityQueue = Promise.resolve();

function reconnect() {
  if (stopped || retry) return;
  retry = setTimeout(() => { retry = undefined; void connect().catch(() => { console.error('Falló la conexión; se reintentará.'); reconnect(); }); }, delay);
  delay = Math.min(delay * 2, 60000);
}
async function shutdown(code = 0) {
  if (stopped) return;
  stopped = true;
  clearTimeout(retry);
  socket?.ev.removeAllListeners('messages.upsert');
  await Promise.allSettled([...incomingTasks]);
  socket?.ev.removeAllListeners('connection.update');
  socket?.end(undefined);
  store.close();
  process.exitCode = code;
}
async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(settings.authDir);
  if (stopped) return;
  const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), syncFullHistory: false,
    markOnlineOnConnect: false, shouldIgnoreJid: jid => !isDirect(jid) });
  socket = sock;
  sock.ev.on('creds.update', () => void saveCreds().catch(() => { console.error('No se pudieron guardar las credenciales.'); void shutdown(1); }));
  sock.ev.on('connection.update', update => {
    if (update.qr && !stopped) {
      // Escritura síncrona del PNG al terminar la conversión, sin publicar el QR en un servidor.
      void QRCode.toBuffer(update.qr, { scale: 8 }).then(buffer => {
        if (!stopped && socket === sock) { fs.writeFileSync(qrPath, buffer, { mode: 0o600 }); console.log(`Escanea el QR en ${qrPath} desde WhatsApp > Dispositivos vinculados.`); }
      }).catch(() => console.error('No se pudo generar el QR.'));
    }
    if (update.connection === 'open') {
      delay = 3000;
      fs.rmSync(qrPath, { force: true });
      console.log('Juntaly conectado a WhatsApp.');
    }
    if (update.connection === 'close') {
      sock.ev.removeAllListeners();
      const code = update.lastDisconnect?.error?.output?.statusCode;
      if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.forbidden].includes(code)) {
        console.error(`Sesión detenida (${code}). Revisa WhatsApp. Se conservaron las credenciales; para vincular de nuevo usa otra AUTH_DIR.`);
        void shutdown(1);
      } else reconnect();
    }
  });
  sock.ev.on('messages.upsert', event => {
    if (stopped) return;
    for (const msg of event.messages) {
      if (!acceptUpsert(event.type, msg.key.fromMe)) continue;
      // Serializa solo resolución de identidad; el motor tiene su propia cola por conversación.
      const prepare = identityQueue.catch(() => {}).then(() => prepareMessage(sock, msg));
      identityQueue = prepare.then(() => {}, () => {});
      const task = prepare.then(work => work?.());
      incomingTasks.add(task);
      void task.catch(() => console.error('Error procesando un mensaje. Consulta las solicitudes pendientes.'))
        .finally(() => incomingTasks.delete(task));
    }
  });
}
async function prepareMessage(sock, msg) {
  const remote = normalizeJid(msg.key.remoteJid);
  if (!isDirect(remote) || !msg.key.id || !msg.message) return;
  if (msg.key.fromMe && store.own(msg.key.id)) return;
  const content = normalizeMessageContent(msg.message);
  const text = messageText(content);
  const media = isMedia(content);
  if (!text && !media) return; // Reacciones, recibos y eventos de protocolo no son consultas.
  const ids = [remote, normalizeJid(msg.key.remoteJidAlt)].filter(isDirect);
  if (remote.endsWith('@lid')) {
    const phone = await sock.signalRepository.lidMapping.getPNForLID(remote).catch(() => null);
    if (phone) ids.push(normalizeJid(phone));
  }
  if (!allowedMessage(settings, ids)) {
    console.log(`Contacto fuera de prueba: ${ids.join(', ')}. Agrégalo a ALLOWED_JIDS y reinicia si corresponde.`);
    return;
  }
  const jid = store.identity(ids);
  if (msg.key.fromMe) {
    if (!store.claim(jid, msg.key.id)) return;
    engine.operator(jid, text);
    store.done(jid, msg.key.id);
    console.log(text.trim().toLowerCase() === '!bot' ? 'Bot reactivado por operador.' : 'Conversación pausada por intervención humana.');
    return;
  }
  return () => engine.receive({ jid, id: msg.key.id, text, media }, (_, reply) => {
    const id = generateMessageIDV2(sock.user?.id);
    store.markOwn(id); // Registrar ANTES de enviar evita confundir el eco con una persona.
    return sock.sendMessage(remote, { text: reply }, { messageId: id });
  });
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
await connect().catch(() => { console.error('No se pudo conectar. Se reintentará.'); reconnect(); });
