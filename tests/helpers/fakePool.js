function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

// Minimal pg Pool stand-in: every query (pool-level or via a checked-out client)
// is recorded and answered by `handler(sql, params)`.
function createFakePool(handler) {
  const queries = [];
  const run = async (sql, params = []) => {
    const text = normalize(sql);
    queries.push({ sql: text, params });
    const result = await handler(text, params);
    return result ?? { rows: [] };
  };
  const client = { query: jest.fn(run), release: jest.fn() };
  return {
    queries,
    client,
    query: jest.fn(run),
    connect: jest.fn(async () => client),
    find: (fragment) => queries.filter((q) => q.sql.includes(fragment)),
  };
}

function createFakeDocumentStore() {
  return {
    saveStatementDocument: jest.fn(async () => {}),
    audit: jest.fn(async () => {}),
  };
}

module.exports = { createFakePool, createFakeDocumentStore };
