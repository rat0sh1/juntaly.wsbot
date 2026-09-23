export function isDirect(jid) { return typeof jid === 'string' && /@(s\.whatsapp\.net|lid)$/.test(jid); }
export function normalizeJid(jid) { return typeof jid === 'string' ? jid.replace(/:\d+@/, '@') : ''; }
export function allowedMessage(settings, identifiers) {
  return !settings.testMode || identifiers.some(jid => settings.allowed.has(normalizeJid(jid)));
}
export function messageText(content) {
  return content?.conversation || content?.extendedTextMessage?.text || '';
}
export function isMedia(content) {
  return Boolean(content && ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'contactMessage', 'contactsArrayMessage', 'locationMessage', 'liveLocationMessage'].some(key => content[key]));
}
// 'append' incluye lo que el operador escribió con el bot desconectado: debe pausar el chat.
// Los mensajes de clientes en 'append' son antiguos y no se responden.
export function acceptUpsert(type, fromMe) { return type === 'notify' || (type === 'append' && Boolean(fromMe)); }
