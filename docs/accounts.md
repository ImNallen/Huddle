# Accounts and identity

Tailscale says who a person is, and Huddle trusts nothing else. Huddle stores no credential, on the server or on any device. `tailscale serve` adds the `Tailscale-User-Login` header to every request and WebSocket upgrade, and Huddle looks that login up in `"user".tailscale_login` each time.

## Create an account

The admin creates the first account during setup, with the setup code from the server log. Every other account needs both of these:

- A Tailscale login that can reach the machine.
- The invite link, which carries the server's join code.

Reaching the server is not membership. A person with a login and no invite sees the **Join** screen and can do nothing else. A person with no login sees a screen that says what is wrong:

- A tagged device has no user. Use a device signed in as a person.
- A request that did not come through Serve has no identity. Open the server's Tailscale address.
- Funnel traffic has no identity. Huddle does not work through Funnel, so turn Funnel off.

The join code stays in the link's fragment, so opening the link sends it to no server and writes it to no log. Your friend's browser stores the code until the account exists, and the code reaches the server only in the join request.

## Know what the account key means

The account key is the exact login string that Tailscale reports, compared with no case folding and no trimming. `Ada@example.com` and `ada@example.com` are two people.

If your identity provider gives a login to someone new, that person inherits the account, including its direct messages. To cut access, remove the login from the machine's Tailscale share or ACL. A person with two logins has two accounts, unless you move one with `account:link`.

Members never see each other's logins. The login appears only on that person's own screens and in `account:link` on the host.

## Link an existing account

An account from an older version of Huddle has no login after the upgrade, and it cannot be reached until you bind one. Only someone with a shell on the host can do that, and no page in Huddle can. To list every account, run this on the host:

```sh
pnpm --filter @huddle/server account:link
```

The list shows each account's ID, role, name, old username, joined date, and login. To bind a login, name the account by its ID or old username:

```sh
pnpm --filter @huddle/server account:link alice alice@example.com
```

The command prints what moved and from where. If another account holds that login, the command takes it, and that account has no login until you link it again. Open sockets of the old login close within a second, and its requests fail at once. In Docker, run `docker compose exec server node --import tsx scripts/account-link.ts` with the same arguments.

For a friend, ask for the login their Huddle page shows and bind it. They select **Check again** and return to their rooms, messages, direct messages, and photos. A friend who creates a new account with an invite by mistake gets an empty account. Use `account:link` to move their login back to the old account, then remove the empty one from **Members** so it leaves the roster.

## Remove and block someone

An admin removes a member from **Members**, with **More actions** beside their row, or with **Remove from server…** in the member list's menu or on their profile card. Admins cannot be removed, and you cannot remove yourself.

Removing someone does these things at once:

- Their open pages close within about a second and say they were removed. Reloading, or opening the invite again, shows the same screen.
- They leave every call within about two seconds, and every group.
- Their account is blocked, so their Tailscale login cannot rejoin with the invite.

Their account stays. Their channel messages stay under their name and photo. Their direct conversations stay readable for the other person, who can no longer send to them.

**Blocked**, under the table on **Members**, lists everyone removed, newest first. **Unblock** lets that login join again. Nothing tells them, so send them the invite yourself, because a removed browser no longer holds the join code. Joining restores the same account, messages, and direct conversations, but not group seats.

The block belongs to the account, not to the login text. `account:link` lists and links only member accounts, so it cannot bring a removed account back. If you link a removed person's login to another member account, that login reaches the other account and is no longer blocked, and the removed account is left with no login.

## Understand the limits

Huddle has no sign-out. Anyone using a device signed in to Tailscale as you is you in Huddle, including every other process and OS user on that device. To leave, disconnect Tailscale on the device.

The join code cannot be rotated. Removing someone blocks their account, but a second Tailscale login of theirs is a new person to Huddle and can join with the same invite. To cut someone off completely, also remove their access in the Tailscale share or ACL. New connections fail as soon as Tailscale stops letting the person reach the machine. An open socket closes when it reaches its age limit, within about five and a half minutes. The person keeps their account, and it works again if you give them access back.

Whoever runs the host can read every message in the database and can bind any account to any login with `account:link`. Admins without a shell cannot do either.

## Rate limits

The server keys these limits on the login or account, because every connection reaches it from loopback:

- 10 setup or join attempts per Tailscale login every 15 minutes.
- 10 photo uploads per account every hour.

A visitor with no identity is refused before any code is compared, so they use up nothing.
