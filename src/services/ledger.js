const { withTransaction } = require('../../db/postgres');
const { ApiError } = require('../lib/errors');
const { decodeBase64File, sha256Hex } = require('../lib/hash');
const { toCents, fromCents, percentOfCents } = require('../lib/money');
const { isUuid } = require('../lib/validate');

const DEFAULT_PLATFORM_FEE_RATE = 0.02;
const PROVIDER_FEE = '0.00';

function computeSettlement(grossAmount, platformFeeRate) {
  const fullBillCents = toCents(grossAmount);
  const beneficiaryFeeCents = percentOfCents(fullBillCents, platformFeeRate);
  return {
    fullBillCents,
    beneficiaryFeeCents,
    totalCreditsRequiredCents: fullBillCents + beneficiaryFeeCents,
    providerFeeCents: 0,
  };
}

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
        const wallet = await lockWallet(client, userId);

        const { rows: [statement] } = await client.query(
          `INSERT INTO statements (user_id, payee_name, account_number_masked, gross_amount, due_date, ocr_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING statement_id, user_id, payee_name, account_number_masked, gross_amount, due_date::text AS due_date,
                     ocr_hash, verification_status, created_at`,
          [userId, payeeName, accountNumberMasked, fromCents(grossCents), dueDate, ocrHash],
        );

        const newBalance = fromCents(toCents(wallet.credit_balance) + grossCents);
        await client.query(
          'UPDATE wallets SET credit_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
          [newBalance, wallet.wallet_id],
        );

        const { rows: [ledgerEntry] } = await client.query(
          `INSERT INTO ledger_entries (wallet_id, statement_id, entry_type, amount, balance_after, description, created_at)
           VALUES ($1, $2, 'CREDIT_ISSUANCE', $3, $4, $5, clock_timestamp())
           RETURNING entry_id, entry_type, amount, balance_after, description, created_at`,
          [wallet.wallet_id, statement.statement_id, fromCents(grossCents), newBalance,
            `Credit issuance for ${payeeName} statement ${accountNumberMasked}`],
        );

        return {
          statement,
          wallet: { walletId: wallet.wallet_id, creditBalance: newBalance, currency: wallet.currency },
          ledgerEntry,
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
        details: { grossAmount: result.statement.gross_amount, balanceAfter: result.wallet.creditBalance },
      }),
    ]);

    return { ...result, documentStored };
  }

  async function settleStatement({ userId, statementId, platformFeeRate = DEFAULT_PLATFORM_FEE_RATE }) {
    if (!isUuid(userId)) throw new ApiError(400, 'VALIDATION_ERROR', 'userId must be a UUID');
    if (!isUuid(statementId)) throw new ApiError(400, 'VALIDATION_ERROR', 'statementId must be a UUID');
    if (typeof platformFeeRate !== 'number' || !Number.isFinite(platformFeeRate)
      || platformFeeRate < 0 || platformFeeRate > 1) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'platformFeeRate must be a number between 0 and 1');
    }

    const result = await tx(async (client) => {
      const { rows: [statement] } = await client.query(
        `SELECT statement_id, user_id, payee_name, gross_amount, verification_status
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

      const calc = computeSettlement(statement.gross_amount, platformFeeRate);
      const balanceCents = toCents(wallet.credit_balance);
      if (balanceCents < calc.totalCreditsRequiredCents) {
        throw new ApiError(400, 'INSUFFICIENT_CREDITS', 'Wallet credit balance is insufficient for this settlement', {
          required: fromCents(calc.totalCreditsRequiredCents),
          available: fromCents(balanceCents),
          shortfall: fromCents(calc.totalCreditsRequiredCents - balanceCents),
        });
      }

      const afterPayment = fromCents(balanceCents - calc.fullBillCents);
      const afterFee = fromCents(balanceCents - calc.totalCreditsRequiredCents);

      await client.query(
        'UPDATE wallets SET credit_balance = $1, updated_at = CURRENT_TIMESTAMP WHERE wallet_id = $2',
        [afterFee, wallet.wallet_id],
      );

      const insertEntry = `INSERT INTO ledger_entries (wallet_id, statement_id, entry_type, amount, balance_after, description, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`;
      await client.query(insertEntry, [
        wallet.wallet_id, statementId, 'SETTLEMENT_PAYMENT', fromCents(-calc.fullBillCents), afterPayment,
        `Full remittance to ${statement.payee_name}`,
      ]);
      await client.query(insertEntry, [
        wallet.wallet_id, statementId, 'PLATFORM_FEE', fromCents(-calc.beneficiaryFeeCents), afterFee,
        `Beneficiary platform fee at rate ${platformFeeRate}`,
      ]);

      const { rows: [settlement] } = await client.query(
        `INSERT INTO settlements (statement_id, payee_name, remittance_amount, fee_deducted_from_provider)
         VALUES ($1, $2, $3, $4)
         RETURNING settlement_id, statement_id, payee_name, remittance_amount, fee_deducted_from_provider,
                   payment_channel, disbursement_status, settled_at`,
        [statementId, statement.payee_name, fromCents(calc.fullBillCents), PROVIDER_FEE],
      );

      await client.query("UPDATE statements SET verification_status = 'settled' WHERE statement_id = $1", [statementId]);

      return {
        settlement,
        breakdown: {
          fullBillAmount: fromCents(calc.fullBillCents),
          platformFeeRate,
          beneficiaryFee: fromCents(calc.beneficiaryFeeCents),
          totalCreditsDeducted: fromCents(calc.totalCreditsRequiredCents),
          providerReceives: fromCents(calc.fullBillCents),
          providerFee: PROVIDER_FEE,
          providerPayoutPercent: 100,
        },
        wallet: { walletId: wallet.wallet_id, creditBalance: afterFee, currency: wallet.currency },
      };
    });

    await recordSideEffects(documentStore, logger, [
      (store) => store.audit('STATEMENT_SETTLED', { userId, statementId, details: result.breakdown }),
    ]);

    return result;
  }

  return { ingestStatement, settleStatement };
}

module.exports = { createLedgerService, computeSettlement, DEFAULT_PLATFORM_FEE_RATE };
