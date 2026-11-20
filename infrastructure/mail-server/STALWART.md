# Mail server: Stalwart on a Linux VPS

Cloudflare Workers cannot run SMTP or IMAP, so mail itself lives on one Linux VPS running [Stalwart Mail Server](https://stalw.art). Stalwart provides SMTP (in and out), IMAP, JMAP (used by our webmail), its own spam filter, DKIM signing and a management REST API (used by our admin console). The Worker reaches it over HTTPS only.

Nothing here assumes a domain, VPS or credentials already exist.

## 1. Pick a VPS

- 2 vCPU, 4 GB RAM and 40+ GB disk is enough for a small company. Grow the disk with your mail volume.
- **Outbound port 25 must be open.** Many providers block it on new accounts and unblock it on request; some never do. Confirm this before you buy.
- **Reverse DNS (PTR)** must be settable to your mail host name (e.g. `mail.veeracloud.shop`). Without it, Gmail and Outlook reject or junk your mail.
- Use a static IPv4 address. Check it against public blocklists before using it.
- Prices change. Check the provider's current pricing and keep the total within the ₹2,000/month target (see [../cloudflare/DEPLOYMENT.md](../cloudflare/DEPLOYMENT.md)).

## 2. Install

Follow Stalwart's official Linux install guide for the current version. During setup:

1. Set the server host name to `mail.veeracloud.shop`.
2. Note the generated **fallback admin** user and password. You need them in step 4.
3. Open ports 25 (SMTP), 465 and 587 (submission), 993 (IMAPS) and 443 (HTTPS: JMAP, management API, TLS certificates). Keep everything else closed.
4. Let Stalwart obtain a TLS certificate through ACME for `mail.veeracloud.shop`. The DNS record for `mail.veeracloud.shop` must be **DNS only (grey cloud)** in Cloudflare, otherwise ports other than 443 do not work.

## 3. Admin console account for the API

The Worker authenticates to the management API with HTTP Basic credentials. Prefer a dedicated admin principal (or API key) over the fallback admin. Store its credentials only as Worker secrets:

```sh
cd apps/api
npx wrangler secret put STALWART_ADMIN_USER --env production
npx wrangler secret put STALWART_ADMIN_PASSWORD --env production
```

`STALWART_URL=https://mail.veeracloud.shop` and `MAIL_PROVIDER=stalwart` are already set in `wrangler.jsonc` for production.

## 4. Verify the API before going live

The adapter in `packages/email-provider/src/stalwart/` was written against Stalwart's management API (v0.11+). Endpoints change between versions, so check each call against your server once:

| Admin console action      | Stalwart call                                                             |
| ------------------------- | ------------------------------------------------------------------------- |
| Add domain                | `POST /api/principal` (type `domain`), then `POST /api/dkim` (Ed25519)    |
| DNS records shown         | `GET /api/dns/records/<domain>`                                           |
| Delete domain             | `DELETE /api/principal/<domain>`                                          |
| Create mailbox            | `POST /api/principal` (type `individual`, name = full address)            |
| Edit / disable / password | `PATCH /api/principal/<address>`                                          |
| Delete mailbox            | `DELETE /api/principal/<address>`                                         |
| Add / remove alias        | `PATCH /api/principal/<address>` (`addItem` / `removeItem` on `emails`)   |
| Health                    | `GET /healthz/ready`                                                      |
| Webmail                   | JMAP session at `/.well-known/jmap` with the employee's own credentials   |
| Live updates              | JMAP `eventSourceUrl` from the session (types `Email,Mailbox`, ping 30 s) |

Checklist:

- [ ] Admin console → Overview shows the mail server as **Reachable**.
- [ ] Add your domain. The DNS records card lists MX, SPF, DKIM and DMARC.
- [ ] Publish those records. Test with an external checker (MX lookup, DKIM, DMARC).
- [ ] Create a test mailbox, sign in to webmail, send to and receive from an outside Gmail address.
- [ ] Check the received headers in Gmail: SPF, DKIM and DMARC all `pass`.
- [ ] With webmail open, send it a message from Gmail: it appears within seconds without reloading (live push).
- [ ] Disable the mailbox and confirm webmail and IMAP sign-in are refused.
- [ ] Delete the test mailbox.

## 5. Operations

- **Backups.** Stalwart stores mail on the VPS disk, and Firestore holds only the directory (mailbox list, aliases, audit log). Back up the Stalwart data directory daily, off the VPS (e.g. provider snapshots plus an encrypted copy elsewhere). Do a restore drill before relying on it.
- **Updates.** Apply OS security updates and Stalwart releases regularly. Read Stalwart's release notes for management API changes and re-run the checklist above.
- **Spam.** Stalwart's built-in spam filter scores every incoming message (SPF, DKIM, DMARC, ARC, DNS blocklists, Bayesian learning, phishing and header checks) and moves suspicious mail to Junk. “Report junk” and “Not junk” in webmail move the message between Junk and Inbox. Check Stalwart's spam-filter training settings for your version to have it learn from those moves (Bayesian training). Employees use “Report junk” / “Not junk” in webmail.
- **Phones and Outlook.** Employees can also use IMAP (993) and SMTP submission (587/465) with the same address and password.
