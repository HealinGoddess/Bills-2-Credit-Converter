require('dotenv').config({ quiet: true });
const { connectPostgres, closePostgres } = require('../db/postgres');
const { connectMongo, closeMongo } = require('../db/mongo');
const { createApp } = require('./app');
const { createOcrService } = require('./services/ocr');
const { createMongoDocumentStore } = require('./services/documentStore');

async function main() {
  const pool = await connectPostgres();
  await connectMongo();
  const ocr = createOcrService();

  const app = createApp({ pool, ocr, documentStore: createMongoDocumentStore() });
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
