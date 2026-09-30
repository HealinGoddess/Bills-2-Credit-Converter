const express = require('express');
const { assertSameUser } = require('../middleware/auth');

function paymentsRouter({ ledgerService }) {
  const router = express.Router();

  router.post('/settle', async (req, res) => {
    const { userId, statementId } = req.body ?? {};
    assertSameUser(req, userId);
    const result = await ledgerService.settleStatement({ userId: req.userId, statementId });
    res.status(200).json({
      message: `Settled 100% of the billed amount to ${result.settlement.payee_name} with $0.00 deducted from the provider`,
      ...result,
    });
  });

  return router;
}

module.exports = paymentsRouter;
