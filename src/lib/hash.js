const crypto = require('crypto');

const DATA_URI_PREFIX = /^data:[^;,]+;base64,/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64File(fileBase64) {
  const normalized = String(fileBase64).replace(DATA_URI_PREFIX, '').replace(/\s+/g, '');
  if (!normalized || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    return null;
  }
  return Buffer.from(normalized, 'base64');
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { decodeBase64File, sha256Hex };
