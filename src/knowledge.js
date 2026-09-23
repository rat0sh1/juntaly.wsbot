import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';

const stopwords = new Set('a al algo como con cual cuando de del el en es esta este esto favor ha hay la las le lo los me mi mis muy no o para pero por porque puede que se si sin sobre su te tengo un una y yo'.split(' '));
export function tokens(text) {
  return [...new Set(text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]{2,}/g) || [])].filter(x => !stopwords.has(x));
}
export function splitText(text, size = 1400, overlap = 200) {
  if (size <= overlap || overlap < 0) throw new Error('Tamaño de fragmento inválido.');
  const clean = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += size - overlap) {
    chunks.push(clean.slice(i, i + size));
    if (i + size >= clean.length) break;
  }
  return chunks;
}
function xmlTexts(node, result = []) {
  if (Array.isArray(node)) for (const item of node) xmlTexts(item, result);
  else if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) {
    if (key === 'a:t') result.push(textContent(value));
    else xmlTexts(value, result);
  }
  return result;
}
function textContent(node) {
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (node && typeof node === 'object') return Object.entries(node).map(([key, value]) => key === '#text' ? String(value) : textContent(value)).join('');
  return String(node ?? '');
}
export async function extract(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: await fs.readFile(file) });
    try {
      const result = await parser.getText();
      return result.pages.map(p => ({ page: p.num, text: p.text }));
    } finally { await parser.destroy(); }
  }
  if (extension === '.pptx') {
    const archive = new AdmZip(await fs.readFile(file));
    const parser = new XMLParser({ preserveOrder: true, parseTagValue: false, processEntities: true });
    const metadataParser = new XMLParser({ ignoreAttributes: false, parseAttributeValue: false });
    const presentation = archive.getEntry('ppt/presentation.xml');
    const relationships = archive.getEntry('ppt/_rels/presentation.xml.rels');
    if (!presentation || !relationships) throw new Error('PowerPoint inválido: falta el índice de diapositivas.');
    const list = metadataParser.parse(presentation.getData().toString('utf8'))['p:presentation']?.['p:sldIdLst']?.['p:sldId'];
    const rels = metadataParser.parse(relationships.getData().toString('utf8')).Relationships?.Relationship;
    const asArray = value => value ? (Array.isArray(value) ? value : [value]) : [];
    return asArray(list).map((slide, index) => {
      const relationship = asArray(rels).find(r => r['@_Id'] === slide['@_r:id']);
      const target = relationship?.['@_Target'];
      if (!target || relationship['@_TargetMode'] === 'External') throw new Error('Relación de diapositiva inválida.');
      const entryName = target.startsWith('/') ? target.slice(1) : path.posix.normalize(path.posix.join('ppt', target));
      if (!/^ppt\/slides\/[^/]+\.xml$/.test(entryName)) throw new Error('Ubicación de diapositiva inválida.');
      const entry = archive.getEntry(entryName);
      if (!entry) throw new Error('Falta una diapositiva del PowerPoint.');
      return { page: index + 1, text: xmlTexts(parser.parse(entry.getData().toString('utf8'))).join(' ') };
    });
  }
  if (['.md', '.txt'].includes(extension)) return [{ page: 1, text: await fs.readFile(file, 'utf8') }];
  throw new Error(`Formato no admitido: ${extension}`);
}
async function filesIn(dir) {
  const result = [];
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory()) result.push(...await filesIn(file));
    else if (item.isFile() && /\.(pdf|pptx|md|txt)$/i.test(item.name)) result.push(file);
  }
  return result.sort();
}
export async function ingest(store, settings, ai, log = console.log) {
  const files = await filesIn(settings.knowledgeDir);
  if (!files.length) throw new Error('Añade PDF, PPTX, MD o TXT a knowledge/. Se conserva el índice anterior.');
  const chunks = [];
  for (const file of files) {
    if ((await fs.stat(file)).size > 30 * 1024 * 1024) throw new Error(`Archivo mayor a 30 MB: ${path.basename(file)}`);
    const source = path.relative(settings.knowledgeDir, file).replaceAll('\\', '/');
    let supplement;
    try { supplement = JSON.parse(await fs.readFile(`${file}.index.json`, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (supplement) {
      const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      if (supplement.sha256 !== hash) throw new Error(`${source}: cambió el original. Revisa su transcripción/exclusión antes de indexar.`);
      if (supplement.exclude === true) {
        log(`Excluido: ${source}. ${supplement.reason || 'Revisión documental pendiente.'}`);
        continue;
      }
    }
    const pages = await extract(file);
    if (supplement?.pages) {
      for (const [number, text] of Object.entries(supplement.pages)) {
        const page = pages.find(p => p.page === Number(number));
        if (!page || typeof text !== 'string' || !text.trim()) throw new Error(`${source}: transcripción de página inválida.`);
        if (!page.text.trim()) {
          page.text = text;
          log(`Transcripción revisada: ${source}, página ${number}.`);
        }
      }
    }
    if (!pages.some(p => p.text.trim())) throw new Error(`${source} no contiene texto extraíble. Usa OCR o una transcripción. Se conserva el índice anterior.`);
    for (const p of pages) {
      if (!p.text.trim()) log(`Aviso: ${source}, página/diapositiva ${p.page} sin texto (no se indexa).`);
      for (const text of splitText(p.text)) chunks.push({ source, page: p.page, text });
    }
    log(`Leído: ${source} (${pages.length} páginas/diapositivas).`);
  }
  if (!chunks.length) throw new Error('No quedaron fragmentos válidos. Se conserva el índice anterior.');
  if (chunks.length > 10000) throw new Error('Este piloto admite hasta 10.000 fragmentos. Reduce los documentos.');
  if (settings.embeddingModel) {
    for (let i = 0; i < chunks.length; i += 32) {
      const batch = chunks.slice(i, i + 32);
      const vectors = await ai.embed(batch.map(c => c.text));
      batch.forEach((chunk, j) => { chunk.embedding = vectors[j]; });
    }
  }
  store.replaceKnowledge(chunks, settings.embeddingModel);
  return chunks.length;
}
export function cosine(a, b) {
  if (!a?.length || a.length !== b?.length) throw new Error('Reindexa: dimensiones de embeddings incompatibles.');
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  return dot / (Math.hypot(...a) * Math.hypot(...b) || 1);
}
// Pagos, recibos, reservas o quejas del propietario: «¿cómo pago la mensualidad?» es soporte, no el precio de Juntaly.
export function isResidentQuery(query) {
  const text = query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return /\b(pag(o|os|ar|ue|ado|ada)|recibos?|deudas?|saldo|alicuota|cuotas?|reserv\w*|quejas?|reclamos?|calcomania|rfid|tag|mi (casa|apartamento|apto|unidad|propiedad|inmueble))\b/.test(text);
}
export function isCommercialQuery(query) {
  const text = query.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  if (/\b(ventas?|contratar|cotiza\w*|demo|comercial)\b/.test(text) ||
    /\b(instalar\w*|instalacion|implementar\w*|implementacion|llevarlo|ponerlo|poner (juntaly|el sistema|la app|la aplicacion|esto))\b[\s\S]{0,100}\b(condominio|edificio|conjunto)\b/.test(text) ||
    /\b(otro|nuevo) condominio\b/.test(text)) return true;
  // Términos ambiguos: también los usan propietarios para hablar de su condominio.
  return /\b(comprar|precios?|cuesta|costos?|mensualidad|planes)\b/.test(text) && !isResidentQuery(query);
}
export async function retrieve(store, query, settings, ai, context = {}) {
  const chunks = store.chunks();
  if (!chunks.length) return [];
  // El deck es breve: dar el contexto comercial completo evita omitir planes,
  // condiciones o el proceso de instalación por falta de coincidencias literales.
  if (context.category === 'sales' || (context.category !== 'support' && isCommercialQuery(query))) {
    const deck = chunks.filter(c => /(^|\/)deck[_ -]/i.test(c.source));
    if (deck.length && deck.reduce((sum, c) => sum + c.text.length, 0) <= 16000) return deck;
  }
  const queryTokens = new Set(tokens(query));
  // Pequeño vocabulario para consultas cotidianas mientras no hay embeddings.
  const synonyms = [
    ['movil', 'celular', 'telefono'], ['reservar', 'reserva', 'reservas'],
    ['caducado', 'caduco', 'vencido', 'expiro'],
    ['precio', 'precios', 'cuesta', 'costo', 'inversion', 'mensualidad'],
    ['incluye', 'modulos', 'funcionalidades'], ['activar', 'activo', 'configurar'],
  ];
  for (const group of synonyms) if (group.some(term => queryTokens.has(term))) group.forEach(term => queryTokens.add(term));
  const mobile = /\b(movil|celular|telefono)\b/.test(tokens(query).join(' '));
  const desktop = /\b(escritorio|computadora|computador|pc)\b/.test(tokens(query).join(' '));
  const candidates = chunks.filter(c => !(mobile && !desktop && /escritorio/i.test(c.source)) && !(desktop && !mobile && /movil/i.test(c.source)));
  const documents = candidates.map(chunk => ({ chunk, words: new Set(tokens(chunk.text)), title: new Set(tokens(chunk.source)) }));
  const frequencies = new Map([...queryTokens].map(term => [term, documents.filter(d => d.words.has(term) || d.title.has(term)).length]));
  const commercial = ['precio', 'cuesta', 'cotizacion', 'contratar', 'demo', 'incluye'].some(term => queryTokens.has(term));
  const lexical = documents.map(({ chunk, words, title }) => {
    let score = 0;
    for (const term of queryTokens) {
      const idf = Math.log(1 + documents.length / (1 + frequencies.get(term)));
      if (words.has(term)) score += idf / (0.6 + 0.4 * words.size / 100);
      if (title.has(term)) score += idf * 1.5;
    }
    if (commercial && /deck|venta|comercial/i.test(chunk.source)) score *= 2;
    return { chunk, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  let semantic = [];
  if (settings.embeddingModel) {
    if (store.embeddingModel() !== settings.embeddingModel) throw new Error('Reindexa los documentos con el modelo de embeddings configurado.');
    const [vector] = await ai.embed([query]);
    semantic = candidates.filter(c => c.embedding).map(c => ({ chunk: c, score: cosine(vector, c.embedding) }))
      .filter(c => c.score >= 0.35).sort((a, b) => b.score - a.score);
  }
  const scores = new Map();
  for (const list of [lexical, semantic]) list.slice(0, 20).forEach(({ chunk }, index) => {
    scores.set(chunk.id, (scores.get(chunk.id) || 0) + 1 / (60 + index));
  });
  return chunks.filter(c => scores.has(c.id)).sort((a, b) => scores.get(b.id) - scores.get(a.id)).slice(0, 4);
}
