import { isCommercialQuery } from './knowledge.js';
const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function conversationCategory(text, previous) {
  const value = normalize(text);
  if (physicalFault(text) || /\b(no puedo|no funciona|no abre|no sirve|no me deja|problema|error|falla|olvide mi contrasena|ayuda con mi|soporte tecnico)\b/.test(value) ||
      /\b(instalar|instalo)\b.*\b(app|aplicacion)\b.*\b(celular|telefono|movil)\b/.test(value)) return 'support';
  return isCommercialQuery(text) ? 'sales' : previous;
}
export function salesHandoffRequested(text, history) {
  const value = normalize(text).trim();
  if (/\b(no|todavia no|aun no)\b.*\b(agendar|coordinar|contratar|cotizacion|visita|demo)\b/.test(value)) return false;
  if (/\b(quiero|quisiera|necesito|deseo|podemos|vamos a)\s+(agendar|coordinar|concertar|programar|contratar|una cotizacion personalizada|una demo|una visita)\b/.test(value) ||
      /\b(agendemos|coordinemos|programemos|contactenme|llamenme)\b/.test(value)) return true;
  const previous = history.filter(m => m.role === 'assistant').at(-1)?.content || '';
  return /^(si|si por favor|claro|dale|de acuerdo|adelante|hagamoslo)[.!\s]*$/.test(value) &&
    /\?/.test(previous) && /\b(agendar|coordinar|programar|contacte|contactemos)\b/.test(normalize(previous));
}
// Fallas del hardware del edificio (portón, antenas, luz, agua, vigilancia): no se resuelven desde la app.
// Si menciona la app o el celular, la IA decide con los manuales.
export function physicalFault(text) {
  const value = normalize(text);
  return /\b(porton|portones|puerta|talanquera|barrera|antenas?|lector|tanques?|cisternas?|bomba|agua|luz|electricidad|energia|camaras?|vigilancia)\b/.test(value) &&
    /\b(no (abre|cierra|funciona|sirve|lee|responde|prende|enciende|hay|llega|esta funcionando)|(tengo|tenemos|hay|reporto|reportar) (un |una |algun |otro )?(problema|falla|fallo)|fallando|estan? (danad\w*|rot[oa]s?|trabad\w*|atascad\w*|apagad\w*)|se (quedo|cayo|dano|fue)|sin (luz|agua))\b/.test(value) &&
    !/\b(app|aplicacion|celular|telefono|movil|pantalla|desliz\w*|web|contrasena|usuario)\b/.test(value) && !isCommercialQuery(text);
}
