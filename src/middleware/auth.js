const { ApiError } = require('../lib/errors');

function requireAuth(sessions) {
  return (req, res, next) => {
    const userId = sessions.userIdFromRequest(req);
    if (!userId) return next(new ApiError(401, 'UNAUTHENTICATED', 'Please log in'));
    req.userId = userId;
    return next();
  };
}

function assertSameUser(req, userId) {
  if (userId !== undefined && userId !== req.userId) {
    throw new ApiError(403, 'FORBIDDEN', 'You can only access your own account');
  }
}

module.exports = { requireAuth, assertSameUser };
