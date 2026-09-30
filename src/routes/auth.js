const express = require('express');
const { ApiError } = require('../lib/errors');
const { createLoginThrottle } = require('../lib/loginThrottle');

function authRouter({ userService, sessions, throttle = createLoginThrottle() }) {
  const router = express.Router();

  router.post('/register', async (req, res) => {
    const { email, password } = req.body ?? {};
    const { user } = await userService.createUser({ email, password });
    sessions.setCookie(res, user.user_id);
    res.status(201).json({ user });
  });

  router.post('/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    const key = `${String(email).toLowerCase()}|${req.ip}`;
    if (throttle.isBlocked(key)) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many failed log-in attempts. Try again in a few minutes.');
    }
    try {
      const { user } = await userService.authenticate({ email, password });
      throttle.reset(key);
      sessions.setCookie(res, user.user_id);
      res.json({ user });
    } catch (err) {
      if (err.code === 'INVALID_CREDENTIALS') throttle.recordFailure(key);
      throw err;
    }
  });

  router.post('/logout', (req, res) => {
    sessions.clearCookie(res);
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    const userId = sessions.userIdFromRequest(req);
    if (!userId) throw new ApiError(401, 'UNAUTHENTICATED', 'Please log in');
    res.json(await userService.getUser(userId));
  });

  return router;
}

module.exports = authRouter;
