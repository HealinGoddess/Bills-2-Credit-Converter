const MONEY_PATTERN = /^-?\d+(\.\d{1,2})?$/;

function toCents(value) {
  const str = typeof value === 'number' ? value.toFixed(2) : String(value).trim();
  if (!MONEY_PATTERN.test(str)) {
    throw new TypeError(`Invalid money value: ${value}`);
  }
  const negative = str.startsWith('-');
  const [whole, frac = ''] = str.replace('-', '').split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return negative ? -cents : cents;
}

function fromCents(cents) {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const str = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return negative ? `-${str}` : str;
}

// Rate is resolved to parts-per-million and applied with integer math, rounding half up.
function percentOfCents(cents, rate) {
  const ppm = BigInt(Math.round(rate * 1_000_000));
  return Number((BigInt(cents) * ppm + 500_000n) / 1_000_000n);
}

module.exports = { toCents, fromCents, percentOfCents };
