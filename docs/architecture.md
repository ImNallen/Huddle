# Huddle's first working slice

## Problem

Build a desktop client and self-hosted server that let a team sign in, create a workspace, invite a colleague, and exchange persistent text messages. Desktop uses Tauri 2, React, and TanStack Router. The server uses TanStack Start, Better Auth, and PostgreSQL. Convex is excluded.

## Usage

Start PostgreSQL, apply migrations, and start the server and desktop frontend. Connect the desktop to the company server URL. Create an account, create a private workspace, and create a channel. An owner generates an invitation code that a signed-in colleague can redeem. Signing up or using company OIDC never automatically grants access to an existing workspace.

The desktop sends explicit HTTP requests for application operations. It opens an authenticated WebSocket to watch workspace events. An authenticated HTTP POST to `/api/watch-ticket` returns a one-use, 30-second opaque ticket. The database stores only the ticket hash and its Better Auth session ID. The initial watch frame carries this ticket, which the realtime listener consumes atomically. Native bearer tokens are also accepted in a watch frame. No credential appears in a WebSocket URL. It never imports Start server functions.

```ts
const workspace = await client.createWorkspace({ name: 'Studio' })
const room = await client.createRoom({ workspaceId: workspace.id, name: 'Studio' })
const channel = await client.createChannel({ roomId: room.id, name: 'general' })
await client.watchWorkspace({ workspaceId: workspace.id, after: snapshot.cursor })
await client.sendMessage({
  channelId: channel.id,
  retryId: crypto.randomUUID(),
  body: 'Hello team',
})
```

These are caller-facing responsibilities. Implementation may use an HTTP client plus a dedicated watch connection instead of a single class.

## Data shape

Better Auth owns users, sessions and linked company accounts. Huddle owns staged authentication ceremonies, session proofs, factors, recovery and device grants, alongside these application tables:

- Workspace has an owner-created identity, a name, and a transactionally updated event cursor.
- Membership associates a user and workspace with an owner or member role.
- Room belongs to a workspace and has a case-insensitively unique name within it. Every member sees every room.
- Channel belongs to a room and has a unique normalized name within it. It also records its workspace, and a composite foreign key keeps the two consistent.
- Message has an author, channel, body, stable retry UUID, and committed event cursor.
- WorkspaceEvent records each public workspace change at its cursor.
- Invitation stores a hash of an opaque random code, expiry, and consumption state.
- A read marker stores, per user and channel, the highest cursor that user has read. It only moves forward and never passes the workspace cursor. Read state is private, so it emits no workspace event.
- A mention records which members a message names with `@` followed by their full or first name.

Each workspace write locks the workspace row, checks membership, applies its mutation, advances the workspace cursor, inserts its event, and commits. Event cursors are decimal strings over the network. Database allocation follows commit order because the same row serializes mutations. A bare sequence or timestamp is insufficient.

The unique message key is the author and retry UUID. An identical retry returns the stored message. Reusing that key with another channel or body returns a conflict. Account or server switches never replay another account's pending messages.

Pending messages use a discriminated sending or failed state. Before the first HTTP send, the client persists the body and retry UUID in local storage under the canonical server origin, account ID, and workspace ID. Interrupted sends restore as failed and require an explicit retry with the same UUID. Session tokens never enter this storage. Confirmed messages have one source of truth. A send response may confirm a pending message but cannot advance the workspace replay cursor.

## Module ownership

- `apps/server` owns Start HTTP routes, Better Auth, application SQL, and the realtime server runtime.
- One server domain module owns workspace permissions and application transactions. Routes parse input and call it directly.
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

Require HTTPS for remote company servers. Permit HTTP only for explicit loopback development. Enforce configured origins at auth, mutation, and socket boundaries. Credential changes must not reach a different server. Workspace permissions remain in Huddle, independently of login providers.

An invitation is an explicit, expiring possession grant. Creation requires workspace ownership. Redeeming it atomically consumes the code and creates membership for the authenticated user. Email or a company domain alone cannot grant access. Multiple isolated workspaces are supported rather than a global first-user administrator.

## Realtime contract

HTTP is the sole write and query API. The socket accepts only authentication and workspace-watch control frames. Do not implement chat commands or correlated mutation acknowledgements on the socket.

The initial workspace snapshot returns rooms, channels, the caller's unread counts, and an exact event cursor from one consistent database snapshot. The client increments unread counts from live events after that cursor. Channel history supports ordered pagination. The client then watches events after the snapshot cursor. Every public change is replayable from PostgreSQL, including a channel created while a client was disconnected.

The server sends committed event pages in cursor order. PostgreSQL NOTIFY delivers post-commit wakeups to the companion listener. A periodic database check recovers a missed wakeup even when a socket stays connected. Each batch revalidates the session and workspace access. Slow clients disconnect with a retryable reason. The client advances its replay cursor only after applying a complete page and merges history and live messages by stable IDs.

Reconnection starts a new authorized watch from the applied cursor. A server crash between commit and broadcast cannot lose data. Initial implementation need not persist a cursor across desktop launches. A fresh snapshot avoids advancing beyond locally retained state.

## Synthesis decision

Use the socket candidate's durable workspace event log and transactionally ordered cursor as the base. Graft the HTTP candidate's explicit mutation and query boundary. Keep the socket watch-only. This removes request correlation and custom socket command errors without weakening replay.

Both candidates recommended native Device Authorization and OS credential storage. Keep those shared choices. Reject singleton bootstrap and setup-secret enrollment because user-owned workspaces plus explicit invitations establish a smaller, testable authorization model.

The independent cross-judge agreed with this synthesis. Candidate evidence is in the local task audit; production code and tests must prove the contracts here.

## Tradeoffs

We accept a workspace row lock and event table in exchange for commit-ordered replay. We accept a single application instance in exchange for an initial installation without Redis or Kafka. Native device approval has an extra confirmation step but avoids a custom credential callback protocol.

Voice, video, file uploads, message editing, and mobile clients are follow-up slices. The interface must not pretend those features work. LiveKit remains the planned media service.

## Verification

Use real PostgreSQL and Better Auth to verify anonymous rejection, cross-workspace isolation, invitation redemption, two-client delivery, retry deduplication and conflicting retries, concurrent commit ordering, snapshot/watch overlap, session revocation, missed-wakeup recovery, and persistence after server restart.

Drive the interface through account creation, sign-in, workspace and channel creation, an invitation, message send, reconnect, and logout. Exercise native device approval with local browser login. A signed local OIDC fixture verifies company callbacks and rejection paths. Customer identity providers still require release testing.

Typecheck and build both JavaScript applications. Compile and launch Tauri on macOS. Windows and Linux remain unverified unless this session obtains those environments.

## Implementation reconciliation

The Start production fetch handler runs in a Node HTTP service with a companion WebSocket listener on a separately configured port. PostgreSQL NOTIFY crosses the framework bundle boundary; a one-second poll remains the recovery mechanism. Watch tickets bridge browser cookie host scoping and native authentication without exposing browser session tokens. PostgreSQL migrations own ticket persistence. The server serves the shared browser application and device approval pages. The local desktop frontend uses the Vite API proxy for the default local server. The native client selects its server at runtime and stores credentials through Rust keyring commands.
