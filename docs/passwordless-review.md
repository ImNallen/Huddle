# Passwordless verification and review

The supplied thirteen screens now share one React implementation between the browser and desktop. Local accounts use email and TOTP, passkeys require user verification, and company accounts follow the installation's OIDC policy. The desktop completes browser authentication through an explicit code match and approval.

## Review decisions

Independent Astra, Sol and Luna reviews traced the full session boundary and its HTTP, WebSocket, watch-ticket and device consumers. These findings were fixed, including a cleanup error identified during final review:

| Finding                                                                | Final behavior                                                                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A cancelled native token could become shared authority.                | A private connection proves readiness before promotion. Cancellation prevents adoption and keychain writes. |
| Company login lost the desktop approval destination.                   | The callback returns to the exact device request, which still requires explicit approval.                   |
| Pending email enrollment survived establishment of a company identity. | Final installation rechecks established methods under the account lock.                                     |
| Reset resend lost its replacement authority.                           | Only an unexpired ceremony for the same email can retain an unused, unexpired reset.                        |
| A failed discovery request stayed cached.                              | Discovery has a timeout and clears rejected results so the next request can retry.                          |
| SSO-only installations recorded unusable local resets.                 | Local recovery is hidden and rejected before a reset request is recorded.                                   |
| The old native client stayed active during server cleanup.             | The old lifetime ends before asynchronous cleanup begins.                                                   |
| Failed cleanup left Back pointing to a disconnected client.            | Connect displays the failure and Back receives a fresh client for the retained origin.                      |

The last fix retains the old server when cleanup fails. It does not report a successful switch or keychain deletion. A successful switch still clears the owned old credential. A withdrawn concern about direct native company confirmation was dismissed after tracing the complete browser-only UI guards.

Final independent review found the accepted issues resolved. The cancellation and cleanup tests both fail when their respective fixes are removed, then pass after restoration. Discovery retry and final enrollment checks also have mutation evidence.

## Reproduce the checks

Use disposable PostgreSQL and Mailpit services. Authentication scripts create and modify synthetic accounts, factors, sessions and reset records. Do not run them against real user data. The CI workflow shows the complete environment and service lifecycle.

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm format:check
cargo check --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm test:email
pnpm test:integration
pnpm test:access
pnpm test:ui
```

`test:access` needs a running test server and Mailpit. The CI workflow starts `apps/server/scripts/access-test-server.ts` and also runs the body-limit checks. The focused `access-review-check.ts` owns its server lifecycle and tests company establishment during enrollment, reset resend and expiry, SSO-only rejection, and abuse limits across a real process restart. It requires the disposable OIDC fixture in `tests/fixtures/oidc-provider.mjs`. Run `company-discovery-check.ts` before starting that fixture because both use its default port.

For external UI services, set `HUDDLE_UI_EXTERNAL_SERVER=1`, `HUDDLE_UI_BASE_URL`, `HUDDLE_UI_SERVER_URL`, `HUDDLE_UI_BROWSER_LOGIN` and `HUDDLE_UI_MAILPIT_URL`. Use the same hostname for browser and server cookie flows. WebAuthn tests use `localhost`, since an IP address is not a valid WebAuthn relying-party ID. `PLAYWRIGHT_CHANNEL=chrome` selects installed Chrome.

## Observed behavior and limits

The local runs verified actual SMTP delivery; first and returning email sign-in; TOTP replay and concurrent-use denial; recovery preparation, replacement and acknowledgement; operator reset; photo validation and ownership; signed WebAuthn software proofs; OIDC token rejection and valid callbacks; revoked HTTP, device and realtime access; and the existing two-person chat and reconnect behavior.

Migration checks preserved legacy user IDs, company links, membership and message counts while clearing password hashes. Old sessions without Huddle proof were denied. The user's development database and existing `.env` were left unchanged.

T3's collaborative browser drove the supplied onboarding, profile, workspace and security screens. A local macOS debug app completed explicit browser approval, restored its owned credential after relaunch, exchanged real chat messages with the browser, and signed out. A separate company sign-in completed OIDC consent, returned to the matching device request and admitted that app after approval.

Physical authenticators, packaged Windows and Linux apps, and customer identity providers still need release testing. Software WebAuthn proofs and a virtual Chromium authenticator do not establish platform authenticator behavior. The CI matrix checks Rust on all three desktop platforms; its remote result is separate from the completed local runs.
