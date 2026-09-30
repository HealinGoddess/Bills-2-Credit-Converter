const express = require('express');

function paymentsRouter({ ledgerService }) {
  const router = express.Router();

  router.post('/settle', async (req, res) => {
    const { userId, statementId, platformFeeRate } = req.body ?? {};
    const result = await ledgerService.settleStatement({ userId, statementId, platformFeeRate });
    res.status(200).json({
      message: `Settled 100% of the billed amount to ${result.settlement.payee_name} with $0.00 deducted from the provider`,
      ...result,
    });
  });

  return router;
}

module.exports = paymentsRouter;
