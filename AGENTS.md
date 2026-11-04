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

`test:rooms-migration` covers migrations 006, 007, and 011: same-named channels in different rooms survive, channels and stored `channel.created` events are backfilled to the `text` kind, and every insert must state a kind. The integration suite covers anonymous rejection, single-use setup codes, joining with the invite code, admin-only invites and password resets, the `account:reset` CLI, reset cutting off open WebSockets and unused watch tickets, retry deduplication and conflicts, room creation, channel names unique within a room, voice channel creation and replay with `kind`, rejection of messages to a voice channel, two-client delivery, ordered replay, snapshot overlap, session revocation, origin restrictions, unread mention counts, and direct messages. Its direct message block has three members. The third member's 404s must match those for a random UUID, and raw snapshot text and socket frames must not contain the body, conversation ID, or direct events. It also covers find-or-create from both directions, empty conversations staying invisible to the peer, retry conflicts that return no body, read capping, paging, and membership checks. There is no HTTP replay route, so replay from cursor 0 is checked over a fresh socket. Do not call `domain` functions that touch the database from `integration.ts`: its process has the `.env` `DATABASE_URL`, not the scratch one. The access suite covers cookie and bearer sessions, wrong passwords, sign-in rate limits, signing out one session while others stay live, signing out all other sessions, cross-account revoke attempts, password change and its rate limit, photos, and sign-out. The UI suite sets up a server, joins a friend with the invite's join code, exchanges messages, reconnects, retries a stored outgoing message after reload, and signs out. `tests/rooms.spec.ts` covers the rail, switching rooms, the remembered channel, and voice channels. `tests/rail.spec.ts` covers the rail scrolling with many rooms. `tests/thread.spec.ts` covers the thread staying at its end through composer growth, resizes, and the member toggle, without moving someone reading history. `tests/direct.spec.ts` uses three browser contexts for starting a direct message from the member list and from `New message`, live delivery both ways, the Home tile and list, a third member seeing nothing, reload persistence, retrying after a failed send including a first message, and an outbox entry stored in the old channel shape. `tests/home.spec.ts` covers the setup checklist, room activity on the rail tile and channel row, and direct messages on Home. `tests/desktop.spec.ts` covers desktop password sign-in, keychain storage, and the merged window bar and its controls. Traces and screenshots go to ignored `test-results/`. `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome instead of Chromium. CI runs every suite above except the native bundle, uses Chrome on Ubuntu, and compiles the desktop on macOS, Windows, and Linux.

Not yet verified: pasting an invite into the packaged macOS app, and native runtime on Windows and Linux.
