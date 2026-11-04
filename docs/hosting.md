# Host a Huddle server

This page covers configuration beyond the basic setup in the [README](../README.md).

## Ports and the friend key

The server runs three listeners in one Node process:

- `PORT`, default 3000, serves the API, the login pages, and the browser app.
- `WS_PORT`, default 3001, serves WebSockets.
- `FRIEND_PORT`, default `PORT + 1000`, serves the API and WebSockets to friends over TLS.

Configure `PORT`, `WS_PORT`, `WS_PUBLIC_URL`, and `FRIEND_PORT` together if you change ports. `FRIEND_PORT` must differ from the other two.

On first start, the server creates a TLS key and self-signed certificate in `apps/server/data/friend/<port>/`. Every invite pins that certificate. If you delete the folder, the server makes a new key, every old invite stops working, and you must share new invites.

## How invites find your server

Huddle builds one invite for each address a friend could use:

- Each private IPv4 address of the host, for friends on the same network. This includes `100.64.0.0/10` addresses such as Tailscale's.
- The router's public address, when the router accepts a NAT-PMP port mapping. The server renews the mapping before it expires. It finds the router only on macOS and Linux hosts.

Forwarding the friend port by hand does not add an invite, because Huddle has no setting for a public address yet. Without NAT-PMP, use Tailscale or a similar network.

## Run in Docker

Docker invites do not work for friends yet. Inside the container, the server sees only the container's network, so it lists the container's `172.x` address and cannot reach your router for NAT-PMP. Run the server directly on the host to invite friends.

```sh
docker compose up -d db
docker compose run --build --rm server node --import tsx scripts/migrate.ts
docker compose up -d server
curl --fail http://localhost:3000/api/health
docker compose logs server
```

Compose publishes port 4000 on every host interface and binds 3000 and 3001 to loopback. The friend key lives in the container under `/app/apps/server/data/friend/4000/` and is not on a volume, so recreating the container breaks every invite.

## Upgrade

PostgreSQL data lives in the `postgres-data` volume. Back it up before you upgrade. Run `pnpm db:migrate` before you start the new server.

Migrations are transactional and tracked in `huddle_migration`. Migration `007_single_server.sql` converts a database from the earlier workspace design. It keeps rooms, channels, messages, read markers, mentions, and events from zero or one workspace, and fails on a database with more than one. To start over from such a database, drop and recreate it, run the migrations, and set up the server again.

Migration `011_channel_kind.sql` marks every existing channel as a text channel. Rooms, channels, and messages are otherwise unchanged. Channels are text or voice, and voice channels carry no audio yet.

## Open Huddle in a browser from other machines

Friends need only the friend port. To also use the browser app from elsewhere, put an HTTPS reverse proxy in front of the server:

- Proxy normal HTTP requests to port 3000 and WebSocket upgrades to port 3001.
- Set `SERVER_URL`, for example `https://chat.example.com`, and `WS_PUBLIC_URL`, for example `wss://events.example.com/`. An HTTPS server requires a WSS endpoint.
- Allow long proxy idle timeouts, so WebSocket connections stay open.
- Set `TRUSTED_ORIGINS` to the exact browser origins you serve plus `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost`. Do not use wildcards.

The desktop app also accepts an HTTPS server address instead of an invite. It allows plain HTTP only for localhost. Desktop sign-in tokens live in the OS credential store.

## Reset a forgotten password

Huddle sends no email, so password resets go through people. An admin resets a friend's password on the **Members** page. If you run the server and forget your own password, reset it from the repository:

```sh
pnpm --filter @huddle/server account:reset USERNAME
```

The command asks for the new password and signs that account out everywhere. See [accounts and sign-in](accounts.md) for details.
