# Email configuration and limits

Unset SMTP is disabled. Any SMTP field activates validation and requires `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURITY`, and `SMTP_FROM`. `SMTP_SERVER_NAME` defaults to `Huddle`. SMTP settings remain server-only.

`local` permits plaintext only with explicit `NODE_ENV=development` and `SMTP_HOST` equal to `localhost`, `127.0.0.1`, `::1`, or the development service name `mailpit`. Production rejects plaintext. SMTP connects only when a sender is called, so startup and migrations never probe the relay.

Each send has a 5-second connection timeout, a 5-second greeting timeout, a 10-second idle socket timeout, and a 15-second overall deadline. The sender closes its socket after completion or deadline. It has no pool and no automatic retries. A timeout or disconnect leaves relay acceptance unconfirmed, even if the relay accepted the message before its response was lost.

The prepared Better Auth callback reserves a recipient before awaiting SMTP. Its 60-second cooldown uses case-insensitive mailbox keys, prunes expired entries, and caps storage at 10,000 recipients. It keeps reservations after failed sends. Restarting the process clears reservations, and each replica has its own map. This groundwork is not a public abuse-control policy.

Authentication-code templates identify `SMTP_SERVER_NAME` and `SERVER_URL`, include both plain text and escaped HTML, and use the shared 5-minute expiry definition. The callback does not generate or validate login codes. Better Auth's email OTP plugin remains unregistered. Public activation requires shared recipient and caller abuse controls and a TOTP assurance gate on HTTP, WebSocket, and device flows.
