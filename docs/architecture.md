# Huddle's first working slice

## Problem

Build a desktop client and self-hosted server that let a team sign in, create a workspace, invite a colleague, and exchange persistent text messages. Desktop uses Tauri 2, React, and TanStack Router. The server uses TanStack Start, Better Auth, and PostgreSQL. Convex is excluded.

## Usage

Start PostgreSQL, apply migrations, and start the server and desktop frontend. Connect the desktop to the company server URL. Create an account, create a private workspace, and create a channel. An owner generates an invitation code that a signed-in colleague can redeem. Signing up or using company OIDC never automatically grants access to an existing workspace.

The desktop sends explicit HTTP requests for application operations. It opens an authenticated WebSocket to watch workspace events. It never imports Start server functions.

```ts
const workspace = await client.createWorkspace({ name: 'Studio' })
const channel = await client.createChannel({ workspaceId: workspace.id, name: 'general' })
await client.watchWorkspace({ workspaceId: workspace.id, after: snapshot.cursor })
await client.sendMessage({ channelId: channel.id, retryId: crypto.randomUUID(), body: 'Hello team' })
```

These are caller-facing responsibilities. Implementation may use an HTTP client plus a dedicated watch connection instead of a single class.

## Data shape

Better Auth owns credentials, sessions, linked accounts, verification, and device authorization. Huddle owns these tables:

- Workspace has an owner-created identity, a name, and a transactionally updated event cursor.
- Membership associates a user and workspace with an owner or member role.
- Channel belongs to a workspace and has a unique normalized name within it.
- Message has an author, channel, body, stable retry UUID, and committed event cursor.
- WorkspaceEvent records each public workspace change at its cursor.
- Invitation stores a hash of an opaque random code, expiry, and consumption state.

Each workspace write locks the workspace row, checks membership, applies its mutation, advances the workspace cursor, inserts its event, and commits. Event cursors are decimal strings over the network. Database allocation follows commit order because the same row serializes mutations. A bare sequence or timestamp is insufficient.

The unique message key is the author and retry UUID. An identical retry returns the stored message. Reusing that key with another channel or body returns a conflict. Account or server switches never replay another account's pending messages.

Pending messages use a discriminated state such as queued, sending, or failed. Confirmed messages have one source of truth. A send response may confirm a pending message but cannot advance the workspace replay cursor.

## Module ownership

- `apps/server` owns Start HTTP routes, Better Auth, application SQL, and the realtime server runtime.
- One server domain module owns workspace permissions and application transactions. Routes parse input and call it directly.
- One realtime module owns authentication, watch subscriptions, replay, session revalidation, bounded buffers, and disconnects. It cannot mutate application tables.
- `apps/desktop` owns the shared React interface, TanStack Router, client synchronization, and the Tauri shell.
- `packages/contracts` owns network schemas and their inferred TypeScript types. It has no server secrets or database connections.

Validate configuration and incoming network data at boundaries. Use parameterized SQL. Keep framework wiring thin. Avoid repository, service, and controller layers that only forward arguments.

## Authentication

Better Auth runs directly in the Node-hosted Start server and stores its data in PostgreSQL. Browser pages use HttpOnly sessions. The initial local development frontend proxies `/api` to the server so browser cookies use one origin.

Native clients use Better Auth's Bearer session support. Store the durable credential in the operating system credential store, scoped to the canonical company server. Do not put session tokens in browser localStorage. Clear credentials and active subscriptions on logout and server changes.

Company login uses an environment-configured Generic OAuth OIDC provider. Native browser login uses Better Auth's first-party Device Authorization flow. The desktop displays a code, opens the server approval page in the system browser, and polls at the server's interval. The approval page requires login, displays the code and Huddle client name, and requires explicit approval or denial. The resulting credential is a Better Auth session token, not a custom OAuth refresh token.

Require HTTPS for remote company servers. Permit HTTP only for explicit loopback development. Enforce configured origins at auth, mutation, and socket boundaries. Credential changes must not reach a different server. Workspace permissions remain in Huddle, independently of login providers.

An invitation is an explicit, expiring possession grant. Creation requires workspace ownership. Redeeming it atomically consumes the code and creates membership for the authenticated user. Email or a company domain alone cannot grant access. Multiple isolated workspaces are supported rather than a global first-user administrator.

## Realtime contract

HTTP is the sole write and query API. The socket accepts only authentication and workspace-watch control frames. Do not implement chat commands or correlated mutation acknowledgements on the socket.

The initial workspace snapshot returns channels and an exact event cursor from one consistent database snapshot. Channel history supports ordered pagination. The client then watches events after the snapshot cursor. Every public change is replayable from PostgreSQL, including a channel created while a client was disconnected.

The server sends committed event pages in cursor order. Post-commit wakeups reduce latency. A periodic database check recovers a missed wakeup even when a socket stays connected. Each batch revalidates the session and workspace access. Slow clients disconnect with a retryable reason. The client advances its replay cursor only after applying a complete page and merges history and live messages by stable IDs.

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

Drive the interface through account creation, sign-in, workspace and channel creation, an invitation, message send, reconnect, and logout. Exercise native device approval with local browser login. Company OIDC configuration is supported, but real company login remains unverified until credentials or a genuine local provider fixture are available.

Typecheck and build both JavaScript applications. Compile and launch Tauri on macOS. Windows and Linux remain unverified unless this session obtains those environments.

## Implementation reconciliation

No implementation yet. Keep accepted interface and behavior changes in this section and update their corresponding contracts above before the next unit starts.
