import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { Store } from './store.js';
import { OpenRouter } from './ai.js';
import { ingest } from './knowledge.js';
import { Engine } from './engine.js';

const settings = config();
fs.mkdirSync(settings.dataDir, { recursive: true });
fs.mkdirSync(settings.knowledgeDir, { recursive: true });
const store = new Store(path.join(settings.dataDir, 'juntaly.sqlite'));
const ai = new OpenRouter(settings);
const [command, jid] = process.argv.slice(2);
try {
  if (command === 'ingest') {
    console.log(`Índice actualizado: ${await ingest(store, settings, ai)} fragmentos. Reiniciar el bot no es necesario.`);
  } else if (command === 'tickets') {
    console.table(store.tickets());
  } else if (command === 'history' && jid) {
    console.table(store.history(jid, 100));
  } else if (command === 'resume' && jid) {
    store.resume(jid); console.log('Bot reactivado; solicitudes pendientes del chat cerradas.');
  } else if (command === 'pause' && jid) {
    store.handoff(jid, 'support', 'Pausa desde administración local.'); console.log('Bot pausado.');
  } else if (command === 'chat') {
    let chat = 'local-demo';
    const engine = new Engine(store, settings, ai);
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    console.log('Prueba local: no conecta WhatsApp. /new inicia un chat limpio; /salir termina; !bot reactiva; !pausa pausa. Consultas de IA consumen OpenRouter.');
    try {
      while (true) {
        const text = await input.question('Tú: ');
        if (text === '/salir') break;
        if (text.trim() === '/new') {
          chat = `local-demo-${randomUUID()}`;
          console.log('Nueva conversación iniciada, sin historial previo ni pausa.');
          continue;
        }
        if (!text.trim()) continue;
        if (['!bot', '!pausa'].includes(text)) { engine.operator(chat, text); continue; }
        if (store.chat(chat).paused) console.log('[Chat pausado; escribe !bot para reactivar.]');
        await engine.receive({ jid: chat, id: randomUUID(), text }, async (_, reply, { references }) => {
          console.log(`Juntaly: ${reply}`);
          if (references.length) console.log(`\nReferencia: ${references.join('; ')}`);
        });
      }
    } finally { input.close(); }
  } else {
    throw new Error('Comandos: ingest | tickets | chat | history JID | pause JID | resume JID');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { store.close(); }
