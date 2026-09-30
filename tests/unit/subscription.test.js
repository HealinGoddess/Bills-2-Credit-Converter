const { monthlyFeeCents, planLabel } = require('../../src/lib/subscription');

describe('monthly plan fee', () => {
  test.each([
    [0, 0], [1, 7500], [5, 7500], [6, 15000], [40, 15000],
  ])('%i companies in a month -> %i cents', (companies, cents) => {
    expect(monthlyFeeCents(companies)).toBe(cents);
  });

  test('labels the plan by company count', () => {
    expect(planLabel(5)).toBe('up to 5 companies');
    expect(planLabel(6)).toBe('more than 5 companies');
  });
});
