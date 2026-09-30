const { toCents, fromCents, percentOfCents } = require('../../src/lib/money');

describe('money', () => {
  test('converts decimal strings and numbers to integer cents', () => {
    expect(toCents('142.37')).toBe(14237);
    expect(toCents('5')).toBe(500);
    expect(toCents('0.1')).toBe(10);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents('-3.05')).toBe(-305);
  });

  test('rejects malformed values', () => {
    expect(() => toCents('12.345')).toThrow(TypeError);
    expect(() => toCents('abc')).toThrow(TypeError);
  });

  test('formats cents as fixed two-decimal strings', () => {
    expect(fromCents(14237)).toBe('142.37');
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(0)).toBe('0.00');
    expect(fromCents(-305)).toBe('-3.05');
  });

  test('applies percentage rates with half-up rounding and no float drift', () => {
    expect(percentOfCents(14237, 0.02)).toBe(285); // 284.74 -> 285
    expect(percentOfCents(12345, 0.02)).toBe(247); // 246.9 -> 247
    expect(percentOfCents(125, 0.02)).toBe(3); // 2.5 -> 3
    expect(percentOfCents(10000, 0)).toBe(0);
    expect(percentOfCents(99999999999, 0.02)).toBe(2000000000);
  });
});
