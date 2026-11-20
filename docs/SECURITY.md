# Security

## Administrators

- Credentials are handled by Firebase Authentication. The Worker never sees admin passwords.
- `POST /auth/session` accepts a Firebase ID token, verified with RS256 against Google's JWKS with exact `iss` and `aud` checks, an `auth_time` within 5 minutes, and a Turnstile token.
- Session: 256-bit random token in `__Host-admin` (`HttpOnly; Secure; SameSite=Lax; Path=/`). Firestore stores only its SHA-256 hash (as the document id). Admin sessions last 12 hours.
- MFA: the session records `mfa_verified` when the token has `firebase.sign_in_second_factor`. Every `/admin/*` route requires it. `DEV_ALLOW_ADMIN_WITHOUT_MFA=true` is honoured only when `ENVIRONMENT=development`; config parsing throws otherwise.
- Admins are exactly the addresses in the `ADMIN_EMAILS` Worker secret, and outside development the Firebase email must be **verified**. No API can grant admin. Removing an address revokes access on the next request. Turn off Firebase self sign-up so nobody can create an account for an admin address.
- Put the admin host behind Cloudflare Access as an extra layer.

## Employees (webmail)

- Employees sign in with mailbox address and password. The mail server checks them; the API never hashes or stores them in plain text.
- The webmail session document holds the password **sealed with AES-256-GCM** (`MAIL_SESSION_KEY`, Worker secret) because every JMAP call needs it. The cookie `__Host-mail` holds a random token stored as a SHA-256 hash. Sessions last 7 days.
- Failed logins return one generic message (no user enumeration), are audit-logged and are rate-limited per IP and per address. Turnstile protects the form when configured.
- Disabling a mailbox or resetting its password deletes all of its sessions. Changing one's own password signs out every other device.
- Mail access goes through JMAP as the employee, so Stalwart itself enforces mailbox isolation.

## Data

- Firestore is reached only by the Worker, with a service-account OAuth token. `firestore.rules` denies every browser and mobile client. The service-account key is a Worker secret.
- Firestore never holds message content or plain-text passwords. Tests dump the whole store and assert the mailbox password is absent.
- Expired sessions are deleted on use and by a daily cron trigger.

## Realtime

- `/mail/events` requires a valid webmail session, is read-only (GET), and only says _that_ something changed; the browser then fetches through the normal authenticated API. Streams are recycled every 5 minutes.

## Web security

- CORS: exact allowlist from `APP_ORIGINS`, with credentials. CSRF: non-GET requests need an allowlisted `Origin`; `SameSite=Lax` is a second layer.
- Pages sites ship `_headers` with a strict CSP (scripts only from self and Turnstile; API and Firebase as the only connect targets), HSTS, `nosniff`, no referrer.
- API headers: HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`, and a `default-src 'none'` CSP on API responses.
- Input: every body and parameter is validated with Zod (`packages/validation`).
- **Email HTML** is untrusted. Webmail renders it in an `<iframe sandbox>` without `allow-scripts` or `allow-same-origin`, so it cannot run code or reach the app's origin. Its CSP blocks remote resources (tracking pixels) until the reader clicks “Show images”. Plain-text mail renders as text.
- **Attachments** download with `Content-Disposition: attachment`, `application/octet-stream`, `nosniff` and a sandbox CSP; they are never rendered inline. Uploads are capped at 25 MB per message.

## Secrets

| Secret                                           | Where                   |
| ------------------------------------------------ | ----------------------- |
| `FIREBASE_SERVICE_ACCOUNT`                       | `wrangler secret put`   |
| `ADMIN_EMAILS`                                   | `wrangler secret put`   |
| `MAIL_SESSION_KEY`                               | `wrangler secret put`   |
| `STALWART_ADMIN_USER`, `STALWART_ADMIN_PASSWORD` | `wrangler secret put`   |
| `TURNSTILE_SECRET_KEY`                           | `wrangler secret put`   |
| `FIREBASE_PROJECT_ID`, `STALWART_URL`            | plain vars (not secret) |

`.dev.vars` and `.env*` (except examples) are git-ignored.

## Audit log

Written in the same atomic Firestore commit as the change: admin sign-in; domain add/delete; mailbox create/update/disable/password reset/delete and failed creation; alias create/delete; webmail sign-in, failed sign-in, password change and send (recipient and attachment counts only). Entries never contain passwords, tokens or message content.

## Backups

Firestore holds the directory: on Blaze, enable Point-in-time recovery or scheduled exports (`gcloud firestore export`) to a Cloud Storage bucket. Mail lives on the VPS: back up Stalwart's data directory daily, off the VPS (see [../infrastructure/mail-server/STALWART.md](../infrastructure/mail-server/STALWART.md)).

## Before going live

- [ ] Stalwart API checklist in `infrastructure/mail-server/STALWART.md` passes on your server version
- [ ] SPF, DKIM and DMARC pass in a Gmail “Show original”; PTR set for the VPS IP
- [ ] Every admin has TOTP enrolled; Cloudflare Access on the admin host
- [ ] `MAIL_PROVIDER=stalwart` and `ENVIRONMENT=production` (the mock refuses to load there)
- [ ] VPS firewall: only 25, 465, 587, 993, 443 (and SSH restricted to your IP or keys only)
- [ ] Firestore rules deployed (`npx firebase deploy --only firestore:rules`): all client access denied
- [ ] Backup restore drill for both Firestore and the mail store
