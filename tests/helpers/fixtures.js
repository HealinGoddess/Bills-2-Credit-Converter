const crypto = require('crypto');

function statementText({ payee = 'City Power & Light', account = '5566778899001234', due = '2026-10-15', amount = '142.37' } = {}) {
  return [
    `Payee: ${payee}`,
    `Account Number: ${account}`,
    `Due Date: ${due}`,
    `Amount Due: $${amount}`,
    `Ref: ${crypto.randomUUID()}`,
  ].join('\n');
}

function toBase64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

module.exports = { statementText, toBase64 };
