const crypto = require('crypto');
const { decodeBase64File, sha256Hex } = require('../../src/lib/hash');

describe('statement hashing', () => {
  const content = Buffer.from('Payee: Water Co\nAmount Due: $10.00');
  const b64 = content.toString('base64');

  test('computes the SHA-256 of the decoded file bytes', () => {
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    expect(sha256Hex(decodeBase64File(b64))).toBe(expected);
    expect(sha256Hex(decodeBase64File(b64))).toHaveLength(64);
  });

  test('produces the same hash regardless of data-URI prefix or line wrapping', () => {
    const plain = sha256Hex(decodeBase64File(b64));
    const wrapped = b64.replace(/(.{8})/g, '$1\n');
    expect(sha256Hex(decodeBase64File(`data:text/plain;base64,${b64}`))).toBe(plain);
    expect(sha256Hex(decodeBase64File(wrapped))).toBe(plain);
  });

  test('different files produce different hashes', () => {
    const other = Buffer.from('Payee: Water Co\nAmount Due: $10.01').toString('base64');
    expect(sha256Hex(decodeBase64File(other))).not.toBe(sha256Hex(decodeBase64File(b64)));
  });

  test('rejects invalid base64', () => {
    expect(decodeBase64File('not base64!!')).toBeNull();
    expect(decodeBase64File('abc')).toBeNull();
    expect(decodeBase64File('')).toBeNull();
  });
});
