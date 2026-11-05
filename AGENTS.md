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
pnpm exec playwright install chromium
pnpm test:ui
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

On macOS, also build the app bundle with `pnpm --filter @huddle/desktop tauri build --bundles app`.

The integration, access, and UI suites each create a scratch database named `huddle_scratch_*` on the PostgreSQL server in `DATABASE_URL`, start their own server with a known `SETUP_CODE`, and drop the database afterwards. The `DATABASE_URL` user needs the `CREATEDB` privilege. Never point the suites at real user data.

`pnpm dev` on 3000, 3002, 3003, and 1420 can keep running, because the suites use their own ports:

- The integration suite runs the production server on 3100 and 3101. It restarts the server to check persistence, and it starts a second server on 3102 and 3103 with `SOCKET_MAX_AGE_SECONDS=2`. `TEST_PORT` changes the HTTP port, and the other ports follow it.
- `pnpm test:access` uses 3200 and 3201.
- The UI suite runs the desktop frontend on `127.0.0.1:1520` and, for each spec file, a production server on `localhost:3400` and `3401`. `HUDDLE_UI_DESKTOP_PORT` and `HUDDLE_UI_SERVER_PORT` change them.
- `test:serve` uses 3790 and 3791.

The server has no test mode. Suites send the headers Serve would add, from outside the process. `tailscale()` in `apps/server/scripts/harness.ts` is the one helper that knows those names. Node clients pass it to `fetch` and `ws`. Playwright sets it as `extraHTTPHeaders` on a browser context, with one context per person. Those headers trigger a preflight on a cross-origin fetch, which production CORS must refuse, so native-shell specs add a no-op `context.route` and Playwright answers the preflight. `pnpm dev` plays Serve with `runtime/dev-serve.ts`, and it refuses anything but a loopback HTTP `SERVER_URL`. `playwright.config.ts` turns off Chrome's local network prompt, because it would stop `tests/cross-site.spec.ts` requests before the server sees them.

Every data POST must carry `X-Huddle-User`, or it answers 401. `Client` in the harness learns the ID from `stage()` and `act()`. A raw `fetch` in a test must send it, as `apiPost` in `tests/accounts.ts` does.

`test:rooms-migration` covers migrations 000, 006, 007, 011, and 013. Same-named channels in different rooms survive, channels and stored `channel.created` events are backfilled to the `text` kind, and every insert must state a kind. It seeds logins, sessions, a watch ticket, a join code, photos, and direct messages at 012, then checks that 013 keeps every row and ID, leaves logins NULL, keeps old usernames as labels, drops credential tables, and issues a valid join code. A fresh install must reach the same shape as an upgrade. `000_better_auth_baseline.sql` was reconciled against a real `pg_dump --schema-only` of Better Auth's own migrator.

`test:access` first runs `scripts/identity-check.ts`, a table of header combinations over `readAttestation`, a table over `contextAllowed`, and config refusals. Then it covers anonymous rejection, setup and join, exact login comparison, join limits per login, members never seeing logins, an unlinked account authenticating nobody, and photos.

The integration suite covers no identity and wrong `Host`, the underscore header, Funnel, listeners refusing off-host connections, single-use setup codes, joining with the invite code, admin-only invites, the `account:link` CLI including sockets closing when a login moves, retry deduplication and conflicts, room creation, channel names unique within a room, voice channel creation and replay with `kind`, rejection of messages to a voice channel, two-client delivery, ordered replay, snapshot overlap, cross-site rejection of POST, no-cors GET, and upgrades, real preflights for the desktop origins, a page naming the wrong account, socket age-out with code 4001, unread mention counts, and direct messages. Its direct message block has three members. The third member's 404s must match those for a random UUID, and raw snapshot text and socket frames must not contain the body, conversation ID, or direct events. It also covers find-or-create from both directions, empty conversations staying invisible to the peer, retry conflicts that return no body, read capping, paging, and membership checks. There is no HTTP replay route, so replay from cursor 0 is checked over a fresh socket. Do not call `domain` functions that touch the database from `integration.ts`: its process has the `.env` `DATABASE_URL`, not the scratch one.

The UI suite sets up a server, joins a friend with the invite link, exchanges messages, reconnects, retries a stored outgoing message after reload, and loses identity. `tests/onboarding.spec.ts` covers visitors with no identity, a stranger without an invite, join by link, and a wrong setup code. `tests/cross-site.spec.ts` serves a page from `http://evil.test` and checks that `fetch`, `<img>`, a form POST, `new WebSocket`, and an `<iframe>` all fail while the context has an identity. `tests/members.spec.ts` covers the roster and a friend moved to a new login keeping their history after **Check again**. `tests/rooms.spec.ts` covers the rail, switching rooms, the remembered channel, and voice channels. `tests/rail.spec.ts` covers the rail scrolling with many rooms. `tests/thread.spec.ts` covers the thread staying at its end through composer growth, resizes, and the member toggle, without moving someone reading history. `tests/direct.spec.ts` uses three browser contexts for starting a direct message from the member list and from `New message`, live delivery both ways, the Home tile and list, a third member seeing nothing, reload persistence, retrying after a failed send including a first message, and an outbox entry stored in the old channel shape. `tests/home.spec.ts` covers the setup checklist, room activity on the rail tile and channel row, and direct messages on Home. `tests/security.spec.ts` covers profile names, the Settings window and its Connection tab, and a new identity under a running page, which must not send what the old one typed. The window floats over a chat that stays live, every way of closing it keeps the draft and returns focus, dragging from a field to the backdrop or dismissing the file picker leaves it open, and a saved name reaches the member list behind it. Messages that arrive behind any dialog stay unread until it closes. Settings and small dialogs share a backdrop that blurs in both themes, pale in light and dark in dark. `tests/desktop.spec.ts` covers the desktop opening with no stored credential and the merged window bar and its controls. `tests/reconnect.spec.ts` covers a socket aging out with no visible change. Traces and screenshots go to ignored `test-results/`. `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome instead of Chromium. CI runs every suite above except the native bundle and `test:serve`, uses Chrome on Ubuntu, and compiles the desktop on macOS, Windows, and Linux.

`pnpm --filter @huddle/server test:serve <https address>` is a manual check against real `tailscale serve`, on a machine with a tailnet. CI has no tailnet, so rerun it on Tailscale upgrades. It also checks that Tailscale uses a TUN device and that the backend ports are closed on the node's Tailscale address. Userspace mode forwards a peer's direct connection onto loopback, past Serve, so `runtime/production.ts` refuses to start under it. The integration suite proves that refusal with a fake `tailscale` on `PATH`.

Not yet verified: identity for a friend whose tailnet received the machine as a share, sharing a tagged Huddle node, the Compose sidecar end to end, how long an established connection survives an ACL change, pasting an invite into the packaged macOS app, the packaged desktop against Serve, and native runtime on Windows and Linux.
