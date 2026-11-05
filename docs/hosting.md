# Host a Huddle server

This page covers configuration beyond the basic setup in the [README](../README.md). Every remote connection goes through `tailscale serve`, which provides the address, a trusted certificate, and each person's identity.

## Keep the machine to Huddle

Run nothing else on the machine or in the container. The server cannot tell Serve from another local process, so any process that can reach its loopback port can claim to be any member. A browser on that machine cannot forge the `Host` header, and the server checks it, but a local program can. Give Huddle its own LXC, VM, or sidecar network namespace.

## Never use userspace networking

Run Tailscale with a TUN device. In userspace mode, `tailscaled` forwards a peer's direct connection to the node's IP onto `127.0.0.1`, past Serve. Any peer your access policy allows could then reach the server's ports and claim to be any member. The server refuses to start when the `tailscale` command reports userspace mode. `compose.yaml` pins kernel networking for its sidecar.

As a second layer, let friends reach only port 443 on this machine in your tailnet's access policy.

Run `pnpm --filter @huddle/server test:serve <address>` on the machine to check all of this.

## Publish the server with Serve

The server listens on two loopback ports, and both addresses are hard-coded to `127.0.0.1`:

- `PORT`, default 3000, serves the API and the browser app.
- `WS_PORT`, default 3001, serves WebSockets.

Serve publishes both under one HTTPS address. Serve strips `/events`, so the WebSocket listener sees `/`.

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve --bg --https=443 --set-path=/events http://127.0.0.1:3001
```

Set `SERVER_URL` to the exact address that Serve publishes, such as `https://huddle.your-tailnet.ts.net`. `WS_PUBLIC_URL` defaults to `wss://` plus that host plus `/events`. If you change a port, change the Serve commands to match. The server treats any request whose `Host` is not one of these two addresses as having no identity, so a wrong `SERVER_URL` shows every visitor the **Open Huddle through Tailscale** screen.

Do not turn on Funnel, because Funnel traffic has no identity. Do not mount another app on this address with `--set-path`. That app would share Huddle's origin, and its pages could act as anyone who opens them.

## Trust only your own origins

The server accepts browser requests from `SERVER_URL` and from the desktop app's two origins, `tauri://localhost` and `https://tauri.localhost`. `TRUSTED_ORIGINS` is for development. On an HTTPS server, the server refuses to start if `TRUSTED_ORIGINS` lists a plain HTTP or loopback origin, because any page on a tailnet device acts as that device's person.

## Run on a Proxmox LXC or VM

1. Install Tailscale, Node.js 24, pnpm 11, and PostgreSQL or Docker.
2. For an LXC, pass through `/dev/net/tun`. In the Proxmox interface, add it under the container's **Resources** as **Device Passthrough**, then restart the container. A VM needs nothing extra.
3. Run `tailscale up`, and turn on HTTPS certificates in your tailnet's DNS settings.
4. Follow the commands in the [README](../README.md). To use your own PostgreSQL instead of Docker, edit `DATABASE_URL` in `.env`.
5. Run the server from a systemd unit as a dedicated user. From `apps/server`, the command is `node --env-file=../../.env --import tsx runtime/production.ts`.

## Run in Docker with a Tailscale sidecar

`compose.yaml` runs the server in the network namespace of a `tailscale` container. The two share loopback, and that mode cannot publish a port. The sidecar uses kernel networking, so it needs `/dev/net/tun` and `NET_ADMIN`. Inside an LXC, pass the device through first. `deploy/tailscale/serve.json` holds the Serve configuration.

```sh
pnpm setup:local --server-url https://huddle.your-tailnet.ts.net
echo TS_AUTHKEY=tskey-your-key >> .env
docker compose up -d db tailscale
docker compose run --build --rm server node --import tsx scripts/migrate.ts
docker compose up -d server
docker compose logs server
```

If the sidecar restarts on its own, run `docker compose restart server`, because the server's network goes with the sidecar. The sidecar's node is named `huddle`, so `SERVER_URL` must use that name. Without `TS_AUTHKEY`, run `docker compose logs tailscale` and open the login link it prints. Use an auth key for a person rather than a tagged key until you confirm that sharing a tagged machine works for your tailnet.

Compose publishes only PostgreSQL, on `127.0.0.1:5434`, for migrations from the host.

## Give friends access in Tailscale

Share the machine with a friend, or add them to your tailnet. A shared machine appears in the friend's tailnet under its own name, and it cannot start connections to them. ACLs can target the friend's email.

Whether Serve reports a friend's own login for a machine shared into their tailnet is not verified. Try it with one friend first. If Serve reports nothing, that friend sees the screen for a device with no user, and they need to join your tailnet instead.

## Upgrade

PostgreSQL data lives in the `postgres-data` volume. Back it up before you upgrade. Run `pnpm db:migrate` before you start the new server.

Migrations are transactional and tracked in `huddle_migration`. Migration `007_single_server.sql` converts a database from the earlier workspace design. It keeps rooms, channels, messages, read markers, mentions, and events from zero or one workspace, and fails on a database with more than one. To start over from such a database, drop and recreate it, run the migrations, and set up the server again.

Migration `011_channel_kind.sql` marks every existing channel as a text channel. Channels are text or voice, and voice channels carry no audio yet.

Migration `013_tailscale_identity.sql` moves an older server to Tailscale identity. It cannot be undone, so back up first. It keeps every account ID, role, room, channel, message, direct message, read marker, mention, avatar, and photo. It drops usernames, stored credentials, and sessions, and it keeps each old username as a label for `account:link`. It issues a new join code, so old invites stop working.

After the upgrade:

1. Edit `.env`. Keep `DATABASE_URL` and `POSTGRES_PASSWORD`, set `SERVER_URL` to the Serve address, and delete every other line. A leftover loopback `TRUSTED_ORIGINS` stops the server from starting.
2. Close the old friend port on your router, and delete `apps/server/data/friend/`.
3. Start the server. It prints a reminder until an admin has a login.
4. Bind accounts with `account:link`, as [accounts](accounts.md) describes.

## Check Serve after a Tailscale upgrade

Continuous integration has no tailnet, so its suites supply the identity headers themselves. To check that real Serve still behaves as Huddle expects, run this on a tailnet machine from a device signed in as a person:

```sh
pnpm --filter @huddle/server test:serve https://your-node.your-tailnet.ts.net:8443
```

The command starts a scratch server, prints the two `tailscale serve` commands to run, and checks TLS, identity on HTTP and on upgrades, forged and underscore headers, the `/events` mapping, and loopback callers.
