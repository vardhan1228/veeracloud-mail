# Implementation plan

History: on 2026-11-20 the project changed from a multi-tenant SaaS to an internal mail system for one company, then moved its data from Cloudflare D1 to Firebase Firestore and gained realtime webmail. Domain: **veeracloud.shop**.

Each change ends with `npm run check` (typecheck, lint, tests) passing.

## Done

- **API** (Hono on Workers): admin sessions (Firebase + MFA, admins from `ADMIN_EMAILS`), webmail sessions (sealed mailbox credentials), domains, mailboxes, aliases, audit log, server health, live `/mail/events` stream, daily session purge. CSRF, CORS, rate limits, security headers.
- **Data**: `Store` interface with a Firestore REST implementation (service account, atomic commits, claim documents for uniqueness) and an in-memory implementation for tests and local runs. Firestore rules deny all client access.
- **Mail server adapter**: Stalwart management API, JMAP client, JMAP push (EventSource), development mock with live change feed.
- **Admin console**: overview with server health, employees (create with generated password, edit, disable, reset password, delete), aliases, domains with copyable DNS records, audit log, email-verification flow.
- **Webmail**: realtime inbox (push, unread count in tab title, desktop notifications), avatars, skeleton loading, undo toasts, keyboard shortcuts (`?` for help), folders, search, paging, sandboxed HTML with blocked remote images, attachments, reply / reply all / forward, drafts, recipient autocomplete, junk / not junk, trash, password change, offline banner; responsive.
- **Delivery**: GitHub Actions CI and deploy-to-Cloudflare workflows; Pages `_headers` with strict CSP.

## Next (needs you)

1. Move `veeracloud.shop` DNS to Cloudflare.
2. Firebase: enable Firestore, deploy the rules, create a service-account key, enable TOTP MFA.
3. Connect GitHub to Cloudflare (API token + account id) and run the deploy workflow.
4. Buy the VPS, install Stalwart, run its checklist. Until then mail screens show "setup required".

See [infrastructure/cloudflare/DEPLOYMENT.md](../infrastructure/cloudflare/DEPLOYMENT.md).

## Later

Rich-text compose, conversation threading, scheduled Firestore exports.
