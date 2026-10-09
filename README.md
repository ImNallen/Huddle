# Huddle

Huddle is a desktop home for your team's conversations. Run your own server, create a private workspace, invite a colleague, and exchange persistent text messages.

The desktop uses Tauri 2, React, and TanStack Router. TanStack Start serves the HTTP API and login pages. Better Auth manages accounts and sessions in PostgreSQL. WebSockets replay committed workspace events. There are no cloud services required for email and password login.

## Run locally

Install Node.js 24 LTS, pnpm 11.23.0, and Docker. Native development also needs [Tauri's platform prerequisites](https://v2.tauri.app/start/prerequisites/), including Rust. The JavaScript applications also run on Node.js 26.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose up -d db
pnpm db:migrate
pnpm dev
```

Open `http://127.0.0.1:1420`. The frontend proxies `/api` to `http://localhost:3000` for browser cookies. The server's operator landing page is at `http://localhost:3000`. WebSockets listen on port 3001.

`pnpm setup:local` creates an ignored `.env` with independent random database and auth secrets. Running the command again preserves your configuration. If you already have PostgreSQL, set `DATABASE_URL` in `.env` and skip the Docker command.

Create an account, create a workspace, and add a text channel. Use **Invite your teammates** to create a one-use invitation that expires in 24 hours. Your colleague creates an account and selects **Join with an invitation**. Account creation alone grants no workspace access.

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
```

PostgreSQL data persists in the `postgres-data` volume. Back up this volume before upgrades. Apply migrations before starting the new server image. The migration command applies Better Auth's schema and Huddle's numbered SQL migrations. Huddle migrations are transactional and tracked in `huddle_migration`.

Place an HTTPS reverse proxy in front of ports 3000 and 3001. Proxy normal HTTP requests to 3000 and WebSocket upgrades to 3001. Both container ports bind to loopback on the host. For example, set `SERVER_URL=https://chat.example.com` and `WS_PUBLIC_URL=wss://events.example.com/`. The WebSocket endpoint is `/`, and authentication travels in its first frame. Configure proxy idle timeouts to allow the connection to remain open.

Set `TRUSTED_ORIGINS` to the exact browser origins you operate plus `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost`. Keep the local Vite origins only for development. The server always trusts its own canonical `SERVER_URL`. Do not use wildcard origins. HTTPS installations require a WSS endpoint.

For a host installation without Docker:

```sh
pnpm build
pnpm db:migrate
pnpm --filter @huddle/server start
```

The server starts HTTP and WebSocket listeners in one Node service. Configure `PORT`, `WS_PORT`, and `WS_PUBLIC_URL` together if you change ports.

## Configure company login

Set `OIDC_DISCOVERY_URL`, `OIDC_CLIENT_ID`, and `OIDC_CLIENT_SECRET` in `.env`. Register this callback URL with your provider:

```text
https://YOUR_HUDDLE_SERVER/api/auth/oauth2/callback/company
```

Huddle requests `openid`, `profile`, and `email` with PKCE. Company login authenticates an account. It never grants workspace membership based on an email domain.

On native desktop, select **Sign in with your browser**. The browser supports email login and the configured company provider. Check that the displayed code matches your desktop, then approve the request. Better Auth issues the desktop a session token. Polling honors expiry, the server interval, and `slow_down`.

No company provider credentials ship with this repository. Real company OIDC login has not been verified against an external provider. Email login and the first-party device authorization flow have automated integration coverage.

## Verify a change

Use a disposable PostgreSQL database in `.env`. The checks create uniquely named test accounts and workspaces in that database. They do not delete them. Run migrations before the integration suite.

```sh
pnpm typecheck
pnpm build
pnpm db:migrate
pnpm test:integration
pnpm exec playwright install chromium
pnpm test:ui
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm --filter @huddle/desktop tauri build --bundles app
```

The integration suite launches the production server on ports 3100 and 3101, stops it, and restarts it to verify persistence. Set `TEST_PORT` to change the HTTP port; the socket uses the next port. The UI suite manages its own server and frontend on ports 3000, 3001, and 1420. Stop development processes before running it.

The integration suite covers anonymous rejection, isolated workspaces, invitations, retry deduplication and conflicts, two-client delivery, ordered replay, snapshot overlap, session revocation, origin restrictions, and device approval. The UI suite signs up two accounts, joins a workspace, exchanges messages, reconnects, retries a stored outgoing message after reload, and signs out. A second browser test verifies the device approval page. Traces and screenshots go to ignored `test-results/`. To use an installed Chrome instead of the downloaded Chromium, run `PLAYWRIGHT_CHANNEL=chrome pnpm test:ui`.

macOS compilation and bundling are verified. Windows and Linux require their own native verification. Voice, video, file uploads, message editing, and mobile clients are outside this first slice. LiveKit is planned for media.

See [the architecture](docs/architecture.md) for authorization, event ordering, pending-message storage, and reconnect behavior.
