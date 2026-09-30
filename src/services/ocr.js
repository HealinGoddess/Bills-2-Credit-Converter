const os = require('os');
const { createWorker } = require('tesseract.js');
const { ApiError } = require('../lib/errors');

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/tiff', 'image/bmp', 'image/gif']);
const TEXT_MIME_TYPES = new Set(['text/plain']);
const JSON_MIME_TYPES = new Set(['application/json']);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const PAYEE_PATTERN = /^\s*(?:payee(?:\s*name)?|biller|pay\s*to|payable\s*to|service\s*provider|provider|company|landlord)\s*[:\-]\s*(.+?)\s*$/im;
const ACCOUNT_PATTERN = /^\s*(?:account|acct\.?)\s*(?:number|no\.?|num\.?|#)?\s*[:\-#]?\s*([A-Za-z0-9*xX][A-Za-z0-9*xX\- ]{2,}[A-Za-z0-9])\s*$/im;
const DUE_DATE_PATTERN = /^\s*(?:payment\s*due\s*date|due\s*date|payment\s*due|due\s*by|due)\s*[:\-]?\s*(.+?)\s*$/im;
const AMOUNT_PATTERN = /^\s*(?:total\s*amount\s*due|amount\s*due|total\s*due|balance\s*due|gross\s*amount|amount)\s*[:\-]?\s*(?:USD\s*)?\$?\s*([\d,]+(?:\.\d{1,2})?)\s*$/im;

function maskAccountNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const compact = String(raw).replace(/[\s-]/g, '');
  const visible = compact.replace(/[*xX]/g, '').slice(-4);
  if (visible.length < 4) return null;
  return `****${visible}`;
}

function toIsoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

function parseDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  let m = str.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return toIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = str.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m) return toIsoDate(Number(m[3]), Number(m[1]), Number(m[2]));
  m = str.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) return toIsoDate(Number(m[3]), month, Number(m[2]));
  }
  return null;
}

function parseAmount(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).replace(/[$,\s]/g, '').replace(/^USD/i, '');
  if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;
  const [whole, frac = ''] = str.split('.');
  const normalized = `${Number(whole)}.${frac.padEnd(2, '0')}`;
  return Number(normalized) > 0 ? normalized : null;
}

function parseStatementText(text) {
  const match = (pattern) => {
    const m = String(text).match(pattern);
    return m ? m[1] : null;
  };
  return {
    payeeName: match(PAYEE_PATTERN),
    accountNumberMasked: maskAccountNumber(match(ACCOUNT_PATTERN)),
    grossAmount: parseAmount(match(AMOUNT_PATTERN)),
    dueDate: parseDate(match(DUE_DATE_PATTERN)),
  };
}

function parseStatementJson(buffer) {
  let doc;
  try {
    doc = JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new ApiError(422, 'OCR_EXTRACTION_FAILED', 'Statement JSON could not be parsed');
  }
  return {
    payeeName: typeof doc.payeeName === 'string' ? doc.payeeName.trim() : null,
    accountNumberMasked: maskAccountNumber(doc.accountNumber ?? doc.accountNumberMasked),
    grossAmount: parseAmount(doc.grossAmount),
    dueDate: parseDate(doc.dueDate),
  };
}

function assertComplete(fields) {
  const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new ApiError(422, 'OCR_EXTRACTION_FAILED', 'Required statement fields could not be extracted', { missing });
  }
  return fields;
}

function createOcrService({ recognizeImage } = {}) {
  let workerPromise;

  const defaultRecognizeImage = async (buffer) => {
    if (!workerPromise) {
      workerPromise = createWorker(process.env.OCR_LANGUAGE || 'eng', undefined, {
        cachePath: process.env.OCR_CACHE_PATH || os.tmpdir(),
      });
    }
    const worker = await workerPromise;
    const { data } = await worker.recognize(buffer);
    return data.text;
  };

  const recognize = recognizeImage || defaultRecognizeImage;

  return {
    async extract({ buffer, mimeType }) {
      const type = String(mimeType).toLowerCase();
      if (JSON_MIME_TYPES.has(type)) {
        return { provider: 'structured-json', rawText: buffer.toString('utf8'), fields: assertComplete(parseStatementJson(buffer)) };
      }
      if (TEXT_MIME_TYPES.has(type)) {
        const rawText = buffer.toString('utf8');
        return { provider: 'text', rawText, fields: assertComplete(parseStatementText(rawText)) };
      }
      if (IMAGE_MIME_TYPES.has(type)) {
        const rawText = await recognize(buffer);
        return { provider: 'tesseract', rawText, fields: assertComplete(parseStatementText(rawText)) };
      }
      throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported mimeType: ${mimeType}`);
    },
    async close() {
      if (workerPromise) {
        const worker = await workerPromise;
        await worker.terminate();
        workerPromise = undefined;
      }
    },
  };
}

module.exports = { createOcrService, parseStatementText, parseDate, parseAmount, maskAccountNumber };
