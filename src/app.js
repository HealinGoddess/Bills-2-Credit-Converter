const path = require('path');
const express = require('express');
const authRouter = require('./routes/auth');
const statementsRouter = require('./routes/statements');
const paymentsRouter = require('./routes/payments');
const usersRouter = require('./routes/users');
const { createLedgerService, parsePlatformFeeRate } = require('./services/ledger');
const { createUserService } = require('./services/users');
const { createSessionManager } = require('./lib/session');
const { requireAuth } = require('./middleware/auth');
const { notFound, createErrorHandler } = require('./middleware/errorHandler');

function createApp({
  pool, ocr, documentStore, sessionSecret, secureCookies = false,
  platformFeeRate = parsePlatformFeeRate(process.env.PLATFORM_FEE_RATE), logger = console,
}) {
  const ledgerService = createLedgerService({ pool, ocr, documentStore, platformFeeRate, logger });
  const userService = createUserService({ pool, platformFeeRate });
  const sessions = createSessionManager({ secret: sessionSecret, secureCookies });
  const authenticated = requireAuth(sessions);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: process.env.MAX_BODY_SIZE || '15mb' }));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use('/api/v1/auth', authRouter({ userService, sessions }));
  app.use('/api/v1/users', authenticated, usersRouter({ userService }));
  app.use('/api/v1/statements', authenticated, statementsRouter({ ledgerService }));
  app.use('/api/v1/payments', authenticated, paymentsRouter({ ledgerService }));

  app.use(notFound);
  app.use(createErrorHandler(logger));
  return app;
}

module.exports = { createApp };
