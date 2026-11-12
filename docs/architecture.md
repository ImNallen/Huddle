# Huddle's first working slice

## Problem

Build a desktop client and self-hosted server that let a group of friends chat the way they would on a Discord server, on a machine one of them runs. Everyone reaches the server over Tailscale. The host sets up the server and shares an invite. Friends open the invite, confirm their name, and exchange persistent text messages. One server holds one group. Desktop uses Tauri 2, React, and TanStack Router. The server uses TanStack Start and PostgreSQL. Convex is excluded.

## Usage

Start PostgreSQL, apply migrations, publish the server with `tailscale serve`, and start it. The host opens the server's Tailscale address and sets up the server with the setup code from the server log, a server name, and a display name. The host becomes the admin, creates rooms and channels, and copies an invite from **Share invite**. A friend with access to the machine in Tailscale opens the invite in a browser or pastes it into the desktop app, confirms their name, and joins as a member. Accounts come only from setup or an invite.

Serve provides the address, a trusted certificate, and each person's identity. An invite is a URL: `https://huddle.your-tailnet.ts.net/#join=<code>`. The code stays in the fragment, so it reaches no server log. Opening the link moves the code to `huddle.join-code:<origin>` in local storage and strips the fragment. The desktop stores the same key and connects to the origin.

The desktop sends explicit HTTP requests for application operations. It opens a WebSocket to watch server events. Serve attests the upgrade, and the first frame carries only the replay cursor. It never imports Start server functions.

```ts
const room = await client.createRoom({ name: 'Studio' })
const channel = await client.createChannel({ roomId: room.id, name: 'general', kind: 'text' })
const { invite } = await client.request('/api/invite', ServerInvite)
await client.watchServer({ after: snapshot.cursor })
await client.sendMessage({
  channelId: channel.id,
  retryId: crypto.randomUUID(),
  body: 'Hello everyone',
})
```

These are caller-facing responsibilities. Implementation may use an HTTP client plus a dedicated watch connection instead of a single class.

## Data shape

User holds each account's ID, display name, and `tailscale_login`. A NULL login is an account from an older version waiting for a link, and it cannot authenticate. `legacy_username` keeps its old username as a label that only `account:link` reads. Huddle also owns these tables:

- Server holds at most one row, enforced by a boolean `singleton` primary key. It stores the server name, chosen at setup and renamed by admins, and a transactionally updated event cursor.
- Member gives a user an `admin` or `member` role on the server, one row per user. Only admins share invites, create, rename, and delete rooms and channels, rename the server, and remove members.
- BlockedAccount holds one row per removed account, keyed by account and not by login. Removing someone deletes their member row and writes this row in one transaction. Unblocking deletes it.
- DeletedVoiceChannel holds only the IDs of deleted voice channels, so voice presence can still recognize their LiveKit rooms and close them. It is never pruned.
- Room has a case-insensitively unique name on the server. Every member sees every room.
- Channel belongs to a room and has a unique normalized name within it. Its kind is `text` or `voice`, and text and voice channels share that name space. A voice channel holds calls and rejects messages.
- Message has an author, channel, body, stable retry UUID, and committed event cursor.
- Event records each server change at its cursor. Its `audience` is NULL for an event every member sees, or the list of user IDs allowed to see it. Its `group_id`, `room_id`, and `channel_id` name what it is about. `appendEvent` derives them from `eventScope` in `domain.ts`, an exhaustive switch over event kinds, and CHECK constraints are the database's copy of that table. Each is a cascading foreign key, so deleting a room or channel deletes its events too.
- AccountSecurity holds each user's avatar.
- JoinCode holds at most one row, with the server's join code in plain text. Setup creates it. The host can already read every message, and the code is useless without a tailnet identity, so sealing it would protect nothing.
- SetupCode holds at most one row, with a SHA-256 hash of the one-time setup code and its expiry.
- A read marker stores, per user and channel, the highest cursor that user has read. It only moves forward and never passes the server cursor. Read state is private, so it emits no event.
- A mention records which members a room message names with `@` followed by their full or first name. The snapshot counts a caller's unread mentions per channel, and each `message.created` event lists who it mentions, so the rail can badge a room without a feed. Stored events without that list parse as mentioning nobody.
- Direct conversation holds one pair of users, stored in database collation order so a pair has one row. Direct message mirrors a message, with a conversation in place of a channel. Direct read is a read marker per user and conversation with the same rules as a channel's.

Migration `007_single_server.sql` moves a database with zero or one legacy workspace to this shape and keeps its rooms, channels, messages, read markers, mentions, and events. It strips legacy workspace IDs from stored event JSON and drops the legacy workspace tables. It refuses a database with more than one legacy workspace. Migration `009_password_only.sql` drops the tables and columns of the removed email, authenticator, passkey, device, and company login features. Migration `011_channel_kind.sql` gives every channel a required kind, backfills existing channels to `text`, and adds the same kind to stored `channel.created` event JSON. The column has no default, so every insert states its kind. Migration `012_direct_messages.sql` adds the direct tables and the nullable `event.audience`, which leaves every existing event open to all members. Migration `000_better_auth_baseline.sql` creates the four tables that Better Auth used to create before 001 ran, so 001 to 012 replay on a fresh database. Migration `013_tailscale_identity.sql` adds the login and label columns, drops the credential tables, and issues a new join code. It keeps every account ID, so nothing that references an account changes. Migration `016_admin_controls.sql` adds the block and voice tombstone tables, the event scope columns, and a cascading `channel_id` on channel edit receipts, and backfills both from stored JSON. An event that names a room or channel that no longer exists fails the migration rather than being deleted.

Each server write locks the server row, checks membership, applies its mutation, advances the server cursor, inserts its event, and commits. Event cursors are decimal strings over the network. Database allocation follows commit order because the same row serializes mutations. A bare sequence or timestamp is insufficient.

The unique message key is the author and retry UUID. An identical retry returns the stored message. Reusing that key with another channel or body returns a conflict. Account or server switches never replay another account's pending messages.

Pending messages use a discriminated sending or failed state. Before the first HTTP send, the client persists the body and retry UUID in local storage under `huddle.outbox:<origin>:<userId>`, keyed by the canonical server origin and account ID. Each entry names its thread, a channel or a direct conversation, and a direct entry also keeps the peer's ID, so a first message can be retried after a reload even though the snapshot does not list a conversation with no messages. Entries stored in the older channel shape still load. Interrupted sends restore as failed and require an explicit retry with the same UUID. Confirmed messages have one source of truth. A send response may confirm a pending message but cannot advance the replay cursor.

## Appearance

Color scheme, theme selection, and custom themes are per device. They live in local storage under `huddle.appearance.mode`, `huddle.appearance.selected.v1`, and `huddle.themes.v1`, with no server route, contract, or migration. In the browser that means per server origin, and in the desktop per app. Nothing is written until someone chooses, so a later change of default reaches everyone who never did. A derived copy of the selected custom palettes sits in `huddle.appearance.paint.v1` for the first paint, and it is rewritten on every load, so a derivation fix reaches stored themes.

`packages/ui/public/appearance-boot.js` runs before the body in both entries. It sets `data-scheme` on `<html>` and adopts a stylesheet from the paint cache. The desktop loads it as an external classic script, because its CSP is `script-src 'self'`, and the server inlines the same file. Vite copies it to the desktop's `dist` from `publicDir`. With nothing stored it does nothing, and CSS follows the OS.

Theme files are untrusted, because friends pass them around. A value reaches a stylesheet only through `parseColor`, which rebuilds it from parsed numbers, and the boot script accepts only the two shapes `parseColor` writes. A check fails the build if they disagree.

Open VSX search is the one place the client contacts a host outside the tailnet. The device calls `open-vsx.org` directly, because Appearance works without an account, and a call through the Huddle server would tell the server what each person searches for. Nothing is sent until someone searches, and requests carry no cookies or referrer. The desktop CSP already allows `https:` in `connect-src`, and it allows `https://open-vsx.org` and `https://openvsx.eclipsecontent.org` in `img-src` for extension icons, because the registry redirects each icon to that CDN and CSP checks the redirect too. An extension is untrusted. `extensionPath` keeps every path a manifest names inside its `extension/` folder, responses are capped by size and time, and an installed variant is rebuilt as theme file text, so it crosses `parseThemeFile` like a pasted file. Files come from the registry's unpacked `/vscode/unpkg` route, so there is no VSIX to unzip.

Palettes use the CSS `light-dark()` function with no fallback, so the browser floor is Chrome 123, Edge 123, Firefox 120, and Safari 17.5. `build.cssTarget` in both Vite configs states the same floor, and it must, because below it Lightning CSS replaces `light-dark()` with a polyfill. Below the floor every color token is invalid and the interface loses its colors. The desktop inherits this floor from the OS web view: the system WebKit on macOS, WebKitGTK on Linux, and WebView2 on Windows.

## Direct messages

Any member can message any other member, one to one. There are no friend requests, blocking between members, or deletion. A direct message's body, author, existence, and participants must never reach a third member.

A conversation outlives a removed peer. The other person keeps reading it, and editing their own messages, but a new send answers 409. A retry of a message sent before the removal still returns the stored message. `GET /api/members` lists such peers as `former`, with name and avatar and never a login, only to the person who shares a conversation with them, so the thread keeps its header and replaces its composer with a note. Pickers read `members` only.

Direct messages live in their own tables and endpoints rather than in a channel kind. No existing room query names those tables, so forgetting a filter on a room route cannot expose a private message. The one shared structure is the event log, where a direct event carries its two participants as its audience.

Every route that can return direct data is scoped to the caller:

- `GET /api/direct/messages`, `POST /api/direct/messages`, and `POST /api/direct/read` go through `requireConversation`, the only way direct code reaches a conversation by ID. It answers 404 with the same text whether the conversation does not exist or the caller is not in it.
- `POST /api/direct/conversations` finds or creates the caller's own pair. It emits no event. A conversation with no messages stays out of the snapshot, so the other person sees nothing until a message exists.
- `GET /api/snapshot` lists only the caller's conversations that have a message.
- The socket and replay share one query. `replay` filters on `audience IS NULL OR caller = ANY(audience)` in SQL, per caller, so a socket only ever sends what that caller may see. Every direct operation also checks membership.

A retry ID that belongs to another conversation or body is a conflict that returns no body.

Cursors stay global and share `server.cursor`, so a member sees gaps in event cursors. A gap lets a member infer that some private event happened and roughly when, and so count direct messages server-wide, but not who sent them or what they said. Sockets send empty frames only on their one-second tick, so a wakeup alone does not timestamp a private event. Keeping one cursor preserves commit-ordered replay and needs no per-user log.

A photo is readable by its owner, and by a member only while it is someone's current avatar, is on a channel message, or is on a direct message in that member's own conversation. That stops a kept photo from revealing that its owner sent a direct message. Event writes must name their audience, and the database rejects a `direct.*` event without one.

The bodies are stored unencrypted, so the host can read them with database access, and the interface says so at the start of each conversation. Whoever has a shell on the host can also run `account:link` to bind a member's account to a login they hold, then read that member's conversations in the app. An admin without a shell cannot, because no web route writes a login. The member notices a takeover of a linked account, because their own login stops reaching it. Until an upgraded account is linked, nothing tells its owner, so the upgrade window is when friends rely on trusting the host most. Avatars are account photos that any member can fetch by ID, and pruning keeps a photo while a direct message still shows it.

## Voice

A person joins a voice channel from its page. The call belongs to `ServerView`, above the views, so moving to another channel leaves it running, and leaving the server, losing identity, or moving to another account ends it. A person is in one call at a time, and joining another channel leaves the first.

`useVoiceCall` holds the call's phase: idle, waiting for the microphone, connecting, connected, reconnecting, or failed. Each attempt is its own session in `voiceCall.ts`, which owns the microphone, the LiveKit room, and the audio elements, and releases all three on every path out. That includes cancelling while a permission prompt is open, because the browser can still hand over the microphone afterwards. `livekit-client` loads on the first join, so nobody who never calls downloads it.

The microphone comes first and the token second, because a permission prompt can outlast the token's 60 seconds. A failure names its cause and what to do. The client tells a port problem from a refused token by whether signalling connected first: if it did and the call still failed, the media port is the likely problem.

The desktop uses the same call engine and controls as the browser. Its local frontend requests the microphone through the system WebView only when someone joins. `apps/desktop/src-tauri/Info.plist` declares `NSMicrophoneUsageDescription`, which Tauri merges into the macOS bundle. `Entitlements.plist` allows audio input when the app is signed with hardened runtime. The native shell grants microphone requests only from the bundled app origin, or the configured development origin in debug builds. Other permissions keep the WebView's default behavior. This handler is required on Linux, where WebKitGTK denies unhandled microphone requests. Wry handles capture, so no native media bridge is needed. System permission denial points to Huddle's microphone privacy settings. A WebView without WebRTC offers a browser fallback. Linux support depends on the installed WebKitGTK media support and permissions.

See [Tauri's macOS bundle configuration](https://v2.tauri.app/distribute/macos-application-bundle/) and [Apple's media authorization requirements](https://developer.apple.com/documentation/bundleresources/requesting-authorization-for-media-capture-on-macos).

One LiveKit server relays audio. Friends on a shared Tailscale node have no route to each other, so a mesh between them cannot work. It runs beside the Huddle server and shares no code or tables with it.

`POST /api/voice/token` takes a channel and answers with LiveKit's address and a token. It sits behind the same `contextAllowed`, `requireAccess`, and `X-Huddle-User` checks as every other POST. A text channel answers 409 and an unknown channel 404. A server with no `LIVEKIT_API_SECRET` answers 503, and `/api/info` reports `voice: false`. Clients read `voice` with a default of false, so a new client still parses an older server. `config.voice` is one value, null or complete, so no caller can hold half a configuration.

The token names the account ID, the display name, and the channel ID as the room. It lets the holder join that room, subscribe, and publish only a microphone. It has no admin or room creation grant, cannot publish data, and cannot change its own metadata. It lasts 60 seconds, because it only has to last until the client connects, and expiry does not end a call in progress.

Voice state is not in the event log. Who is in a call is live state that LiveKit owns and that nothing needs to replay. Issuing a token writes nothing.

The realtime process asks LiveKit every second who is in each room and adds the full list as `voice` on each `events` frame, so a socket only hears it after passing the same access check as its events. A polled full list cannot drift, which webhooks can: a LiveKit restart sends no leave event for someone who had already crashed. Older clients drop the unknown field. The server reaches LiveKit's API on `127.0.0.1` at `LIVEKIT_PORT`, so LiveKit must run on the same machine or in the same network namespace. It looks only at rooms named for a voice channel in its own database, or in `deleted_voice_channel`, so servers that share a LiveKit, as `pnpm dev` and the suites share `livekit-dev`, neither list nor remove each other's people.

Deleting a voice channel, or its room, writes the channel's ID to `deleted_voice_channel` in the same transaction. The next look deletes that LiveKit room, and LiveKit disconnects everyone in it. The tombstone is durable, so a crash between the commit and the close only delays it, and a room recreated by a token issued just before the delete is closed again on the following look. The client usually ends the call first, from the `channel.deleted` event. It releases the microphone and says which channel was deleted. A participant whose account has no member row is removed on the next look, with no grace period, because only members get tokens.

A call outlives its token, and LiveKit never re-checks Tailscale, so a person in a call must keep an attested watch socket. Serve attests a socket when it opens, and a socket lasts at most `SOCKET_MAX_AGE_SECONDS`. A participant with no socket for `VOICE_ACCESS_GRACE_SECONDS`, 60 by default, is removed, and removed again on the next look if they rejoin without one, because their absence is remembered until a socket returns. So someone who loses access is out of a call within about six and a half minutes at worst. The grace period restarts with the server, so a deploy removes nobody.

Signalling reaches LiveKit through Serve on HTTPS port 8443, not under Huddle's address, because a mount there would share Huddle's origin. `contextAllowed` refuses requests from a page on that origin, and its address is never a `serverHosts` entry, so it carries no Huddle identity. Serve cannot carry UDP, so audio goes to one UDP port on the node's Tailscale address. ICE over TCP stays off, because LiveKit binds that port on every interface and ignores its interface filter. [Hosting](hosting.md#run-livekit) has the operator's view.

## Module ownership

- `apps/server` owns Start HTTP routes, the identity gate, application SQL, and the realtime server runtime. `src/lib/identity.ts` is the only file that reads a Tailscale header, and `scripts/check-admission.ts` fails the typecheck otherwise.
- One server domain module owns member permissions and application transactions. Routes parse input and call it directly.
- One realtime module owns watch subscriptions, replay, access revalidation, bounded buffers, and disconnects. It cannot mutate application tables.
- `packages/ui` owns the shared React interface, browser transport and client synchronization.
- `apps/desktop` owns TanStack Router, the development endpoint override, and the Tauri shell. The Rust shell holds only window setup.
- `packages/contracts` owns network schemas and their inferred TypeScript types. It has no database connections.

Validate configuration and incoming network data at boundaries. Use parameterized SQL. Keep framework wiring thin. Avoid repository, service, and controller layers that only forward arguments.

## Authentication

The Tailscale headers on each request are the only credential. Serve deletes any client copy of its identity headers and sets its own. The server stores no session, cookie, or token. Its only secrets are the database's and LiveKit's, and a voice token grants a LiveKit room, never access to Huddle. A session minted from ambient identity would have exactly the authority of that identity and would outlive it, so it would add state and a revocation gap and little else.

`requireAccess(headers)` in `src/lib/identity.ts` is the one authentication gate, for HTTP and for each realtime batch. It calls `identify`, which calls the pure `readAttestation`, then runs one query. `readAttestation` decides who Tailscale says this is:

- A `Tailscale-Funnel-Request` header means public traffic, so there is no identity.
- A `Host` outside `SERVER_URL` and `WS_PUBLIC_URL` means there is no identity. A browser on the server cannot forge `Host`, which stops DNS rebinding to the backend.
- With no valid login, `X-Forwarded-Host` tells a tagged device from a loopback caller, so the screen can say which.

Serve Q-encodes non-ASCII values, so the server decodes them. It compares logins exactly. `Tailscale_User_Login` is a different header. Serve 1.104.5 passes it through, so nothing normalizes names. Node joins a repeated header with `, `, and the login schema refuses commas.

Listeners bind `127.0.0.1` in code, with no setting to widen it. No code path branches on `NODE_ENV` or a flag. Tests and `pnpm dev` send the same headers from outside the process that Serve sends, and `runtime/dev-serve.ts` plays Serve in development. `scripts/check-admission.ts` keeps it out of `src/` and `runtime/production.ts`.

Every browser on a tailnet device has ambient identity, including `credentials: 'omit'` requests and pages in frames. `contextAllowed` in the same module is the only cross-site rule, used by HTTP and realtime:

- A request with an `Origin` must name `SERVER_URL`, a desktop origin, or a `TRUSTED_ORIGINS` entry.
- A write or upgrade without an `Origin` is refused, because browsers always send one.
- A read without an `Origin` is refused if `Sec-Fetch-Site` says `cross-site` or `same-site`. Another service on another port of this host is same-site, so a `SameSite` cookie would not have stopped it.
- HTML answers with `frame-ancestors 'none'` and `X-Frame-Options: DENY`, because a framed app would be signed in.
- The server never allows a Tailscale header in CORS, and config refuses a loopback or plain HTTP trusted origin on an HTTPS server.

Setup creates the server. Until the server row exists, a person with an identity sees setup, and a visitor with no identity sees why they have none, so no account can exist without a login. On each start before setup, the server generates a one-time code, stores only its hash with a 24-hour expiry, and prints the code to stdout. `SETUP_CODE` supplies the code instead and is not printed. `account.setup` creates the admin's account, the server row with its name, the admin member, and the join code in one transaction that consumes the setup code. After setup, setup is impossible.

A friend account comes from `account.join`, which compares the join code in constant time, then creates the account and a `member` row in one transaction. Setup and join are idempotent on login, so a retry after commit returns `ready`. `account:link` on the host is the only way to bind an existing account, and no web route writes a login.

Identity can change under a running page, through fast user switching or a login moved with `account:link`. So `Connection` learns its user ID from the `ready` stage and sends `X-Huddle-User` on every POST. Any POST with the header must match the member Tailscale attests, and every data POST must have it. A mismatch answers 401 `no_access`, the client rereads its stage, and `ServerView` is keyed by user ID, so a new identity remounts everything, including the per-user outbox. A socket remembers the first account it served and closes if its login moves to another.

A removed account is a fourth kind of visitor. `identify` joins `member` and `blocked_account` in its one query and answers `removed` when a block exists, even if a member row somehow remains, so the block fails closed. `requireAccess` refuses anything but a member, so every route answers 401 and each socket closes with 1008 on its next batch, with no new call site. `GET /api/access` reports the `removed` stage with the person's own login. `account.setup` and `account.join` return that stage before the join limit, so a removed person spends nothing. `joinAccount` takes the server row lock, which `removeMember` also takes, and inserts a member row only for an account with no block. Without the lock, a join that read "not blocked" before a removal committed could still succeed. The client shows the removed screen for that stage. A removed browser no longer holds the join code, because the client cleared it once the account was ready, but the block is still needed, because the invite link sits in chat history.

There is no sign-out, and no way to rotate the join code yet. See [accounts](accounts.md).

## Realtime contract

HTTP is the sole write and query API. The socket accepts only one watch frame. Do not implement chat commands or correlated mutation acknowledgements on the socket.

The initial snapshot returns the server, rooms, channels, the caller's unread and mention counts, the caller's direct conversations, and an exact event cursor from one consistent database snapshot. The client increments unread counts from live events after that cursor. Channel history supports ordered pagination. The client then watches events after the snapshot cursor. Every change is replayable from PostgreSQL to the members in its audience, including a channel created while a client was disconnected.

The server sends committed event pages in cursor order. PostgreSQL NOTIFY delivers post-commit wakeups to the companion listener. A periodic database check recovers a missed wakeup even when a socket stays connected. Each batch revalidates the login and membership. Slow clients disconnect with a retryable reason. The client advances its replay cursor only after applying a complete page and merges history and live messages by stable IDs.

Renames carry the whole room or channel, so the client applies them with the same upsert as a create, and a replayed create can never undo a later rename. A create response carries its event's cursor. The creator applies it only while its socket is still behind that cursor, so a slow response can't bring back an old name or a deleted channel. Deletes send tombstones, `room.deleted` and `channel.deleted`, that carry IDs and no name, because the name is part of what was deleted. Admin writes answer `{}`, and the client applies nothing from the response, so the socket event is the one write path for every client, the admin's included.

Deleting a room or channel is one statement, `DELETE FROM room` or `DELETE FROM channel`. Every row that holds its content hangs off it by a cascading foreign key: messages, mentions, read markers, edit receipts, and the events whose JSON holds the bodies. Nothing outside the cascade remembers the channel except the ID-only tombstones. `channel.deleted` is scoped to its room only, so it survives the channel's cascade, and a room's delete takes the earlier tombstones in it. The typed name is compared inside the transaction, so a rename by another admin between opening the dialog and pressing **Delete** turns the delete into a 409. `sendMessage` and `createChannel` look their channel or room up after taking the server lock, and `markRead` reads the channel `FOR KEY SHARE`, so a write that races a delete answers 404, never a foreign key error.

Deletion is permanent within the database: no query can return the rows afterwards. PostgreSQL's dead tuples until vacuum reuses their space, its write-ahead log, and any backup the operator keeps are outside that promise.

Clients converge on the snapshot. `departed(before, after)` in `useServer.ts` names the rooms and channels that left, and one `forgetChannels` drops their messages, outbox entries in memory and storage, unread and mention counts, read marks, history cursors, and drafts. `room.deleted`, `channel.deleted`, and a fresh snapshot all go through it, so no event kind lists what to forget. On a fresh load, outbox entries that name a channel absent from the snapshot are dropped too, because every member sees every channel. `merge` drops channel messages whose channel is gone, so a late history page or send response cannot bring one back. The view falls back with one rule: to the room's landing channel, or to Home for a deleted room, with one notice, such as "#plans was deleted.", whose name comes from the snapshot before the change. A dialog that names a deleted room or channel closes. Replay converges as well: every event about a channel precedes its tombstone, because the delete holds the server lock, and a client that missed the channel's whole life sees only a tombstone for an ID it never had.

The client parses each page with an extra unknown-kind member that only advances the cursor, so a later event kind cannot stall this build. Builds released before this change parse strictly, so the first `server.renamed` or `channel.deleted` leaves an old desktop client reporting "Could not read server events" until it updates.

Serve attests a socket once, at upgrade, and a per-second check sees Huddle's database but not a Tailscale ACL change. So each socket closes with code 4001 after `SOCKET_MAX_AGE_SECONDS`, default 300, with up to 10% jitter. The client reconnects at once with no status change, and Serve attests the new upgrade. Reconnection starts a new watch from the applied cursor. A server crash between commit and broadcast cannot lose data. Initial implementation need not persist a cursor across desktop launches. A fresh snapshot avoids advancing beyond locally retained state.

## Synthesis decision

Use the socket candidate's durable event log and transactionally ordered cursor as the base. Graft the HTTP candidate's explicit mutation and query boundary. Keep the socket watch-only. This removes request correlation and custom socket command errors without weakening replay.

Both candidates recommended OS credential storage. The 2026-11-05 decision removed it.

Superseded: "Reject singleton bootstrap and setup-secret enrollment because user-owned workspaces plus explicit invitations establish a smaller, testable authorization model."

On 2026-10-09 this decision was reversed. A self-hosted company server serves one team. Per-user workspaces let anyone who reached the server create an account and a workspace. A singleton server row plus a one-time setup code gives the operator a bootstrap path outside the web interface. The server stores only the code's hash, expires it after 24 hours, and prints it to the operator's log, so no first visitor can claim the server. Email invitations bind access to a verified address instead of a bearer code that anyone holding it could redeem.

On 2026-10-29 Huddle moved from company teams to groups of friends. Friends rarely share an SMTP relay or a domain with a certificate. A pinned invite replaces both. It carries the address, so friends type nothing. Its certificate pin replaces a certificate authority. Its join code admits a new account without email. The join code is a bearer secret, which the 2026-10-09 decision rejected for company servers. For a group of friends, the host decides who receives the invite, and the server cannot rotate the code yet.

On 2026-11-01 Huddle removed email entirely. No friend group should need a mail server to chat. Email codes were also the only way into authenticator (TOTP) enrollment and recovery codes, so those went too. The person who runs the server resets passwords from the command line instead.

Later on 2026-11-01 Huddle dropped company login, passkeys, and native device approval. Friends do not have a company identity provider, and one sign-in method is easier to explain and to secure. The desktop signs in with a password directly. An admin resets a forgotten password and sends it to the friend.

On 2026-11-05 Huddle reversed the reach and identity decisions of 2026-10-29 and 2026-11-01. The owner hosts on a Proxmox machine and wants every remote user on Tailscale, and passwords had become the weakest and the most work of what remained. `tailscale serve` gives a trusted certificate, so the self-signed portal, certificate pin, Rust bridge, and NAT-PMP mapping all went. It also attests each person on each request, so usernames, scrypt hashes, Better Auth, sessions, cookies, bearer tokens, watch tickets, and the OS credential store went too. Creating an account still takes an invite, because reaching the server is not membership. The cost is real and accepted. There is no sign-out, and a person who shares an OS account or a Tailscale login cannot keep the other person out. The cross-site protections that `SameSite` cookies gave for free are now explicit rules in one function, with a real-browser spec. Linking old accounts is command-line only, so no browser path can bind an unlinked friend's account to a login of an admin's choosing. Whether Serve reports a friend's own login for a machine shared into their tailnet was inferred and not observed when this decision was made.

The independent cross-judge agreed with this synthesis. Candidate evidence is in the local task audit; production code and tests must prove the contracts here.

## Tradeoffs

We accept a server row lock and event table in exchange for commit-ordered replay. We accept a single application instance in exchange for an initial installation without Redis or Kafka.

We accept no sign-out and no per-device view in exchange for no session state and no gap between Tailscale revocation and Huddle revocation. We accept that any process on a member's device acts as that member, in exchange for no credential to steal or store. We accept that a loopback connection on the server can claim any identity, in exchange for one credential path, so the machine must run only Huddle. We accept that a socket can outlive an ACL change by up to `SOCKET_MAX_AGE_SECONDS`.

`000_better_auth_baseline.sql` looks like dead code, because 013 drops most of what it creates. It lets 001 to 012 replay on a fresh database and lets `test:rooms-migration` keep proving the legacy paths.

Video, file uploads, and mobile clients are follow-up slices. A server without LiveKit shows a notice in a voice channel, with no call controls.

## Verification

Use real PostgreSQL to verify anonymous rejection, a required single-use setup code, rejection of a second setup, joining with the join code, admin-only invites, `account:link`, two-client delivery, retry deduplication and conflicting retries, a third member finding no trace of a direct message in any route, concurrent commit ordering, snapshot/watch overlap, losing a socket when a login moves, socket age-out, join rate limits, voice tokens that real LiveKit accepts, missed-wakeup recovery, persistence after server restart, and an upgrade of a populated 012 database that keeps every row and ID.

Drive the interface through visitors with no identity, server setup, room and channel creation, a shared invite, the friend's account creation, message send, reconnect, loss of identity, and a new identity under a running page. Drive a page from another site with `tests/cross-site.spec.ts`, in a browser that has an identity.

Typecheck and build both JavaScript applications. Compile and launch Tauri on macOS. Windows and Linux remain unverified unless this session obtains those environments.

## Implementation reconciliation

The Start production fetch handler runs in a Node HTTP service with a companion WebSocket listener on a separately configured port, and Serve publishes both under one address. PostgreSQL NOTIFY crosses the framework bundle boundary; a one-second poll remains the recovery mechanism. The server serves the shared browser application. The local desktop frontend uses the Vite API proxy for the default local server. The native client selects its server at runtime and stores no credential.
