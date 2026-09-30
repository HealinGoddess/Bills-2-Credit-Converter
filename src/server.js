require('dotenv').config({ quiet: true });
const { connectPostgres, closePostgres } = require('../db/postgres');
const { connectMongo, closeMongo } = require('../db/mongo');
const crypto = require('crypto');
const { createApp } = require('./app');
const { createOcrService } = require('./services/ocr');
const { createMongoDocumentStore } = require('./services/documentStore');

function resolveSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  console.warn('SESSION_SECRET is not set; using a random secret, so log-ins reset when the server restarts');
  return crypto.randomBytes(32).toString('hex');
}

async function main() {
  const sessionSecret = resolveSessionSecret();
  const pool = await connectPostgres();
  await connectMongo();
  const ocr = createOcrService();

  const app = createApp({
    pool,
    ocr,
    documentStore: createMongoDocumentStore(),
    sessionSecret,
    secureCookies: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
  });
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () => console.log(`Necessify API listening on port ${port}`));

  const shutdown = () => {
    server.close(async () => {
      await Promise.allSettled([ocr.close(), closePostgres(), closeMongo()]);
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start Necessify API:', err);
  process.exit(1);
});
