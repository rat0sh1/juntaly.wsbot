import { retrieve } from './knowledge.js';
import { conversationCategory, salesHandoffRequested } from './conversation.js';

export const HANDOFF = {
  support: 'Dejé tu consulta pendiente para atención técnica y pausé las respuestas automáticas. Una persona podrá continuar por este mismo chat. Puedes dejar el nombre del condominio y una descripción del problema; no compartas contraseñas ni códigos de acceso.',
  sales: 'Dejé tu consulta pendiente para el equipo de ventas y pausé las respuestas automáticas. Una persona podrá continuar por este mismo chat. Puedes dejar tu nombre, condominio y qué necesitas implementar.',
};
// Sin pausa: al renovarse el límite diario el bot vuelve a responder solo.
export const BUDGET_NOTICE = 'Por ahora no puedo responder automáticamente. Dejé tu consulta pendiente para que una persona del equipo la revise por este mismo chat.';
const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function explicitHuman(text) {
  return /^(humano|agente|asesor|persona|soporte humano)[.!?\s]*$/.test(normalize(text).trim()) ||
    /\b(quiero|necesito|puedo|quisiera|deseo)\s+(hablar|contactar|comunicarme)\s+con\s+(un |una |el |la )?(humano|agente|asesor|persona|tecnico|ventas)\b/.test(normalize(text));
}
export class Engine {
  constructor(store, settings, ai, search = retrieve) {
    this.store = store; this.settings = settings; this.ai = ai; this.search = search; this.queues = new Map();
  }
  operator(jid, text = '') {
    const command = text.trim().toLowerCase();
    if (command === '!bot') this.store.resume(jid);
    else {
      this.store.handoff(jid, 'support', 'El operador tomó la conversación.');
      if (command !== '!pausa') this.store.record(jid, 'assistant', text || '[El operador envió un archivo o audio]');
    }
  }
  receive(message, send) {
    const previous = this.queues.get(message.jid) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.process(message, send));
    this.queues.set(message.jid, next);
    void next.finally(() => { if (this.queues.get(message.jid) === next) this.queues.delete(message.jid); }).catch(() => {});
    return next;
  }
  async process({ jid, id, text, media = false }, send) {
    if (!this.store.claim(jid, id)) return;
    const snapshot = this.store.chat(jid);
    const current = () => {
      const chat = this.store.chat(jid);
      return !chat.paused && chat.revision === snapshot.revision;
    };
    try {
      this.store.record(jid, 'user', media ? '[Mensaje multimedia: requiere atención humana]' : text.slice(0, 4000));
      if (snapshot.paused) return;
      const category = conversationCategory(text, snapshot.category);
      this.store.category(jid, category);
      let result;
      let chunks = [];
      if (media) result = { action: 'handoff', category: 'support', reason: 'Audio/imagen/documento entrante: revisar manualmente.' };
      else if (explicitHuman(text)) result = { action: 'handoff', category, reason: 'La persona solicitó atención humana.' };
      else if (text.length > 4000) result = { action: 'handoff', category: 'support', reason: 'Mensaje demasiado largo para el piloto.' };
      else if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches)[!.,\s]*$/.test(normalize(text).trim())) {
        result = { action: 'answer', reply: '¡Hola! Soy el asistente virtual de Juntaly. ¿Necesitas ayuda con la aplicación en tu condominio o información para implementarla?', sources: [] };
      } else if (!this.store.budget(this.settings.dailyLimit)) {
        this.store.ticket(jid, category, 'Se alcanzó el límite diario de consultas de IA del piloto.');
        // Un solo aviso seguido: los mensajes siguientes quedan en el historial para la persona.
        const last = this.store.history(jid).findLast(m => m.role === 'assistant');
        result = last?.content === BUDGET_NOTICE ? { action: 'silent' } : { action: 'answer', reply: BUDGET_NOTICE, sources: [] };
      } else {
        try {
          const history = this.store.history(jid);
          const query = history.filter(m => m.role === 'user').slice(-3).map(m => m.content).join('\n');
          const context = { category, allowSalesHandoff: salesHandoffRequested(text, history) };
          chunks = await this.search(this.store, query, this.settings, this.ai, context);
          result = await this.ai.answer(history, chunks, context);
          if (category === 'sales' && !context.allowSalesHandoff && result.action === 'handoff') {
            if (!current()) return;
            // El reintento también cuenta en el límite diario; sin cupo se usa la aclaración fija.
            if (this.store.budget(this.settings.dailyLimit)) result = await this.ai.answer(history, chunks, { ...context, correctPrematureHandoff: true });
            if (result.action === 'handoff') result = {
              action: 'clarify', category: 'sales', sources: [],
              reply: 'Puedo seguir orientándote sobre Juntaly sin pasar todavía a un asesor. ¿Quieres revisar los planes, lo que incluyen o el proceso de instalación?',
            };
          }
        } catch {
          result = { action: 'handoff', category: 'support', reason: 'No fue posible obtener una respuesta válida de la IA o consultar los documentos.' };
        }
      }
      if (!current()) return; // La intervención humana invalida cualquier respuesta en vuelo.
      if (result.action === 'silent') return;
      let reply;
      let references = [];
      if (result.action === 'handoff') {
        this.store.handoff(jid, result.category, result.reason);
        reply = HANDOFF[result.category];
      } else {
        reply = result.reply;
        references = [...new Set(chunks.filter(c => result.sources?.includes(c.id)).map(c => `${c.source}, pág./diap. ${c.page}`))];
      }
      // send inicia el envío inmediatamente; no debe hacer trabajo asíncrono previo.
      await send(jid, reply, { references });
      const internalReply = references.length ? `${reply}\n\nReferencia: ${references.join('; ')}` : reply;
      this.store.record(jid, 'assistant', internalReply);
    } catch (error) {
      this.store.handoff(jid, 'support', 'Falló el envío o procesamiento. Revisar el chat antes de reactivar.');
      throw error;
    } finally { this.store.done(jid, id); }
  }
}
