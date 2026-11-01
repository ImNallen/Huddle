# Agent instructions

`README.md` is for humans. Keep it short and about using and hosting Huddle. This file is for AI agents. Put agent-facing detail, such as test ports and suite internals, here instead of in the README. `CLAUDE.md` imports this file.

## Git and pull requests

Do not commit, push, or create a pull request until the user tells you to. Leave changes uncommitted in the working tree and report what changed.

## Verify a change

Run these from the repository root. Build before the UI suite, because it runs the production server.

```sh
pnpm typecheck
pnpm build
pnpm format:check
pnpm db:migrate
pnpm test:integration
pnpm test:access
pnpm --filter @huddle/server test:rooms-migration
pnpm --filter @huddle/server test:friend
pnpm exec playwright install chromium
pnpm test:ui
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

On macOS, also build the app bundle with `pnpm --filter @huddle/desktop tauri build --bundles app`.

The integration, access, and UI suites each create a scratch database named `huddle_scratch_*` on the PostgreSQL server in `DATABASE_URL`, start their own server with a known `SETUP_CODE`, and drop the database afterwards. The `DATABASE_URL` user needs the `CREATEDB` privilege. Never point the suites at real user data.

The suites use their own ports, so development processes on 3000, 3001, 4000, and 1420 can keep running:

- The integration suite runs the production server on 3100 and 3101, with the friend port on 4100. It restarts the server to check persistence. `TEST_PORT` changes the HTTP port, and the socket uses the next port.
- `pnpm test:access` uses port 3200.
- The UI suite runs the desktop frontend on `127.0.0.1:1520` and, for each spec file, a production server on `localhost:3400` with the friend port on 4400. `HUDDLE_UI_DESKTOP_PORT` and `HUDDLE_UI_SERVER_PORT` change them.
- `test:friend` uses 3510, 3511, and 4510.

`HUDDLE_INVITE_LOOPBACK=1` adds a `127.0.0.1` invite. The integration and UI suites read the join code from that invite and join over the HTTP port. Only `test:friend` connects through the friend port and checks the certificate pin, including rejection of a wrong pin.

The integration suite covers anonymous rejection, single-use setup codes, joining with the invite code, admin-only invites and password resets, the `account:reset` CLI, reset cutting off open WebSockets and unused watch tickets, retry deduplication and conflicts, two-client delivery, ordered replay, snapshot overlap, session revocation, and origin restrictions. The access suite covers cookie and bearer sessions, wrong passwords, sign-in rate limits, signing out one session while others stay live, signing out all other sessions, cross-account revoke attempts, password change and its rate limit, photos, and sign-out. The UI suite sets up a server, joins a friend with the invite's join code, exchanges messages, reconnects, retries a stored outgoing message after reload, and signs out. `tests/desktop.spec.ts` covers desktop password sign-in and keychain storage. Traces and screenshots go to ignored `test-results/`. `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome instead of Chromium. CI runs every suite above except the native bundle, uses Chrome on Ubuntu, and compiles the desktop on macOS, Windows, and Linux.

Not yet verified: pasting an invite into the packaged macOS app, and native runtime on Windows and Linux.
