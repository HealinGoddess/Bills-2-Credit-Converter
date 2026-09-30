const express = require('express');
const { assertSameUser } = require('../middleware/auth');

function usersRouter({ userService }) {
  const router = express.Router();

  router.get('/:userId/statements', async (req, res) => {
    assertSameUser(req, req.params.userId);
    res.json(await userService.listStatements(req.userId));
  });

  router.get('/:userId/wallet', async (req, res) => {
    assertSameUser(req, req.params.userId);
    res.json(await userService.getWallet(req.userId));
  });

  return router;
}

module.exports = usersRouter;
