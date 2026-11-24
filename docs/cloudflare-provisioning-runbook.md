# Cloudflare provisioning runbook

The exact, ordered steps to take a domain from "no webmail" to "staff
sending and receiving real mail through this package," as actually
performed for `altasme.com`. Follow this order -- several steps fail if
done out of sequence (noted inline).

Placeholders used below: `<domain>`, `<account-id>`, `<zone-id>`,
`<database-name>`, `<database-id>`, `<worker-name>`, `<bucket-name>`.

## 0. Before touching anything: check for existing live mail

**Do this first, always.** Query the zone's current MX records
(`GET /zones/<zone-id>/dns_records?type=MX`) before assuming the domain
has no mail setup. If real MX records already point somewhere (a previous
host, Google Workspace, Purelymail, Titan, anything), **confirm directly
with the business owner** whether those addresses are actively used
before touching DNS. Cloudflare Email Routing's own `enable` endpoint will
refuse to run while foreign MX records exist, which is a deliberate safety
net, not a bug -- but you can still delete those records yourself and
cause real mail loss if you skip this check. Get explicit, affirmative
confirmation ("yes, fully migrate, nothing else should receive mail at
this domain afterward") before proceeding past step 4.

Also check for existing SPF/DKIM TXT records on the root domain at this
point (`GET /zones/<zone-id>/dns_records?type=TXT`) -- you'll need to
reconcile these in step 5, and knowing what's there up front avoids
surprises.

## 1. The Cloudflare API token

A single token can cover this whole runbook, but Cloudflare splits its
permission groups more finely than you'd expect. **Create (or edit) a
token scoped to the specific zone**, with these permission groups, under
**Account** and **Zone** respectively:

| Scope | Permission | Why |
|---|---|---|
| Zone | DNS → Edit | MX/SPF/DKIM records |
| Zone | Email Routing Rules → Edit | the actual routing rule (catch-all → Worker). **This is a *different* permission group from the one that lets you enable Email Routing and read its settings/DNS recommendations** -- the general status/enable/DNS-recommendation endpoints work with other zone permissions already in place, but `GET`/`PUT` on `/zones/<id>/email/routing/rules*` specifically returns `403 Authentication error` without this exact group. This was the single most time-consuming permission gap in the original setup -- if routing rules 403 after you've "already added Email Routing permissions," this specific group is almost certainly the missing one. |
| Account | Workers Scripts → Edit | deploying the standalone inbound Worker |
| Account | Cloudflare Pages → Edit | binding R2/env vars/secrets to your Pages project, triggering redeploys |
| Account | Workers R2 Storage → Edit | creating the attachments bucket |
| Account | D1 → Edit | applying the schema, creating the first mailbox row |
| Account | Account Settings → Read | general account/zone lookups |

Verify the token works before relying on it:

```bash
curl -s https://api.cloudflare.com/client/v4/user/tokens/verify
```

If a permission is missing, you'll see `403 {"code":10000,"message":"Authentication error"}` on that *specific* endpoint while everything else keeps working -- a very misleading symptom if you assume one failure means the whole token is bad. Check each resource (DNS, email routing rules, D1, R2, Workers, Pages) independently.

## 2. D1 schema

Apply `schema/mail-schema.sql` from this package to the database your app
already uses (not a new one, unless this is a brand-new app):

```bash
npx wrangler d1 execute <database-name> --remote --file=./mail-schema.sql
```

Do this **before** deploying any code that queries these tables -- every
route and the inbound Worker assume the tables already exist and will
fail with "no such table" otherwise.

## 3. R2 bucket + bindings

```bash
# create the bucket
curl -s -X POST https://api.cloudflare.com/client/v4/accounts/<account-id>/r2/buckets \
  -H "Content-Type: application/json" -d '{"name":"<bucket-name>"}'
```

Bind it to your Pages project as `MAIL_ATTACHMENTS`. The Pages API's
`PATCH /accounts/<account-id>/pages/projects/<project>` endpoint has two
sharp edges worth knowing up front:

- It will reject the request with `fail_open must be set equally for
  production and preview` unless you include **both** environments'
  `deployment_configs` in the same PATCH body, even if you're only
  changing production. Fetch the full project config first, modify only
  what you need, and send both `production` and `preview` back.
- A Pages env var change **does not apply retroactively** to the current
  live deployment. After patching, trigger a fresh deploy:
  `POST /accounts/<account-id>/pages/projects/<project>/deployments/<latest-deployment-id>/retry`.

## 4. Deploy the inbound/retry Worker

Fill in `wrangler.toml`'s D1 binding with your real database name/id (get
it via `GET /accounts/<account-id>/d1/database/<database-id>` if you only
have the id), bind the same R2 bucket, then:

```bash
cd <your-worker-directory>
npm install
npx wrangler deploy
```

This gets you a Worker with D1 + R2 bindings and a cron trigger, but no
SMTP configured yet -- that's fine, inbound storage and manual-retry-free
sends don't need it yet.

## 5. Email Routing: enable, then fix DNS conflicts, then enable again

```bash
curl -X POST https://api.cloudflare.com/client/v4/zones/<zone-id>/email/routing/enable
```

Two specific, named errors you are likely to hit here, in order:

1. **`{"code":2008,"message":"Non-Cloudflare MX records exist"}`** --
   delete the domain's existing MX records first (step 0's confirmation
   should already have happened). Re-run enable.
2. **`{"code":2026,"message":"Multiple SPF records exist"}`** -- SPF
   allows only one TXT record per name; if the root domain has more than
   one `v=spf1 ...` record (common after years of adding different
   providers without ever consolidating), `enable` refuses to run.
   **Consolidate into a single record** before retrying:
   - Fetch `GET /zones/<zone-id>/email/routing/dns` for Cloudflare's
     recommended SPF/DKIM/MX content for this zone.
   - Delete every existing root-domain SPF TXT record.
   - Add **one** new TXT record combining every `include:`/`ip4:`
     mechanism you actually still need (your SMTP provider's, plus
     `include:_spf.mx.cloudflare.net`) ending in the same qualifier
     (`~all` is the usual, non-hard-fail choice). Never add Cloudflare's
     recommended SPF as a second, separate record next to an existing one
     -- merge it into one.

Once `enable` succeeds, re-fetch the zone's MX records to confirm they
now read `route1/2/3.mx.cloudflare.net` and that email routing status is
`"ready"`.

## 6. The actual routing rule

`enable` only sets up DNS and creates a disabled, "drop everything"
catch-all rule. You still need to point that rule at your Worker:

```bash
curl -X PUT https://api.cloudflare.com/client/v4/zones/<zone-id>/email/routing/rules/catch_all \
  -H "Content-Type: application/json" \
  -d '{"name":"Catch-all to <worker-name>","matchers":[{"type":"all"}],"actions":[{"type":"worker","value":["<worker-name>"]}],"enabled":true}'
```

A catch-all to the Worker is usually right even if you only have one
mailbox so far: the Worker itself looks up the envelope recipient against
`mail_accounts` and bounces (550) anything that isn't an active,
inbound-enabled mailbox -- so an address nobody's provisioned yet gets a
clean bounce, not silently dropped mail and not a routing-rule edit every
time you add a mailbox.

## 7. SMTP (outbound)

You need real SMTP credentials from wherever the business already hosts
mail (cPanel, Google Workspace, a dedicated SMTP relay -- anything that
issues an SMTP login). Set, in both places (they must match):

- **Worker**: non-secret `MAIL_SMTP_HOST`/`MAIL_SMTP_PORT`/
  `MAIL_SMTP_USERNAME` in the committed `[vars]` block of `wrangler.toml`;
  the password via `npx wrangler secret put MAIL_SMTP_PASSWORD` (never
  committed, never printed to a terminal you'll keep around).
- **Pages project**: the same three as plain-text env vars via the Pages
  API, and the password as `{"type": "secret_text", "value": "..."}` in
  the same PATCH (so it's a real write-only secret, not retrievable via a
  later `GET` the way a plain-text var would be).

Redeploy both after setting these (the Worker via `wrangler deploy`
again; the Pages project via the deployment-retry call from step 3).

Add an SPF `ip4:`/`include:` mechanism for this SMTP server into the
**same, single** consolidated SPF record from step 5 -- don't create a
second TXT record. If the mail host's dashboard (e.g. cPanel's "Email
Deliverability" page) gives you an exact recommended SPF string, prefer
that exact text over hand-assembling one yourself.

Publish the DKIM record the mail host's dashboard gives you (its own
selector, e.g. `default._domainkey.<domain>`) as a TXT record. **This has
to come from that specific host's dashboard** -- there's no way to derive
or guess it, and a generic Email Routing DKIM record (step 5's
`cf2024-1._domainkey...`) is for Email Routing's own anti-spoofing, not a
substitute for your SMTP relay's DKIM.

## 8. First mailbox

Insert directly via D1 (fastest for the very first bootstrap, before any
UI exists to do it) or through your app's settings UI once deployed:

```sql
INSERT INTO mail_accounts (id, email_address, display_name, created_at, updated_at)
  VALUES ('<uuid>', 'sales@<domain>', 'Display Name', '<iso-now>', '<iso-now>');
INSERT INTO mail_account_access (account_id, user_id, can_send, created_at)
  VALUES ('<that uuid>', '<a real users.id>', 1, '<iso-now>');
```

## 9. Test for real

Nothing in this runbook can be verified from a sandboxed dev environment
with no path to the public internet on SMTP ports -- the first genuine
end-to-end test has to happen against the real deployment:

1. Send a real email to the new mailbox from an external account. Confirm
   it shows up in your app.
2. Reply (or compose new) from your app. Confirm it actually sends
   (check the recipient's inbox, not just your own "sent" folder) and
   doesn't land in spam (SPF/DKIM from step 7 matters here).

See `docs/troubleshooting.md` if either of those fails.
