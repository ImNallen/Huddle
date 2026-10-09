ALTER TABLE account_security ADD COLUMN company_issuer text;
CREATE INDEX access_device_expiry ON access_device(expires_at);
CREATE INDEX access_limit_expiry ON access_limit(starts_at);
CREATE INDEX account_photo_expiry ON account_photo(created_at);
CREATE INDEX account_reset_expiry ON account_reset(requested_at);
