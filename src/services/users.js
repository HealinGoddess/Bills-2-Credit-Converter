const { withTransaction } = require('../../db/postgres');
const { ApiError } = require('../lib/errors');
const { isUuid } = require('../lib/validate');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function createUserService({ pool }) {
  async function createUser({ email }) {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email) || email.length > 255) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A valid email is required');
    }
    try {
      return await withTransaction(async (client) => {
        const { rows: [user] } = await client.query(
          'INSERT INTO users (email) VALUES ($1) RETURNING user_id, email, account_status, created_at',
          [email.toLowerCase()],
        );
        const { rows: [wallet] } = await client.query(
          'INSERT INTO wallets (user_id) VALUES ($1) RETURNING wallet_id, credit_balance, currency',
          [user.user_id],
        );
        return { user, wallet };
      }, pool);
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'users_email_key') {
        throw new ApiError(409, 'EMAIL_EXISTS', 'A user with this email already exists');
      }
      throw err;
    }
  }

  async function getWallet(userId, { limit = 50 } = {}) {
    if (!isUuid(userId)) throw new ApiError(400, 'VALIDATION_ERROR', 'userId must be a UUID');
    const { rows: [wallet] } = await pool.query(
      'SELECT wallet_id, user_id, credit_balance, currency, updated_at FROM wallets WHERE user_id = $1',
      [userId],
    );
    if (!wallet) throw new ApiError(404, 'WALLET_NOT_FOUND', 'Wallet not found');
    const { rows: entries } = await pool.query(
      `SELECT entry_id, statement_id, entry_type, amount, balance_after, description, created_at
       FROM ledger_entries WHERE wallet_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [wallet.wallet_id, limit],
    );
    return { wallet, ledgerEntries: entries };
  }

  async function findByEmail(email) {
    if (typeof email !== 'string' || !EMAIL_PATTERN.test(email)) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'A valid email is required');
    }
    const { rows: [user] } = await pool.query(
      'SELECT user_id, email, account_status, created_at FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
    return { user };
  }

  async function listStatements(userId) {
    if (!isUuid(userId)) throw new ApiError(400, 'VALIDATION_ERROR', 'userId must be a UUID');
    const { rows } = await pool.query(
      `SELECT statement_id, payee_name, account_number_masked, gross_amount, due_date::text AS due_date,
              verification_status, created_at
       FROM statements WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return { statements: rows };
  }

  return { createUser, getWallet, findByEmail, listStatements };
}

module.exports = { createUserService };
