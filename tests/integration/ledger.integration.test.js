const crypto = require('crypto');
const request = require('supertest');
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

const PASSWORD = 'integration-pass';
let pool;
let app;

beforeAll(async () => {
  pool = await connectPostgres({ retries: 3, delayMs: 1000 });
  await connectMongo({ retries: 3, delayMs: 1000 });
  app = createApp({
    pool,
    ocr: createOcrService(),
    documentStore: createMongoDocumentStore(),
    sessionSecret: 'integration-test-session-secret',
    platformFeeRate: 0.02,
  });
});

afterAll(async () => {
  await closePostgres();
  await closeMongo();
});

async function createUser(email = `user-${crypto.randomUUID()}@example.com`) {
  const agent = request.agent(app);
  const res = await agent.post('/api/v1/auth/register').send({ email, password: PASSWORD });
  expect(res.status).toBe(201);
  return { agent, userId: res.body.user.user_id, email };
}

function ingest(agent, amount) {
  return agent.post('/api/v1/statements/ingest').send({
    fileBase64: toBase64(statementText({ amount })), mimeType: 'text/plain',
  });
}

function settle(agent, statementId, extra = {}) {
  return agent.post('/api/v1/payments/settle').send({ statementId, ...extra });
}

async function walletOf({ agent, userId }) {
  const res = await agent.get(`/api/v1/users/${userId}/wallet`);
  expect(res.status).toBe(200);
  return res.body;
}

async function addExistingCredits(userId, amount) {
  await pool.query('UPDATE wallets SET credit_balance = credit_balance + $1 WHERE user_id = $2', [amount, userId]);
}

describe('accounts and log-in (Postgres)', () => {
  test('register, log out, log back in; wrong password is rejected', async () => {
    const email = `Login-${crypto.randomUUID()}@Example.com`;
    const { userId } = await createUser(email);

    const { rows: [stored] } = await pool.query('SELECT password_hash FROM users WHERE user_id = $1', [userId]);
    expect(stored.password_hash).toMatch(/^scrypt\$/);
    expect(stored.password_hash).not.toContain(PASSWORD);

    const agent = request.agent(app);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
    const wrong = await agent.post('/api/v1/auth/login').send({ email, password: 'not-the-password' });
    expect(wrong.status).toBe(401);
    const ok = await agent.post('/api/v1/auth/login').send({ email: email.toLowerCase(), password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.user.user_id).toBe(userId);
    expect((await agent.get('/api/v1/auth/me')).body.user.user_id).toBe(userId);

    expect((await agent.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  test('duplicate emails are rejected', async () => {
    const { email } = await createUser();
    const res = await request(app).post('/api/v1/auth/register').send({ email: email.toUpperCase(), password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_EXISTS');
  });

  test("one user cannot see or pay another user's bills", async () => {
    const alice = await createUser();
    const bob = await createUser();
    const { body: { statement } } = await ingest(alice.agent, '12.00');

    expect((await bob.agent.get(`/api/v1/users/${alice.userId}/wallet`)).status).toBe(403);
    expect((await bob.agent.get(`/api/v1/users/${alice.userId}/statements`)).status).toBe(403);
    expect((await settle(bob.agent, statement.statement_id)).status).toBe(404);
    expect((await settle(bob.agent, statement.statement_id, { userId: alice.userId })).status).toBe(403);
    expect((await walletOf(alice)).wallet.credit_balance).toBe('12.00');
  });
});

describe('Necessify ledger (Postgres + Mongo)', () => {
  test('ingest mints credits dollar for dollar, records the 2% fee, writes the ledger, and stores the OCR document', async () => {
    const user = await createUser();

    const res = await ingest(user.agent, '142.37');

    expect(res.status).toBe(201);
    expect(res.body.wallet.creditBalance).toBe('142.37');
    expect(res.body.documentStored).toBe(true);
    const { statement } = res.body;
    expect(statement).toMatchObject({
      gross_amount: '142.37', verification_status: 'verified', due_date: '2026-10-15',
      platform_fee_rate: '0.020000', platform_fee: '2.85',
    });

    const { wallet, ledgerEntries } = await walletOf(user);
    expect(wallet.credit_balance).toBe('142.37');
    expect(ledgerEntries.map((e) => [e.entry_type, e.amount, e.balance_after])).toEqual([
      ['CREDIT_ISSUANCE', '142.37', '142.37'],
    ]);

    const doc = await StatementDocument.findOne({ statementId: statement.statement_id }).lean();
    expect(doc).toMatchObject({ userId: user.userId, ocrHash: statement.ocr_hash, ocrProvider: 'text' });
    expect(doc.extractedFields.grossAmount).toBe('142.37');
    expect(await AuditLog.countDocuments({ statementId: statement.statement_id, event: 'STATEMENT_INGESTED' })).toBe(1);
  });

  test('duplicate statement files are rejected with 400 and do not mint credits', async () => {
    const user = await createUser();
    const other = await createUser();
    const payload = { fileBase64: toBase64(statementText({ amount: '75.00' })), mimeType: 'text/plain' };

    const first = await user.agent.post('/api/v1/statements/ingest').send(payload);
    const again = await user.agent.post('/api/v1/statements/ingest').send(payload);
    const otherUser = await other.agent.post('/api/v1/statements/ingest').send(payload);

    expect(first.status).toBe(201);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('DUPLICATE_STATEMENT');
    expect(otherUser.status).toBe(400);
    expect((await walletOf(user)).wallet.credit_balance).toBe('75.00');
    expect((await walletOf(other)).wallet.credit_balance).toBe('0.00');
  });

  test('concurrent duplicate submissions mint exactly once', async () => {
    const user = await createUser();
    const payload = { fileBase64: toBase64(statementText({ amount: '20.00' })), mimeType: 'text/plain' };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => user.agent.post('/api/v1/statements/ingest').send(payload)),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 400)).toHaveLength(4);
    expect((await walletOf(user)).wallet.credit_balance).toBe('20.00');
  });

  test('a single $150 bill alone cannot cover its $3 fee', async () => {
    const user = await createUser();
    const { body: { statement, wallet } } = await ingest(user.agent, '150.00');
    expect(wallet.creditBalance).toBe('150.00');

    const res = await settle(user.agent, statement.statement_id);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { required: '153.00', shortfall: '3.00' } });
  });

  test('settling pays the provider 100% and takes the fee from existing wallet credits', async () => {
    const user = await createUser();
    await addExistingCredits(user.userId, '10.00');
    const { body: { statement } } = await ingest(user.agent, '142.37');

    const res = await settle(user.agent, statement.statement_id);

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toMatchObject({
      fullBillAmount: '142.37', platformFeeRate: 0.02, beneficiaryFee: '2.85', totalCreditsDeducted: '145.22',
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

    const { wallet, ledgerEntries } = await walletOf(user);
    expect(wallet.credit_balance).toBe('7.15');
    expect(ledgerEntries.map((e) => [e.entry_type, e.amount, e.balance_after])).toEqual([
      ['PLATFORM_FEE', '-2.85', '7.15'],
      ['SETTLEMENT_PAYMENT', '-142.37', '10.00'],
      ['CREDIT_ISSUANCE', '142.37', '152.37'],
    ]);

    const { rows: [s] } = await pool.query('SELECT verification_status FROM statements WHERE statement_id = $1', [statement.statement_id]);
    expect(s.verification_status).toBe('settled');
    expect(await AuditLog.countDocuments({ statementId: statement.statement_id, event: 'STATEMENT_SETTLED' })).toBe(1);
  });

  test('a client cannot lower or remove the fee', async () => {
    const user = await createUser();
    await addExistingCredits(user.userId, '5.00');
    const { body: { statement } } = await ingest(user.agent, '100.00');

    const res = await settle(user.agent, statement.statement_id, { platformFeeRate: 0 });

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toMatchObject({ platformFeeRate: 0.02, beneficiaryFee: '2.00', providerFee: '0.00' });
    expect(res.body.wallet.creditBalance).toBe('3.00');
  });

  test('settlement with insufficient credits is rejected and leaves no trace', async () => {
    const user = await createUser();
    const { body: { statement } } = await ingest(user.agent, '100.00');
    await pool.query('UPDATE wallets SET credit_balance = 50.00 WHERE user_id = $1', [user.userId]);

    const res = await settle(user.agent, statement.statement_id);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', details: { shortfall: '52.00' } });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM settlements WHERE statement_id = $1', [statement.statement_id]);
    expect(rows[0].n).toBe(0);
    const { rows: [s] } = await pool.query('SELECT verification_status FROM statements WHERE statement_id = $1', [statement.statement_id]);
    expect(s.verification_status).toBe('verified');
  });

  test('concurrent settle requests settle once and never overdraw', async () => {
    const user = await createUser();
    await addExistingCredits(user.userId, '7.00');
    const { body: { statement } } = await ingest(user.agent, '50.00');

    const results = await Promise.all(Array.from({ length: 4 }, () => settle(user.agent, statement.statement_id)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await walletOf(user)).wallet.credit_balance).toBe('6.00');
  });

  test('the database itself refuses any settlement with a nonzero provider fee', async () => {
    const user = await createUser();
    const { body: { statement } } = await ingest(user.agent, '30.00');

    await expect(pool.query(
      `INSERT INTO settlements (statement_id, payee_name, remittance_amount, fee_deducted_from_provider)
       VALUES ($1, 'X', 30.00, 0.60)`,
      [statement.statement_id],
    )).rejects.toMatchObject({ code: '23514', constraint: 'settlements_zero_provider_fee' });
  });

  test('users list their statements with current status and fee', async () => {
    const user = await createUser();
    const { body: { statement: paid } } = await ingest(user.agent, '40.00');
    await ingest(user.agent, '5.00');
    expect((await settle(user.agent, paid.statement_id)).status).toBe(200);

    const res = await user.agent.get(`/api/v1/users/${user.userId}/statements`);
    expect(res.status).toBe(200);
    expect(res.body.statements.map((s) => [s.gross_amount, s.platform_fee, s.verification_status])).toEqual([
      ['5.00', '0.10', 'verified'], ['40.00', '0.80', 'settled'],
    ]);
    expect((await walletOf(user)).wallet.credit_balance).toBe('4.20');
  });

  test('ledger invariants hold across many bills: wallet = sum of entries, provider gets gross, fee only from wallet', async () => {
    const user = await createUser();
    await addExistingCredits(user.userId, '3.00');
    await pool.query(
      `INSERT INTO ledger_entries (wallet_id, entry_type, amount, balance_after, description)
       SELECT wallet_id, 'CREDIT_ISSUANCE', 3.00, 3.00, 'opening balance' FROM wallets WHERE user_id = $1`,
      [user.userId],
    );
    const amounts = ['150.00', '0.01', '33.33', '1234.56', '99.99'];
    const statements = [];
    for (const amount of amounts) {
      const res = await ingest(user.agent, amount);
      expect(res.status).toBe(201);
      statements.push(res.body.statement);
    }
    for (const st of statements.slice(0, 4)) {
      expect((await settle(user.agent, st.statement_id)).status).toBe(200);
    }

    const { wallet } = await walletOf(user);
    const { rows: [sum] } = await pool.query(
      'SELECT sum(amount)::numeric(12,2)::text AS total FROM ledger_entries WHERE wallet_id = $1', [wallet.wallet_id],
    );
    expect(sum.total).toBe(wallet.credit_balance);
    expect(wallet.credit_balance).toBe('74.63');

    const { rows: outflows } = await pool.query(
      `SELECT s.gross_amount, st.remittance_amount, st.fee_deducted_from_provider, s.platform_fee,
              (SELECT -sum(amount) FROM ledger_entries l WHERE l.statement_id = s.statement_id
                 AND l.entry_type = 'PLATFORM_FEE')::numeric(12,2)::text AS fee_debited
       FROM settlements st JOIN statements s USING (statement_id) WHERE s.user_id = $1`,
      [user.userId],
    );
    expect(outflows).toHaveLength(4);
    for (const row of outflows) {
      expect(row.remittance_amount).toBe(row.gross_amount);
      expect(row.fee_deducted_from_provider).toBe('0.00');
      expect(row.fee_debited).toBe(row.platform_fee);
    }
  });

  test('settlement of an unknown statement returns 404', async () => {
    const user = await createUser();
    const res = await settle(user.agent, crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});
