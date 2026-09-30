const express = require('express');

function statementsRouter({ ledgerService }) {
  const router = express.Router();

  router.post('/ingest', async (req, res) => {
    const { userId, fileBase64, mimeType } = req.body ?? {};
    const result = await ledgerService.ingestStatement({ userId, fileBase64, mimeType });
    res.status(201).json(result);
  });

  return router;
}

module.exports = statementsRouter;
