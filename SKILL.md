---
name: webmail-setup
description: Set up a real, production business webmail module (inbound via Cloudflare Email Routing + a standalone Worker, outbound via raw SMTP) in a Cloudflare Pages/D1 app, using @altasme/webmail-kit. Use when asked to add staff email/webmail, set up business email, or wire up Cloudflare Email Routing for a project.
---

# Webmail setup

This skill sets up a full staff webmail module (inbox/sent/drafts/
starred/archive/junk/trash, threading, search, labels, attachments,
signatures, multiple sender identities, SMTP sending with tracked
retries, inbound mail via Cloudflare Email Routing) in a Cloudflare
Pages + D1 app, reusing `altasme/webmail` (`@altasme/webmail-kit`)
instead of rebuilding any of it from scratch.

**Read `docs/architecture.md` in that repo before writing any code** --
it explains the two-deployable-unit shape (your Pages app + a separate
standalone Worker) and why it has to be that shape, the data model, the
security measures the package already implements for you, and the thin-
wrapper pattern for wiring routes.

## 1. Confirm scope before building anything

Ask (don't assume) if these aren't already answered:

- **Whose mailboxes?** This package is for one business's own staff
  mailboxes, not per-client/multi-tenant mail. If the request is actually
  for per-client/tenant mail, this package's schema (no `tenant_id`
  anywhere) doesn't fit as-is -- flag that before proceeding.
- **Does the domain already have live mail?** Check current MX records
  before assuming it's safe to touch DNS -- see
  `docs/cloudflare-provisioning-runbook.md` step 0. If real MX records
  already point somewhere, get explicit confirmation before migrating
  (not an implicit "well they said set it up").
- **Outbound mechanism**: real SMTP credentials (this package's approach)
  or something else? If the project already uses an HTTP email API
  (Resend, etc.) for other transactional mail, that's unrelated and
  should stay untouched -- this is a separate, additional capability, not
  a replacement, unless told otherwise.
- **Which mailbox addresses** to provision first (e.g. `hello@`,
  `support@`, `sales@`) and who should have access to each.

## 2. Install the package

```bash
npm install github:altasme/webmail
```

Pin to a specific tag/commit in `package.json` once a stable point
exists, rather than tracking `main` indefinitely -- a dependency that can
silently change underneath a production app is worse than a slightly
stale one. Check this repo's tags/releases first.

## 3. Apply the schema

Copy `schema/mail-schema.sql` into the consuming app's own schema file
(or run it standalone) and apply it to the **real, already-used**
database -- not a new one, unless this genuinely is a brand-new app. It
requires a `users` table with a TEXT `id` primary key to already exist.
See the file's own header comment for the exact `wrangler d1 execute`
command, and the runbook's step 2.

## 4. Build the standalone inbound/retry Worker

A new deployable unit is required (not a Pages Function) -- see
`docs/architecture.md`'s "The two deployable units" section for why. Copy
the shape of `altasme/clientkeeper`'s `mail-worker/` directory (its own
`wrangler.toml`, `package.json` with `postal-mime` as a dependency,
`tsconfig.json`) into the new project, pointing its entry at
`@altasme/webmail-kit/worker`'s default export (or compose your own entry
from `processInbound`/`processDueSendJobs`/`cloudflareSmtpTransport` if
you need custom behavior -- don't fork the file to add a small tweak).

## 5. Wire routes in the Pages app

Thin wrappers using `mailHandler()` -- see `docs/architecture.md`'s
"Wiring routes in your app" section for the exact pattern and a worked
example. `altasme/clientkeeper`'s `functions/api/app/mail/` has ~35 real
route files if a complete reference is useful; each is a short wrapper,
not something to copy wholesale without adapting the auth/path
conventions to the new app.

## 6. Build the frontend

Not provided by this package (see `docs/architecture.md`'s "What this
package deliberately does NOT include"). Either build fresh against
whatever component system the project already uses, or copy
`altasme/clientkeeper`'s `src/components/mail/*` as a structural
starting point (three-pane desktop, drawer-based mobile, composer with
autosave, settings) and restyle.

## 7. Provision the real Cloudflare infrastructure

Follow `docs/cloudflare-provisioning-runbook.md` **in order** -- several
steps genuinely fail if done out of sequence (schema before Worker
deploy, MX/SPF cleanup before Email Routing `enable`, routing rule after
`enable`, etc.). It documents the exact Cloudflare API permission groups
needed (including a real gotcha: Email Routing Rules is a separate
permission group from general Email Routing settings) and the exact
commands.

If anything fails during provisioning, check
`docs/troubleshooting.md` first -- it covers the specific failures
already hit once for real (`535` AUTH rejections, "Multiple SPF records
exist," the Email Routing Rules permission split) before re-deriving a
fix from scratch.

## 8. Test for real, not just a local build

Nothing about real SMTP delivery, real Email Routing, or real DNS
propagation can be verified from a sandboxed dev environment with no path
to the public internet on SMTP ports. Say so plainly rather than implying
it's been tested end to end. The actual test is: send a real email to the
new mailbox from an outside account and confirm it's received; send one
out from the app and confirm the recipient actually gets it (not just
that the UI says "accepted").

## Reporting back

Be explicit and honest about what's genuinely verified vs. what's
provisioned-but-untested, same as any other build in this ecosystem.
"The schema is applied and the Worker is deployed" is not the same claim
as "a real email was sent and received" -- don't blur the two.
