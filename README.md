# Necessify Backend

Node.js/Express API and PostgreSQL credit ledger for Necessify, a cooperative digital payment platform.

- **Statement ingestion**: accepts a base64 billing statement, rejects duplicates by SHA-256 of the decoded file bytes, runs OCR, and mints wallet credits 1:1 with the billed amount.
- **Settlement**: pays 100% of the bill to the provider (`fee_deducted_from_provider` is always `0.00`, which a DB `CHECK` constraint also enforces) and charges the platform fee only to the user's wallet.

## Stack

| Concern | Tech |
| --- | --- |
| API | Node.js 20, Express 5 |
| Ledger, wallets, statements, settlements | PostgreSQL 16 (`db/init.sql`, applied automatically on startup) |
| Raw OCR payloads and audit logs | MongoDB 7 (`statement_documents`, `audit_logs`) |
| OCR | `tesseract.js` for images; structured parsing for `text/plain` and `application/json` |
| Tests | Jest + Supertest |

## Running

```bash
docker compose up --build        # API on :3000, Postgres on :5432, Mongo on :27017
```

For local development without the API container:

```bash
cp .env.example .env
docker compose up -d postgres mongo
npm install
npm start
```

## Testing

```bash
npm test                         # unit tests (no databases needed)
docker compose up -d postgres mongo
npm run test:integration         # end-to-end against real Postgres + Mongo
```

Integration tests default to `postgres://necessify:necessify@localhost:5432/necessify` and `mongodb://localhost:27017/necessify_test`; override with `DATABASE_URL` / `MONGO_URL`. They run Jest with `--experimental-vm-modules` because the MongoDB driver loads `os` through a dynamic `import()`.

## API

All errors use `{ "error": { "code", "message", "details"? } }`.

### `POST /api/v1/users`
`{ "email": "a@b.com" }` → `201` with `user` and a zero-balance `wallet`. `409 EMAIL_EXISTS` on duplicates.

### `GET /api/v1/users/:userId/wallet`
Wallet balance plus the 50 most recent ledger entries.

### `POST /api/v1/statements/ingest`
```json
{ "userId": "<uuid>", "fileBase64": "<base64 or data URI>", "mimeType": "image/png" }
```
Supported `mimeType`s: `image/png|jpeg|webp|tiff|bmp|gif` (Tesseract OCR), `text/plain`, `application/json` (`payeeName`, `accountNumber`, `grossAmount`, `dueDate`).

Flow: validate → user must exist and be `active` → SHA-256 duplicate check → OCR → one transaction (insert statement, lock and credit wallet, insert `CREDIT_ISSUANCE`) → save raw OCR JSON and audit log in Mongo.

| Status | Code |
| --- | --- |
| 201 | statement, updated wallet, ledger entry, `documentStored` |
| 400 | `DUPLICATE_STATEMENT`, `VALIDATION_ERROR` |
| 404 / 403 | `USER_NOT_FOUND` / `ACCOUNT_INACTIVE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `OCR_EXTRACTION_FAILED` (`details.missing` lists fields) |

Account numbers are stored masked (`****1234`). If the Mongo write fails after the ledger commit, the request still returns `201` with `documentStored: false` and the error is logged.

### `POST /api/v1/payments/settle`
```json
{ "userId": "<uuid>", "statementId": "<uuid>", "platformFeeRate": 0.02 }
```
In one transaction: lock statement and wallet (`FOR UPDATE`), compute
`fullBillAmount = gross_amount`, `beneficiaryFee = round_half_up(fullBillAmount * rate)`, `totalCreditsRequired = fullBillAmount + beneficiaryFee`,
debit the wallet, write `SETTLEMENT_PAYMENT` and `PLATFORM_FEE` ledger entries, insert the settlement with `fee_deducted_from_provider = 0.00`, and mark the statement `settled`.

| Status | Code |
| --- | --- |
| 200 | `settlement`, `breakdown` (`providerReceives`, `providerFee: "0.00"`, `providerPayoutPercent: 100`, …), updated wallet |
| 400 | `INSUFFICIENT_CREDITS` (`details.required/available/shortfall`), `VALIDATION_ERROR` |
| 404 | `STATEMENT_NOT_FOUND` (also for another user's statement), `WALLET_NOT_FOUND` |
| 409 | `ALREADY_SETTLED` |

## Ledger conventions

- Money is handled as integer cents in JS and `NUMERIC(12,2)` in Postgres (the `pg` NUMERIC parser returns strings), so no floating-point arithmetic touches balances.
- Ledger `amount` is signed: issuance is positive, settlement payments and fees are negative. `SUM(amount)` for a wallet equals its `credit_balance`, and `balance_after` gives a running balance.
- Constraints added on top of the base schema: `settlements.fee_deducted_from_provider = 0.00` and one settlement per statement.
