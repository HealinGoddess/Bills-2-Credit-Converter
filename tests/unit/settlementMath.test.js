const { computeSettlement } = require('../../src/services/ledger');

describe('computeSettlement', () => {
  test('provider receives 100% of the bill; fee is charged only to the beneficiary', () => {
    expect(computeSettlement('142.37', 0.02)).toEqual({
      fullBillCents: 14237,
      beneficiaryFeeCents: 285,
      totalCreditsRequiredCents: 14522,
      providerFeeCents: 0,
    });
  });

  test.each([
    ['0.01', 0.02], ['100.00', 0], ['999.99', 0.035], ['9999999999.99', 1],
  ])('provider fee is always zero (bill %s, rate %s)', (amount, rate) => {
    const calc = computeSettlement(amount, rate);
    expect(calc.providerFeeCents).toBe(0);
    expect(calc.totalCreditsRequiredCents - calc.beneficiaryFeeCents).toBe(calc.fullBillCents);
  });
});
