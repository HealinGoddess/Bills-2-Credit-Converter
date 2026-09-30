const PLAN_COMPANY_LIMIT = 5;
const BASIC_MONTHLY_FEE_CENTS = 7500;
const EXTENDED_MONTHLY_FEE_CENTS = 15000;

// Monthly platform fee, based on how many different companies the user is billed by that month.
function monthlyFeeCents(companyCount) {
  if (companyCount <= 0) return 0;
  return companyCount <= PLAN_COMPANY_LIMIT ? BASIC_MONTHLY_FEE_CENTS : EXTENDED_MONTHLY_FEE_CENTS;
}

function planLabel(companyCount) {
  return companyCount <= PLAN_COMPANY_LIMIT
    ? `up to ${PLAN_COMPANY_LIMIT} companies`
    : `more than ${PLAN_COMPANY_LIMIT} companies`;
}

module.exports = {
  monthlyFeeCents, planLabel, PLAN_COMPANY_LIMIT, BASIC_MONTHLY_FEE_CENTS, EXTENDED_MONTHLY_FEE_CENTS,
};
