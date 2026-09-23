import { isCommercialQuery } from './knowledge.js';
const normalize = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function conversationCategory(text, previous) {
  const value = normalize(text);
  if (/\b(no puedo|no funciona|error|falla|olvide mi contrasena|ayuda con mi|soporte tecnico)\b/.test(value) ||
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
