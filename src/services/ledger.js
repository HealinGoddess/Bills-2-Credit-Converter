const crypto = require('crypto');
const { withTransaction } = require('../../db/postgres');
const { ApiError } = require('../lib/errors');
const { decodeBase64File, sha256Hex } = require('../lib/hash');
const { toCents, fromCents } = require('../lib/money');
const { monthlyFeeCents, planLabel } = require('../lib/subscription');
const { isUuid } = require('../lib/validate');

const PROVIDER_FEE = '0.00';
const SUBSCRIPTION_TYPE = 'PLATFORM_SUBSCRIPTION';
const SUBSCRIPTION_PAYEE = 'Necessify Monthly Plan';
const SUBSCRIPTION_COLUMNS = `statement_id, payee_name, account_number_masked, gross_amount, due_date::text AS due_date,
  verification_status, statement_type, billing_month::text AS billing_month`;

async function recordSideEffects(documentStore, logger, tasks) {
  const results = await Promise.allSettled(tasks.map((task) => task(documentStore)));
  results.forEach((r) => {
    if (r.status === 'rejected') logger.error('Document store write failed:', r.reason);
  });
  return results.map((r) => r.status === 'fulfilled');
}

async function lockWallet(client, userId) {
  await client.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
  const { rows } = await client.query(
    'SELECT wallet_id, credit_balance, currency FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  return rows[0];
}

// Converts a verified statement (remittance asset) into NOU credits, dollar for dollar.
// `amount` mints only part of the statement (used when a monthly plan bill is raised).
async function mintCreditsFromAsset(client, { statementId, userId, amount }) {
  const { rows: [asset] } = await client.query(
    `SELECT statement_id, payee_name, account_number_masked, gross_amount
     FROM statements WHERE statement_id = $1 AND user_id = $2 FOR UPDATE`,
    [statementId, userId],
  );
  if (!asset) throw new ApiError(404, 'STATEMENT_NOT_FOUND', 'Statement not found');
  const wallet = await lockWallet(client, userId);

  const mintCents = toCents(amount ?? asset.gross_amount);
  const newBalance = fromCents(toCents(wallet.credit_balance) + mintCents);
  await client.query(
    'UPDATE wallets SET credit_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
    [newBalance, wallet.wallet_id],
  );

  const { rows: [ledgerEntry] } = await client.query(
    `INSERT INTO ledger_entries (wallet_id, statement_id, entry_type, amount, balance_after, description, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())
     RETURNING entry_id, entry_type, amount, balance_after, description, created_at`,
    [
      wallet.wallet_id, statementId, 'CREDIT_ISSUANCE', fromCents(mintCents), newBalance,
      `Credit issuance for ${asset.payee_name} statement ${asset.account_number_masked}`,
    ],
  );

  return {
    wallet: { walletId: wallet.wallet_id, creditBalance: newBalance, currency: wallet.currency },
    ledgerEntries: [ledgerEntry],
  };
}

// Brings this month's plan bill(s) up to the fee for the number of companies billed this month.
// Raises the unpaid plan bill if there is one, otherwise bills the difference as a new plan bill.
async function syncMonthlySubscription(client, { userId }) {
  const { rows: [usage] } = await client.query(
    `SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date::text AS billing_month,
            count(DISTINCT lower(trim(payee_name)))::int AS companies
     FROM statements
     WHERE user_id = $1 AND statement_type = 'UTILITY'
       AND date_trunc('month', created_at AT TIME ZONE 'UTC') = date_trunc('month', now() AT TIME ZONE 'UTC')`,
    [userId],
  );
  const { rows: bills } = await client.query(
    `SELECT statement_id, gross_amount, verification_status FROM statements
     WHERE user_id = $1 AND statement_type = $2 AND billing_month = $3 ORDER BY created_at FOR UPDATE`,
    [userId, SUBSCRIPTION_TYPE, usage.billing_month],
  );
  const billedCents = bills.reduce((total, bill) => total + toCents(bill.gross_amount), 0);
  const extraCents = monthlyFeeCents(usage.companies) - billedCents;
  if (extraCents <= 0) return null;

  const plan = `${usage.billing_month.slice(0, 7)} plan, ${planLabel(usage.companies)}`;
  const unpaid = bills.find((bill) => bill.verification_status !== 'settled');
  let subscription;
  if (unpaid) {
    ({ rows: [subscription] } = await client.query(
      `UPDATE statements SET gross_amount = gross_amount + $2, account_number_masked = $3 WHERE statement_id = $1
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [unpaid.statement_id, fromCents(extraCents), plan],
    ));
  } else {
    ({ rows: [subscription] } = await client.query(
      `INSERT INTO statements (user_id, payee_name, account_number_masked, gross_amount, due_date, ocr_hash,
                               verification_status, statement_type, billing_month)
       VALUES ($1, $2, $3, $4, ($5::date + interval '1 month' - interval '1 day')::date, $6, 'verified', $7, $5::date)
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        userId, SUBSCRIPTION_PAYEE, bills.length > 0 ? `Upgrade: ${plan}` : plan, fromCents(extraCents),
        usage.billing_month, sha256Hex(Buffer.from(`necessify-subscription:${crypto.randomUUID()}`)), SUBSCRIPTION_TYPE,
      ],
    ));
  }
  const { wallet } = await mintCreditsFromAsset(client, {
    statementId: subscription.statement_id, userId, amount: fromCents(extraCents),
  });
  return { subscription, wallet };
}

function createLedgerService({ pool, ocr, documentStore, logger = console }) {
  const tx = (fn) => withTransaction(fn, pool);

  async function assertActiveUser(userId) {
    const { rows } = await pool.query('SELECT account_status FROM users WHERE user_id = $1', [userId]);
    if (rows.length === 0) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
    if (rows[0].account_status !== 'active') {
      throw new ApiError(403, 'ACCOUNT_INACTIVE', 'User account is not active');
    }
  }

  async function ingestStatement({ userId, fileBase64, mimeType }) {
    if (!isUuid(userId)) throw new ApiError(400, 'VALIDATION_ERROR', 'userId must be a UUID');
    if (typeof fileBase64 !== 'string' || fileBase64.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'fileBase64 is required');
    }
    if (typeof mimeType !== 'string' || mimeType.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'mimeType is required');
    }

    const buffer = decodeBase64File(fileBase64);
    if (!buffer || buffer.length === 0) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'fileBase64 is not valid base64');
    }
    const ocrHash = sha256Hex(buffer);

    await assertActiveUser(userId);

    const duplicate = await pool.query('SELECT statement_id FROM statements WHERE ocr_hash = $1', [ocrHash]);
    if (duplicate.rows.length > 0) {
      throw new ApiError(400, 'DUPLICATE_STATEMENT', 'This statement has already been submitted');
    }

    const ocrResult = await ocr.extract({ buffer, mimeType });
    const { payeeName, accountNumberMasked, grossAmount, dueDate } = ocrResult.fields;
    const grossCents = toCents(grossAmount);

    let result;
    try {
      result = await tx(async (client) => {
        await lockWallet(client, userId);

        const { rows: [statement] } = await client.query(
          `INSERT INTO statements (user_id, payee_name, account_number_masked, gross_amount, due_date, ocr_hash,
                                   verification_status)
           VALUES ($1, $2, $3, $4, $5, $6, 'verified')
           RETURNING statement_id, user_id, payee_name, account_number_masked, gross_amount, due_date::text AS due_date,
                     ocr_hash, verification_status, statement_type, created_at`,
          [userId, payeeName, accountNumberMasked, fromCents(grossCents), dueDate, ocrHash],
        );

        const minted = await mintCreditsFromAsset(client, { statementId: statement.statement_id, userId });
        const plan = await syncMonthlySubscription(client, { userId });
        return {
          statement,
          ledgerEntries: minted.ledgerEntries,
          subscription: plan?.subscription ?? null,
          wallet: plan?.wallet ?? minted.wallet,
        };
      });
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'statements_ocr_hash_key') {
        throw new ApiError(400, 'DUPLICATE_STATEMENT', 'This statement has already been submitted');
      }
      throw err;
    }

    const statementId = result.statement.statement_id;
    const [documentStored] = await recordSideEffects(documentStore, logger, [
      (store) => store.saveStatementDocument({
        statementId,
        userId,
        ocrHash,
        mimeType,
        ocrProvider: ocrResult.provider,
        rawText: ocrResult.rawText,
        extractedFields: ocrResult.fields,
      }),
      (store) => store.audit('STATEMENT_INGESTED', {
        userId,
        statementId,
        details: {
          grossAmount: result.statement.gross_amount,
          subscriptionStatementId: result.subscription?.statement_id ?? null,
          balanceAfter: result.wallet.creditBalance,
        },
      }),
    ]);

    return { ...result, documentStored };
  }

  async function settleStatement({ userId, statementId }) {
    if (!isUuid(userId)) throw new ApiError(400, 'VALIDATION_ERROR', 'userId must be a UUID');
    if (!isUuid(statementId)) throw new ApiError(400, 'VALIDATION_ERROR', 'statementId must be a UUID');

    const result = await tx(async (client) => {
      const { rows: [statement] } = await client.query(
        `SELECT statement_id, user_id, payee_name, gross_amount, verification_status, statement_type
         FROM statements WHERE statement_id = $1 FOR UPDATE`,
        [statementId],
      );
      if (!statement || statement.user_id !== userId) {
        throw new ApiError(404, 'STATEMENT_NOT_FOUND', 'Statement not found');
      }
      if (statement.verification_status === 'settled') {
        throw new ApiError(409, 'ALREADY_SETTLED', 'Statement has already been settled');
      }

      const { rows: [wallet] } = await client.query(
        'SELECT wallet_id, credit_balance, currency FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId],
      );
      if (!wallet) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet not found');

      // A statement can only be paid with the credits minted from that same statement.
      const { rows: [earmarked] } = await client.query(
        `SELECT COALESCE(SUM(amount), 0)::numeric(12, 2)::text AS available
         FROM ledger_entries WHERE wallet_id = $1 AND statement_id = $2`,
        [wallet.wallet_id, statementId],
      );
      const billCents = toCents(statement.gross_amount);
      const availableCents = toCents(earmarked.available);
      if (availableCents < billCents) {
        throw new ApiError(400, 'INSUFFICIENT_CREDITS', "This statement's own credits don't cover its amount", {
          required: fromCents(billCents),
          available: fromCents(availableCents),
          shortfall: fromCents(billCents - availableCents),
        });
      }

      const isSubscription = statement.statement_type === SUBSCRIPTION_TYPE;
      const afterPayment = fromCents(toCents(wallet.credit_balance) - billCents);
      await client.query(
        'UPDATE wallets SET credit_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
        [afterPayment, wallet.wallet_id],
      );
      await client.query(
        `INSERT INTO ledger_entries (wallet_id, statement_id, entry_type, amount, balance_after, description, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`,
        [
          wallet.wallet_id, statementId, isSubscription ? 'PLATFORM_FEE' : 'SETTLEMENT_PAYMENT',
          fromCents(-billCents), afterPayment,
          isSubscription ? 'Necessify monthly plan payment' : `Full remittance to ${statement.payee_name}`,
        ],
      );

      const { rows: [settlement] } = await client.query(
        `INSERT INTO settlements (statement_id, payee_name, remittance_amount, fee_deducted_from_provider)
         VALUES ($1, $2, $3, $4)
         RETURNING settlement_id, statement_id, payee_name, remittance_amount, fee_deducted_from_provider,
                   payment_channel, disbursement_status, settled_at`,
        [statementId, statement.payee_name, fromCents(billCents), PROVIDER_FEE],
      );

      await client.query("UPDATE statements SET verification_status = 'settled' WHERE statement_id = $1", [statementId]);

      return {
        settlement,
        breakdown: {
          fullBillAmount: fromCents(billCents),
          creditsDeducted: fromCents(billCents),
          providerReceives: fromCents(billCents),
          providerFee: PROVIDER_FEE,
          providerPayoutPercent: 100,
        },
        wallet: { walletId: wallet.wallet_id, creditBalance: afterPayment, currency: wallet.currency },
      };
    });

    await recordSideEffects(documentStore, logger, [
      (store) => store.audit('STATEMENT_SETTLED', { userId, statementId, details: result.breakdown }),
    ]);

    return result;
  }

  return { ingestStatement, settleStatement };
}

module.exports = { createLedgerService, mintCreditsFromAsset, syncMonthlySubscription };
