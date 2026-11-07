# Private group chat

A named group starts with the creator and at least two other server members. Any current member can add people or leave. Groups hold up to 32 people and remain usable after shrinking below three. Added people can read earlier messages; the add dialog explains this before submission. Empty groups appear immediately. A group with no members retains inaccessible history.

## Callers and ownership

The creation dialog calls `sync.createGroup({ retryId, name, others })` and opens the returned group thread, if still authorized. A group thread carries `{ kind: 'group', id, admission }`. The shared Transcript calls `sync.send` with that captured thread. The member dialog calls `sync.addGroupPeople(thread, ids)` or `sync.leaveGroup(thread)`.

Contracts own validated wire schemas. `domain.ts` owns transactions, the server-row lock, event publication, group membership and authorization. Group operations use separate conversation, membership and message tables. Existing direct-message tables, IDs, API shapes and stored events remain intact. Snapshot adds `groups`; events add group metadata, messages and minimal removals.

`chat.ts` owns thread and pending-message types. `groupState.ts` owns all retained group metadata, admissions, history, unread counts, drafts and pending messages. `useServer` applies observations and adapts HTTP, sockets and storage to that owner. Components render the resulting state and submit commands. Existing channel and DM runtime state stays in `useServer` to preserve its established behavior.

## Admission and replay

Each membership's admission is the global event cursor when it was created. Other people's membership changes preserve that admission; leaving and rejoining replaces it. Every group operation, including history and read markers, names its admission. Mutations authorize the exact current admission under the existing server-row lock, before examining retries. A delayed old leave, send or read cannot borrow a later membership.

Group events have both an original audience and a group ID. Replay filters by original audience, current membership and event cursor at or after the current admission before applying the page limit. The minimal removal event is addressed only to the leaver and remains replayable after departure. Authorized HTTP history returns the full message history. Snapshots and complete metadata events establish empty groups and new admissions without rewinding the socket cursor.

Create retries compare the immutable original name and sorted participant set and require current membership before returning anything. Message retries also compare the original author's admission. Read markers only update existing membership rows and never recreate access. Group message photos require current membership; retention preserves referenced photos even when no group members remain.

The client keeps observation versions and an ended-admission cutoff. Snapshot absence, a removal event or a 404 ends the captured admission. Positive metadata cannot revive it; a later admission can. History, send results, drafts and stored outbox entries never establish access. Revocation clears memory even when storage writes fail. On startup, outbox entries survive only if the authoritative snapshot contains the exact admission. Already authorized responses can finish after departure; their client merge is fenced by admission.

## Synthesis and alternatives

The architecture comparison selected separate group storage, an admission-bearing thread and a single group-state owner. This keeps the existing pair model intact and makes the membership behind every queued command explicit.

A unified private-conversation table could preserve DM JSON through adapters while migrating pairs and messages into a direct/group sum. It requires migration and compatibility work throughout existing DM authorization and events. Separate tables make the compatibility boundary smaller for this feature. Local cancellation without server admissions loses because an old command can reach the server after a re-add. A separate group-domain service was rejected because exporting lock/event internals would split transaction ownership.

## Implementation reconciliation

The implementation owner accepted a local change to the selected sketch: isolate the group reducer instead of moving existing channel and DM caches and drafts into it. All group representations still have one owner; this reduces risk to existing outbox restoration. Shared types live in `chat.ts`, avoiding a runtime cycle between the hook and reducer. The domain retains transaction and publication ownership. New checks cover real scratch-database authorization and replay, server restart, membership changes and production UI behavior alongside the unchanged DM suite.

HTTP history and send results retain the existing array/message response shape. The hook captures the requested admission and checks it before merging, so these responses do not need to echo an admission. HTTP metadata summaries initialize new admissions; same-admission command responses preserve unread counts already advanced by live events. Authoritative snapshots replace read state and set the replay coverage cursor.
