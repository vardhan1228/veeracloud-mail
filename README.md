# HAVINS TECHNOLOGIES: company mail on veeracloud.shop

Internal email for one company. Administrators manage domains, employee mailboxes and aliases in the admin console. Employees read and send mail in a realtime webmail (or any IMAP/SMTP app).

- **Cloudflare**: API on Workers (`api.veeracloud.shop`), admin console and webmail on Pages.
- **Firebase**: Authentication for admins (with TOTP MFA) and Firestore for the company directory and audit log.
- **Stalwart** on a Linux VPS (`mail.veeracloud.shop`): SMTP, IMAP, JMAP, built-in spam filter, DKIM.

| Doc                                                                                |                                                      |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)                                       | How it fits together, data layer, realtime           |
| [docs/SECURITY.md](docs/SECURITY.md)                                               | Auth, sessions, data protection, launch checklist    |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)                         | Status and next steps                                |
| [infrastructure/cloudflare/DEPLOYMENT.md](infrastructure/cloudflare/DEPLOYMENT.md) | Go live: DNS, Firebase, secrets, GitHub → Cloudflare |
| [infrastructure/mail-server/STALWART.md](infrastructure/mail-server/STALWART.md)   | Mail server setup and checklist                      |

## Local development

Requires Node 22.12+.

```sh
npm install
cp apps/api/.dev.vars.example apps/api/.dev.vars   # then fill in MAIL_SESSION_KEY
npm run dev:api        # API on http://localhost:8787 (memory store + mock mail server + demo data)
npm run dev:admin      # admin console on http://localhost:5174
npm run dev:webmail    # webmail on http://localhost:5175
```

Demo data (development only, recreated whenever the API restarts):

- Webmail: `priya@company.test` / `Welcome-2026!` and `ravi@company.test` / `Welcome-2026!`. Mail between them arrives live.
- Admin console: any Firebase account whose email is in `ADMIN_EMAILS` (`wrangler.jsonc` → `vars`). The admin console reads Firebase settings from `apps/admin/.env.local` (see `.env.example`).

To use real Firestore locally, put `FIREBASE_SERVICE_ACCOUNT` in `apps/api/.dev.vars` and set `DATA_STORE=firestore`.

The mock mail server delivers only between local mailboxes. Sending to the internet needs Stalwart (see the mail server guide).

## Checks

```sh
npm run check          # typecheck + lint + tests
npx vitest run apps/api/test/mail.test.ts
npx vitest run -t "live change"
```

On Windows, run tests from a terminal whose path starts with an uppercase drive letter (`C:\...`). With `c:\...`, Vitest loads twice and every suite fails with `Cannot read properties of undefined (reading 'config')`.

## Deploy

Pushes to `main` run CI and deploy to Cloudflare through GitHub Actions once the repository has the `CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable. See the deployment guide.
