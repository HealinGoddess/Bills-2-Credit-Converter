const crypto = require('crypto');

const COOKIE_NAME = 'necessify_session';
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return [part.trim(), ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
}

function createSessionManager({ secret, ttlSeconds = DEFAULT_TTL_SECONDS, secureCookies = false }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('Session secret must be at least 16 characters');
  }

  const signature = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function sign(userId, now = Date.now()) {
    const expiresAt = Math.floor(now / 1000) + ttlSeconds;
    const payload = Buffer.from(JSON.stringify({ uid: userId, exp: expiresAt })).toString('base64url');
    return `${payload}.${signature(payload)}`;
  }

  function verify(token, now = Date.now()) {
    if (typeof token !== 'string') return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(signature(payload));
    const actual = Buffer.from(sig);
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    try {
      const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof uid !== 'string' || typeof exp !== 'number' || exp * 1000 <= now) return null;
      return uid;
    } catch {
      return null;
    }
  }

  const cookieAttributes = (maxAge) => [
    'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`, ...(secureCookies ? ['Secure'] : []),
  ].join('; ');

  return {
    sign,
    verify,
    userIdFromRequest: (req) => verify(parseCookies(req.headers.cookie)[COOKIE_NAME]),
    setCookie: (res, userId) => res.append('Set-Cookie', `${COOKIE_NAME}=${sign(userId)}; ${cookieAttributes(ttlSeconds)}`),
    clearCookie: (res) => res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(0)}`),
  };
}

module.exports = { createSessionManager, parseCookies, COOKIE_NAME };
