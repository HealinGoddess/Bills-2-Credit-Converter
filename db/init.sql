CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
    user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    account_status VARCHAR(50) DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS wallets (
    wallet_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID UNIQUE REFERENCES users(user_id) ON DELETE RESTRICT,
    credit_balance NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (credit_balance >= 0.00),
    currency VARCHAR(10) DEFAULT 'NOU',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS statements (
    statement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(user_id),
    payee_name VARCHAR(255) NOT NULL,
    account_number_masked VARCHAR(100) NOT NULL,
    gross_amount NUMERIC(12, 2) NOT NULL,
    due_date DATE NOT NULL,
    ocr_hash VARCHAR(64) UNIQUE NOT NULL,
    verification_status VARCHAR(50) DEFAULT 'pending',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ledger_entries (
    entry_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id UUID REFERENCES wallets(wallet_id),
    statement_id UUID REFERENCES statements(statement_id),
    entry_type VARCHAR(50) NOT NULL, -- CREDIT_ISSUANCE, SETTLEMENT_PAYMENT, PLATFORM_FEE
    amount NUMERIC(12, 2) NOT NULL,
    balance_after NUMERIC(12, 2) NOT NULL,
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settlements (
    settlement_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    statement_id UUID REFERENCES statements(statement_id),
    payee_name VARCHAR(255) NOT NULL,
    remittance_amount NUMERIC(12, 2) NOT NULL,
    fee_deducted_from_provider NUMERIC(12, 2) DEFAULT 0.00, -- ALWAYS 0.00
    payment_channel VARCHAR(50) DEFAULT 'ACH_DIRECT',
    disbursement_status VARCHAR(50) DEFAULT 'completed',
    settled_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_zero_provider_fee') THEN
        ALTER TABLE settlements
            ADD CONSTRAINT settlements_zero_provider_fee CHECK (fee_deducted_from_provider = 0.00);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlements_statement_unique') THEN
        ALTER TABLE settlements
            ADD CONSTRAINT settlements_statement_unique UNIQUE (statement_id);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_statements_user_id ON statements(user_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_wallet_id ON ledger_entries(wallet_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_statement_id ON ledger_entries(statement_id);
