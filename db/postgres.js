const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Keep NUMERIC as strings so money never passes through floating point.
types.setTypeParser(types.builtins.NUMERIC, (value) => value);

const SCHEMA_LOCK_KEY = 815_2024;

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
    });
  }
  return pool;
}

async function initSchema(targetPool = getPool()) {
  const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');
  const client = await targetPool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [SCHEMA_LOCK_KEY]);
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

async function connectPostgres({ retries = 10, delayMs = 2000 } = {}) {
  const p = getPool();
  for (let attempt = 1; ; attempt += 1) {
    try {
      await p.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await initSchema(p);
  return p;
}

async function withTransaction(fn, targetPool = getPool()) {
  const client = await targetPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closePostgres() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = { getPool, initSchema, connectPostgres, withTransaction, closePostgres };
