-- ==============================================================================
-- Migration: 001_enable_extensions.sql
-- Description: Enable PostgreSQL cryptographic extensions and shared trigger functions
-- ==============================================================================

-- Enable pgcrypto for gen_random_uuid() and cryptographic hashing
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Shared trigger function to automatically update the updated_at timestamp
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
