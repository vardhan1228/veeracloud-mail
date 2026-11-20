# Architecture

Internal company email for HAVINS TECHNOLOGIES on **veeracloud.shop**. One company, two kinds of sign-in:

- **Administrators** use the admin console to manage domains, employee mailboxes and aliases. They sign in with Firebase Authentication plus a second factor. Who is an admin is set by the `ADMIN_EMAILS` secret.
- **Employees** use webmail (or any IMAP/SMTP app). They sign in with their mailbox address and password, which the mail server checks.

There is no public sign-up, no billing and no multi-tenancy.

| Surface       | Host                      | Deployed as                                               |
| ------------- | ------------------------- | --------------------------------------------------------- |
| Admin console | `admin.veeracloud.shop`   | Cloudflare Pages `veeracloud-admin` (+ Cloudflare Access) |
| Webmail       | `webmail.veeracloud.shop` | Cloudflare Pages `veeracloud-webmail`                     |
| API           | `api.veeracloud.shop`     | Cloudflare Worker `veeracloud-mail-api` (Hono)            |
| Mail server   | `mail.veeracloud.shop`    | Stalwart on a Linux VPS, **DNS only**                     |

Hostnames live only in configuration (`wrangler.jsonc`, `_headers`, GitHub Actions variables), never in application code.

## Who does what

```
Admin browser ──(Firebase SDK)──▶ Firebase Authentication (admin identity + TOTP MFA)
      │ ID token → POST /auth/session → __Host-admin cookie
      ▼
Cloudflare Worker (apps/api) ──▶ Firebase Firestore (REST, service account):
      │                            admins, sessions, domains, mailboxes, aliases, audit log
      │                      ──▶ Stalwart management API (admin credentials)    ← admin actions
      │                      ──▶ Stalwart JMAP + EventSource (employee's creds) ← webmail + live push
      ▲ POST /mail/login → __Host-mail cookie;  GET /mail/events (server-sent events)
Employee browser (webmail)

Stalwart (VPS): SMTP in/out, IMAP, JMAP, spam filter, DKIM, mail storage
```

- **Firebase Authentication** holds admin identities only.
- **Firestore** is the company directory and audit log. Only the Worker can reach it (service-account auth); `firestore.rules` denies all browser access. It never holds message content.
- **Stalwart** owns mail, mailbox passwords and spam filtering. Webmail talks JMAP **as the employee**, so the mail server itself enforces that an employee sees only their own mail.
- `packages/email-provider` is the only path to the mail server. `createEmailProvider` returns the Stalwart adapter, the development-only mock (`MAIL_PROVIDER=mock`, refused in production), or throws `ProviderNotConfiguredError` → `503 provider_not_configured` ("setup required" in both UIs).

## Data layer

`packages/database` defines a small `Store` interface (`get`, `query`, `count`, atomic `commit` with create/update preconditions) with two implementations:

- `FirestoreStore`: Firestore REST API, OAuth token minted from the service-account key with `jose` (cached per isolate). Works in Workers without the Node SDK.
- `MemoryStore`: same semantics in memory, for tests and `wrangler dev` without credentials.

Rules that keep Firestore cheap and free of composite indexes: look up by document id wherever possible (sessions by token hash, admins by Firebase uid); query with equality filters or one range filter on one field; sort small collections in the API. Uniqueness of addresses and domain names uses claim documents (`claims/address:<email>`, `claims/domain:<name>`) created in the same atomic commit as the record. Audit entries are part of the same commit as the change they record.

## Realtime webmail

`GET /mail/events` is a server-sent events stream. The Worker opens Stalwart's JMAP EventSource (RFC 8620 §7.3) with the employee's credentials and forwards `state` changes as `change` events, plus keep-alive pings. The browser refreshes the folder list and message list immediately, updates the unread count in the tab title and can show a desktop notification. Each stream is recycled after 5 minutes (EventSource reconnects automatically) so no request runs forever. If the stream is down, the app falls back to polling every 60 seconds.

## Monorepo

| Path                      | Purpose                                                                       |
| ------------------------- | ----------------------------------------------------------------------------- |
| `apps/api`                | Hono Worker: `/auth/*` (admin session), `/admin/*`, `/mail/*` (webmail)       |
| `apps/admin`              | React + Vite admin console                                                    |
| `apps/webmail`            | React + Vite webmail                                                          |
| `packages/database`       | Store interface, Firestore REST store, memory store, collection schema        |
| `packages/auth`           | Firebase ID token verification                                                |
| `packages/email-provider` | Provider interface, Stalwart adapter (management API + JMAP + push), dev mock |
| `packages/validation`     | Zod schemas shared by API and frontends                                       |
| `packages/ui`             | Tailwind tokens, components, toasts, avatars, `api()` client, hash router     |
| `infrastructure/`         | Cloudflare deployment and Stalwart server guides                              |
| `.github/workflows`       | CI on every push; deploy to Cloudflare from `main`                            |

## Request pipeline (apps/api)

1. Security headers and a strict CSP on API responses.
2. CORS restricted to `APP_ORIGINS`, with credentials. CSRF: state-changing requests must carry an allowlisted `Origin`.
3. Session loader: `__Host-admin` → admin user (Firestore `adminSessions/<sha256>` → `users/<uid>`).
4. `/admin/*` → `requireAdmin`: email in `ADMIN_EMAILS`, verified, account active, and a session created with a second factor.
5. `/mail/*` → `requireMail`: `mailSessions/<sha256>` → active mailbox → decrypt the sealed password → JMAP client.
6. Rate limits on admin session creation, webmail login (per IP and per address), sending and password change.
7. A daily cron trigger purges expired sessions.

## Webmail sessions

A JMAP request needs the employee's credentials, so the session document holds the password **sealed with AES-256-GCM** under `MAIL_SESSION_KEY` (a Worker secret). The cookie holds a random token; only its SHA-256 is stored, as the document id. Sessions last 7 days. Logging out, disabling the mailbox or resetting its password deletes the session.
