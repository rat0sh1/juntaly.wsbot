import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { extract, ingest, retrieve, splitText, cosine, isCommercialQuery } from '../src/knowledge.js';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juntaly-docs-'));
  const store = new Store(':memory:');
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return { dir, store, settings: { knowledgeDir: dir, embeddingModel: '' } };
}
test('indexación y consulta recuperan documento con su página', async t => {
  const { dir, store, settings } = await fixture(t);
  await fs.writeFile(path.join(dir, 'manual.txt'), 'Los invitados deben registrarse previamente con la administración.');
  await fs.writeFile(path.join(dir, 'ventas.md'), 'Juntaly incluye módulos de domótica y administración.');
  assert.equal(await ingest(store, settings, {}, () => {}), 2);
  const result = await retrieve(store, 'registrar invitados', settings, {});
  assert.equal(result[0].source, 'manual.txt');
  assert.equal(result[0].page, 1);
  assert.deepEqual(await retrieve(store, 'astronauta', settings, {}), []);
});
test('reindexar reemplaza archivos retirados y falla sin borrar el índice previo', async t => {
  const { dir, store, settings } = await fixture(t);
  await fs.writeFile(path.join(dir, 'uno.txt'), 'Invitados');
  await ingest(store, settings, {}, () => {});
  await fs.unlink(path.join(dir, 'uno.txt'));
  await assert.rejects(ingest(store, settings, {}, () => {}), /Se conserva/);
  assert.equal(store.chunks()[0].text, 'Invitados');
  await fs.writeFile(path.join(dir, 'dos.txt'), 'Domótica');
  await ingest(store, settings, {}, () => {});
  assert.equal(store.chunks().length, 1);
  assert.equal(store.chunks()[0].source, 'dos.txt');
});
test('PowerPoint extrae texto Unicode, entidades y orden de diapositivas', async t => {
  const { dir } = await fixture(t);
  const zip = new AdmZip();
  zip.addFile('ppt/presentation.xml', Buffer.from('<p:presentation><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>'));
  zip.addFile('ppt/_rels/presentation.xml.rels', Buffer.from('<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>'));
  zip.addFile('ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>Invitados &amp; domótica</a:t></p:sld>'));
  zip.addFile('ppt/slides/slide1.xml', Buffer.from('<p:sld><a:t>Juntaly</a:t><a:t>Administración</a:t></p:sld>'));
  const file = path.join(dir, 'ventas.pptx');
  zip.writeZip(file);
  const result = await extract(file);
  assert.equal(result[0].text, 'Invitados & domótica');
  assert.equal(result[1].text, 'Juntaly Administración');
  assert.equal(result[1].page, 2);
});
test('PDF real de una página conserva contenido y número', async t => {
  const { dir } = await fixture(t);
  const stream = 'BT /F1 12 Tf 40 200 Td (Juntaly soporte propietarios) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  const file = path.join(dir, 'manual.pdf');
  await fs.writeFile(file, pdf);
  const result = await extract(file);
  assert.equal(result[0].page, 1);
  assert.match(result[0].text, /Juntaly soporte propietarios/);
});
test('búsqueda semántica y protección contra modelo incompatible', async t => {
  const { store } = await fixture(t);
  store.replaceKnowledge([{ source: 'manual.pdf', page: 5, text: 'Visitantes', embedding: [1, 0] }], 'embed-a');
  const settings = { embeddingModel: 'embed-a' };
  const ai = { embed: async () => [[1, 0]] };
  assert.equal((await retrieve(store, 'invitados', settings, ai))[0].page, 5);
  await assert.rejects(retrieve(store, 'invitados', { embeddingModel: 'embed-b' }, ai), /Reindexa/);
  assert.throws(() => cosine([1], [1, 0]), /dimensiones/);
});
test('fallo de embeddings conserva índice anterior y divide textos con solapamiento', async t => {
  const { dir, store, settings } = await fixture(t);
  store.replaceKnowledge([{ source: 'anterior.txt', page: 1, text: 'Anterior' }], '');
  await fs.writeFile(path.join(dir, 'nuevo.txt'), 'Nuevo');
  await assert.rejects(ingest(store, { ...settings, embeddingModel: 'test' }, { embed: async () => { throw new Error('offline'); } }, () => {}));
  assert.equal(store.chunks()[0].text, 'Anterior');
  assert.deepEqual(splitText('abcdefghijkl', 6, 2), ['abcdef', 'efghij', 'ijkl']);
});
test('transcripción revisada conserva página y rechaza originales cambiados', async t => {
  const { dir, store, settings } = await fixture(t);
  const file = path.join(dir, 'escaneado.txt');
  await fs.writeFile(file, '');
  await fs.writeFile(file + '.index.json', JSON.stringify({ sha256: createHash('sha256').update('').digest('hex'), pages: { 1: 'Crear una invitación desde Accesos.' } }));
  await ingest(store, settings, {}, () => {});
  assert.equal(store.chunks()[0].source, 'escaneado.txt');
  assert.equal(store.chunks()[0].page, 1);
  await fs.writeFile(file, 'Original nuevo');
  await assert.rejects(ingest(store, settings, {}, () => {}), /cambió el original/);
  assert.match(store.chunks()[0].text, /Crear una invitación/);
});
test('archivo excluido no se indexa ni borra todo el índice', async t => {
  const { dir, store, settings } = await fixture(t);
  store.replaceKnowledge([{ source: 'anterior.pdf', page: 1, text: 'Vigente' }], '');
  const file = path.join(dir, 'incorrecto.txt');
  await fs.writeFile(file, 'Otro tema');
  await fs.writeFile(file + '.index.json', JSON.stringify({ sha256: createHash('sha256').update('Otro tema').digest('hex'), exclude: true }));
  await assert.rejects(ingest(store, settings, {}, () => {}), /No quedaron fragmentos/);
  assert.equal(store.chunks()[0].text, 'Vigente');
});
test('búsqueda prioriza tema específico y respeta plataforma explícita', async t => {
  const { store } = await fixture(t);
  store.replaceKnowledge([
    { source: 'Guia administrativa.pdf', page: 1, text: 'El recibo está activo para activar gastos y notificaciones administrativas.' },
    { source: 'Manual Notificaciones - Movil.pdf', page: 1, text: 'Configurar notificaciones. En Perfil abre Preferencias de Comunicación.' },
    { source: 'Manual Notificaciones - Escritorio.pdf', page: 1, text: 'Configurar notificaciones. En Perfil abre Preferencias de Comunicación.' },
  ], '');
  const result = await retrieve(store, '¿Cómo activo las notificaciones desde el celular?', { embeddingModel: '' }, {});
  assert.equal(result[0].source, 'Manual Notificaciones - Movil.pdf');
  assert.ok(result.every(c => !c.source.includes('Escritorio')));
});
test('interés en instalar en otro condominio recupera el deck completo', async t => {
  const { store } = await fixture(t);
  store.replaceKnowledge([
    { source: 'Deck_Juntaly.pdf', page: 5, text: 'Administración e infraestructura.' },
    { source: 'Deck_Juntaly.pdf', page: 8, text: 'Planes según propiedades.' },
    { source: 'Deck_Juntaly.pdf', page: 9, text: 'Levantamiento técnico antes de instalar hardware.' },
    { source: 'Manual Primer Ingreso - Movil.pdf', page: 1, text: 'Instalar la aplicación en el celular del propietario.' },
  ], '');
  const result = await retrieve(store, 'hola quiero saber como hago para comprar e instalar este sistema en un condominio', { embeddingModel: '' }, {});
  assert.deepEqual(result.map(c => c.page), [5, 8, 9]);
  assert.ok(result.every(c => c.source === 'Deck_Juntaly.pdf'));
  assert.equal(isCommercialQuery('¿Cómo instalo la app en mi celular?'), false);
  assert.equal(isCommercialQuery('Quiero instalar Juntaly en otro condominio'), true);
  assert.equal(isCommercialQuery('Vi el sistema donde un amigo y quiero ponerlo en mi conjunto'), true);
  assert.equal(isCommercialQuery('¿Cómo pago la mensualidad?'), false);
  assert.equal(isCommercialQuery('Quiero poner una queja en el condominio'), false);
  assert.equal(isCommercialQuery('¿Cuánto cuesta reservar el salón?'), false);
  assert.equal(isCommercialQuery('¿Cuánto cuesta Juntaly al mes?'), true);
  assert.equal(isCommercialQuery('¿Qué planes tienen?'), true);
  const followup = await retrieve(store, 'tiene como 100', { embeddingModel: '' }, {}, { category: 'sales' });
  assert.deepEqual(followup.map(c => c.page), [5, 8, 9]);
});
test('la caché de fragmentos se renueva cuando otro proceso reindexa', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'juntaly-cache-'));
  const bot = new Store(path.join(dir, 'db.sqlite'));
  const cli = new Store(path.join(dir, 'db.sqlite'));
  t.after(async () => { bot.close(); cli.close(); await fs.rm(dir, { recursive: true, force: true }); });
  cli.replaceKnowledge([{ source: 'a.txt', page: 1, text: 'uno' }], '');
  const first = bot.chunks();
  assert.equal(bot.chunks(), first);
  cli.replaceKnowledge([{ source: 'b.txt', page: 1, text: 'dos' }], '');
  assert.deepEqual(bot.chunks().map(c => c.source), ['b.txt']);
});
