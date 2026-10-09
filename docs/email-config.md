# Email configuration and limits

Unset SMTP is disabled. Any SMTP field activates validation and requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, and `SMTP_FROM`. `SMTP_SERVER_NAME` defaults to `Huddle`. SMTP settings remain server-only.

`local` permits plaintext only with explicit `NODE_ENV=development` and `SMTP_HOST` equal to `localhost`, `127.0.0.1`, `::1`, or the development service name `mailpit`. Production rejects plaintext. SMTP connects only when a sender is called, so startup and migrations never probe the relay.

Each send has a 5-second connection timeout, a 5-second greeting timeout, a 10-second idle socket timeout, and a 15-second overall deadline. The sender closes its socket after completion or deadline. It has no pool and no automatic retries. A timeout or disconnect leaves relay acceptance unconfirmed, even if the relay accepted the message before its response was lost.

Huddle reserves email sends in PostgreSQL before awaiting SMTP. Normalized recipient keys enforce a 60-second cooldown and ten sends per hour, including failed deliveries. Recipient, account and trusted socket-IP limits survive server restart. Forwarded headers do not supply caller identity.

Authentication-code templates identify `SMTP_SERVER_NAME` and `SERVER_URL`, include both plain text and escaped HTML, and use a five-minute expiry. Huddle owns code generation, single-use verification and staged enrollment. Better Auth's email OTP plugin remains unregistered. Email verification alone cannot admit a session to HTTP, WebSocket or device access. See [passwordless authentication](passwordless.md) for TOTP, recovery, policy and session checks.
