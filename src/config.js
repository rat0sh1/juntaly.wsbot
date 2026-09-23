import path from 'node:path';

export function config(env = process.env) {
  const dailyLimit = Number(env.MAX_DAILY_AI_TURNS || 100);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) throw new Error('MAX_DAILY_AI_TURNS debe ser un entero positivo.');
  if (env.TEST_MODE && !['true', 'false'].includes(env.TEST_MODE)) throw new Error('TEST_MODE debe ser true o false.');
  return {
    apiKey: env.OPENROUTER_API_KEY || '',
    model: env.OPENROUTER_MODEL || '',
    embeddingModel: env.OPENROUTER_EMBEDDING_MODEL || '',
    testMode: env.TEST_MODE !== 'false',
    allowed: new Set((env.ALLOWED_JIDS || '').split(',').map(x => x.trim()).filter(Boolean)),
    dataDir: path.resolve(env.DATA_DIR || './data'),
    authDir: path.resolve(env.AUTH_DIR || './auth_info'),
    knowledgeDir: path.resolve(env.KNOWLEDGE_DIR || './knowledge'),
    dailyLimit,
  };
}
