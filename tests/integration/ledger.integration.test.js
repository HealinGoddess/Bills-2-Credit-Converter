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

function ingest(agent, amount, payee) {
  return agent.post('/api/v1/statements/ingest').send({
    fileBase64: toBase64(statementText({ amount, payee })), mimeType: 'text/plain',
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
    expect((await walletOf(alice)).wallet.credit_balance).toBe('87.00');
  });
});

describe('Necessify ledger (Postgres + Mongo)', () => {
  test("ingest mints credits dollar for dollar, bills the month's $75 plan, writes the ledger, and stores the OCR document", async () => {
    const user = await createUser();

    const res = await ingest(user.agent, '142.37');

    expect(res.status).toBe(201);
    expect(res.body.documentStored).toBe(true);
    const { statement, subscription } = res.body;
    expect(statement).toMatchObject({
      gross_amount: '142.37', verification_status: 'verified', due_date: '2026-10-15', statement_type: 'UTILITY',
    });
    expect(subscription).toMatchObject({
      payee_name: 'Necessify Monthly Plan', gross_amount: '75.00', verification_status: 'verified',
      statement_type: 'PLATFORM_SUBSCRIPTION',
    });
    expect(subscription.account_number_masked).toMatch(/^\d{4}-\d{2} plan, up to 5 companies$/);
    expect(res.body.wallet.creditBalance).toBe('217.37');

    const { wallet, ledgerEntries } = await walletOf(user);
    expect(wallet.credit_balance).toBe('217.37');
    expect(ledgerEntries.map((e) => [e.entry_type, e.amount, e.balance_after])).toEqual([
      ['CREDIT_ISSUANCE', '75.00', '217.37'],
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
    expect((await walletOf(user)).wallet.credit_balance).toBe('150.00');
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
    expect((await walletOf(user)).wallet.credit_balance).toBe('95.00');
  });

  test('the plan is billed once a month: $75 for up to 5 companies, raised to $150 at the 6th', async () => {
    const user = await createUser();
    const payees = ['Light Co', 'Water Co', 'Gas Co', 'Internet Co', 'Landlord LLC'];
    const first = await ingest(user.agent, '10.00', payees[0]);
    const planId = first.body.subscription.statement_id;
    for (const payee of [...payees.slice(1), ' light co ']) {
      const res = await ingest(user.agent, '10.00', payee);
      expect(res.status).toBe(201);
      expect(res.body.subscription).toBeNull();
    }

    const sixth = await ingest(user.agent, '10.00', 'Phone Co');
    expect(sixth.body.subscription).toMatchObject({ statement_id: planId, gross_amount: '150.00' });
    expect(sixth.body.subscription.account_number_masked).toMatch(/more than 5 companies$/);
    expect((await ingest(user.agent, '10.00', 'Trash Co')).body.subscription).toBeNull();
    expect((await walletOf(user)).wallet.credit_balance).toBe('230.00');

    const paid = await settle(user.agent, planId);
    expect(paid.status).toBe(200);
    expect(paid.body.breakdown.providerReceives).toBe('150.00');
    expect(paid.body.wallet.creditBalance).toBe('80.00');
  });

  test('a 6th company after the $75 plan was paid bills the extra $75 as its own upgrade bill', async () => {
    const user = await createUser();
    const first = await ingest(user.agent, '10.00', 'Co 1');
    expect((await settle(user.agent, first.body.subscription.statement_id)).status).toBe(200);
    for (let i = 2; i <= 5; i += 1) await ingest(user.agent, '10.00', `Co ${i}`);

    const sixth = await ingest(user.agent, '10.00', 'Co 6');

    expect(sixth.body.subscription.statement_id).not.toBe(first.body.subscription.statement_id);
    expect(sixth.body.subscription).toMatchObject({ gross_amount: '75.00', verification_status: 'verified' });
    expect(sixth.body.subscription.account_number_masked).toMatch(/^Upgrade: .* more than 5 companies$/);
    expect((await settle(user.agent, sixth.body.subscription.statement_id)).status).toBe(200);
    const { rows: [billed] } = await pool.query(
      `SELECT sum(gross_amount)::text AS total FROM statements WHERE user_id = $1 AND statement_type = 'PLATFORM_SUBSCRIPTION'`,
      [user.userId],
    );
    expect(billed.total).toBe('150.00');
  });

  test('a $150 bill pays its provider in full from its own credits; the monthly plan is paid separately from its own credits', async () => {
    const user = await createUser();
    const { body: { statement, subscription, wallet } } = await ingest(user.agent, '150.00');
    expect(wallet.creditBalance).toBe('225.00');

    const paid = await settle(user.agent, statement.statement_id);
    expect(paid.status).toBe(200);
    expect(paid.body.breakdown).toEqual({
      fullBillAmount: '150.00', creditsDeducted: '150.00', providerReceives: '150.00', providerFee: '0.00',
      providerPayoutPercent: 100,
    });
    expect(paid.body.wallet.creditBalance).toBe('75.00');

    const fee = await settle(user.agent, subscription.statement_id);
    expect(fee.status).toBe(200);
    expect(fee.body.wallet.creditBalance).toBe('0.00');
    expect((await settle(user.agent, subscription.statement_id)).status).toBe(409);

    const { ledgerEntries } = await walletOf(user);
    expect(ledgerEntries.map((e) => [e.entry_type, e.amount, e.balance_after])).toEqual([
      ['PLATFORM_FEE', '-75.00', '0.00'],
      ['SETTLEMENT_PAYMENT', '-150.00', '75.00'],
      ['CREDIT_ISSUANCE', '75.00', '225.00'],
      ['CREDIT_ISSUANCE', '150.00', '150.00'],
    ]);

    const { rows: settlements } = await pool.query(
      `SELECT st.payee_name, st.remittance_amount, st.fee_deducted_from_provider, st.payment_channel, st.disbursement_status
       FROM settlements st JOIN statements s USING (statement_id) WHERE s.user_id = $1 ORDER BY st.remittance_amount DESC`,
      [user.userId],
    );
    expect(settlements).toEqual([
      { payee_name: 'City Power & Light', remittance_amount: '150.00', fee_deducted_from_provider: '0.00', payment_channel: 'ACH_DIRECT', disbursement_status: 'completed' },
      { payee_name: 'Necessify Monthly Plan', remittance_amount: '75.00', fee_deducted_from_provider: '0.00', payment_channel: 'ACH_DIRECT', disbursement_status: 'completed' },
    ]);
    const { rows } = await pool.query('SELECT verification_status FROM statements WHERE user_id = $1', [user.userId]);
    expect(rows.map((r) => r.verification_status)).toEqual(['settled', 'settled']);
    expect(await AuditLog.countDocuments({ statementId: statement.statement_id, event: 'STATEMENT_SETTLED' })).toBe(1);
  });

  test("one bill's credits cannot pay another bill", async () => {
    const user = await createUser();
    await ingest(user.agent, '100.00');
    const { rows: [water] } = await pool.query(
      `INSERT INTO statements (user_id, payee_name, account_number_masked, gross_amount, due_date, ocr_hash, verification_status)
       VALUES ($1, 'Water Co', '****9999', 80.00, '2026-11-01', $2, 'verified') RETURNING statement_id`,
      [user.userId, crypto.randomUUID().replace(/-/g, '')],
    );

    const res = await settle(user.agent, water.statement_id);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_CREDITS', details: { required: '80.00', available: '0.00', shortfall: '80.00' },
    });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM settlements WHERE statement_id = $1', [water.statement_id]);
    expect(rows[0].n).toBe(0);
    expect((await walletOf(user)).wallet.credit_balance).toBe('175.00');
  });

  test('a client cannot add a fee at payment time', async () => {
    const user = await createUser();
    const { body: { statement } } = await ingest(user.agent, '100.00');

    const res = await settle(user.agent, statement.statement_id, { platformFeeRate: 0.5 });

    expect(res.status).toBe(200);
    expect(res.body.breakdown).toMatchObject({ creditsDeducted: '100.00', providerReceives: '100.00', providerFee: '0.00' });
    expect(res.body.wallet.creditBalance).toBe('75.00');
  });

  test('concurrent settle requests settle exactly once', async () => {
    const user = await createUser();
    const { body: { statement } } = await ingest(user.agent, '50.00');

    const results = await Promise.all(Array.from({ length: 4 }, () => settle(user.agent, statement.statement_id)));

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
    expect((await walletOf(user)).wallet.credit_balance).toBe('75.00');
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

  test('users list their statements, including the monthly plan bill', async () => {
    const user = await createUser();
    const { body: { statement: paid } } = await ingest(user.agent, '40.00');
    await ingest(user.agent, '5.00', 'Water Co');
    expect((await settle(user.agent, paid.statement_id)).status).toBe(200);

    const res = await user.agent.get(`/api/v1/users/${user.userId}/statements`);
    expect(res.status).toBe(200);
    expect(res.body.statements.map((s) => [s.statement_type, s.payee_name, s.gross_amount, s.verification_status])).toEqual([
      ['UTILITY', 'Water Co', '5.00', 'verified'],
      ['PLATFORM_SUBSCRIPTION', 'Necessify Monthly Plan', '75.00', 'verified'],
      ['UTILITY', 'City Power & Light', '40.00', 'settled'],
    ]);
    expect(res.body.statements[1].billing_month).toMatch(/^\d{4}-\d{2}-01$/);
    expect((await walletOf(user)).wallet.credit_balance).toBe('80.00');
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
    let plan;
    for (const amount of amounts) {
      const res = await ingest(user.agent, amount);
      expect(res.status).toBe(201);
      statements.push(res.body.statement);
      plan ??= res.body.subscription;
    }
    for (const st of [...statements.slice(0, 4), plan]) {
      expect((await settle(user.agent, st.statement_id)).status).toBe(200);
    }

    const { wallet } = await walletOf(user);
    const { rows: [sum] } = await pool.query(
      'SELECT sum(amount)::numeric(12,2)::text AS total FROM ledger_entries WHERE wallet_id = $1', [wallet.wallet_id],
    );
    expect(sum.total).toBe(wallet.credit_balance);
    expect(wallet.credit_balance).toBe('102.99');

    const { rows: outflows } = await pool.query(
      `SELECT s.statement_type, s.gross_amount, st.remittance_amount, st.fee_deducted_from_provider,
              (SELECT sum(amount) FROM ledger_entries l WHERE l.statement_id = s.statement_id)::numeric(12,2)::text AS left_on_statement,
              (SELECT count(*) FROM ledger_entries l WHERE l.statement_id = s.statement_id AND l.entry_type = 'PLATFORM_FEE')::int AS fee_rows
       FROM settlements st JOIN statements s USING (statement_id) WHERE s.user_id = $1`,
      [user.userId],
    );
    expect(outflows).toHaveLength(5);
    for (const row of outflows) {
      expect(row.remittance_amount).toBe(row.gross_amount);
      expect(row.fee_deducted_from_provider).toBe('0.00');
      expect(row.left_on_statement).toBe('0.00');
      expect(row.fee_rows).toBe(row.statement_type === 'PLATFORM_SUBSCRIPTION' ? 1 : 0);
    }
  });

  test('settlement of an unknown statement returns 404', async () => {
    const user = await createUser();
    const res = await settle(user.agent, crypto.randomUUID());
    expect(res.status).toBe(404);
  });
});
