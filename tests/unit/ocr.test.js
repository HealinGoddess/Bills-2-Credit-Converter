const {
  createOcrService, parseStatementText, parseDate, parseAmount, maskAccountNumber,
} = require('../../src/services/ocr');

const SAMPLE = `CITY POWER & LIGHT
Payee: City Power & Light
Account Number: 5566-7788-9900-1234
Statement Date: 09/20/2026
Due Date: October 15, 2026
Amount Due: $1,142.37`;

describe('OCR field extraction', () => {
  test('parses payee, masked account, amount, and due date from statement text', () => {
    expect(parseStatementText(SAMPLE)).toEqual({
      payeeName: 'City Power & Light',
      accountNumberMasked: '****1234',
      grossAmount: '1142.37',
      dueDate: '2026-10-15',
    });
  });

  test('parses supported date formats and rejects impossible dates', () => {
    expect(parseDate('2026-10-15')).toBe('2026-10-15');
    expect(parseDate('10/15/2026')).toBe('2026-10-15');
    expect(parseDate('Oct 5, 2026')).toBe('2026-10-05');
    expect(parseDate('02/30/2026')).toBeNull();
    expect(parseDate('soon')).toBeNull();
  });

  test('normalizes amounts and rejects zero or malformed values', () => {
    expect(parseAmount('$1,200')).toBe('1200.00');
    expect(parseAmount('45.5')).toBe('45.50');
    expect(parseAmount('0.00')).toBeNull();
    expect(parseAmount('12.345')).toBeNull();
  });

  test('masks account numbers down to the last four characters', () => {
    expect(maskAccountNumber('123456789')).toBe('****6789');
    expect(maskAccountNumber('****6789')).toBe('****6789');
    expect(maskAccountNumber('XXXX-XXXX-6789')).toBe('****6789');
    expect(maskAccountNumber('12')).toBeNull();
  });

  describe('createOcrService().extract', () => {
    const ocr = createOcrService({ recognizeImage: async () => SAMPLE });

    test('handles text/plain statements', async () => {
      const result = await ocr.extract({ buffer: Buffer.from(SAMPLE), mimeType: 'text/plain' });
      expect(result.provider).toBe('text');
      expect(result.fields.grossAmount).toBe('1142.37');
    });

    test('handles structured JSON statements', async () => {
      const buffer = Buffer.from(JSON.stringify({
        payeeName: 'Metro Housing', accountNumber: '998877', grossAmount: 950, dueDate: '2026-11-01',
      }));
      const result = await ocr.extract({ buffer, mimeType: 'application/json' });
      expect(result.fields).toEqual({
        payeeName: 'Metro Housing', accountNumberMasked: '****8877', grossAmount: '950.00', dueDate: '2026-11-01',
      });
    });

    test('routes images through the image recognizer', async () => {
      const result = await ocr.extract({ buffer: Buffer.from([0x89, 0x50]), mimeType: 'image/png' });
      expect(result.provider).toBe('tesseract');
      expect(result.fields.payeeName).toBe('City Power & Light');
    });

    test('returns 422 listing fields that could not be extracted', async () => {
      await expect(ocr.extract({ buffer: Buffer.from('Payee: Gas Co'), mimeType: 'text/plain' }))
        .rejects.toMatchObject({
          status: 422,
          code: 'OCR_EXTRACTION_FAILED',
          details: { missing: ['accountNumberMasked', 'grossAmount', 'dueDate'] },
        });
    });

    test('returns 415 for unsupported media types', async () => {
      await expect(ocr.extract({ buffer: Buffer.from('x'), mimeType: 'application/zip' }))
        .rejects.toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
    });
  });
});
