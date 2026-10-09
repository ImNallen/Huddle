# Send an installation test

The email test sends one message to an explicit recipient. It succeeds only after the SMTP relay accepts that recipient. Relay acceptance does not confirm inbox delivery.

## Capture mail during host development

Run `pnpm setup:local` and start Mailpit:

```sh
docker compose --profile dev up -d mailpit
```

Append these values to your existing `.env`, or uncomment the corresponding generated examples. Keep your database and auth secrets.

```dotenv
NODE_ENV=development
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURITY=local
SMTP_FROM=huddle@huddle.test
SMTP_SERVER_NAME=Huddle
```

Send a test and open `http://127.0.0.1:8025` to inspect both message alternatives:

```sh
pnpm --silent email:test recipient@example.com
```

Use `--silent` to suppress pnpm wrapper logs, which include the recipient argument. `pnpm email:test` also works, but prints those wrapper logs.

The command prints `SMTP relay accepted the requested recipient. Inbox delivery is not confirmed.` on success. It exits nonzero on disabled email, invalid input, rejection, unavailable relay, or an unconfirmed timeout. Diagnostics omit recipients, authentication codes, credentials, and SMTP response text.

## Capture mail from a development server container

Start the same Mailpit profile. Override the server's production environment explicitly for the development command:

```sh
docker compose --profile dev run --rm -e NODE_ENV=development -e SMTP_HOST=mailpit -e SMTP_PORT=1025 -e SMTP_SECURITY=local -e SMTP_FROM=huddle@huddle.test server node --import tsx scripts/email-test.ts recipient@example.com
```

`127.0.0.1` inside the server container refers to that container. Use `mailpit` to reach the Mailpit service. The production server does not depend on Mailpit.

## Configure a production relay

Set these values in `.env` using your provider's host, port, and sender:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURITY=starttls
SMTP_FROM=huddle@example.com
SMTP_SERVER_NAME=Company Huddle
SMTP_USERNAME=your-relay-user
SMTP_PASSWORD=your-relay-password
```

For implicit TLS, use `SMTP_SECURITY=tls` and your provider's TLS port, commonly 465. `starttls` requires a successful TLS upgrade. Both modes verify certificates and hostnames. For a private certificate authority, start Node with `NODE_EXTRA_CA_CERTS` pointing to your trusted CA PEM file. There is no insecure TLS override.

Credentials must both be set or both be absent. The sender uses one mailbox for `SMTP_FROM`; display names belong in `SMTP_SERVER_NAME`. Protect `.env` as you protect your database password. Restart the server after changing configuration.

Run `pnpm --silent email:test recipient@example.com` with a mailbox you control. Configure your provider's sender verification, sending limits, and DNS records separately. Provider reputation, spam filtering, bounces, and delivery to real inboxes require provider-specific verification.

## Verify email changes

Use a disposable Mailpit instance. The suite reads captured messages but does not clear the inbox. Set its SMTP and API ports to match your instance:

```sh
TEST_SMTP_HOST=127.0.0.1 TEST_SMTP_PORT=1025 TEST_MAILPIT_URL=http://127.0.0.1:8025 pnpm test:email
```

The suite uses actual SMTP sockets, generates temporary certificates with `openssl`, verifies trusted and untrusted STARTTLS and implicit TLS, and cleans its listeners and temporary files. It checks both message alternatives, rejection, connection failure, dropped connections, greeting and whole-operation timeouts, safe CLI diagnostics and setup preservation. Run migrations first, then use `pnpm test:integration` and `pnpm test:access` with disposable services for authentication, durable cooldown and device admission checks.

See [email configuration and limits](email-config.md) for the configuration fields, deadlines and authentication policy.
