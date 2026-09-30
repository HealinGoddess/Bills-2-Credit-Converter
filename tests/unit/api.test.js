const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { createSessionManager, COOKIE_NAME } = require('../../src/lib/session');
const { hashPassword } = require('../../src/lib/password');
const { createOcrService } = require('../../src/services/ocr');
const { createFakePool, createFakeDocumentStore } = require('../helpers/fakePool');
const { statementText, toBase64 } = require('../helpers/fixtures');

const USER_ID = crypto.randomUUID();
const WALLET_ID = crypto.randomUUID();
const STATEMENT_ID = crypto.randomUUID();
const silentLogger = { error: jest.fn() };
const SESSION_SECRET = 'unit-test-session-secret';
const sessions = createSessionManager({ secret: SESSION_SECRET });
const COOKIE = `${COOKIE_NAME}=${sessions.sign(USER_ID)}`;

function buildApp(handler, { ocr = createOcrService(), documentStore = createFakeDocumentStore() } = {}) {
  const pool = createFakePool(handler);
  const app = createApp({
    pool, ocr, documentStore, sessionSecret: SESSION_SECRET, platformFeeRate: 0.02, logger: silentLogger,
  });
  return { app, pool, ocr, documentStore };
}

const post = (app, path) => request(app).post(path).set('Cookie', COOKIE);
const get = (app, path) => request(app).get(path).set('Cookie', COOKIE);

function ingestHandler({ duplicate = false, walletBalance = '0.00', insertError } = {}) {
  return (sql, params) => {
    if (sql.startsWith('SELECT account_status FROM users')) return { rows: [{ account_status: 'active' }] };
    if (sql.startsWith('SELECT statement_id FROM statements WHERE ocr_hash')) {
      return { rows: duplicate ? [{ statement_id: STATEMENT_ID }] : [] };
    }
    if (sql.startsWith('SELECT wallet_id, credit_balance, currency FROM wallets')) {
      return { rows: [{ wallet_id: WALLET_ID, credit_balance: walletBalance, currency: 'NOU' }] };
    }
    if (sql.startsWith('INSERT INTO statements')) {
      if (insertError) throw insertError;
      return {
        rows: [{
          statement_id: STATEMENT_ID, user_id: params[0], payee_name: params[1], account_number_masked: params[2],
          gross_amount: params[3], due_date: params[4], ocr_hash: params[5], verification_status: 'pending',
          platform_fee_rate: String(params[6]), platform_fee: params[7],
        }],
      };
    }
    if (sql.startsWith('INSERT INTO ledger_entries')) {
      return { rows: [{ entry_type: params[2], amount: params[3], balance_after: params[4] }] };
    }
    return undefined;
  };
}

function settleHandler({
  grossAmount = '100.00', walletBalance = '500.00', status = 'pending', owner = USER_ID,
  platformFeeRate = null, platformFee = null,
} = {}) {
  return (sql, params) => {
    if (sql.startsWith('SELECT statement_id, user_id, payee_name, gross_amount')) {
      return {
        rows: [{
          statement_id: STATEMENT_ID, user_id: owner, payee_name: 'City Power & Light',
          gross_amount: grossAmount, verification_status: status,
          platform_fee_rate: platformFeeRate, platform_fee: platformFee,
        }],
      };
    }
    if (sql.startsWith('SELECT wallet_id, credit_balance, currency FROM wallets')) {
      return { rows: [{ wallet_id: WALLET_ID, credit_balance: walletBalance, currency: 'NOU' }] };
    }
    if (sql.startsWith('INSERT INTO settlements')) {
      return {
        rows: [{
          settlement_id: crypto.randomUUID(), statement_id: params[0], payee_name: params[1],
          remittance_amount: params[2], fee_deducted_from_provider: params[3],
          payment_channel: 'ACH_DIRECT', disbursement_status: 'completed',
        }],
      };
    }
    return undefined;
  };
}

describe('POST /api/v1/statements/ingest', () => {
  const text = statementText({ amount: '142.37' });
  const body = { userId: USER_ID, fileBase64: toBase64(text), mimeType: 'text/plain' };

  test('mints credits for the bill plus the fixed 2% fee inside a single transaction', async () => {
    const { app, pool, documentStore } = buildApp(ingestHandler({ walletBalance: '10.00' }));

    const res = await post(app, '/api/v1/statements/ingest').send(body);

    expect(res.status).toBe(201);
    expect(res.body.statement).toMatchObject({
      payee_name: 'City Power & Light', account_number_masked: '****1234', gross_amount: '142.37', due_date: '2026-10-15',
    });
    expect(res.body.statement.ocr_hash).toBe(crypto.createHash('sha256').update(text).digest('hex'));
    expect(res.body.statement).toMatchObject({ platform_fee_rate: '0.02', platform_fee: '2.85' });
    expect(res.body.wallet).toEqual({ walletId: WALLET_ID, creditBalance: '155.22', currency: 'NOU' });
    expect(res.body.documentStored).toBe(true);

    const [walletUpdate] = pool.find('UPDATE wallets SET credit_balance');
    expect(walletUpdate.params).toEqual(['155.22', WALLET_ID]);
    const entries = pool.find('INSERT INTO ledger_entries').map((q) => q.params.slice(0, 5));
    expect(entries).toEqual([
      [WALLET_ID, STATEMENT_ID, 'CREDIT_ISSUANCE', '142.37', '152.37'],
      [WALLET_ID, STATEMENT_ID, 'FEE_CREDIT_ISSUANCE', '2.85', '155.22'],
    ]);
    const [statementInsert] = pool.find('INSERT INTO statements');
    expect(statementInsert.params.slice(6)).toEqual([0.02, '2.85']);

    const txSql = pool.client.query.mock.calls.map(([sql]) => sql.trim().split(/\s+/)[0]);
    expect(txSql[0]).toBe('BEGIN');
    expect(txSql[txSql.length - 1]).toBe('COMMIT');
    expect(pool.find('FOR UPDATE')).toHaveLength(1);

    expect(documentStore.saveStatementDocument).toHaveBeenCalledWith(expect.objectContaining({
      statementId: STATEMENT_ID, userId: USER_ID, ocrProvider: 'text', rawText: text,
    }));
  });

  test('rejects a duplicate statement (same SHA-256) with 400 before OCR or any write', async () => {
    const ocr = { extract: jest.fn() };
    const { app, pool } = buildApp(ingestHandler({ duplicate: true }), { ocr });

    const res = await post(app, '/api/v1/statements/ingest').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_STATEMENT');
    expect(ocr.extract).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    const [dupCheck] = pool.find('WHERE ocr_hash');
    expect(dupCheck.params).toEqual([crypto.createHash('sha256').update(text).digest('hex')]);
  });

  test('maps a concurrent unique-hash violation to 400 and rolls back', async () => {
    const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'statements_ocr_hash_key' });
    const { app, pool } = buildApp(ingestHandler({ insertError: err }));

    const res = await post(app, '/api/v1/statements/ingest').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('DUPLICATE_STATEMENT');
    expect(pool.find('ROLLBACK')).toHaveLength(1);
    expect(pool.find('COMMIT')).toHaveLength(0);
    expect(pool.find('UPDATE wallets')).toHaveLength(0);
  });

  test('still returns 201 when the Mongo document write fails', async () => {
    const documentStore = createFakeDocumentStore();
    documentStore.saveStatementDocument.mockRejectedValue(new Error('mongo down'));
    const { app } = buildApp(ingestHandler(), { documentStore });

    const res = await post(app, '/api/v1/statements/ingest').send(body);

    expect(res.status).toBe(201);
    expect(res.body.documentStored).toBe(false);
  });

  test('ignores a client-supplied platformFeeRate', async () => {
    const { app, pool } = buildApp(ingestHandler());
    const res = await post(app, '/api/v1/statements/ingest').send({ ...body, platformFeeRate: 0 });
    expect(res.status).toBe(201);
    expect(res.body.wallet.creditBalance).toBe('145.22');
    expect(pool.find('INSERT INTO statements')[0].params.slice(6)).toEqual([0.02, '2.85']);
  });

  test('uses the logged-in user, not a userId from another account', async () => {
    const { app, pool } = buildApp(ingestHandler());
    const res = await post(app, '/api/v1/statements/ingest').send({ ...body, userId: crypto.randomUUID() });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(pool.queries).toHaveLength(0);
  });

  test.each([
    [{ ...body, fileBase64: '' }, 'fileBase64'],
    [{ ...body, fileBase64: '###' }, 'fileBase64'],
    [{ ...body, mimeType: undefined }, 'mimeType'],
  ])('validates input (%#: %s)', async (payload, field) => {
    const { app } = buildApp(ingestHandler());
    const res = await post(app, '/api/v1/statements/ingest').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(field);
  });

  test('returns 404 for unknown users', async () => {
    const { app } = buildApp(() => ({ rows: [] }));
    const res = await post(app, '/api/v1/statements/ingest').send(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('POST /api/v1/payments/settle', () => {
  const body = { userId: USER_ID, statementId: STATEMENT_ID };

  test('pays 100% to the provider, charges the fee to the beneficiary, and records 0.00 provider fee', async () => {
    const { app, pool } = buildApp(settleHandler({ grossAmount: '142.37', walletBalance: '200.00' }));

    const res = await post(app, '/api/v1/payments/settle').send(body);

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toEqual({
      fullBillAmount: '142.37',
      platformFeeRate: 0.02,
      beneficiaryFee: '2.85',
      totalCreditsDeducted: '145.22',
      providerReceives: '142.37',
      providerFee: '0.00',
      providerPayoutPercent: 100,
    });
    expect(res.body.settlement).toMatchObject({ remittance_amount: '142.37', fee_deducted_from_provider: '0.00' });
    expect(res.body.wallet.creditBalance).toBe('54.78');

    const [settlementInsert] = pool.find('INSERT INTO settlements');
    expect(settlementInsert.params).toEqual([STATEMENT_ID, 'City Power & Light', '142.37', '0.00']);

    const entries = pool.find('INSERT INTO ledger_entries').map((q) => q.params.slice(2, 5));
    expect(entries).toEqual([
      ['SETTLEMENT_PAYMENT', '-142.37', '57.63'],
      ['PLATFORM_FEE', '-2.85', '54.78'],
    ]);
    expect(pool.find('UPDATE wallets')[0].params[0]).toBe('54.78');
    expect(pool.find("verification_status = 'settled'")).toHaveLength(1);
    expect(pool.find('FOR UPDATE')).toHaveLength(2);
    expect(pool.find('COMMIT')).toHaveLength(1);
  });

  test.each([0, 0.05, 0.5, -1, '0', null])(
    'ignores client platformFeeRate %p: fee stays 2%% and provider fee stays 0.00',
    async (platformFeeRate) => {
      const { app, pool } = buildApp(settleHandler({ grossAmount: '999.99', walletBalance: '5000.00' }));

      const res = await post(app, '/api/v1/payments/settle').send({ ...body, platformFeeRate });

      expect(res.status).toBe(200);
      expect(res.body.breakdown).toMatchObject({ platformFeeRate: 0.02, beneficiaryFee: '20.00' });
      expect(res.body.settlement.fee_deducted_from_provider).toBe('0.00');
      expect(res.body.breakdown.providerReceives).toBe('999.99');
      expect(pool.find('INSERT INTO settlements')[0].params[3]).toBe('0.00');
    },
  );

  test('charges the fee recorded on the statement when it was ingested', async () => {
    const { app } = buildApp(settleHandler({
      grossAmount: '100.00', walletBalance: '103.00', platformFeeRate: '0.030000', platformFee: '3.00',
    }));
    const res = await post(app, '/api/v1/payments/settle').send(body);
    expect(res.status).toBe(200);
    expect(res.body.breakdown).toMatchObject({ platformFeeRate: 0.03, beneficiaryFee: '3.00', providerFee: '0.00' });
    expect(res.body.wallet.creditBalance).toBe('0.00');
  });

  test('rejects insufficient balance with 400, rolls back, and writes nothing', async () => {
    // 100.00 bill + 2.00 fee = 102.00 required
    const { app, pool } = buildApp(settleHandler({ grossAmount: '100.00', walletBalance: '100.00' }));

    const res = await post(app, '/api/v1/payments/settle').send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
      details: { required: '102.00', available: '100.00', shortfall: '2.00' },
    });
    expect(pool.find('ROLLBACK')).toHaveLength(1);
    expect(pool.find('COMMIT')).toHaveLength(0);
    expect(pool.find('UPDATE wallets')).toHaveLength(0);
    expect(pool.find('INSERT INTO ledger_entries')).toHaveLength(0);
    expect(pool.find('INSERT INTO settlements')).toHaveLength(0);
  });

  test('settles when the balance exactly covers bill plus fee', async () => {
    const { app } = buildApp(settleHandler({ grossAmount: '100.00', walletBalance: '102.00' }));
    const res = await post(app, '/api/v1/payments/settle').send(body);
    expect(res.status).toBe(200);
    expect(res.body.wallet.creditBalance).toBe('0.00');
  });

  test('returns 409 for an already-settled statement', async () => {
    const { app, pool } = buildApp(settleHandler({ status: 'settled' }));
    const res = await post(app, '/api/v1/payments/settle').send(body);
    expect(res.status).toBe(409);
    expect(pool.find('INSERT INTO settlements')).toHaveLength(0);
  });

  test("returns 404 when settling another user's statement", async () => {
    const { app } = buildApp(settleHandler({ owner: crypto.randomUUID() }));
    const res = await post(app, '/api/v1/payments/settle').send(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('STATEMENT_NOT_FOUND');
  });

  test("rejects a userId that isn't the logged-in user", async () => {
    const { app, pool } = buildApp(settleHandler());
    const res = await post(app, '/api/v1/payments/settle').send({ ...body, userId: crypto.randomUUID() });
    expect(res.status).toBe(403);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  test('returns 400 for malformed JSON and 404 for unknown routes', async () => {
    const { app } = buildApp(() => undefined);
    const bad = await post(app, '/api/v1/payments/settle').set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const missing = await request(app).get('/api/v1/nope');
    expect(missing.status).toBe(404);
  });
});

function authHandler({ passwordHash, accountStatus = 'active', existing = false } = {}) {
  return (sql, params) => {
    if (sql.startsWith('INSERT INTO users')) {
      if (existing) throw Object.assign(new Error('dup'), { code: '23505', constraint: 'users_email_key' });
      return { rows: [{ user_id: USER_ID, email: params[0], account_status: 'active' }] };
    }
    if (sql.startsWith('INSERT INTO wallets')) {
      return { rows: [{ wallet_id: WALLET_ID, credit_balance: '0.00', currency: 'NOU' }] };
    }
    if (sql.includes('password_hash FROM users WHERE email = $1')) {
      return {
        rows: passwordHash && params[0] === 'a@b.com'
          ? [{ user_id: USER_ID, email: 'a@b.com', account_status: accountStatus, password_hash: passwordHash }]
          : [],
      };
    }
    if (sql.includes('FROM users WHERE user_id = $1')) {
      return { rows: params[0] === USER_ID ? [{ user_id: USER_ID, email: 'a@b.com', account_status: 'active' }] : [] };
    }
    return undefined;
  };
}

const sessionCookie = (res) => (res.headers['set-cookie'] ?? []).find((c) => c.startsWith(`${COOKIE_NAME}=`));

describe('accounts and log-in', () => {
  let passwordHash;
  beforeAll(async () => { passwordHash = await hashPassword('correct horse'); });

  test('register stores a password hash (never the password) and starts a session', async () => {
    const { app, pool } = buildApp(authHandler());

    const res = await request(app).post('/api/v1/auth/register').send({ email: 'A@B.com', password: 'correct horse' });

    expect(res.status).toBe(201);
    expect(res.body.user).toEqual({ user_id: USER_ID, email: 'a@b.com', account_status: 'active' });
    const [insert] = pool.find('INSERT INTO users');
    expect(insert.params[0]).toBe('a@b.com');
    expect(insert.params[1]).toMatch(/^scrypt\$/);
    expect(JSON.stringify(pool.queries)).not.toContain('correct horse');
    const cookie = sessionCookie(res);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  test.each([
    [{ email: 'a@b.com', password: 'short' }, 'Password'],
    [{ email: 'a@b.com' }, 'Password'],
    [{ email: 'nope', password: 'long enough' }, 'email'],
  ])('register validates input (%#)', async (payload, field) => {
    const { app, pool } = buildApp(authHandler());
    const res = await request(app).post('/api/v1/auth/register').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(field);
    expect(pool.find('INSERT INTO users')).toHaveLength(0);
  });

  test('register returns 409 when the email is taken', async () => {
    const { app } = buildApp(authHandler({ existing: true }));
    const res = await request(app).post('/api/v1/auth/register').send({ email: 'a@b.com', password: 'correct horse' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_EXISTS');
    expect(sessionCookie(res)).toBeUndefined();
  });

  test('login succeeds with the right password and fails otherwise', async () => {
    const { app } = buildApp(authHandler({ passwordHash }));

    const ok = await request(app).post('/api/v1/auth/login').send({ email: 'A@b.com', password: 'correct horse' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toEqual({ user_id: USER_ID, email: 'a@b.com', account_status: 'active' });
    expect(sessions.verify(sessionCookie(ok).split(';')[0].split('=')[1])).toBe(USER_ID);

    const wrong = await request(app).post('/api/v1/auth/login').send({ email: 'a@b.com', password: 'wrong horse' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(sessionCookie(wrong)).toBeUndefined();

    const unknown = await request(app).post('/api/v1/auth/login').send({ email: 'x@y.com', password: 'correct horse' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  test('accounts without a password (created before log-in existed) cannot log in', async () => {
    const { app } = buildApp(authHandler({ passwordHash: null }));
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@b.com', password: 'anything' });
    expect(res.status).toBe(401);
  });

  test('locks out repeated failed log-ins', async () => {
    const { app } = buildApp(authHandler({ passwordHash }));
    for (let i = 0; i < 10; i += 1) {
      await request(app).post('/api/v1/auth/login').send({ email: 'a@b.com', password: 'wrong horse' });
    }
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'a@b.com', password: 'correct horse' });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  test('/auth/me returns the session user; logout clears the cookie', async () => {
    const { app } = buildApp(authHandler());
    const me = await get(app, '/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.user.user_id).toBe(USER_ID);

    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);

    const out = await post(app, '/api/v1/auth/logout');
    expect(out.status).toBe(204);
    expect(sessionCookie(out)).toContain('Max-Age=0');
  });

  test.each([
    ['get', `/api/v1/users/${USER_ID}/wallet`],
    ['get', `/api/v1/users/${USER_ID}/statements`],
    ['post', '/api/v1/statements/ingest'],
    ['post', '/api/v1/payments/settle'],
  ])('%s %s requires a valid session', async (method, path) => {
    const { app, pool } = buildApp(() => undefined);
    const none = await request(app)[method](path).send({});
    expect(none.status).toBe(401);
    const forged = await request(app)[method](path).set('Cookie', `${COOKIE}x`).send({});
    expect(forged.status).toBe(401);
    const otherSecret = createSessionManager({ secret: 'some-other-secret-value' }).sign(USER_ID);
    const foreign = await request(app)[method](path).set('Cookie', `${COOKIE_NAME}=${otherSecret}`).send({});
    expect(foreign.status).toBe(401);
    expect(pool.queries).toHaveLength(0);
  });

  test("cannot read another user's wallet or statements", async () => {
    const { app, pool } = buildApp(() => undefined);
    const other = crypto.randomUUID();
    expect((await get(app, `/api/v1/users/${other}/wallet`)).status).toBe(403);
    expect((await get(app, `/api/v1/users/${other}/statements`)).status).toBe(403);
    expect(pool.queries).toHaveLength(0);
  });

  test('the old unauthenticated email lookup is gone', async () => {
    const { app } = buildApp(() => undefined);
    expect((await request(app).get('/api/v1/users/by-email/a@b.com')).status).toBe(401);
  });
});

describe('statement listing', () => {
  test("lists the user's statements newest first with the fee each one will be charged", async () => {
    const rows = [
      {
        statement_id: STATEMENT_ID, payee_name: 'Water Co', gross_amount: '142.37', verification_status: 'pending',
        platform_fee_rate: '0.020000', platform_fee: '2.85',
      },
      {
        statement_id: crypto.randomUUID(), payee_name: 'Old Bill', gross_amount: '100.00', verification_status: 'pending',
        platform_fee_rate: null, platform_fee: null,
      },
    ];
    const { app, pool } = buildApp(() => ({ rows }));

    const res = await get(app, `/api/v1/users/${USER_ID}/statements`);

    expect(res.status).toBe(200);
    expect(res.body.statements.map((st) => [st.platform_fee_rate, st.platform_fee])).toEqual([
      [0.02, '2.85'],
      [0.02, '2.00'],
    ]);
    const [q] = pool.find('FROM statements WHERE user_id = $1');
    expect(q.sql).toContain('ORDER BY created_at DESC');
    expect(q.params).toEqual([USER_ID]);
  });
});

describe('web UI', () => {
  test('serves the website at /', async () => {
    const { app } = buildApp(() => undefined);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Necessify');
    expect((await request(app).get('/app.js')).status).toBe(200);
  });
});
