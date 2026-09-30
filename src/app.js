const path = require('path');
const express = require('express');
const statementsRouter = require('./routes/statements');
const paymentsRouter = require('./routes/payments');
const usersRouter = require('./routes/users');
const { createLedgerService } = require('./services/ledger');
const { createUserService } = require('./services/users');
const { notFound, createErrorHandler } = require('./middleware/errorHandler');

function createApp({ pool, ocr, documentStore, logger = console }) {
  const ledgerService = createLedgerService({ pool, ocr, documentStore, logger });
  const userService = createUserService({ pool });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: process.env.MAX_BODY_SIZE || '15mb' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/v1/users', usersRouter({ userService }));
  app.use('/api/v1/statements', statementsRouter({ ledgerService }));
  app.use('/api/v1/payments', paymentsRouter({ ledgerService }));

  app.use(notFound);
  app.use(createErrorHandler(logger));
  return app;
}

module.exports = { createApp };
