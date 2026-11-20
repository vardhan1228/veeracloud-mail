# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Internal company email for HAVINS TECHNOLOGIES on the domain **veeracloud.shop**: an admin console and a realtime webmail. Public repo: `github.com/vardhan1228/veeracloud-mail`. [prompt.txt](prompt.txt) is the original multi-tenant SaaS spec and is **superseded** wherever it conflicts with this file:

- **Not a SaaS.** No tenants, plans, billing, payments, public sign-up, customer portal or marketing site. Don't reintroduce them.
- **Two sign-ins only.** Admins: Firebase Authentication + MFA; admin = email listed in the `ADMIN_EMAILS` secret (verified outside development). Employees: mailbox address + password, checked by the mail server.
- **Data in Firebase Firestore** (user's choice), reached only by the Worker through the REST API with a service account. Never message content.
- **Mail server: Stalwart on a Linux VPS** (`mail.veeracloud.shop`): management API for admin actions, JMAP + EventSource push for webmail, built-in spam filter.
- Hostnames live in config only (`wrangler.jsonc`, `_headers`, GitHub Actions variables), not in application code.

Design docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/SECURITY.md](docs/SECURITY.md), [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) (status), [infrastructure/cloudflare/DEPLOYMENT.md](infrastructure/cloudflare/DEPLOYMENT.md), [infrastructure/mail-server/STALWART.md](infrastructure/mail-server/STALWART.md). Keep them in sync with the code.

## Commands

npm workspaces (no pnpm). Run from the repo root:

```sh
npm run check                                  # typecheck + lint + tests (run before finishing any change)
npm test                                       # vitest, all workspaces
npx vitest run apps/api/test/mail.test.ts      # single file
npx vitest run -t "employee webmail"           # by test name
npm run typecheck
npm run lint && npm run format
npm run dev:api                                # wrangler dev on :8787: memory store, mock mail, demo seed
npm run dev:admin / dev:webmail                # Vite on :5174 / :5175, /api proxied to :8787
```

On Windows, run Vitest from a cwd with an uppercase drive letter (`C:\`). With `c:\` it loads twice and every suite fails with "reading 'config'".

Local dev: `DATA_STORE=memory` (resets on restart) and `DEV_SEED=true` create `priya@company.test` / `ravi@company.test` (password `Welcome-2026!`). `ADMIN_EMAILS=admin@company.test` in dev vars; that Firebase user exists in project `mail-auth-dd889`. `DEV_ALLOW_ADMIN_WITHOUT_MFA`, `DATA_STORE=memory`, `DEV_SEED` and `FIRESTORE_EMULATOR_HOST` work only when `ENVIRONMENT=development`. `apps/api/.dev.vars` needs `MAIL_SESSION_KEY`.

npm 11 blocks install scripts. Only `esbuild` and `workerd` are approved (`npm approve-scripts`).

## Architecture

- `apps/api`: Hono Worker. `createApp(getDeps)`; every external dependency (Store, Firebase verifier, mail provider, credential sealer, Turnstile, rate limiter, clock) is injected through `Deps` in `src/env.ts`. `src/index.ts` builds real deps (and the cron `scheduled` handler); `test/helpers.ts` builds fakes. New external calls must go through `Deps`.
- Routes: `/auth/*` (admin session exchange), `/admin/*` (`requireAdmin`), `/mail/*` (`requireMail` opens a JMAP client as the employee), `/mail/events` (SSE).
- `packages/database`: `Store` interface (`get`/`query`/`count`/atomic `commit` with create/update preconditions), `FirestoreStore` (REST + service-account token via jose), `MemoryStore`, and the collection schema `C`. No composite indexes: look up by id, equality or single-field range filters only, sort small collections in code. Uniqueness via `claims/address:*` and `claims/domain:*` created in the same commit. `@havins/database/testing` → `createTestStore()`.
- `packages/email-provider`: `EmailProvider` (`admin: MailAdmin` + `authenticate() → MailClient`, which includes `watch()` for live events). `StalwartProvider`, `MockEmailProvider` (stores in the Store, dev only) and `createEmailProvider` (throws `ProviderNotConfiguredError` → 503 `provider_not_configured`; refuses `mock` in production).
- `packages/ui`: Tailwind v4 tokens, components (`Dialog`, `Avatar`, `ToastProvider`/`useToast`, `SkeletonRows`, `Kbd`), `AuthScreen`, `client.ts` (`api()`, `apiUpload()`, `useApi`, Firebase sign-in, hash router, `useOnline`).
- `apps/admin`, `apps/webmail`: React + Vite, hash routes, `useApi`. Webmail realtime lives in `apps/webmail/src/live.ts`.
- `.github/workflows`: `ci.yml` (checks), `deploy.yml` (main → Worker + Pages `veeracloud-admin` / `veeracloud-webmail`; skipped until `CLOUDFLARE_ACCOUNT_ID` is set).

## Hard rules

- Never fake success for mail delivery, domain setup or mailbox creation. If no mail server is configured, show "setup required". The mock is development-only.
- Don't invent API keys, DNS records, SMTP credentials or production config. Secrets go in `wrangler secret put` or GitHub secrets, never in files: the repo is **public**. Admin email addresses are a secret (`ADMIN_EMAILS`), not a var.
- Never store mailbox passwords in plain text or log them, and never store or log message bodies. Webmail session credentials are sealed with AES-GCM. Tests dump the store and assert passwords are absent.
- Email HTML renders only in a sandboxed iframe (no `allow-scripts`, no `allow-same-origin`), remote images blocked by default.
- Audit-log sensitive operations: `auditInsert(c, …)` inside the same `db.commit([...])` as the change.
- DNS: MX and mail-server host records must be DNS-only (grey cloud).
- Cost target is about ₹2,000/month. Disclose free-tier limits (Workers, Firestore Spark quotas).
- Every UI needs loading, success, error, empty and responsive states. Webmail also needs an offline state.
