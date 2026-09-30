const crypto = require('crypto');
const request = require('supertest');
const mongoose = require('mongoose');
const { connectPostgres, closePostgres } = require('../../db/postgres');
const { connectMongo, closeMongo } = require('../../db/mongo');
const { createApp } = require('../../src/app');
const { createOcrService } = require('../../src/services/ocr');
const { createMongoDocumentStore } = require('../../src/services/documentStore');
const StatementDocument = require('../../src/models/StatementDocument');
const AuditLog = require('../../src/models/AuditLog');
const { statementText, toBase64 } = require('../helpers/fixtures');

process.env.DATABASE_URL ||= 'postgres://necessify:necessify@localhost:5432/necessify';
process.env.MONGO_URL ||= 'mongodb://localhost:27017/necessify_test';

jest.setTimeout(30000);

let pool;
let app;

beforeAll(async () => {
  pool = await connectPostgres({ retries: 3, delayMs: 1000 });
  await connectMongo({ retries: 3, delayMs: 1000 });
  app = createApp({ pool, ocr: createOcrService(), documentStore: createMongoDocumentStore() });
});

afterAll(async () => {
  await closePostgres();
  await closeMongo();
});

async function createUser() {
  const res = await request(app).post('/api/v1/users').send({ email: `user-${crypto.randomUUID()}@example.com` });
  expect(res.status).toBe(201);
  return res.body.user.user_id;
}

async function ingest(userId, amount) {
  return request(app).post('/api/v1/statements/ingest').send({
    userId, fileBase64: toBase64(statementText({ amount })), mimeType: 'text/plain',
  });
}

async function walletOf(userId) {
  const res = await request(app).get(`/api/v1/users/${userId}/wallet`);
  expect(res.status).toBe(200);
  return res.body;
}

describe('Necessify ledger (Postgres + Mongo)', () => {
  test('ingest mints credits 1:1, writes the ledger, and stores the OCR document', async () => {
    const userId = await createUser();

    const res = await ingest(userId, '142.37');

    expect(res.status).toBe(201);
    expect(res.body.wallet.creditBalance).toBe('142.37');
    expect(res.body.documentStored).toBe(true);
    const { statement } = res.body;
    expect(statement).toMatchObject({ gross_amount: '142.37', verification_status: 'pending', due_date: '2026-10-15' });

    const { wallet, ledgerEntries } = await walletOf(userId);
    expect(wallet.credit_balance).toBe('142.37');
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0]).toMatchObject({ entry_type: 'CREDIT_ISSUANCE', amount: '142.37', balance_after: '142.37' });

    const doc = await StatementDocument.findOne({ statementId: statement.statement_id }).lean();
    expect(doc).toMatchObject({ userId, ocrHash: statement.ocr_hash, ocrProvider: 'text' });
    expect(doc.extractedFields.grossAmount).toBe('142.37');
    expect(await AuditLog.countDocuments({ statementId: statement.statement_id, event: 'STATEMENT_INGESTED' })).toBe(1);
  });

  test('duplicate statement files are rejected with 400 and do not mint credits', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    const payload = { fileBase64: toBase64(statementText({ amount: '75.00' })), mimeType: 'text/plain' };

    const first = await request(app).post('/api/v1/statements/ingest').send({ ...payload, userId });
    const again = await request(app).post('/api/v1/statements/ingest').send({ ...payload, userId });
    const otherUser = await request(app).post('/api/v1/statements/ingest').send({ ...payload, userId: otherUserId });

    expect(first.status).toBe(201);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('DUPLICATE_STATEMENT');
    expect(otherUser.status).toBe(400);
    expect((await walletOf(userId)).wallet.credit_balance).toBe('75.00');
    expect((await walletOf(otherUserId)).wallet.credit_balance).toBe('0.00');
  });

  test('concurrent duplicate submissions mint exactly once', async () => {
    const userId = await createUser();
    const payload = { userId, fileBase64: toBase64(statementText({ amount: '20.00' })), mimeType: 'text/plain' };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post('/api/v1/statements/ingest').send(payload)),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
    expect((await walletOf(userId)).wallet.credit_balance).toBe('20.00');
  });

  test('settlement with insufficient credits is rejected and leaves no trace', async () => {
    const userId = await createUser();
    const { body: { statement } } = await ingest(userId, '100.00');

    const res = await request(app).post('/api/v1/payments/settle').send({ userId, statementId: statement.statement_id });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { shortfall: '2.00' } });
    const { wallet, ledgerEntries } = await walletOf(userId);
    expect(wallet.credit_balance).toBe('100.00');
    expect(ledgerEntries).toHaveLength(1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM settlements WHERE statement_id = $1', [statement.statement_id]);
    expect(rows[0].n).toBe(0);
    const { rows: [s] } = await pool.query('SELECT verification_status FROM statements WHERE statement_id = $1', [statement.statement_id]);
    expect(s.verification_status).toBe('pending');
  });

  test('settlement pays the provider in full with 0.00 provider fee and debits bill + fee from the wallet', async () => {
    const userId = await createUser();
    const { body: { statement } } = await ingest(userId, '142.37');
    await ingest(userId, '10.00');

    const res = await request(app).post('/api/v1/payments/settle')
      .send({ userId, statementId: statement.statement_id, platformFeeRate: 0.02 });

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toMatchObject({
      fullBillAmount: '142.37', beneficiaryFee: '2.85', totalCreditsDeducted: '145.22',
      providerReceives: '142.37', providerFee: '0.00', providerPayoutPercent: 100,
    });
    expect(res.body.wallet.creditBalance).toBe('7.15');

    const { rows: [settlement] } = await pool.query(
      'SELECT remittance_amount, fee_deducted_from_provider, payment_channel, disbursement_status FROM settlements WHERE statement_id = $1',
      [statement.statement_id],
    );
    expect(settlement).toEqual({
      remittance_amount: '142.37', fee_deducted_from_provider: '0.00', payment_channel: 'ACH_DIRECT', disbursement_status: 'completed',
    });

    const { wallet, ledgerEntries } = await walletOf(userId);
    expect(wallet.credit_balance).toBe('7.15');
    const byType = Object.fromEntries(ledgerEntries.filter((e) => e.entry_type !== 'CREDIT_ISSUANCE').map((e) => [e.entry_type, e]));
    expect(byType.SETTLEMENT_PAYMENT).toMatchObject({ amount: '-142.37', balance_after: '10.00' });
    expect(byType.PLATFORM_FEE).toMatchObject({ amount: '-2.85', balance_after: '7.15' });
    expect(ledgerEntries.map((e) => e.balance_after)).toEqual(['7.15', '10.00', '152.37', '142.37']);

    const { rows: [sum] } = await pool.query(
      'SELECT sum(amount)::text AS total FROM ledger_entries WHERE wallet_id = $1', [wallet.wallet_id],
    );
    expect(sum.total).toBe(wallet.credit_balance);

    const { rows: [s] } = await pool.query('SELECT verification_status FROM statements WHERE statement_id = $1', [statement.statement_id]);
    expect(s.verification_status).toBe('settled');
    expect(await AuditLog.countDocuments({ statementId: statement.statement_id, event: 'STATEMENT_SETTLED' })).toBe(1);
  });

  test('concurrent settle requests settle once and never overdraw', async () => {
    const userId = await createUser();
    const { body: { statement } } = await ingest(userId, '50.00');
    await ingest(userId, '60.00');

    const results = await Promise.all(Array.from({ length: 4 }, () => request(app)
      .post('/api/v1/payments/settle').send({ userId, statementId: statement.statement_id })));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await walletOf(userId)).wallet.credit_balance).toBe('59.00');
  });

  test('the database itself refuses any settlement with a nonzero provider fee', async () => {
    const userId = await createUser();
    const { body: { statement } } = await ingest(userId, '30.00');

    await expect(pool.query(
      `INSERT INTO settlements (statement_id, payee_name, remittance_amount, fee_deducted_from_provider)
       VALUES ($1, 'X', 30.00, 0.60)`,
      [statement.statement_id],
    )).rejects.toMatchObject({ code: '23514', constraint: 'settlements_zero_provider_fee' });
  });

  test('settlement of an unknown statement returns 404', async () => {
    const userId = await createUser();
    const res = await request(app).post('/api/v1/payments/settle').send({ userId, statementId: crypto.randomUUID() });
    expect(res.status).toBe(404);
  });
});
