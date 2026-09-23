import fs from 'node:fs';

// Un bloqueo con el PID propio es residuo de un cierre forzado: en Docker el PID se repite en cada arranque.
export function acquireLock(file, pid = process.pid, alive = other => { try { process.kill(other, 0); return true; } catch (error) { if (error.code !== 'ESRCH') throw error; return false; } }) {
  if (fs.existsSync(file)) {
    const previous = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(previous) || previous <= 0) throw new Error('Revisa bot.lock: no fue posible validar el proceso anterior.');
    if (previous !== pid && alive(previous)) throw new Error('Ya hay un bot usando esta sesión.');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, String(pid), { flag: 'wx' });
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(pid)) fs.unlinkSync(file); };
}
