const express = require('express');

function usersRouter({ userService }) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    const result = await userService.createUser({ email: req.body?.email });
    res.status(201).json(result);
  });

  router.get('/by-email/:email', async (req, res) => {
    res.json(await userService.findByEmail(req.params.email));
  });

  router.get('/:userId/statements', async (req, res) => {
    res.json(await userService.listStatements(req.params.userId));
  });

  router.get('/:userId/wallet', async (req, res) => {
    res.json(await userService.getWallet(req.params.userId));
  });

  return router;
}

module.exports = usersRouter;
