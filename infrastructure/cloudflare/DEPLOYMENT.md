# Deployment: veeracloud.shop on Cloudflare + Firebase + Stalwart

Code lives at `github.com/vardhan1228/veeracloud-mail`. Every push to `main` runs the checks and, once Cloudflare is connected, deploys the API Worker and both Pages sites (`.github/workflows/deploy.yml`). The mail server is covered in [../mail-server/STALWART.md](../mail-server/STALWART.md).

Order: 1 → 2 → 3 → 4 → 5. Steps 1–4 make the admin console and webmail live (mail shows "setup required"); step 5 makes mail work.

## 1. Domain DNS on Cloudflare

1. Cloudflare dashboard → **Add a site** → `veeracloud.shop` → Free plan. Check the imported records.
2. At the registrar (GoDaddy → the domain → DNS → **Nameservers** → Change), enter the two Cloudflare nameservers. Propagation can take 24–48 hours. Wait until Cloudflare shows the zone as **Active**.

## 2. Firebase (admin sign-in + Firestore)

Project: `mail-auth-dd889`.

1. **Authentication** → Sign-in method → **Email/Password** on. Settings → Authorized domains → add `admin.veeracloud.shop`. Settings → User actions → turn **off** "Enable create (sign-up)" so only accounts you add exist.
2. **MFA** (required in production): upgrade to the Blaze plan (a handful of admins stays inside the free allowance), then Authentication → Sign-in method → Multi-factor → enable **TOTP**.
3. **Firestore**: Build → Firestore Database → Create database → **production mode** → location `asia-south1` (Mumbai) or the closest to you. Location cannot be changed later.
4. **Rules**: from the repo, `npx firebase login` then `npx firebase deploy --only firestore:rules`. The rules deny all browser access; only the Worker's service account can read or write.
5. **Service account key**: Project settings → Service accounts → **Generate new private key**. Keep the file off GitHub (it is git-ignored by name, but store it outside the repo). You load it into the Worker in step 3 and then can delete it.

Free-tier (Spark) Firestore limits: 50,000 reads, 20,000 writes and 20,000 deletes per day, 1 GiB stored. Each webmail request reads about two documents (session + mailbox), so a 20-person company uses a few thousand reads a day. On Blaze, usage beyond the free tier is billed.

## 3. Cloudflare Worker secrets

```sh
cd apps/api
npx wrangler login
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT --env production   # paste the whole key JSON
npx wrangler secret put ADMIN_EMAILS --env production               # e.g. you@veeracloud.shop,owner@gmail.com
npx wrangler secret put MAIL_SESSION_KEY --env production           # node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
npx wrangler secret put TURNSTILE_SECRET_KEY --env production       # optional; then also set VITE_TURNSTILE_SITE_KEY
```

The first deploy creates the Worker, so if `secret put` says the Worker does not exist, run step 4 first and come back. Stalwart secrets are added in step 5.

## 4. Connect GitHub to Cloudflare

1. Cloudflare → My Profile → **API Tokens** → Create token → "Edit Cloudflare Workers" template, then add **Cloudflare Pages: Edit**. Scope it to your account and the `veeracloud.shop` zone.
2. GitHub repo → Settings → Secrets and variables → Actions:
   - Secret `CLOUDFLARE_API_TOKEN` = the token.
   - Variable `CLOUDFLARE_ACCOUNT_ID` = Cloudflare dashboard → Workers & Pages → Account ID.
   - Variables `VITE_FIREBASE_*` and `VITE_API_URL=https://api.veeracloud.shop` are already set.
3. Actions → **Deploy to Cloudflare** → Run workflow (or push to `main`).
4. Cloudflare → Workers & Pages → `veeracloud-admin` → Custom domains → add `admin.veeracloud.shop`. Same for `veeracloud-webmail` → `webmail.veeracloud.shop`. The API's `api.veeracloud.shop` is attached automatically by the Worker route.
5. Zero Trust → Access → add an application for `admin.veeracloud.shop` allowing only your admins' emails (free up to 50 users).

Rollback: `npx wrangler rollback --env production` for the API; Pages → Deployments → Rollback for the sites.

## 5. Mail server (makes mail work)

Follow [STALWART.md](../mail-server/STALWART.md), then:

```sh
npx wrangler secret put STALWART_ADMIN_USER --env production
npx wrangler secret put STALWART_ADMIN_PASSWORD --env production
```

`MAIL_PROVIDER=stalwart` and `STALWART_URL=https://mail.veeracloud.shop` are already in `wrangler.jsonc`. Then, in the admin console, add the domain `veeracloud.shop` and publish the DNS records it shows.

## DNS records (Cloudflare → veeracloud.shop → DNS)

| Name               | Type                 | Value                                     | Proxy                |
| ------------------ | -------------------- | ----------------------------------------- | -------------------- |
| `admin`            | CNAME                | added by the Pages custom domain          | **Proxied** (orange) |
| `webmail`          | CNAME                | added by the Pages custom domain          | **Proxied** (orange) |
| `api`              | Worker custom domain | added by the Worker route                 | **Proxied** (orange) |
| `mail`             | A                    | the VPS IPv4 address                      | **DNS only** (grey)  |
| `@`                | MX                   | from the admin console's DNS records card | n/a                  |
| SPF / DKIM / DMARC | TXT                  | from the admin console's DNS records card | n/a                  |

`mail` must be **DNS only**: Cloudflare's proxy carries only HTTP(S), so a proxied mail host breaks SMTP and IMAP. Also set the VPS's reverse DNS (PTR) to `mail.veeracloud.shop` at the VPS provider.

## Monthly cost (target about ₹2,000)

Check current pricing; it changes.

| Service                  | Free tier                                                  | When you pay                                        |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------- |
| VPS (Stalwart)           | none                                                       | **The main cost**: a 2 vCPU / 4 GB VPS plus backups |
| Workers                  | 100k requests/day, 10 ms CPU/request                       | Workers Paid $5/month (≈ ₹450) if exceeded          |
| Pages, Turnstile, Access | free (Access: 50 users)                                    | n/a                                                 |
| Firestore                | 50k reads / 20k writes per day, 1 GiB                      | per-operation on Blaze beyond that                  |
| Firebase Auth            | email/password free; TOTP MFA needs Blaze (free allowance) | rarely for a few admins                             |

Free-plan limit to know: a Worker invocation may make 50 subrequests. Each live webmail stream uses one long-lived subrequest to Stalwart and is recycled every 5 minutes, so it stays well inside that.
