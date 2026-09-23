import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, jid TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS seen (jid TEXT, id TEXT, state TEXT NOT NULL, PRIMARY KEY(jid,id));
      CREATE TABLE IF NOT EXISTS outgoing (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS aliases (alias TEXT PRIMARY KEY, jid TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tickets (id INTEGER PRIMARY KEY, jid TEXT NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL, status TEXT DEFAULT 'open', created TEXT DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS chunks (id INTEGER PRIMARY KEY, source TEXT NOT NULL, page INTEGER NOT NULL, text TEXT NOT NULL, embedding TEXT);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS message_chat ON messages(jid,id);
      CREATE INDEX IF NOT EXISTS ticket_chat ON tickets(jid,status);`);
    if (!this.db.prepare('PRAGMA table_info(chats)').all().some(c => c.name === 'category')) {
      this.db.exec("ALTER TABLE chats ADD COLUMN category TEXT NOT NULL DEFAULT 'support'");
    }
  }
  chat(jid) {
    this.db.prepare('INSERT OR IGNORE INTO chats(jid) VALUES (?)').run(jid);
    return this.db.prepare('SELECT * FROM chats WHERE jid=?').get(jid);
  }
  identity(identifiers) {
    const ids = [...new Set(identifiers.filter(Boolean))];
    if (!ids.length) throw new Error('Falta identificador del chat.');
    const existing = [...new Set(ids.map(id => this.db.prepare('SELECT jid FROM aliases WHERE alias=?').get(id)?.jid).filter(Boolean))];
    const canonical = existing[0] || ids.find(id => id.endsWith('@s.whatsapp.net')) || ids[0];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const old of existing.slice(1)) {
        const previous = this.chat(old);
        this.chat(canonical);
        this.db.prepare('UPDATE chats SET paused=MAX(paused,?), revision=revision+1 WHERE jid=?').run(previous.paused, canonical);
        this.db.prepare('UPDATE messages SET jid=? WHERE jid=?').run(canonical, old);
        this.db.prepare('UPDATE tickets SET jid=? WHERE jid=?').run(canonical, old);
        this.db.prepare('INSERT OR IGNORE INTO seen(jid,id,state) SELECT ?,id,state FROM seen WHERE jid=?').run(canonical, old);
        this.db.prepare('UPDATE aliases SET jid=? WHERE jid=?').run(canonical, old);
        this.pause(old); // Invalida respuestas en vuelo con la identidad previa.
      }
      for (const id of ids) this.db.prepare('INSERT OR REPLACE INTO aliases(alias,jid) VALUES (?,?)').run(id, canonical);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return canonical;
  }
  pause(jid) {
    this.chat(jid);
    this.db.prepare('UPDATE chats SET paused=1, revision=revision+1 WHERE jid=?').run(jid);
  }
  category(jid, category) {
    this.chat(jid);
    this.db.prepare('UPDATE chats SET category=? WHERE jid=?').run(category, jid);
  }
  resume(jid) {
    this.chat(jid);
    this.db.prepare('UPDATE chats SET paused=0, revision=revision+1 WHERE jid=?').run(jid);
    this.db.prepare("UPDATE tickets SET status='closed' WHERE jid=? AND status='open'").run(jid);
  }
  record(jid, role, content) { this.db.prepare('INSERT INTO messages(jid,role,content) VALUES (?,?,?)').run(jid, role, content); }
  history(jid, limit = 12) {
    return this.db.prepare('SELECT role,content FROM messages WHERE jid=? ORDER BY id DESC LIMIT ?').all(jid, limit).reverse();
  }
  claim(jid, id) {
    return this.db.prepare("INSERT OR IGNORE INTO seen(jid,id,state) VALUES (?,?,'processing')").run(jid, id).changes > 0;
  }
  done(jid, id) { this.db.prepare("UPDATE seen SET state='done' WHERE jid=? AND id=?").run(jid, id); }
  recover() {
    const rows = this.db.prepare("SELECT DISTINCT jid FROM seen WHERE state='processing'").all();
    for (const { jid } of rows) this.handoff(jid, 'support', 'Proceso interrumpido: revisar conversación y último envío antes de reactivar.');
    this.db.prepare("UPDATE seen SET state='interrupted' WHERE state='processing'").run();
    return rows.length;
  }
  own(id) { return Boolean(this.db.prepare('SELECT 1 FROM outgoing WHERE id=?').get(id)); }
  markOwn(id) { this.db.prepare('INSERT OR IGNORE INTO outgoing(id) VALUES (?)').run(id); }
  handoff(jid, category, reason) {
    this.pause(jid);
    this.ticket(jid, category, reason);
  }
  ticket(jid, category, reason) {
    const existing = this.db.prepare("SELECT id FROM tickets WHERE jid=? AND status='open'").get(jid);
    if (!existing) this.db.prepare('INSERT INTO tickets(jid,category,reason) VALUES (?,?,?)').run(jid, category, reason);
    return !existing;
  }
  tickets() { return this.db.prepare("SELECT * FROM tickets WHERE status='open' ORDER BY id").all(); }
  budget(limit, day = new Date().toISOString().slice(0, 10)) {
    this.db.prepare('INSERT OR IGNORE INTO usage(day,calls) VALUES (?,0)').run(day);
    return this.db.prepare('UPDATE usage SET calls=calls+1 WHERE day=? AND calls<?').run(day, limit).changes > 0;
  }
  chunks() {
    // La indexación puede correr en otro proceso (CLI): la versión decide si recargar.
    const version = this.db.prepare("SELECT value FROM metadata WHERE key='knowledgeVersion'").get()?.value || '';
    if (this.cache?.version !== version) {
      const chunks = this.db.prepare('SELECT * FROM chunks').all().map(x => ({ ...x, embedding: x.embedding ? JSON.parse(x.embedding) : null }));
      this.cache = { version, chunks };
    }
    return this.cache.chunks;
  }
  embeddingModel() { return this.db.prepare("SELECT value FROM metadata WHERE key='embeddingModel'").get()?.value || ''; }
  replaceKnowledge(chunks, model) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM chunks');
      const insert = this.db.prepare('INSERT INTO chunks(source,page,text,embedding) VALUES (?,?,?,?)');
      for (const c of chunks) insert.run(c.source, c.page, c.text, c.embedding ? JSON.stringify(c.embedding) : null);
      this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('embeddingModel',?)").run(model);
      this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES ('knowledgeVersion',?)").run(randomUUID());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
