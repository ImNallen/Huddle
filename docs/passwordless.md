# Passwordless authentication

Local sign-in requires a delivered email code and an authenticator. New accounts enroll an authenticator, save ten recovery codes and finish their profile. Returning accounts verify their existing authenticator. Passkeys require user verification and can sign in directly. Company OIDC requires a signed, unexpired ID token with the configured issuer, audience, subject, nonce and verified email. Huddle does not implicitly link an existing account by email.

Only onboarding and invitations create accounts. Verifying an email code creates an account only for the admin during onboarding or for an address with a pending, unexpired invitation. For an unknown, uninvited address, the sign-in flow still shows the email step, so it does not reveal which addresses have accounts. The email itself says the server has no account for that address and asks the reader to request an invitation from an admin. It contains no code. A new company identity also needs a pending invitation for its email address, unless it completes login with the setup code during onboarding. Without one, Huddle rejects the login before creating a user. Existing company accounts sign in as before.

`AUTH_POLICY=mixed` enables local methods and configured company login. `AUTH_POLICY=sso-only` requires company OIDC and rejects local methods and existing local sessions on every admission check. Company login alone does not grant membership. An invitation for the account's email does. The optional first passkey offer is available only in mixed policy. Native company and passkey authentication use the system browser and an explicitly approved, single-use device grant.

The migration preserves user IDs, linked providers, memberships and messages. It clears credential password hashes and does not trust historic email verification or sessions without Huddle proof. Existing accounts prove their email and enroll. An established authenticator, passkey or company identity cannot be replaced by email alone. Established company issuer bindings prevent another issuer's matching subject from silently taking over the link.

The server stores pending email challenges, factor replay steps, rate limits and encrypted onboarding state in PostgreSQL. Email codes expire after five minutes, sends wait one minute and each recipient gets at most ten sends per hour. Five failed factor verifications lock further attempts for fifteen minutes. Successful verifications do not consume that failure budget. Sensitive changes require a newly entered authenticator code or a one-use, session-bound passkey proof. Factor changes advance the account epoch and revoke old HTTP, socket, watch-ticket and device authority.

Recovery codes are stored as keyed hashes. Preparing recovery grants no session or account access. If clients prepare replacement concurrently, exactly one final transaction consumes the recovery code, installs the verified replacement and advances the epoch. A failed transaction preserves the old factor. Recovery plaintext is encrypted only until acknowledgement so a page reload can resume saving it.

## Local email

Fresh `pnpm setup:local` configures development Mailpit and preserves any existing `.env`. Start `docker compose --profile dev up -d db mailpit`. Read delivered codes at http://localhost:8025. An existing installation must set the SMTP fields documented in [email delivery](email.md), or configure company OIDC with sso-only policy. Email is unavailable honestly when SMTP is absent or rejects delivery. The production container requires a production SMTP relay with TLS; local Mailpit configuration is for host development.

## Operator recovery

A recovery request always acknowledges generically. It never reveals whether an email exists or names a server admin. The admin role grants no account reset authority.

An installation operator with database and CLI access must independently confirm the account owner's identity outside Huddle before issuing a reset. The operator is responsible for that confirmation; possession of an email inbox alone is insufficient. Run these commands from `apps/server` with the installation environment.

```
node --env-file=../../.env --import tsx scripts/account-reset.ts list CONFIRMED_EMAIL
HUDDLE_IDENTITY_CONFIRMED=yes node --env-file=../../.env --import tsx scripts/account-reset.ts issue REQUEST_ID OPERATOR CONFIRMATION_REASON /private/path/capability.txt
```

The listing filters the independently confirmed email and contains opaque request IDs and timestamps. The reason must describe the completed independent identity confirmation. Issuance records the operator and reason and writes the capability once to a mode0600 file. Give that capability to the confirmed owner through the confirmed channel. The owner submits it through the reset flow, proves their email and enrolls a new authenticator. The capability expires in fifteen minutes and its final redemption is atomic with replacement. Operator reset removes local passkeys as well as replacing the authenticator and recovery codes; company links remain. Issuing it does not immediately revoke the previous factor. Audit requests are retained for ninety days.

## Encryption keys and verification

Better Auth's authenticated encryption stores versioned envelopes. By default, encryption version1 uses `BETTER_AUTH_SECRET`. To rotate encryption independently, set `AUTH_ENCRYPTION_KEYS` to a JSON array of objects with positive unique `version` numbers and at least32-character random `secret` values. The first entry encrypts new records. Keep prior entries until every active factor and pending ceremony has been re-encrypted or replaced. Retaining `BETTER_AUTH_SECRET` keeps existing keyed hashes and session signatures valid. Replacing that secret invalidates them and requires recovery planning.

`pnpm --filter @huddle/server typecheck` and `build` check the implementation. `scripts/access-integration.ts` drives real HTTP, Mailpit email, TOTP, device exchange and cryptographically valid WebAuthn software fixtures. It starts its own server on a scratch database. Set `MAILPIT_URL` if Mailpit is not at `http://127.0.0.1:8025`. It proves UV requirements and replay behavior, not physical platform authenticator behavior. The original integration script now creates its accounts through setup-code onboarding, email invitations, and passwordless email and TOTP. It reads the same `MAILPIT_URL`. Never point these scripts at real user data.

Company-only users confirm session revocation through a new company sign-in. The pending intent binds the exact session action, user, current session and epoch. The verified callback consumes it once, revokes the selected authority and creates a fresh company session. This works under sso-only policy and cannot request local factor changes.

A pending recovery batch belongs to the account. Every newly verified session must save it before admission to the server, including passkey or company sessions. The encrypted payload survives loss of a browser continuation or a native pending token. Only acknowledgement of its exact batch clears this gate.
