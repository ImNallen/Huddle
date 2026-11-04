# Huddle's first working slice

## Problem

Build a desktop client and self-hosted server that let a group of friends chat the way they would on a Discord server, on a machine one of them runs. The host sets up the server and shares an invite. Friends paste the invite, create an account, and exchange persistent text messages. One server holds one group. Desktop uses Tauri 2, React, and TanStack Router. The server uses TanStack Start, Better Auth, and PostgreSQL. Convex is excluded.

## Usage

Start PostgreSQL, apply migrations, and start the server and desktop frontend. The host connects the desktop to `http://localhost:3000` and sets up the server with the setup code from the server log, a server name, a username, and a password. The host becomes the admin, creates rooms and channels, and copies an invite from **Share invite**. A friend pastes the invite into the desktop app, chooses a username and password, and joins as a member. Accounts come only from setup or an invite.

The server listens for friends on a separate HTTPS port with its own self-signed certificate. An invite is `huddle:` followed by base64url JSON with the host, friend port, join code, and the SHA-256 pin of that certificate. The desktop's Rust shell opens a loopback listener and bridges each connection to the friend port over TLS that accepts only the pinned certificate. The client keeps the invite's `https://host:port` as its server origin, which scopes its stored credential. It sends requests through the bridge at `http://127.0.0.1:<port>`, which the desktop's content security policy permits.

The desktop sends explicit HTTP requests for application operations. It opens an authenticated WebSocket to watch server events. An authenticated HTTP POST to `/api/watch-ticket` returns a one-use, 30-second opaque ticket. The database stores only the ticket hash and its Better Auth session ID. The initial watch frame carries this ticket, which the realtime listener consumes atomically. Native bearer tokens are also accepted in a watch frame. No credential appears in a WebSocket URL. It never imports Start server functions.

```ts
const room = await client.createRoom({ name: 'Studio' })
const channel = await client.createChannel({ roomId: room.id, name: 'general', kind: 'text' })
const { invites } = await client.request('/api/friend-invite', FriendInvites)
await client.watchServer({ after: snapshot.cursor })
await client.sendMessage({
  channelId: channel.id,
  retryId: crypto.randomUUID(),
  body: 'Hello everyone',
})
```

These are caller-facing responsibilities. Implementation may use an HTTP client plus a dedicated watch connection instead of a single class.

## Data shape

Better Auth owns users and sessions. Huddle owns password logins and session proofs, alongside these application tables:

- Server holds at most one row, enforced by a boolean `singleton` primary key. It stores the server name chosen at setup and a transactionally updated event cursor.
- Member gives a user an `admin` or `member` role on the server, one row per user. Only admins share invites, reset member passwords, and create rooms and channels.
- Room has a case-insensitively unique name on the server. Every member sees every room.
- Channel belongs to a room and has a unique normalized name within it. Its kind is `text` or `voice`, and text and voice channels share that name space. A voice channel carries no audio yet and rejects messages.
- Message has an author, channel, body, stable retry UUID, and committed event cursor.
- Event records each server change at its cursor. Its `audience` is NULL for an event every member sees, or the list of user IDs allowed to see it.
- Login maps a unique lowercase username to a user and an scrypt password hash. Better Auth requires an email, so each user gets a placeholder under `member.huddle.invalid` that Huddle never shows or uses.
- AccountSecurity holds each user's avatar.
- JoinCode holds at most one row, with the hash of the server's join code and the code sealed with the auth encryption key, so admins can show it in invites. Setup creates it.
- SetupCode holds at most one row, with an HMAC hash of the one-time setup code and its expiry.
- A read marker stores, per user and channel, the highest cursor that user has read. It only moves forward and never passes the server cursor. Read state is private, so it emits no event.
- A mention records which members a room message names with `@` followed by their full or first name. The snapshot counts a caller's unread mentions per channel, and each `message.created` event lists who it mentions, so the rail can badge a room without a feed. Stored events without that list parse as mentioning nobody.
- Direct conversation holds one pair of users, stored in database collation order so a pair has one row. Direct message mirrors a message, with a conversation in place of a channel. Direct read is a read marker per user and conversation with the same rules as a channel's.

Migration `007_single_server.sql` moves a database with zero or one legacy workspace to this shape and keeps its rooms, channels, messages, read markers, mentions, and events. It strips legacy workspace IDs from stored event JSON and drops the legacy workspace tables. It refuses a database with more than one legacy workspace. Migration `009_password_only.sql` drops the tables and columns of the removed email, authenticator, passkey, device, and company login features. Migration `011_channel_kind.sql` gives every channel a required kind, backfills existing channels to `text`, and adds the same kind to stored `channel.created` event JSON. The column has no default, so every insert states its kind. Migration `012_direct_messages.sql` adds the direct tables and the nullable `event.audience`, which leaves every existing event open to all members.

Each server write locks the server row, checks membership, applies its mutation, advances the server cursor, inserts its event, and commits. Event cursors are decimal strings over the network. Database allocation follows commit order because the same row serializes mutations. A bare sequence or timestamp is insufficient.

The unique message key is the author and retry UUID. An identical retry returns the stored message. Reusing that key with another channel or body returns a conflict. Account or server switches never replay another account's pending messages.

Pending messages use a discriminated sending or failed state. Before the first HTTP send, the client persists the body and retry UUID in local storage under `huddle.outbox:<origin>:<userId>`, keyed by the canonical server origin and account ID. Each entry names its thread, a channel or a direct conversation, and a direct entry also keeps the peer's ID, so a first message can be retried after a reload even though the snapshot does not list a conversation with no messages. Entries stored in the older channel shape still load. Interrupted sends restore as failed and require an explicit retry with the same UUID. Session tokens never enter this storage. Confirmed messages have one source of truth. A send response may confirm a pending message but cannot advance the replay cursor.

## Direct messages

Any member can message any other member, one to one. There are no friend requests, group conversations, blocking, or deletion. A direct message's body, author, existence, and participants must never reach a third member.

Direct messages live in their own tables and endpoints rather than in a channel kind. No existing room query names those tables, so forgetting a filter on a room route cannot expose a private message. The one shared structure is the event log, where a direct event carries its two participants as its audience.

Every route that can return direct data is scoped to the caller:

- `GET /api/direct/messages`, `POST /api/direct/messages`, and `POST /api/direct/read` go through `requireConversation`, the only way direct code reaches a conversation by ID. It answers 404 with the same text whether the conversation does not exist or the caller is not in it.
- `POST /api/direct/conversations` finds or creates the caller's own pair. It emits no event. A conversation with no messages stays out of the snapshot, so the other person sees nothing until a message exists.
- `GET /api/snapshot` lists only the caller's conversations that have a message.
- The socket and replay share one query. `replay` filters on `audience IS NULL OR caller = ANY(audience)` in SQL, per caller, so a socket only ever sends what that caller may see. Every direct operation also checks membership.

A retry ID that belongs to another conversation or body is a conflict that returns no body.

Cursors stay global and share `server.cursor`, so a member sees gaps in event cursors. A gap lets a member infer that some private event happened and roughly when, and so count direct messages server-wide, but not who sent them or what they said. Sockets send empty frames only on their one-second tick, so a wakeup alone does not timestamp a private event. Keeping one cursor preserves commit-ordered replay and needs no per-user log.

A photo is readable by its owner, and by a member only while it is someone's current avatar, is on a channel message, or is on a direct message in that member's own conversation. That stops a kept photo from revealing that its owner sent a direct message. Event writes must name their audience, and the database rejects a `direct.*` event without one.

The bodies are stored unencrypted, so the host can read them with database access, and the interface says so at the start of each conversation. An admin's password reset also lets that admin sign in as a member and read that member's conversations. The member notices, because the reset ends their sessions and their password stops working. Avatars are account photos that any member can fetch by ID, and pruning keeps a photo while a direct message still shows it.

## Module ownership

- `apps/server` owns Start HTTP routes, Better Auth, application SQL, and the realtime server runtime.
- One server domain module owns member permissions and application transactions. Routes parse input and call it directly.
- One realtime module owns authentication, watch subscriptions, replay, session revalidation, bounded buffers, and disconnects. It cannot mutate application tables.
- `packages/ui` owns the shared React interface, browser transport and client synchronization.
- `apps/desktop` owns TanStack Router, the native transport, OS credential storage and the Tauri shell.
- `packages/contracts` owns network schemas and their inferred TypeScript types. It has no server secrets or database connections.

Validate configuration and incoming network data at boundaries. Use parameterized SQL. Keep framework wiring thin. Avoid repository, service, and controller layers that only forward arguments.

## Authentication

Better Auth runs directly in the Node-hosted Start server and stores its data in PostgreSQL. Browser pages use HttpOnly sessions. The initial local development frontend proxies `/api` to the server so browser cookies use one origin.

Native clients sign in with `account.signin` and use Better Auth's Bearer session support. Store the durable credential in the operating system credential store, scoped to the server's canonical origin. Do not put session tokens in browser localStorage. Clear credentials and active subscriptions on logout and server changes.

The only way to sign in is a username and password. Huddle sends no email. Revoking access means deleting Better Auth session rows. A deleted session fails HTTP checks, its watch tickets cascade away, and the realtime listener closes its socket on the next revalidation. See [accounts and sign-in](accounts.md) for limits and password resets.

Require HTTPS for remote servers. Permit HTTP only for loopback, which covers both local development and the desktop's pinned invite bridge. Enforce configured origins at auth, mutation, and socket boundaries. Credential changes must not reach a different server.

Setup creates the server. Until the server row exists, the access flow offers setup instead of sign-in. On each start before setup, the server generates a one-time code, stores only its HMAC hash with a 24-hour expiry, and prints the code to stdout. `SETUP_CODE` supplies the code instead and is not printed. `account.setup` creates the admin's login, the server row with its name, the admin member, and the join code in one transaction that consumes the setup code. After setup, setup is impossible.

A friend account comes from `account.join`, which compares the join code's hash in constant time, then creates the login and a `member` row in one transaction. A taken username returns 409. `account.signin` checks the password against the stored hash, or against a dummy hash for an unknown username. A password reset, by an admin or by `account:reset` on the server, replaces the hash and deletes the account's sessions. `password.change` checks the current password, replaces the hash, and deletes every other session in one transaction. Sign-in checks the password, creates the session, then rereads the hash under a share lock and drops the new session if a password change committed in between. `session.revoke` deletes one of the caller's other sessions, and `sessions.revoke-others` deletes all of them.

## Realtime contract

HTTP is the sole write and query API. The socket accepts only authentication and watch control frames. Do not implement chat commands or correlated mutation acknowledgements on the socket.

The initial snapshot returns the server, rooms, channels, the caller's unread and mention counts, the caller's direct conversations, and an exact event cursor from one consistent database snapshot. The client increments unread counts from live events after that cursor. Channel history supports ordered pagination. The client then watches events after the snapshot cursor. Every change is replayable from PostgreSQL to the members in its audience, including a channel created while a client was disconnected.

The server sends committed event pages in cursor order. PostgreSQL NOTIFY delivers post-commit wakeups to the companion listener. A periodic database check recovers a missed wakeup even when a socket stays connected. Each batch revalidates the session and membership. Slow clients disconnect with a retryable reason. The client advances its replay cursor only after applying a complete page and merges history and live messages by stable IDs.

Reconnection starts a new authorized watch from the applied cursor. A server crash between commit and broadcast cannot lose data. Initial implementation need not persist a cursor across desktop launches. A fresh snapshot avoids advancing beyond locally retained state.

## Synthesis decision

Use the socket candidate's durable event log and transactionally ordered cursor as the base. Graft the HTTP candidate's explicit mutation and query boundary. Keep the socket watch-only. This removes request correlation and custom socket command errors without weakening replay.

Both candidates recommended OS credential storage. Keep that shared choice.

Superseded: "Reject singleton bootstrap and setup-secret enrollment because user-owned workspaces plus explicit invitations establish a smaller, testable authorization model."

On 2026-10-09 this decision was reversed. A self-hosted company server serves one team. Per-user workspaces let anyone who reached the server create an account and a workspace. A singleton server row plus a one-time setup code gives the operator a bootstrap path outside the web interface. The server stores only the code's hash, expires it after 24 hours, and prints it to the operator's log, so no first visitor can claim the server. Email invitations bind access to a verified address instead of a bearer code that anyone holding it could redeem.

On 2026-10-29 Huddle moved from company teams to groups of friends. Friends rarely share an SMTP relay or a domain with a certificate. A pinned invite replaces both. It carries the address, so friends type nothing. Its certificate pin replaces a certificate authority. Its join code admits a new account without email. The join code is a bearer secret, which the 2026-10-09 decision rejected for company servers. For a group of friends, the host decides who receives the invite, and the server cannot rotate the code yet.

On 2026-11-01 Huddle removed email entirely. No friend group should need a mail server to chat. Email codes were also the only way into authenticator (TOTP) enrollment and recovery codes, so those went too. The person who runs the server resets passwords from the command line instead.

Later on 2026-11-01 Huddle dropped company login, passkeys, and native device approval. Friends do not have a company identity provider, and one sign-in method is easier to explain and to secure. The desktop signs in with a password directly. An admin resets a forgotten password and sends it to the friend.

The independent cross-judge agreed with this synthesis. Candidate evidence is in the local task audit; production code and tests must prove the contracts here.

## Tradeoffs

We accept a server row lock and event table in exchange for commit-ordered replay. We accept a single application instance in exchange for an initial installation without Redis or Kafka.

Voice calls, video, file uploads, message editing, and mobile clients are follow-up slices. The interface must not pretend those features work, so a voice channel opens to a notice with no call controls. LiveKit remains the planned media service.

## Verification

Use real PostgreSQL and Better Auth to verify anonymous rejection, a required single-use setup code, rejection of a second setup, joining with the join code, rejection of a certificate that does not match the invite's pin, admin-only invites and password resets, the command-line password reset, two-client delivery, retry deduplication and conflicting retries, a third member finding no trace of a direct message in any route, concurrent commit ordering, snapshot/watch overlap, session revocation, sign-in rate limits, missed-wakeup recovery, and persistence after server restart.

Drive the interface through server setup, room and channel creation, a shared invite, the friend's account creation, message send, reconnect, and logout. Sign in from the desktop with a password and keep its token in the OS credential store.

Typecheck and build both JavaScript applications. Compile and launch Tauri on macOS. Windows and Linux remain unverified unless this session obtains those environments.

## Implementation reconciliation

The Start production fetch handler runs in a Node HTTP service with a companion WebSocket listener on a separately configured port. The friend listener on `FRIEND_PORT` serves the API handler and WebSocket upgrades over its self-signed TLS, and publishes its LAN and NAT-PMP addresses for the invite list. PostgreSQL NOTIFY crosses the framework bundle boundary; a one-second poll remains the recovery mechanism. Watch tickets bridge browser cookie host scoping and native authentication without exposing browser session tokens. PostgreSQL migrations own ticket persistence. The server serves the shared browser application. The local desktop frontend uses the Vite API proxy for the default local server. The native client selects its server at runtime and stores credentials through Rust keyring commands.
