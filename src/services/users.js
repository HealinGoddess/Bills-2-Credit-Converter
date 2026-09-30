const { withTransaction } = require('../../db/postgres');
const { ApiError } = require('../lib/errors');
const { isUuid } = require('../lib/validate');
const { hashPassword, verifyPassword, isAcceptablePassword, MIN_PASSWORD_LENGTH } = require('../lib/password');
const { resolvePlatformFee } = require('./ledger');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USER_COLUMNS = 'user_id, email, account_status, created_at';

function assertEmail(email) {
  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email) || email.length > 255) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'A valid email is required');
  }
}

function createUserService({ pool, platformFeeRate }) {
  let dummyHash;

  async function createUser({ email, password }) {
    assertEmail(email);
    if (!isAcceptablePassword(password)) {
      throw new ApiError(400, 'VALIDATION_ERROR', `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const passwordHash = await hashPassword(password);
    try {
      return await withTransaction(async (client) => {
        const { rows: [user] } = await client.query(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING ${USER_COLUMNS}`,
          [email.toLowerCase(), passwordHash],
        );
        const { rows: [wallet] } = await client.query(
          'INSERT INTO wallets (user_id) VALUES ($1) RETURNING wallet_id, credit_balance, currency',
          [user.user_id],
        );
        return { user, wallet };
      }, pool);
    } catch (err) {
      if (err.code === '23505' && err.constraint === 'users_email_key') {
        throw new ApiError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async function authenticate({ email, password }) {
    const invalid = new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    if (typeof email !== 'string' || typeof password !== 'string' || password.length === 0) throw invalid;
    const { rows: [row] } = await pool.query(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase()],
    );
    if (!row?.password_hash) {
      dummyHash ??= await hashPassword('necessify-timing-equalizer');
      await verifyPassword(password, dummyHash);
      throw invalid;
    }
    if (!(await verifyPassword(password, row.password_hash))) throw invalid;
    if (row.account_status !== 'active') {
      throw new ApiError(403, 'ACCOUNT_INACTIVE', 'User account is not active');
    }
    const { password_hash: _omit, ...user } = row;
    return { user };
  }

  async function getUser(userId) {
    if (!isUuid(userId)) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in');
    const { rows: [user] } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE user_id = $1`, [userId]);
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in');
    return { user };
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

  async function listStatements(userId) {
    if (!isUuid(userId)) throw new ApiError(400, 'VALIDATION_ERROR', 'userId must be a UUID');
    const { rows } = await pool.query(
      `SELECT statement_id, payee_name, account_number_masked, gross_amount, due_date::text AS due_date,
              verification_status, platform_fee_rate, platform_fee, created_at
       FROM statements WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return {
      statements: rows.map((row) => {
        const fee = resolvePlatformFee(row, platformFeeRate);
        return { ...row, platform_fee_rate: fee.rate, platform_fee: fee.amount };
      }),
    };
  }

  return { createUser, authenticate, getUser, getWallet, listStatements };
}

module.exports = { createUserService };
