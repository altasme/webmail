# Troubleshooting

Real issues hit during the first real-world setup of this package,
in the order you're likely to hit them.

## "Authentication error" (403) on *some* Cloudflare API endpoints, not all

**Symptom:** `GET /zones/<id>/email/routing` returns `200`, but
`GET /zones/<id>/email/routing/rules` returns
`{"code":10000,"message":"Authentication error"}` with the exact same
token.

**Cause:** Cloudflare splits Email Routing into separate permission
groups -- the general settings/status/DNS-recommendation surface is one
group, and **Email Routing Rules** (actually creating/editing routing
rules) is a different one. Adding "Email Routing" permissions in the
dashboard doesn't necessarily mean you added the Rules group specifically
-- the dropdown has multiple similarly-named options (Rules, Addresses,
and whatever covers plain enable/DNS).

**Fix:** Edit the token, add exactly **Zone → Email Routing Rules →
Edit**, scoped to the zone in question. Don't assume a previous "I added
Email Routing permissions" pass covered this -- re-check the specific
`/rules` endpoint directly:

```bash
curl -s https://api.cloudflare.com/client/v4/zones/<zone-id>/email/routing/rules
```

A `200` with a JSON array (even an empty one, or one `drop` rule) means
it's fixed. A `403` means it's still missing.

## Email Routing `enable` fails with "Multiple SPF records exist"

**Symptom:** `POST /zones/<id>/email/routing/enable` returns
`{"code":2026,"message":"Multiple SPF records exist"}`.

**Cause:** A domain with history (a previous host, a migrated provider,
an old test setup) very often has more than one `v=spf1 ...` TXT record
on the root name. SPF only tolerates one; Cloudflare refuses to add its
own on top of an already-ambiguous setup rather than make it worse.

**Fix:** List every TXT record on the root domain, find all the ones
starting with `v=spf1`, delete all of them, then create exactly **one**
new TXT record that combines every mechanism you still need (your SMTP
provider's `include:`/`ip4:`, plus Cloudflare's own
`include:_spf.mx.cloudflare.net`), ending in one qualifier. Then retry
`enable`.

Don't be tempted to just add Cloudflare's recommended record alongside
the existing one(s) "to be safe" -- that makes the actual problem worse,
not better.

## Email Routing `enable` fails with "Non-Cloudflare MX records exist"

**Cause:** exactly what it says -- `enable` won't overwrite MX records it
didn't put there itself, on purpose (this is the main safety net
protecting you from accidentally nuking a domain's real, live mail setup
mid-automation).

**Fix:** delete the old MX records yourself first (after getting
explicit confirmation they're safe to remove -- see the runbook's step
0), then retry `enable`. It will then add its own three
`route1/2/3.mx.cloudflare.net` records automatically.

## Outbound send fails with `AUTH rejected: 535`

**What this actually means:** the SMTP client reached the server and the
server's own authentication step explicitly rejected the login. This is
**not** a bug in this package's SMTP client -- the error is deliberately
redacted (no AUTH payload, no session transcript ever appears in a
thrown error or a log line, by design, see `src/smtp.ts`), so `535` with
no further detail is the *correct*, intentional shape of this failure,
not a sign something's broken in how the error was reported.

**Diagnose, in order:**

1. **Confirm the credentials actually work at all**, independent of this
   package -- log into the mail host's webmail UI (or any other IMAP/SMTP
   client) with the exact same username/password. If that also fails,
   the password is wrong or has changed; get the current one from the
   mail host directly, don't guess or reuse an old one.
2. If webmail login works fine but SMTP AUTH from the Worker still
   doesn't, check the mail host's dashboard for anything that restricts
   SMTP auth by source IP or flags unfamiliar senders (some hosts apply
   stricter rules to a brand-new sending IP than to IMAP/webmail login) --
   Cloudflare Workers' outbound IPs are dynamic and won't be on any
   allowlist by default.
3. Double-check `MAIL_SMTP_PORT` actually matches the security mode you
   intend: 465 defaults to implicit TLS, 587 to STARTTLS. Mismatching
   port and security mode against what the server expects can also
   surface as an auth-stage failure rather than a clearer connection
   error, depending on the server.

**Once the password changes:** it has to be updated in **two** places
(the Worker's secret *and* the Pages project's secret), and **both** need
a fresh deploy to actually pick up the change -- a Pages env var/secret
change does not apply to an already-running deployment.

## DKIM: don't invent it, don't skip it

There's no way to derive a correct DKIM record yourself -- it's a real
public key the mail host's own system generated and expects published
verbatim. Get it from that host's dashboard (cPanel calls this page
"Email Deliverability"; other hosts have an equivalent). Skipping DKIM
entirely still mostly works (SPF alone covers a lot), but meaningfully
hurts deliverability and can fail DMARC alignment checks some receivers
apply.

## A sandbox/dev environment can't verify any of this end to end

If you're setting this up from an environment with no outbound network
path to arbitrary SMTP ports (most sandboxed dev containers, including
the one this package was originally built from), you cannot test real
SMTP connect/AUTH/send from that environment at all -- `connect()` will
simply fail with a connection-refused-style error regardless of whether
the real setup is correct. This is expected, not a sign anything's wrong.
The only real test is against the actual deployed Worker/Pages app, per
the runbook's step 9.
