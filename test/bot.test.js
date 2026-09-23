import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Engine, HANDOFF, BUDGET_NOTICE } from '../src/engine.js';
import { OpenRouter, validateAnswer } from '../src/ai.js';
import { config } from '../src/config.js';
import { allowedMessage, isDirect, messageText, isMedia, acceptUpsert } from '../src/transport.js';
import { acquireLock } from '../src/lock.js';
import { conversationCategory, salesHandoffRequested } from '../src/conversation.js';

const settings = { dailyLimit: 100, embeddingModel: '' };
const salesAnswer = { reply: 'Juntaly integra administración, acceso, invitados y domótica. ¿Qué necesita tu condominio?', action: 'answer', category: 'sales', sources: [] };
function harness(t, answer = async () => salesAnswer) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const engine = new Engine(store, settings, { answer }, async () => []);
  const sent = [];
  return { store, engine, sent, receive: (text, id = '1', extra = {}) => engine.receive({ jid: 'client', id, text, ...extra }, async (jid, reply) => sent.push({ jid, reply })) };
}
test('saludo no consume IA y duplicados no generan dos respuestas', async t => {
  const h = harness(t, () => { throw new Error('No debe llamar IA'); });
  await Promise.all([h.receive('Hola'), h.receive('Hola')]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].reply, /asistente virtual/);
  assert.equal(h.store.history('client').length, 2);
});
test('solicitud de persona pausa y conserva mensajes posteriores', async t => {
  const h = harness(t);
  await h.receive('Quiero hablar con una persona');
  await h.receive('Mi condominio es Los Pinos', '2');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].reply, HANDOFF.support);
  assert.equal(h.store.tickets().length, 1);
  assert.equal(h.store.chat('client').paused, 1);
  assert.match(h.store.history('client').at(-1).content, /Los Pinos/);
  h.engine.operator('client', '!bot');
  await h.receive('Hola', '3');
  assert.equal(h.sent.length, 2);
  assert.equal(h.store.tickets().length, 0);
});
test('el cliente no puede reactivar mediante !bot', async t => {
  const h = harness(t);
  h.engine.operator('client', '!pausa');
  await h.receive('!bot');
  assert.equal(h.store.chat('client').paused, 1);
  assert.equal(h.sent.length, 0);
});
test('intervención humana descarta respuesta de IA en curso', async t => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness(t, async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = h.receive('Cuéntame sobre Juntaly');
  await ready;
  h.engine.operator('client', 'Hola, soy Ana del equipo de Juntaly');
  release(salesAnswer);
  await pending;
  assert.equal(h.sent.length, 0);
  assert.equal(h.store.chat('client').paused, 1);
});
test('pausar y reactivar durante generación invalida respuesta anterior', async t => {
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness(t, async () => { started(); return new Promise(resolve => { release = resolve; }); });
  const pending = h.receive('Información');
  await ready;
  h.engine.operator('client', '!pausa');
  h.engine.operator('client', '!bot');
  release(salesAnswer);
  await pending;
  assert.equal(h.sent.length, 0);
});
test('dos mensajes del mismo chat se procesan en orden', async t => {
  let active = 0, max = 0;
  const h = harness(t, async () => {
    active++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return salesAnswer;
  });
  await Promise.all([h.receive('Información', '1'), h.receive('Y sus módulos', '2')]);
  assert.equal(max, 1);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.store.history('client').map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
});
test('derivación comercial usa ventas y no inventa notificaciones', async t => {
  const h = harness(t, async () => ({ action: 'handoff', category: 'sales', reason: 'Solicita una demostración.' }));
  await h.receive('Quiero una demo para instalarlo');
  assert.equal(h.store.tickets()[0].category, 'sales');
  assert.equal(h.sent[0].reply, HANDOFF.sales);
});
test('fallo IA deriva sin exponer secretos ni errores del proveedor', async t => {
  const h = harness(t, async () => { throw new Error('SECRET'); });
  await h.receive('Tengo problemas con mi cuenta');
  assert.equal(h.sent[0].reply, HANDOFF.support);
  assert.ok(!JSON.stringify(h.store.history('client')).includes('SECRET'));
});
test('audio recibido se deriva; no se interpreta como texto vacío', async t => {
  const h = harness(t);
  await h.receive('', '1', { media: true });
  assert.equal(h.sent[0].reply, HANDOFF.support);
});
test('envío fallido pausa y crea pendiente sin repetir automáticamente', async t => {
  const h = harness(t);
  await assert.rejects(h.engine.receive({ jid: 'client', id: '1', text: 'Hola' }, async () => { throw new Error('network'); }));
  await h.receive('Hola', '1');
  assert.equal(h.store.chat('client').paused, 1);
  assert.equal(h.store.tickets().length, 1);
  assert.equal(h.sent.length, 0);
});
test('límite diario impide llamadas adicionales, avisa una vez y no pausa el chat', async t => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return salesAnswer; });
  h.engine.settings = { dailyLimit: 1 };
  await h.receive('Información', '1');
  await h.receive('Más información', '2');
  await h.receive('¿Siguen ahí?', '3');
  assert.equal(calls, 1);
  assert.deepEqual(h.sent.map(m => m.reply), [salesAnswer.reply, BUDGET_NOTICE]);
  assert.equal(h.store.chat('client').paused, 0);
  assert.equal(h.store.tickets().length, 1);
  assert.match(h.store.history('client').at(-1).content, /Siguen/);
});
test('el reintento por derivación prematura en ventas cuenta en el límite diario', async t => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return { action: 'handoff', category: 'sales', reason: 'Interés' }; });
  h.engine.settings = { dailyLimit: 1 };
  await h.receive('¿Qué planes tienen?');
  assert.equal(calls, 1);
  assert.equal(h.store.chat('client').paused, 0);
  assert.match(h.sent[0].reply, /sin pasar todavía a un asesor/);
});
test('respuestas técnicas requieren fuentes y se rechazan fuentes inventadas', () => {
  const answer = { ...salesAnswer, category: 'support' };
  assert.equal(validateAnswer(answer, []).action, 'handoff');
  assert.throws(() => validateAnswer({ ...answer, sources: [42] }, []));
  assert.throws(() => validateAnswer({ ...answer, action: 'execute' }, []));
  assert.equal(validateAnswer({ ...answer, sources: [1] }, [{ id: 1 }]).action, 'answer');
});
test('memoria, pausas, deduplicación y ecos sobreviven un reinicio', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juntaly-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.sqlite');
  let store = new Store(file);
  store.record('a', 'user', 'ayuda'); store.pause('a'); store.claim('a', '1'); store.done('a', '1'); store.markOwn('out');
  store.claim('b', '2'); store.close();
  store = new Store(file);
  try {
    assert.equal(store.chat('a').paused, 1);
    assert.equal(store.history('a')[0].content, 'ayuda');
    assert.equal(store.claim('a', '1'), false);
    assert.ok(store.own('out'));
    assert.equal(store.recover(), 1);
    assert.equal(store.chat('b').paused, 1);
    assert.equal(store.tickets().length, 1);
  } finally { store.close(); }
});
test('alias LID y teléfono conservan la pausa al vincularse', t => {
  const h = harness(t);
  const lid = h.store.identity(['123@lid']);
  h.store.pause(lid);
  h.store.identity(['58412@s.whatsapp.net']);
  const merged = h.store.identity(['123@lid', '58412@s.whatsapp.net']);
  assert.equal(h.store.chat(merged).paused, 1);
  assert.equal(h.store.identity(['58412@s.whatsapp.net']), merged);
});
test('modo prueba es cerrado por defecto y respeta LID sin inventar números', () => {
  const cfg = config({});
  assert.equal(allowedMessage(cfg, ['123@lid']), false);
  cfg.allowed.add('123@lid');
  assert.equal(allowedMessage(cfg, ['123:5@lid']), true);
  assert.equal(allowedMessage(cfg, ['123@s.whatsapp.net']), false);
  assert.equal(isDirect('123@g.us'), false);
  assert.equal(isDirect('status@broadcast'), false);
  assert.equal(messageText({ extendedTextMessage: { text: 'hola' } }), 'hola');
  assert.ok(isMedia({ audioMessage: {} }));
});
test('cliente OpenRouter valida JSON y orden de embeddings usando API simulada', async () => {
  const seen = [];
  const ai = new OpenRouter({ apiKey: 'fake', model: 'test', embeddingModel: 'embed' }, async (url, options) => {
    seen.push({ url, body: JSON.parse(options.body) });
    return { ok: true, json: async () => url.endsWith('embeddings') ? { data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] } : { choices: [{ message: { content: JSON.stringify(salesAnswer) } }] } };
  });
  assert.deepEqual(await ai.embed(['a', 'b']), [[1, 0], [0, 1]]);
  assert.equal((await ai.answer([{ role: 'assistant', content: 'Respuesta anterior\n\nReferencia: manual.pdf, pág./diap. 1' }, { role: 'user', content: 'Hola' }], [])).category, 'sales');
  assert.equal(seen[1].body.messages[0].role, 'system');
  assert.ok(seen[1].body.messages[0].content.includes('No inventes'));
  assert.equal(seen[1].body.messages[1].content, 'Respuesta anterior');
});
test('WhatsApp recibe texto limpio y las referencias quedan para el simulador e historial', async t => {
  const reply = 'Toca Áreas Comunes y entra a Nueva Reserva.';
  const h = harness(t, async () => ({ reply, action: 'answer', category: 'support', sources: [1, 2] }));
  h.engine.search = async () => [
    { id: 1, source: 'Reservas.pdf', page: 1, text: 'Nueva Reserva' },
    { id: 2, source: 'Reservas.pdf', page: 1, text: 'Áreas Comunes' },
  ];
  let delivered;
  await h.engine.receive({ jid: 'client', id: '1', text: 'Cómo reservo un área' }, async (jid, text, metadata) => { delivered = { jid, text, ...metadata }; });
  assert.equal(delivered.text, reply);
  assert.deepEqual(delivered.references, ['Reservas.pdf, pág./diap. 1']);
  assert.equal(h.store.history('client').at(-1).content, `${reply}\n\nReferencia: Reservas.pdf, pág./diap. 1`);
});
test('ventas mantiene contexto y bloquea derivación por cantidad o precio incluso si la IA insiste', async t => {
  const h = harness(t, async () => ({ action: 'handoff', category: 'sales', reason: 'Interés en implementar' }));
  const categories = [];
  h.engine.search = async (_, query, settings, ai, context) => { categories.push(context.category); return []; };
  await h.receive('Vi el sistema donde un amigo y quiero ponerlo en mi conjunto', '1');
  await h.receive('tiene como 100', '2');
  await h.receive('que precio tiene', '3');
  assert.deepEqual(categories, ['sales', 'sales', 'sales']);
  assert.equal(h.store.chat('client').paused, 0);
  assert.equal(h.store.chat('client').category, 'sales');
  assert.equal(h.store.tickets().length, 0);
  assert.equal(h.sent.length, 3);
  await h.receive('Quiero hablar con una persona', '4');
  assert.equal(h.store.tickets()[0].category, 'sales');
  assert.equal(h.store.chat('client').paused, 1);
});
test('una pregunta técnica puede salir de ventas y la confirmación requiere oferta previa', () => {
  assert.equal(conversationCategory('No puedo entrar a la app', 'sales'), 'support');
  assert.equal(conversationCategory('tiene como 100', 'sales'), 'sales');
  const history = [{ role: 'assistant', content: '¿Quieres agendar una demo?' }];
  assert.equal(salesHandoffRequested('tiene como 100', history), false);
  assert.equal(salesHandoffRequested('que precio tiene', history), false);
  assert.equal(salesHandoffRequested('sí', history), true);
  assert.equal(salesHandoffRequested('sí', [{ role: 'assistant', content: '¿Son 100 propiedades?' }]), false);
  assert.equal(salesHandoffRequested('Todavía no quiero agendar una demo', history), false);
});
test('el propietario que pregunta por su mensualidad sigue en soporte', () => {
  assert.equal(conversationCategory('¿Cómo pago la mensualidad?', 'support'), 'support');
  assert.equal(conversationCategory('¿Cuánto cuesta Juntaly?', 'support'), 'sales');
});
test('mensajes del operador enviados sin conexión se procesan; los del cliente no', () => {
  assert.equal(acceptUpsert('notify', false), true);
  assert.equal(acceptUpsert('append', true), true);
  assert.equal(acceptUpsert('append', false), false);
});
test('bloqueo de sesión: rechaza otro proceso vivo y reutiliza uno propio o muerto', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juntaly-lock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'bot.lock');
  await fs.writeFile(file, '7');
  assert.throws(() => acquireLock(file, 8, () => true), /Ya hay un bot/);
  const release = acquireLock(file, 7, () => { throw new Error('No debe consultar su propio PID'); });
  assert.equal(await fs.readFile(file, 'utf8'), '7');
  release();
  await fs.writeFile(file, '9');
  acquireLock(file, 8, () => false);
  assert.equal(await fs.readFile(file, 'utf8'), '8');
});
