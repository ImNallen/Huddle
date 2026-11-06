# Host a Huddle server

This page covers configuration beyond the basic setup in the [README](../README.md). Every remote connection goes through `tailscale serve`, which provides the address, a trusted certificate, and each person's identity.

## Keep the machine to Huddle

Run nothing else on the machine or in the container. The server cannot tell Serve from another local process, so any process that can reach its loopback port can claim to be any member. A browser on that machine cannot forge the `Host` header, and the server checks it, but a local program can. Give Huddle its own LXC, VM, or sidecar network namespace.

## Never use userspace networking

Run Tailscale with a TUN device. In userspace mode, `tailscaled` forwards a peer's direct connection to the node's IP onto `127.0.0.1`, past Serve. Any peer your access policy allows could then reach the server's ports and claim to be any member. The server refuses to start when the `tailscale` command reports userspace mode. `compose.yaml` pins kernel networking for its sidecar.

As a second layer, let friends reach only `tcp:443`, `tcp:8443`, and `udp:7882` on this machine in your tailnet's access policy.

Run `pnpm --filter @huddle/server test:serve <address>` on the machine to check all of this.

## Publish the server with Serve

Huddle uses three loopback ports:

- `PORT`, default 3000, serves the API and the browser app. Its address is hard-coded to `127.0.0.1`.
- `WS_PORT`, default 3001, serves WebSockets. Its address is hard-coded to `127.0.0.1`.
- 7880 is LiveKit's signalling port. LiveKit's configuration binds it to `127.0.0.1`.

Serve publishes the first two under one HTTPS address, and LiveKit on HTTPS port 8443 of the same name. Serve strips `/events`, so the WebSocket listener sees `/`.

```sh
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve --bg --https=443 --set-path=/events http://127.0.0.1:3001
tailscale serve --bg --https=8443 http://127.0.0.1:7880
```

Set `SERVER_URL` to the exact address that Serve publishes, such as `https://huddle.your-tailnet.ts.net`. `WS_PUBLIC_URL` defaults to `wss://` plus that host plus `/events`. If you change a port, change the Serve commands to match. The server treats any request whose `Host` is not one of these two addresses as having no identity, so a wrong `SERVER_URL` shows every visitor the **Open Huddle through Tailscale** screen.

Do not turn on Funnel, because Funnel traffic has no identity. Do not mount another app on this address with `--set-path`. That app would share Huddle's origin, and its pages could act as anyone who opens them.

## Run LiveKit

Calls in voice channels run through LiveKit, so set it up with the rest of the server. Without it, voice channels say voice is turned off, and everything else works.

One LiveKit server relays everyone's audio, because friends on a shared Tailscale node have no route to each other.

- **Signalling goes through Serve on port 8443.** HTTPS port 8443 is a separate origin from Huddle's address, so nothing LiveKit serves can act as a member. Mounting it under Huddle's address with `--set-path` would share Huddle's origin.
- **Audio uses one UDP port, 7882, on the node's Tailscale address.** Serve does not carry UDP. `rtc.interfaces.includes: [tailscale0]` binds that port only on the Tailscale addresses, so the rest of your network cannot reach it. Keeping it to one port keeps the access policy to one line.
- **ICE over TCP stays off, with `rtc.tcp_port: 0`.** LiveKit binds that port on every interface and ignores the interface filter, so turning it on would open a port to your whole network. A friend whose access policy does not allow `udp:7882` gets no audio.

LiveKit binds its UDP port once, when it starts, and only if `tailscale0` is already up. Started any earlier, it still answers on 8443 and carries no audio, and it does not recover by itself. Start LiveKit after Tailscale is up, and restart it if Tailscale was down when it started.

`pnpm setup:local` and `deploy/install.sh` write `LIVEKIT_API_SECRET` to a new `.env`, and `pnpm setup:local` adds it to an existing one. The server and LiveKit must share this value, which must be at least 32 characters. The server offers voice only when it is set, so leave it empty to turn voice off. `LIVEKIT_PUBLIC_URL` defaults to `wss://` plus the name in `SERVER_URL` plus `:8443`, and an HTTPS server refuses a plain `ws:` value.

Without the Docker sidecar, run LiveKit on the host's network from the directory that holds `.env`:

```sh
docker run -d --name huddle-livekit --restart unless-stopped --network host \
  -e LIVEKIT_CONFIG="port: 7880
bind_addresses: [127.0.0.1]
rtc:
  udp_port: 7882
  tcp_port: 0
  use_external_ip: false
  interfaces:
    includes: [tailscale0]
keys:
  huddle: $(sed -n 's/^LIVEKIT_API_SECRET=//p' .env)" \
  livekit/livekit-server:v1.13.11
```

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
docker compose up -d server livekit
docker compose logs server
```

If the sidecar restarts on its own, run `docker compose restart server livekit`, because their network goes with the sidecar. The sidecar's node is named `huddle`, so `SERVER_URL` must use that name. Without `TS_AUTHKEY`, run `docker compose logs tailscale` and open the login link it prints. Use an auth key for a person rather than a tagged key until you confirm that sharing a tagged machine works for your tailnet.

Compose publishes only PostgreSQL, on `127.0.0.1` at `POSTGRES_PORT` (5434 by default), for migrations from the host. The `livekit` service shares the sidecar's network, and Serve publishes it from `serve.json`. The `livekit-dev` service, behind the `dev` profile, is for development and tests on a machine with no `tailscale0`.

## Deploy updates automatically

An Ubuntu VM can run the Docker sidecar setup and deploy each commit that passes the checks on `main`. Nothing reaches into the VM. It needs no inbound port or self-hosted runner, and GitHub holds no credential for the VM or your tailnet.

1. After the checks pass on `main`, GitHub Actions publishes `ghcr.io/imnallen/huddle:main`. Pull requests and forks cannot publish this image.
2. Every five minutes, a systemd timer on the VM runs `deploy/update.sh`, which pulls the image. If the server already runs that image, it stops there.
3. For a new image, it takes `compose.yaml` and `deploy/` out of the image, backs up the database, runs the migrations, and starts the new server. The VM has no Git checkout, so the Compose file always matches the code.
4. If the migrations fail, or the server is not healthy within three minutes, it restores the previous image and skips the new one. LiveKit starts after the server, and a LiveKit failure does not fail the deploy.

Anyone who can merge to `main` controls this VM, because the updater runs what `main` publishes as root. Decide who can merge with that in mind.

### Set up the VM

In your tailnet's DNS settings, turn on HTTPS certificates. The sidecar's node is named `huddle`, so the server's address must use that name. The VM pulls without credentials, so the image's package on GitHub must be public.

Run these as root on a fresh Ubuntu VM:

```sh
apt update
apt install -y docker.io docker-compose-v2
mkdir -p /opt/huddle
docker run --rm ghcr.io/imnallen/huddle:main tar -C /app -c compose.yaml deploy | tar -x --no-same-owner -C /opt/huddle
/opt/huddle/deploy/install.sh --server-url https://huddle.your-tailnet.ts.net
systemctl start huddle-update.service
docker compose --project-directory /opt/huddle logs tailscale
```

`install.sh` writes `.env` with a generated database password and LiveKit secret if `.env` does not exist, and it never changes an existing one. It also installs and starts the timer.

Open the newest login link from the `tailscale` log to add the node to your tailnet. Until you do, the sidecar restarts every minute with a new link, and the updater waits instead of deploying. In the Tailscale admin console, turn off key expiry for this machine, or friends lose access when the key expires. Then deploy and read the setup code from the `server` log:

```sh
systemctl start huddle-update.service
docker compose --project-directory /opt/huddle logs server
```

### Operate it

- `journalctl -u huddle-update` shows what each run did.
- `systemctl start huddle-update` deploys now instead of waiting for the timer.
- `systemctl stop huddle-update.timer` pauses deploys until you start it again.
- Each run also restarts the server and LiveKit if the server is unhealthy, which covers a sidecar restart cutting off their network.
- Each run restarts LiveKit if it has no UDP port, which covers a reboot that started it before `tailscale0` was up.
- Each run adds `LIVEKIT_API_SECRET` to an `.env` that lacks the line and starts LiveKit with it. On a VM from before voice, this happens on the run after the deploy that introduces LiveKit, and it restarts the server once. An existing line is never changed, so an empty one keeps voice off.
- An image that fails its deploy is tagged `huddle:failed`, and the updater skips it until a newer image is published. To retry it, run `docker rmi huddle:failed`. If it was the first deploy, there is no earlier image to restore, so also run `docker compose rm -sf server`.
- A published change to the systemd units takes effect only after you run `install.sh` again.

### Restore a backup

Before each deploy, the updater writes a dump to `/var/backups/huddle` and keeps the newest 14. These stay on the VM's disk, so they do not survive losing that disk. Copy them elsewhere or back up the VM in Proxmox if that matters to you.

Migrations only go forward. A restored image may not work with a database that a newer migration changed. In that case, restore the newest dump, which was taken just before the failed deploy:

```sh
cd /opt/huddle
systemctl stop huddle-update.timer
docker compose stop server
docker compose exec -T db pg_restore -U huddle -d huddle --clean --if-exists --single-transaction < /var/backups/huddle/your-dump.dump
docker compose up -d --no-build server
systemctl start huddle-update.timer
```

### Deploy a fork

A fork's own `main` publishes to its own package, such as `ghcr.io/you/huddle:main`. Use that address in the setup commands, and point the updater at it before you run `install.sh`:

```sh
mkdir -p /etc/systemd/system/huddle-update.service.d
printf '[Service]\nEnvironment=HUDDLE_RELEASE_IMAGE=ghcr.io/you/huddle:main\n' > /etc/systemd/system/huddle-update.service.d/image.conf
systemctl daemon-reload
```

## Give friends access in Tailscale

Share the machine with a friend, or add them to your tailnet. A shared machine appears in the friend's tailnet under its own name, and it cannot start connections to them. ACLs can target the friend's email.

Whether Serve reports a friend's own login for a machine shared into their tailnet is not verified. Try it with one friend first. If Serve reports nothing, that friend sees the screen for a device with no user, and they need to join your tailnet instead.

## Upgrade

PostgreSQL data lives in the `postgres-data` volume. Back it up before you upgrade. Run `pnpm db:migrate` before you start the new server. A VM that [deploys updates automatically](#deploy-updates-automatically) does both for you. Run `pnpm setup:local` to add any missing LiveKit lines to `.env`. It changes nothing else in the file.

Migrations are transactional and tracked in `huddle_migration`. Migration `007_single_server.sql` converts a database from the earlier workspace design. It keeps rooms, channels, messages, read markers, mentions, and events from zero or one workspace, and fails on a database with more than one. To start over from such a database, drop and recreate it, run the migrations, and set up the server again.

Migration `011_channel_kind.sql` marks every existing channel as a text channel. Channels are text or voice.

Migration `013_tailscale_identity.sql` moves an older server to Tailscale identity. It cannot be undone, so back up first. It keeps every account ID, role, room, channel, message, direct message, read marker, mention, avatar, and photo. It drops usernames, stored credentials, and sessions, and it keeps each old username as a label for `account:link`. It issues a new join code, so old invites stop working.

After the upgrade:

1. Edit `.env`. Keep `DATABASE_URL` and `POSTGRES_PASSWORD`, set `SERVER_URL` to the Serve address, and delete every other line. A leftover loopback `TRUSTED_ORIGINS` stops the server from starting.
2. Close the old friend port on your router, and delete `apps/server/data/friend/`.
3. Start the server. It prints a reminder until an admin has a login.
4. Bind accounts with `account:link`, as [accounts](accounts.md) describes.

## Check Serve after a Tailscale upgrade

Continuous integration has no tailnet, so its suites supply the identity headers themselves. To check that real Serve still behaves as Huddle expects, run this on a tailnet machine from a device signed in as a person:

```sh
pnpm --filter @huddle/server test:serve https://your-node.your-tailnet.ts.net:10000
```

Port 8443 is LiveKit's, so the command refuses it. If you set `LIVEKIT_PUBLIC_URL`, the command checks that address instead. LiveKit must already be running, as [Run LiveKit](#run-livekit) describes.

The command starts a scratch server, prints the three `tailscale serve` commands to run, and checks TLS, identity on HTTP and on upgrades, forged and underscore headers, the `/events` mapping, and loopback callers. It also checks that LiveKit accepts the server's token over `wss` on 8443, and that 7880 is closed on the Tailscale address.
