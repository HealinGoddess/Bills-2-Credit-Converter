const express = require('express');
const { assertSameUser } = require('../middleware/auth');

function statementsRouter({ ledgerService }) {
  const router = express.Router();

  router.post('/ingest', async (req, res) => {
    const { userId, fileBase64, mimeType } = req.body ?? {};
    assertSameUser(req, userId);
    const result = await ledgerService.ingestStatement({ userId: req.userId, fileBase64, mimeType });
    res.status(201).json(result);
  });

  return router;
}

module.exports = statementsRouter;
