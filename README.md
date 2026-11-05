# Huddle

Huddle is a self-hosted chat server for you and your friends, like a Discord server that runs on your own machine. Everyone reaches it over [Tailscale](https://tailscale.com), and Tailscale says who they are, so there is nothing to sign in with. You run the server and share an invite link. A friend opens the link on a device signed in to Tailscale, confirms their name, and chats with you in rooms and channels. Any two friends can also message each other directly from Home. Other members never see those conversations, but they are stored unencrypted on your server, so the host could read them.

Huddle is text only for now. A room can list voice channels, but they carry no audio yet. Voice calls, video, file uploads, message editing, group direct messages, blocking, and mobile apps are not built yet.

## Host a server

You need a machine that runs only Huddle, with Tailscale, Node.js 24, pnpm 11, and Docker for PostgreSQL. A Proxmox LXC or VM works. Turn on HTTPS certificates in your tailnet's DNS settings, then run these commands with your machine's Tailscale name:

```sh
pnpm install --frozen-lockfile
pnpm setup:local --server-url https://huddle.your-tailnet.ts.net
docker compose up -d db
pnpm build
pnpm db:migrate
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve --bg --https=443 --set-path=/events http://127.0.0.1:3001
pnpm --filter @huddle/server start
```

`pnpm setup:local` writes a `.env` with a generated database password and a database port, 5434 unless that port is taken. The server prints a setup code to its log.

From a device signed in to Tailscale as you, open `https://huddle.your-tailnet.ts.net`. Enter the setup code, a server name, and your name. You are now the admin, as your Tailscale login. Create a room and a channel so your friends have somewhere to talk.

To run the server in Docker with a Tailscale sidecar instead, see [hosting](docs/hosting.md). To have a VM deploy each new version by itself, see [Deploy updates automatically](docs/hosting.md#deploy-updates-automatically).

## Invite friends

1. In Tailscale, give your friend access to this machine. Share the machine with them, or add them to your tailnet.
2. In Huddle, open **Members** and select **Share invite**.
3. Copy the invite link and send it to your friend.

Your friend opens the link in a browser or pastes it into the Huddle desktop app, then confirms their name. Reaching the server is not enough to create an account. They also need the invite, so share it only with people you trust.

## Upgrade from an older version

Back up the database first. Then run `pnpm db:migrate`. In `.env`, keep `DATABASE_URL` and `POSTGRES_PASSWORD`, set `SERVER_URL` to your machine's Tailscale address, and delete every other line. Bind your account to your Tailscale login:

```sh
pnpm --filter @huddle/server account:link
pnpm --filter @huddle/server account:link <id-or-old-username> you@example.com
```

Friends do the same through you. Each friend sends you the login their Huddle page shows, you run `account:link` for them, and they select **Check again**. Everyone keeps their rooms, messages, direct messages, and photos. See [accounts](docs/accounts.md).

## Known limits

- There is no sign-out. Anyone using a device signed in to Tailscale as you is you in Huddle. To leave, disconnect Tailscale on that device.
- Huddle cannot remove a member yet. To cut someone off, remove their access in Tailscale.
- Every invite uses the same join code, and you cannot change that code yet.
- Any process on the server machine can claim to be any member, so run nothing else on that machine.

## Develop

Native desktop work also needs Rust 1.90 or newer and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose up -d db
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000` for the browser app. `pnpm dev` plays `tailscale serve` on that port, so you need no tailnet, and you act as the login in `HUDDLE_DEV_LOGIN`. To try a second person, open another browser profile and set a `huddle-dev-login` cookie to another login. For the desktop app, stop `pnpm dev`, then run `pnpm --filter @huddle/server dev` and `pnpm desktop` in two terminals.

## More

- [Hosting](docs/hosting.md) covers Serve, Proxmox, Docker, ports, and upgrades.
- [Accounts](docs/accounts.md) covers Tailscale identity, invites, linking old accounts, and limits.
- [Architecture](docs/architecture.md) explains the data model, realtime events, and design decisions.
- [AGENTS.md](AGENTS.md) holds testing and contribution notes for AI agents.
