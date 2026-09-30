# Necessify Backend

Node.js/Express API and PostgreSQL credit ledger for Necessify, a cooperative digital payment platform.

- **Statement ingestion**: accepts a base64 billing statement, rejects duplicates by SHA-256 of the decoded file bytes, runs OCR, and mints wallet credits for the billed amount plus the platform fee, so each statement is the money of account that satisfies its own bill.
- **Settlement**: pays 100% of the bill to the provider (`fee_deducted_from_provider` is always `0.00`, which a DB `CHECK` constraint also enforces) and charges the platform fee only to the user's wallet. The fee rate is fixed on the server (default 2%, `PLATFORM_FEE_RATE`); clients cannot change it.
- **Accounts**: email + password (scrypt-hashed). Logging in sets an HttpOnly, `SameSite=Strict` signed session cookie; wallet, statement and payment endpoints act only on the logged-in user.

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

Set `SESSION_SECRET` (any long random string) so log-ins survive restarts; without it the server picks a random secret at startup (and refuses to start when `NODE_ENV=production`). Set `COOKIE_SECURE=true` when serving over HTTPS.

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

### Auth
| Endpoint | Body | Result |
| --- | --- | --- |
| `POST /api/v1/auth/register` | `{ "email", "password" }` (8+ chars) | `201 { user }` + session cookie; `409 EMAIL_EXISTS` |
| `POST /api/v1/auth/login` | `{ "email", "password" }` | `200 { user }` + session cookie; `401 INVALID_CREDENTIALS`; `429 TOO_MANY_ATTEMPTS` after 10 failures in 15 min |
| `POST /api/v1/auth/logout` | – | `204`, clears the cookie |
| `GET /api/v1/auth/me` | – | `200 { user }` or `401 UNAUTHENTICATED` |

All endpoints below require the session cookie (`401 UNAUTHENTICATED` otherwise). A `userId` in a path or body is optional and must match the logged-in user (`403 FORBIDDEN`). Accounts created before passwords existed have no password hash and cannot log in; re-register with a new email.

### `GET /api/v1/users/:userId/wallet`
Wallet balance plus the 50 most recent ledger entries.

### `GET /api/v1/users/:userId/statements`
The user's statements, newest first, each with `platform_fee_rate` and `platform_fee`.

### `POST /api/v1/statements/ingest`
```json
{ "fileBase64": "<base64 or data URI>", "mimeType": "image/png" }
```
Supported `mimeType`s: `image/png|jpeg|webp|tiff|bmp|gif` (Tesseract OCR), `text/plain`, `application/json` (`payeeName`, `accountNumber`, `grossAmount`, `dueDate`).

Flow: validate → user must exist and be `active` → SHA-256 duplicate check → OCR → one transaction (insert the statement as a `verified` remittance asset with its fixed `platform_fee`, then `mintCreditsFromAsset` locks and credits the wallet with bill + fee, insert `CREDIT_ISSUANCE` for the bill and `FEE_CREDIT_ISSUANCE` for the fee) → save raw OCR JSON and audit log in Mongo.

| Status | Code |
| --- | --- |
| 201 | statement, updated wallet, `ledgerEntries`, `documentStored` |
| 400 | `DUPLICATE_STATEMENT`, `VALIDATION_ERROR` |
| 404 / 403 | `USER_NOT_FOUND` / `ACCOUNT_INACTIVE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `OCR_EXTRACTION_FAILED` (`details.missing` lists fields) |

Account numbers are stored masked (`****1234`). If the Mongo write fails after the ledger commit, the request still returns `201` with `documentStored: false` and the error is logged.

### `POST /api/v1/payments/settle`
```json
{ "statementId": "<uuid>" }
```
In one transaction: lock statement and wallet (`FOR UPDATE`), compute
`fullBillAmount = gross_amount`, `beneficiaryFee = statement.platform_fee` (set at ingestion as `round_half_up(gross_amount * PLATFORM_FEE_RATE)`), `totalCreditsRequired = fullBillAmount + beneficiaryFee`,
debit the wallet, write `SETTLEMENT_PAYMENT` and `PLATFORM_FEE` ledger entries, insert the settlement with `fee_deducted_from_provider = 0.00`, and mark the statement `settled`.

| Status | Code |
| --- | --- |
| 200 | `settlement`, `breakdown` (`providerReceives`, `providerFee: "0.00"`, `providerPayoutPercent: 100`, …), updated wallet |
| 400 | `INSUFFICIENT_CREDITS` (`details.required/available/shortfall`), `VALIDATION_ERROR` |
| 404 | `STATEMENT_NOT_FOUND` (also for another user's statement), `WALLET_NOT_FOUND` |
| 409 | `ALREADY_SETTLED` |

## Ledger conventions

- Money is handled as integer cents in JS and `NUMERIC(12,2)` in Postgres (the `pg` NUMERIC parser returns strings), so no floating-point arithmetic touches balances.
- Example: a $100.00 bill mints $102.00 (`CREDIT_ISSUANCE` 100.00 + `FEE_CREDIT_ISSUANCE` 2.00); settling it debits 100.00 (`SETTLEMENT_PAYMENT`, paid in full to the provider) and 2.00 (`PLATFORM_FEE`), leaving the wallet where it started.
- Currency is `NOU` (Necessify Operational Unit), valued 1.00 NOU = $1.00 USD, closed-loop.
- Ledger `amount` is signed: issuance is positive, settlement payments and fees are negative. `SUM(amount)` for a wallet equals its `credit_balance`, and `balance_after` gives a running balance.
- Constraints added on top of the base schema: `settlements.fee_deducted_from_provider = 0.00` and one settlement per statement.
