# Huddle

Huddle is a self-hosted chat server for you and your friends, like a Discord server that runs on your own machine. You run the server and share an invite. Friends paste it into the Huddle desktop app, pick a username and password, and chat with you in rooms and channels.

Huddle is text only for now. Voice, video, file uploads, message editing, and mobile apps are not built yet.

## Host a server

You need Node.js 24, pnpm 11, and Docker for PostgreSQL.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose up -d db
pnpm build
pnpm db:migrate
pnpm --filter @huddle/server start
```

`pnpm setup:local` writes a `.env` with fresh secrets. The server prints a setup code to its log.

Open `http://localhost:3000/login`, or point the desktop app at `http://localhost:3000`. Choose **Set up this server** and enter the setup code, a server name, a username, and a password. You are now the admin. Create a room and a channel so your friends have somewhere to talk.

## Invite friends

1. Open **Members** and select **Share invite**.
2. Copy the invite for where your friend is, **on this network** or **from the internet**.
3. Send it to your friend.

Your friend pastes the invite into the Huddle desktop app and creates an account. Invites work only in the desktop app, not in a browser.

Anyone with an invite can join, so share it only with people you trust. Every invite uses the same join code, and you cannot change that code yet.

## How friends connect

Friends connect to port 4000 on your machine. The invite carries your address and a fingerprint of your server's certificate, so you need no domain name, and the app refuses any server that does not match.

Friends on your network use the network invite. Friends elsewhere get an invite only if your router supports NAT-PMP, which Huddle uses to open the port automatically. If yours does not, join the same [Tailscale](https://tailscale.com) network and share the Tailscale invite. The server log says at startup whether remote friends can connect.

## Manage friends

Admins see everyone on the **Members** page. If a friend forgets their password, select **Reset password**, set a new one, and tell them. Your friend can then pick their own password under **Account security**. Huddle never sends email.

If you forget your own password, reset it on the server with `pnpm --filter @huddle/server account:reset USERNAME`.

## Known limits

- Invites from the Docker image do not work yet. Run the server directly on your machine.
- Keep `apps/server/data/friend/`. It holds your server's key, and losing it breaks every invite.

## Develop

Native desktop work also needs Rust 1.90 or newer and [Tauri's prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
pnpm install --frozen-lockfile
pnpm setup:local
docker compose up -d db
pnpm db:migrate
pnpm dev
```

Open `http://127.0.0.1:1420` for the browser app. For the desktop app, stop `pnpm dev`, then run `pnpm --filter @huddle/server dev` and `pnpm desktop` in two terminals.

## More

- [Hosting](docs/hosting.md) covers ports, Docker, upgrades, password resets, and a browser domain.
- [Architecture](docs/architecture.md) explains the data model, realtime events, and design decisions.
- [Accounts and sign-in](docs/accounts.md) covers usernames, passwords, sign-in limits, and sessions.
- [AGENTS.md](AGENTS.md) holds testing and contribution notes for AI agents.
