function createLoginThrottle({ maxFailures = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const failures = new Map();

  function current(key) {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= now()) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  }

  return {
    isBlocked: (key) => (current(key)?.count ?? 0) >= maxFailures,
    recordFailure(key) {
      const entry = current(key) ?? { count: 0, resetAt: now() + windowMs };
      entry.count += 1;
      failures.set(key, entry);
    },
    reset: (key) => failures.delete(key),
  };
}

module.exports = { createLoginThrottle };
