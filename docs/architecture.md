# Huddle's first working slice

## Problem

Build a desktop client and self-hosted server that let a team set up its server, invite colleagues by email, and exchange persistent text messages. One server holds one team. Desktop uses Tauri 2, React, and TanStack Router. The server uses TanStack Start, Better Auth, and PostgreSQL. Convex is excluded.

## Usage

Start PostgreSQL, apply migrations, and start the server and desktop frontend. Connect the desktop to the company server URL. The operator onboards the server with the setup code from the server log, a server name, and the admin's email. The admin creates rooms and channels and invites colleagues by email. An invited colleague signs in with the invited address and joins as a member. Accounts come only from onboarding or an invitation. Company OIDC never grants access without an invitation.

The desktop sends explicit HTTP requests for application operations. It opens an authenticated WebSocket to watch server events. An authenticated HTTP POST to `/api/watch-ticket` returns a one-use, 30-second opaque ticket. The database stores only the ticket hash and its Better Auth session ID. The initial watch frame carries this ticket, which the realtime listener consumes atomically. Native bearer tokens are also accepted in a watch frame. No credential appears in a WebSocket URL. It never imports Start server functions.

```ts
const room = await client.createRoom({ name: 'Studio' })
const channel = await client.createChannel({ roomId: room.id, name: 'general' })
await client.invite({ email: 'colleague@example.com' })
await client.watchServer({ after: snapshot.cursor })
await client.sendMessage({
  channelId: channel.id,
  retryId: crypto.randomUUID(),
  body: 'Hello team',
})
```

These are caller-facing responsibilities. Implementation may use an HTTP client plus a dedicated watch connection instead of a single class.

## Data shape

Better Auth owns users, sessions and linked company accounts. Huddle owns staged authentication ceremonies, session proofs, factors, recovery and device grants, alongside these application tables:

- Server holds at most one row, enforced by a boolean `singleton` primary key. It stores the server name chosen at onboarding and a transactionally updated event cursor.
- Member gives a user an `admin` or `member` role on the server, one row per user. Only admins invite people and create rooms and channels.
- Room has a case-insensitively unique name on the server. Every member sees every room.
- Channel belongs to a room and has a unique normalized name within it.
- Message has an author, channel, body, stable retry UUID, and committed event cursor.
- Event records each public server change at its cursor.
- Invitation is keyed by a lowercase email address. It records the inviting admin, an expiry, and who accepted it and when.
- SetupCode holds at most one row, with an HMAC hash of the one-time setup code and its expiry.
- A read marker stores, per user and channel, the highest cursor that user has read. It only moves forward and never passes the server cursor. Read state is private, so it emits no event.
- A mention records which members a message names with `@` followed by their full or first name.

Migration `007_single_server.sql` moves a database with zero or one legacy workspace to this shape and keeps its rooms, channels, messages, read markers, mentions, and events. It strips legacy workspace IDs from stored event JSON and drops the legacy workspace tables. It refuses a database with more than one legacy workspace.

Each server write locks the server row, checks membership, applies its mutation, advances the server cursor, inserts its event, and commits. Event cursors are decimal strings over the network. Database allocation follows commit order because the same row serializes mutations. A bare sequence or timestamp is insufficient.

The unique message key is the author and retry UUID. An identical retry returns the stored message. Reusing that key with another channel or body returns a conflict. Account or server switches never replay another account's pending messages.

Pending messages use a discriminated sending or failed state. Before the first HTTP send, the client persists the body and retry UUID in local storage under `huddle.outbox:<origin>:<userId>`, keyed by the canonical server origin and account ID. Interrupted sends restore as failed and require an explicit retry with the same UUID. Session tokens never enter this storage. Confirmed messages have one source of truth. A send response may confirm a pending message but cannot advance the replay cursor.

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

Native clients use Better Auth's Bearer session support. Store the durable credential in the operating system credential store, scoped to the canonical company server. Do not put session tokens in browser localStorage. Clear credentials and active subscriptions on logout and server changes.

Company login uses an environment-configured Generic OAuth OIDC provider with signed ID-token verification. Huddle owns native device authorization. The desktop displays a code, opens the server approval page in the system browser, and polls at the server's interval. The approval page requires an admitted session, displays the code and Huddle client name, and requires explicit approval or denial. The resulting credential is a Better Auth session token with a Huddle proof.

Local email sign-in requires TOTP enrollment or verification before application access. Passkeys require user verification and bypass TOTP. Account epochs revoke stale HTTP, socket, watch-ticket and device authority after sensitive changes. See [passwordless authentication](passwordless.md) for the full assurance and recovery model.

Require HTTPS for remote company servers. Permit HTTP only for explicit loopback development. Enforce configured origins at auth, mutation, and socket boundaries. Credential changes must not reach a different server. Member roles and permissions remain in Huddle, independently of login providers.

Onboarding creates the server. Until the server row exists, the access flow offers setup instead of sign-in. On each start before onboarding, the server generates a one-time code, stores only its HMAC hash with a 24-hour expiry, and prints the code to stdout. `SETUP_CODE` supplies the code instead and is not printed. Verifying the admin's email creates the user, the server row with its name, and the admin member in one transaction that consumes the code. With company OIDC configured, the company identity that completes login with the setup code becomes the admin instead. After onboarding, setup is impossible.

An invitation binds access to a verified email address. Creation requires the admin role. Invitations expire after 7 days. Inviting the same address again restarts that period and resends the email. Inviting an existing member returns 409. Verifying the invited address, by email code or by company login with that email, creates the user and a `member` row and marks the invitation accepted in one transaction. An existing account without membership accepts its invitation at its next sign-in. For an uninvited address without an account, `email.send` shows the same email step but sends a no-account email with no code. A new company identity without an invitation is rejected before Better Auth creates a user. A company domain alone cannot grant access.

## Realtime contract

HTTP is the sole write and query API. The socket accepts only authentication and watch control frames. Do not implement chat commands or correlated mutation acknowledgements on the socket.

The initial snapshot returns the server, rooms, channels, the caller's unread counts, and an exact event cursor from one consistent database snapshot. The client increments unread counts from live events after that cursor. Channel history supports ordered pagination. The client then watches events after the snapshot cursor. Every public change is replayable from PostgreSQL, including a channel created while a client was disconnected.

The server sends committed event pages in cursor order. PostgreSQL NOTIFY delivers post-commit wakeups to the companion listener. A periodic database check recovers a missed wakeup even when a socket stays connected. Each batch revalidates the session and membership. Slow clients disconnect with a retryable reason. The client advances its replay cursor only after applying a complete page and merges history and live messages by stable IDs.

Reconnection starts a new authorized watch from the applied cursor. A server crash between commit and broadcast cannot lose data. Initial implementation need not persist a cursor across desktop launches. A fresh snapshot avoids advancing beyond locally retained state.

## Synthesis decision

Use the socket candidate's durable event log and transactionally ordered cursor as the base. Graft the HTTP candidate's explicit mutation and query boundary. Keep the socket watch-only. This removes request correlation and custom socket command errors without weakening replay.

Both candidates recommended native Device Authorization and OS credential storage. Keep those shared choices.

Superseded: "Reject singleton bootstrap and setup-secret enrollment because user-owned workspaces plus explicit invitations establish a smaller, testable authorization model."

On 2026-10-09 this decision was reversed. A self-hosted company server serves one team. Per-user workspaces let anyone who reached the server create an account and a workspace. A singleton server row plus a one-time setup code gives the operator a bootstrap path outside the web interface. The server stores only the code's hash, expires it after 24 hours, and prints it to the operator's log, so no first visitor can claim the server. Email invitations bind access to a verified address instead of a bearer code that anyone holding it could redeem.

The independent cross-judge agreed with this synthesis. Candidate evidence is in the local task audit; production code and tests must prove the contracts here.

## Tradeoffs

We accept a server row lock and event table in exchange for commit-ordered replay. We accept a single application instance in exchange for an initial installation without Redis or Kafka. Native device approval has an extra confirmation step but avoids a custom credential callback protocol.

Voice, video, file uploads, message editing, and mobile clients are follow-up slices. The interface must not pretend those features work. LiveKit remains the planned media service.

## Verification

Use real PostgreSQL and Better Auth to verify anonymous rejection, a required single-use setup code, rejection of a second onboarding, the no-account email for an uninvited address, rejection of an uninvited company identity, joining by invited email and invited company identity, admin-only invitations, invitation refresh after expiry, two-client delivery, retry deduplication and conflicting retries, concurrent commit ordering, snapshot/watch overlap, session revocation, missed-wakeup recovery, and persistence after server restart.

Drive the interface through server onboarding, room and channel creation, an email invitation, the invited colleague's sign-in, message send, reconnect, and logout. Exercise native device approval with local browser login. A signed local OIDC fixture verifies company callbacks and rejection paths. Customer identity providers still require release testing.

Typecheck and build both JavaScript applications. Compile and launch Tauri on macOS. Windows and Linux remain unverified unless this session obtains those environments.

## Implementation reconciliation

The Start production fetch handler runs in a Node HTTP service with a companion WebSocket listener on a separately configured port. PostgreSQL NOTIFY crosses the framework bundle boundary; a one-second poll remains the recovery mechanism. Watch tickets bridge browser cookie host scoping and native authentication without exposing browser session tokens. PostgreSQL migrations own ticket persistence. The server serves the shared browser application and device approval pages. The local desktop frontend uses the Vite API proxy for the default local server. The native client selects its server at runtime and stores credentials through Rust keyring commands.
