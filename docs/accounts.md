# Accounts and sign-in

Every Huddle account signs in with a username and password. Huddle has no email, passkeys, company login, or authenticator apps.

## Create accounts

The admin creates the first account during setup. Every other account comes from an invite. The invite carries the server's join code, and `account.join` creates the account only when the code's hash matches. The new account joins as a member.

Usernames are unique, lowercase, 2 to 32 characters, and use letters, digits, `_`, and `-`. Passwords are 8 to 200 characters and stored as scrypt hashes. An unknown username costs the same hash check as a wrong password, so timing does not reveal which usernames exist.

## Rate limits

Every 15 minutes, the server allows:

- 10 setup or join attempts per IP address.
- 30 sign-in attempts per IP address.
- 10 sign-in attempts per username.
- 5 password changes per account.
- 10 password resets per admin.

## Reset a forgotten password

An admin resets a member's password with **Reset password** on the **Members** page, then sends the new password to that friend.

Whoever runs the server can reset any password, including the admin's own, from the repository:

```sh
pnpm --filter @huddle/server account:reset USERNAME
```

The command reads the new password from the terminal without echoing it, or from standard input when piped. It never takes the password as an argument, so the password stays out of shell history.

Both resets replace the hash and delete every session of that account. Deleting a session cuts it off everywhere. Its HTTP requests fail, the server closes its WebSocket within a second, and its unused watch tickets go with it.

## Change your password

Members change their own password under **Account security**. The form asks for the current password and the new one twice. A change keeps the current session signed in and signs out every other session of the account. After an admin reset, a friend can use this to replace the password the admin chose.

## Sessions

Browsers hold the session in an HttpOnly cookie. The desktop app holds a bearer token in the OS credential store, scoped to the server's origin.

The **Account security** page lists the account's sessions and marks the current one **This device**. **Sign out** next to a session ends only that session. **Sign out all other sessions** ends every session except the current one. Neither needs the password, because signing out can only remove access.

## Encryption keys

Better Auth's authenticated encryption seals the join code. By default, encryption version 1 uses `BETTER_AUTH_SECRET`. To rotate encryption independently, set `AUTH_ENCRYPTION_KEYS` to a JSON array of objects with positive unique `version` numbers and `secret` values of at least 32 random characters. The first entry encrypts new records. Keep prior entries until every record they encrypted has been replaced. Replacing `BETTER_AUTH_SECRET` invalidates keyed hashes and session signatures.
