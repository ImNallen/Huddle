# Huddle

Huddle is a desktop home for your team's conversations. Run your own server, set it up with a one-time code, invite colleagues by email, and exchange persistent text messages. One server holds one team with its rooms, channels, and members.

The desktop uses Tauri 2, React, and TanStack Router. TanStack Start serves the HTTP API and login pages. Better Auth manages accounts and sessions in PostgreSQL. WebSockets replay committed server events. Local passwordless sign-in uses SMTP email codes and an authenticator.

## Run locally

Install Node.js 24 LTS, pnpm 11.23.0, and Docker. Native development also needs Rust 1.90 or newer and [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/). The JavaScript applications also run on Node.js 26.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose --profile dev up -d db mailpit
pnpm db:migrate
pnpm dev
```

On first start, the server prints a setup code to its log. Open `http://127.0.0.1:1420`. The frontend proxies `/api` to `http://localhost:3000` for browser cookies. The server's operator landing page is at `http://localhost:3000`. WebSockets listen on port 3001.

`pnpm setup:local` creates an ignored `.env` with independent random database and auth secrets. Running the command again preserves your configuration. If you already have PostgreSQL, set `DATABASE_URL` in `.env` and skip the Docker command.

The sign-in screen shows **Set up this server** until the server is onboarded. Enter the setup code from the server log, a server name, and your email. Verify the emailed code, enroll an authenticator, save your recovery codes, and finish your profile. You become the server's admin. Create a room and a channel, then use **Invite coworkers** to email an invitation to a colleague. Your colleague signs in with the invited address and joins as a member. Only admins can invite people and create rooms and channels.

Huddle has no self-registration. Accounts come only from onboarding or from an invitation for that exact address. An uninvited address still sees **Check your email**, but the email says the server has no account for it and asks the reader to request an invitation from an admin.

The setup code works once and expires after 24 hours. Each restart replaces it until onboarding completes. The server limits setup attempts per IP address. To supply your own code, for example in automation, set `SETUP_CODE` to 8 to 64 characters. The server then does not print the code.

To run the native desktop, keep the server running in one terminal and launch Tauri in another. Stop the browser frontend first because Tauri starts its own Vite process on port 1420.

```sh
pnpm --filter @huddle/server dev
# In another terminal:
pnpm desktop
```

The desktop's server setting accepts a company HTTPS origin at runtime. HTTP is permitted only for localhost, 127.0.0.1, and ::1. The selected origin is not a build-time variable. Native tokens live in the OS credential store, scoped to that origin. Browser sessions use HttpOnly cookies. The browser preview is intended for the local proxy setup or a same-origin deployment.

## Run the production server

Generate `.env` with `pnpm setup:local`, then configure the public URLs and origins before starting the server.

```sh
docker compose up -d db
docker compose run --build --rm server node --import tsx scripts/migrate.ts
docker compose up -d server
curl --fail http://localhost:3000/api/health
docker compose logs server
```

The server log shows the setup code until the server is onboarded. Open `SERVER_URL/login` in a browser or connect the desktop app, and set up the server with that code.

PostgreSQL data persists in the `postgres-data` volume. Back up this volume before upgrades. Apply migrations before starting the new server image. The migration command applies Better Auth's schema and Huddle's numbered SQL migrations. Huddle migrations are transactional and tracked in `huddle_migration`. Migration `007_single_server.sql` converts a legacy workspace database into a single server. It keeps rooms, channels, messages, read markers, mentions, and events from zero or one legacy workspace. It fails on a database with more than one legacy workspace. Reset such a database: drop and recreate it, run the migrations, and onboard with the setup code.

Place an HTTPS reverse proxy in front of ports 3000 and 3001. Proxy normal HTTP requests to 3000 and WebSocket upgrades to 3001. Both container ports bind to loopback on the host. For example, set `SERVER_URL=https://chat.example.com` and `WS_PUBLIC_URL=wss://events.example.com/`. The WebSocket endpoint is `/`, and authentication travels in its first frame. Configure proxy idle timeouts to allow the connection to remain open.

Set `TRUSTED_ORIGINS` to the exact browser origins you operate plus `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost`. Keep the local Vite origins only for development. The server always trusts its own canonical `SERVER_URL`. Do not use wildcard origins. HTTPS installations require a WSS endpoint.

For a host installation without Docker:

```sh
pnpm build
pnpm db:migrate
pnpm --filter @huddle/server start
```

The server starts HTTP and WebSocket listeners in one Node service. Configure `PORT`, `WS_PORT`, and `WS_PUBLIC_URL` together if you change ports.

## Configure email delivery

SMTP is required for local passwordless login, email onboarding, and invitations. An installation can instead require company OIDC with `AUTH_POLICY=sso-only`. `SMTP_SERVER_NAME` sets only the sender's display name. Email subjects and bodies use the server name chosen at onboarding. See [send an installation test](docs/email.md) to capture development mail in Mailpit or configure a production relay. Run `pnpm --silent email:test recipient@example.com` to verify relay acceptance before onboarding users.

Email-code login requires an authenticator before chat or desktop admission. New local accounts enroll one and save recovery codes; returning accounts verify their existing authenticator. Passkeys sign in directly with user verification.

## Configure company login

Set `OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` in `.env`. Register this callback URL with your provider:

```text
https://YOUR_HUDDLE_SERVER/api/auth/callback/company
```

Huddle requests `openid`, `profile`, and `email` with PKCE. Company login authenticates an account. It never grants membership based on an email domain. A new company identity needs a pending invitation for its email address. Without one, Huddle creates no account and returns to the login page with a `not_invited` error. Existing accounts sign in as before. An existing account without membership accepts its pending invitation at its next sign-in.

When company login is configured, the setup screen also offers **Continue with company login**. The company identity that completes login with the setup code becomes the admin. Under `AUTH_POLICY=sso-only`, company login is the only way to set up the server. The native desktop app does not offer company setup. When company login is the only method, it asks you to open the server's `/login` page in a browser to finish setup.

On native desktop, select **Sign in with your browser**. The browser supports email login and the configured company provider. Check that the displayed code matches your desktop, then approve the request. Huddle issues the desktop an admitted session only after explicit browser approval. Polling honors expiry, the server interval, and `slow_down`.

No company provider credentials ship with this repository. Real company OIDC login has not been verified against an external provider. Email login and the first-party device authorization flow have automated integration coverage.

## Verify a change

The integration, access, and UI suites each create a scratch database named `huddle_scratch_*` on the PostgreSQL server in `DATABASE_URL`, migrate it, start their own server with a known `SETUP_CODE`, and onboard an admin. They create further accounts through email invitations and drop the scratch database afterwards. They use `DATABASE_URL` as an admin connection to create and drop databases, so its user needs the `CREATEDB` privilege. The suites read captured email from Mailpit at `MAILPIT_URL`, default `http://127.0.0.1:8025`. Build before the UI suite, because it runs the production server.

```sh
pnpm typecheck
pnpm build
pnpm db:migrate
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:ui
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

On macOS, also build the application bundle:

```sh
pnpm --filter @huddle/desktop tauri build --bundles app
```

The integration suite launches the production server on ports 3100 and 3101, stops it, and restarts it to verify persistence. Set `TEST_PORT` to change the HTTP port; the socket uses the next port. `pnpm test:access` uses port 3200. The UI suite starts the desktop frontend on `127.0.0.1:1520` and, for each spec file, a production server on `localhost:3400` with its own scratch database. Set `HUDDLE_UI_DESKTOP_PORT` and `HUDDLE_UI_SERVER_PORT` to change them. These ports do not collide with a development setup on 3000, 3001, and 1420, so you can keep development processes running. The UI suite loads `.env` for SMTP settings.

The integration suite covers anonymous rejection, single-use setup codes, a second onboarding attempt, email invitations, the no-account email for an uninvited address, invitation expiry and refresh, admin-only invitations, retry deduplication and conflicts, two-client delivery, ordered replay, snapshot overlap, session revocation, origin restrictions, and device approval. The UI suite onboards an admin with the setup code, invites a colleague by email, exchanges messages, reconnects, retries a stored outgoing message after reload, and signs out. A second browser test verifies the device approval page. Traces and screenshots go to ignored `test-results/`. To use an installed Chrome instead of the downloaded Chromium, run `PLAYWRIGHT_CHANNEL=chrome pnpm test:ui`.

If Google Chrome is already installed, use `PLAYWRIGHT_CHANNEL=chrome pnpm test:ui` instead of downloading Chromium. The CI workflow uses Chrome on the Ubuntu runner and defines native compile checks for macOS, Windows, and Linux.

The Docker server build and runtime are verified on Node.js 24. Native macOS checks covered launch, signup, invitation redemption, live chat, browser device approval, credential restoration, and logout after restart. Those checks predate setup-code onboarding and email invitations, which still need a native macOS run. Windows and Linux still need native runtime verification. Real company OIDC needs provider credentials. Voice, video, file uploads, message editing, and mobile clients are outside this first slice. LiveKit is planned for media.

See [the architecture](docs/architecture.md) for authorization, event ordering, pending-message storage, and reconnect behavior.

See [passwordless security and operator recovery](docs/passwordless.md) for migration, policy, recovery and verification.

See [passwordless review and verification](docs/passwordless-review.md) for accepted review findings, test recipes and release limits.
