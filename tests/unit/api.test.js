const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const { createOcrService } = require('../../src/services/ocr');
const { createFakePool, createFakeDocumentStore } = require('../helpers/fakePool');
const { statementText, toBase64 } = require('../helpers/fixtures');

const USER_ID = crypto.randomUUID();
const WALLET_ID = crypto.randomUUID();
const STATEMENT_ID = crypto.randomUUID();
const silentLogger = { error: jest.fn() };

function buildApp(handler, { ocr = createOcrService(), documentStore = createFakeDocumentStore() } = {}) {
  const pool = createFakePool(handler);
  const app = createApp({ pool, ocr, documentStore, logger: silentLogger });
  return { app, pool, ocr, documentStore };
}

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
        }],
      };
    }
    if (sql.startsWith('INSERT INTO ledger_entries')) {
      return { rows: [{ entry_type: 'CREDIT_ISSUANCE', amount: params[2], balance_after: params[3] }] };
    }
    return undefined;
  };
}

function settleHandler({ grossAmount = '100.00', walletBalance = '500.00', status = 'pending', owner = USER_ID } = {}) {
  return (sql, params) => {
    if (sql.startsWith('SELECT statement_id, user_id, payee_name, gross_amount')) {
      return {
        rows: [{
          statement_id: STATEMENT_ID, user_id: owner, payee_name: 'City Power & Light',
          gross_amount: grossAmount, verification_status: status,
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

  test('mints credits 1:1 with the gross amount inside a single transaction', async () => {
    const { app, pool, documentStore } = buildApp(ingestHandler({ walletBalance: '10.00' }));

    const res = await request(app).post('/api/v1/statements/ingest').send(body);

    expect(res.status).toBe(201);
    expect(res.body.statement).toMatchObject({
      payee_name: 'City Power & Light', account_number_masked: '****1234', gross_amount: '142.37', due_date: '2026-10-15',
    });
    expect(res.body.statement.ocr_hash).toBe(crypto.createHash('sha256').update(text).digest('hex'));
    expect(res.body.wallet).toEqual({ walletId: WALLET_ID, creditBalance: '152.37', currency: 'NOU' });
    expect(res.body.documentStored).toBe(true);

    const [walletUpdate] = pool.find('UPDATE wallets SET credit_balance');
    expect(walletUpdate.params).toEqual(['152.37', WALLET_ID]);
    const [entry] = pool.find('INSERT INTO ledger_entries');
    expect(entry.sql).toContain("'CREDIT_ISSUANCE'");
    expect(entry.params.slice(0, 4)).toEqual([WALLET_ID, STATEMENT_ID, '142.37', '152.37']);

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

    const res = await request(app).post('/api/v1/statements/ingest').send(body);

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

    const res = await request(app).post('/api/v1/statements/ingest').send(body);

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

    const res = await request(app).post('/api/v1/statements/ingest').send(body);

    expect(res.status).toBe(201);
    expect(res.body.documentStored).toBe(false);
  });

  test.each([
    [{ ...body, userId: 'nope' }, 'userId'],
    [{ ...body, fileBase64: '' }, 'fileBase64'],
    [{ ...body, fileBase64: '###' }, 'fileBase64'],
    [{ ...body, mimeType: undefined }, 'mimeType'],
  ])('validates input (%#: %s)', async (payload, field) => {
    const { app } = buildApp(ingestHandler());
    const res = await request(app).post('/api/v1/statements/ingest').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain(field);
  });

  test('returns 404 for unknown users', async () => {
    const { app } = buildApp(() => ({ rows: [] }));
    const res = await request(app).post('/api/v1/statements/ingest').send(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('USER_NOT_FOUND');
  });
});

describe('POST /api/v1/payments/settle', () => {
  const body = { userId: USER_ID, statementId: STATEMENT_ID };

  test('pays 100% to the provider, charges the fee to the beneficiary, and records 0.00 provider fee', async () => {
    const { app, pool } = buildApp(settleHandler({ grossAmount: '142.37', walletBalance: '200.00' }));

    const res = await request(app).post('/api/v1/payments/settle').send(body);

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

  test.each([0, 0.02, 0.05, 0.5])('fee_deducted_from_provider is always 0.00 (rate %s)', async (platformFeeRate) => {
    const { app, pool } = buildApp(settleHandler({ grossAmount: '999.99', walletBalance: '5000.00' }));

    const res = await request(app).post('/api/v1/payments/settle').send({ ...body, platformFeeRate });

    expect(res.status).toBe(200);
    expect(res.body.settlement.fee_deducted_from_provider).toBe('0.00');
    expect(res.body.breakdown.providerReceives).toBe('999.99');
    expect(pool.find('INSERT INTO settlements')[0].params[3]).toBe('0.00');
  });

  test('rejects insufficient balance with 400, rolls back, and writes nothing', async () => {
    // 100.00 bill + 2.00 fee = 102.00 required; wallet only holds the minted 100.00
    const { app, pool } = buildApp(settleHandler({ grossAmount: '100.00', walletBalance: '100.00' }));

    const res = await request(app).post('/api/v1/payments/settle').send(body);

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
    const res = await request(app).post('/api/v1/payments/settle').send(body);
    expect(res.status).toBe(200);
    expect(res.body.wallet.creditBalance).toBe('0.00');
  });

  test('returns 409 for an already-settled statement', async () => {
    const { app, pool } = buildApp(settleHandler({ status: 'settled' }));
    const res = await request(app).post('/api/v1/payments/settle').send(body);
    expect(res.status).toBe(409);
    expect(pool.find('INSERT INTO settlements')).toHaveLength(0);
  });

  test("returns 404 when settling another user's statement", async () => {
    const { app } = buildApp(settleHandler({ owner: crypto.randomUUID() }));
    const res = await request(app).post('/api/v1/payments/settle').send(body);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('STATEMENT_NOT_FOUND');
  });

  test.each([-0.01, 1.5, '0.02', Number.NaN])('rejects invalid platformFeeRate %p', async (platformFeeRate) => {
    const { app, pool } = buildApp(settleHandler());
    const res = await request(app).post('/api/v1/payments/settle').send({ ...body, platformFeeRate });
    expect(res.status).toBe(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe('error handling', () => {
  test('returns 400 for malformed JSON and 404 for unknown routes', async () => {
    const { app } = buildApp(() => undefined);
    const bad = await request(app).post('/api/v1/payments/settle').set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const missing = await request(app).get('/api/v1/nope');
    expect(missing.status).toBe(404);
  });
});
