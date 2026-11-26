# Architecture

This package is a portable Cloudflare Workers/Pages backend for a real
business webmail module: folders, threading, search, labels, attachments,
signatures, several sender identities, SMTP sending with tracked retries,
and inbound mail through Cloudflare Email Routing. It was extracted
unmodified (apart from genericizing two small type dependencies) from
ClientKeeper's `/mail` build for `altasme.com` -- see this repo's own
`docs/cloudflare-provisioning-runbook.md` for the exact live setup, and
`altasme/clientkeeper`'s CLAUDE.md §32 for the original, fuller build
write-up if you want more narrative detail than this doc repeats.

## The two deployable units

A webmail module needs **two separate Cloudflare deployments**, not one,
because of a hard platform constraint: **Cloudflare Email Routing can only
deliver to a Worker's `email()` handler, never to a Pages Function, and
Pages Functions have no cron.**

1. **Your existing Pages app** (or any Pages Functions app) imports this
   package's default export (`.`) and wires HTTP routes behind your own
   auth. This is where staff actually read/search/compose/send mail.
2. **A new, standalone Worker** -- not part of your Pages project -- built
   from `@altasme/webmail-kit/worker`. It does two jobs:
   - `email()`: Cloudflare Email Routing delivers inbound mail here. It's
     parsed, deduped, threaded, and stored in D1/R2.
   - `scheduled()`, once a minute: retries due outbound sends, reaps sends
     stuck mid-flight (crashed after `DATA` but before a final SMTP
     reply), and purges Trash after 30 days.

**Both bind the exact same D1 database (as `DB`) and the exact same
private R2 bucket (as `MAIL_ATTACHMENTS`).** They both import this same
package, so both writers produce identical rows -- there's no risk of the
Worker and your Pages app disagreeing about what a message record looks
like.

## Data model

See `schema/mail-schema.sql` for the real, documented table definitions.
In short:

- `mail_accounts` is the mailbox identity (e.g. `sales@yourdomain.com`).
  **Which addresses exist is data, not code** -- you add a row, you don't
  hardcode an address list anywhere.
- `mail_account_access` is the explicit, per-staff-member grant list.
  **Default is nobody.** A staff role alone (even "owner") implies nothing
  about mailbox access; owner/admin grant access to specific mailboxes,
  including to themselves.
- `mail_messages` holds every real email (inbound or outbound). Drafts are
  separate (`mail_drafts`) until actually sent.
- `mail_send_jobs` is the outbound pipeline: a job and its message row are
  written in the **same D1 batch**, before any SMTP traffic, so a message
  can never be "sent" without a database record of the attempt.
- There is no `tenant_id` anywhere. This schema is for **one business's
  own staff mailboxes**, not per-client/multi-tenant mail. If you need
  multi-tenant mail, this isn't that -- you'd need to add a tenant
  dimension throughout, which this package does not do for you.

## Inbound flow (`src/worker/inbound.ts`)

Envelope recipient → optional `+tag` stripped → looked up against active,
inbound-enabled `mail_accounts`. No match → `message.setReject("550 ...")`,
an explicit bounce, never a silent drop. The raw `.eml` is written to R2
**first**, then parsed with `postal-mime` (small, built for Workers,
isomorphic so it's unit-testable in Node too). Deduping uses the
normalized Message-ID, with a SHA-256 fallback over sender/date/subject/
body for mail that lacks one. Threading comes from In-Reply-To then
References, **never from the subject alone**. Message, recipients,
attachments, thread bookkeeping and an audit event are inserted in one
transactional `db.batch()`. On any processing error, the raw copy is kept,
a failure row is recorded, and the message is either forwarded to a
configured fallback address or the error is re-thrown so the delivery
fails visibly -- a message is never silently accepted and then lost.

**Junk filtering is honest about what Email Routing actually gives you**:
it records SPF/DKIM/DMARC results but no spam score, so only a DMARC
failure files a message in Junk. An SPF-only failure doesn't, because
forwarding (including through Cloudflare Email Routing itself) legitimately
breaks SPF for mail that's otherwise fine.

## Outbound flow (`src/smtp.ts`, `src/send.ts`, `src/smtpTransport.ts`)

A **real SMTP client over `cloudflare:sockets`** (not an HTTP email API):
greeting, EHLO, STARTTLS (587) or implicit TLS (465), AUTH PLAIN or LOGIN
(whichever the server advertises), MAIL FROM (with SIZE), RCPT TO, DATA
(dot-stuffed), QUIT. Port 25 is blocked platform-wide by Cloudflare, so
outbound SMTP is always 465 or 587. Plaintext (`security: "none"`) is
refused unless the host is `localhost`, so a misconfiguration can't
silently send credentials over an unencrypted connection.

The first send attempt runs **inline in the HTTP request** that triggers
it (so the UI gets an immediate accepted/failed answer); later retries
need the standalone Worker's cron -- **if that Worker isn't deployed,
scheduled retries simply won't run** (manual retry still works from the
UI). Outcomes:

- 4xx / network error / timeout before end-of-data → `retry_scheduled`
  with exponential backoff (±20% jitter), up to a configurable attempt cap.
- 5xx, missing SMTP config, or a vanished attachment → `failed`, never
  auto-retried.
- Connection lost **after** end-of-data, or a job still `sending` past its
  lease → `failed` with an **"outcome unknown"** reason, never
  auto-resent, because the server may already have accepted it -- a human
  decides whether to retry, since retrying a message that already went
  out would double-send it.
- Every attempt is logged. **The UI should only ever say "accepted by the
  mail server," never "delivered"** -- SMTP's 250 response means the
  destination server took responsibility for the message, not that a
  human read it.

`idempotency_key` (client-generated, one per compose session) makes a
double-click or a retried HTTP request return the existing job instead of
sending the same message twice.

## Security measures this package implements for you

- **Sender identity is never taken from request input.** Your route
  handler should resolve `From` from the database (the mailbox's own
  `mail_accounts.email_address`), never from anything the client sent.
- **Inbound HTML gets two layers before a human ever sees it**:
  1. `src/sanitize.ts`'s server-side allowlist sanitizer (built on
     Workers-native `HTMLRewriter`) drops `script`/`iframe`/`object`/
     `embed`/form controls/`svg`/`math`/`meta`/`link`/`base` with their
     content, strips every `on*` handler and every non-allowlisted
     attribute, keeps only `http`/`https`/`mailto`/`tel` links (forced to
     `target=_blank rel="noopener noreferrer"`), and strips
     `@import`/`expression()`/`behavior`/`javascript:`/`position:fixed`
     from CSS.
  2. **Your frontend must still render the result inside a sandboxed
     `<iframe srcdoc>` without `allow-scripts`**, plus a CSP meta
     (`script-src 'none'`). This package sanitizes the HTML; it does not
     render it for you, so step 2 is on your app.
- **Remote images should be blocked by default** with an explicit
  per-message "load remote images" action -- this package's sanitizer
  supports that policy; wire the toggle into your UI.
- **Attachments have no public URL, ever.** `src/storage.ts` only ever
  returns R2 object keys. Downloads from your app should always be
  `application/octet-stream` with `Content-Disposition: attachment`,
  `X-Content-Type-Options: nosniff`, and a sandboxed CSP; inline preview
  should be limited to a short allowlist (e.g. png/jpeg/gif/webp/pdf/
  plain text) and HTML/SVG should never be previewed inline.
- **SMTP credentials never leave the server.** `src/config.ts`'s
  `smtpStatus()` returns only `"configured" | "not_configured"`, nothing
  in any error message includes a credential, and `src/smtp.ts` redacts
  the AUTH exchange from thrown errors (`AUTH rejected: 535` with no
  further detail is the correct, intentional shape of that error).
- **Header injection is rejected** in addresses, Message-ID/In-Reply-To/
  References and the subject (CR/LF collapsed) -- see `src/address.ts`.
- **Authorization is per-mailbox, not per-staff-role.** Every message,
  thread, draft, label and attachment access should be checked against
  `mail_account_access` (`src/access.ts`'s `loadAccess()`/
  `scopeAccountIds()`) on every request, and a resource whose mailbox the
  caller can't access should return **404, never 403** -- so ids can't be
  probed for existence by a legitimate but unauthorized staff member.

## Wiring routes in your app

This package gives you the library functions; **it does not create HTTP
routes for you**, because Cloudflare Pages' file-based routing needs
actual files at specific paths in your own repo. The pattern is a thin
wrapper per route using `mailHandler()` from `src/route.ts`:

```ts
// functions/api/mail/messages/index.ts (illustrative path -- yours may differ)
import { mailHandler, listMessages, jsonResponse } from "@altasme/webmail-kit";

export const onRequestGet = mailHandler(async ({ ctx, db, user, access }) => {
  const url = new URL(ctx.request.url);
  const result = await listMessages(db, access, {
    accountId: url.searchParams.get("accountId"),
    folder: url.searchParams.get("folder") ?? "inbox",
  });
  return jsonResponse(result);
});
```

`mailHandler()`'s one real requirement on your app: **your own auth
middleware must already have run and stored the logged-in staff user on
`ctx.data.staffUser`** before a request reaches a handler built this way.
The type only needs to structurally satisfy `MailUser` (`{ id, role }`)
from `src/access.ts` -- pass your app's real user type as a generic
parameter for full typing: `mailHandler<MyParams, MyStaffUser>(...)`.

You'll typically need routes for: identities (list/create/edit, per-
identity access, signatures), message list/detail/bulk actions (archive/
junk/restore/star/labels/raw download), search, send/reply/reply-all/
forward/retry, drafts, labels, attachment upload/download/preview, and
settings (policy + per-user preferences). ClientKeeper's
`functions/api/app/mail/` has ~35 such files if you want a complete,
working reference to copy the shape of -- each one is a short wrapper
around one or two of this package's functions, in the same spirit as the
example above.

## Mailbox owners (a second kind of principal)

Some apps also let the owner of ONE mailbox (not a staff user) sign in to
just that mailbox. ClientKeeper does this for client-hosted mailboxes (its
CLAUDE.md §36). The package supports it with three additive pieces; the
app owns the session, the eligibility rule and the routes:

- **`smtpVerifyLogin(connector, config, username, password)`** (`smtp.ts`)
  and its `cloudflare:sockets` binding **`verifySmtpLogin(config, username,
  password)`** (`smtpTransport.ts`): connect, EHLO, STARTTLS if configured,
  AUTH with the *supplied* credentials, QUIT. Sends nothing. The config's
  own username/password are ignored. Returns `{ ok: true }` or
  `{ ok: false, reason: "auth_failed" | "connection_failed" | "timeout" }`,
  never throws, never puts the password in anything it returns. An empty
  username/password is refused before connecting (the shared handshake
  skips AUTH when there's no username, so an empty login would otherwise
  "succeed"). It shares one handshake implementation (`SmtpSession` in
  `smtp.ts`) with `smtpSend()`, so the login check and real sending can't
  drift apart.
- **`queueOutboundMessageAsMailboxOwner(env, accountId, access, input)`**
  (`send.ts`): the normal send pipeline with `created_by = NULL` (the
  column `REFERENCES users(id)`, and a mailbox owner has no `users` row),
  the idempotency key and hourly limit scoped to that mailbox, the From
  identity forced to `accountId`, and drafts refused.
- **`loadMessageDetails(..., attachmentBasePath)`** (`detail.ts`): the
  `cid:` inline-image URL prefix, defaulting to `/api/app/mail/attachments`,
  so a second route tree can point images at routes its own session can use.

Do NOT reuse `mailHandler()` for mailbox owners: it reads
`ctx.data.staffUser` and resolves access from `mail_account_access` by
`users.id`. Build a separate guard that resolves the owner's one mailbox
from its own session and passes a one-entry `MailAccess` map; every query,
detail and action function here scopes by that map.

**Drafts don't work for mailbox owners with this schema:**
`mail_drafts.created_by` is `NOT NULL REFERENCES users(id)`, and D1
enforces foreign keys. Attachment upload depends on drafts, so it doesn't
either. Supporting them needs a schema change (e.g. a nullable
`created_by` plus an owner-account column), not a code change here.

## Importing: the barrel vs. per-module subpaths

Import the default barrel (`@altasme/webmail-kit`) from your Pages
Functions routes and your standalone Worker -- that's the common case,
and it's fine there because `cloudflare:sockets` genuinely exists in the
Workers runtime both run on.

**Don't import the barrel from plain Node code (notably: tests).** The
barrel transitively re-exports `sendRoute.ts`, which has a real (not
type-only) top-level `import` of `smtpTransport.ts`, which has a real
top-level `import { connect } from "cloudflare:sockets"`. Node's own ESM
loader rejects that scheme outright (`ERR_UNSUPPORTED_ESM_URL_SCHEME`) --
and because ES module imports are evaluated eagerly, this happens the
instant *anything* is imported from the barrel, even if all you actually
wanted was `dedupeAddresses` from `address.ts`. This isn't a bug to work
around with a try/catch; it's `cloudflare:sockets` doing exactly what
it's supposed to do outside a Workers runtime.

For Node-based testing (or any other non-Workers consumer), import the
specific per-module subpath instead -- every module has one:

```ts
import { dedupeAddresses } from "@altasme/webmail-kit/address";
import { dotStuff, smtpSend, SmtpError } from "@altasme/webmail-kit/smtp"; // smtp.ts itself has no cloudflare:sockets import -- only smtpTransport.ts does
import { resolveSmtpConfig } from "@altasme/webmail-kit/config";
```

`smtp.ts` (the protocol logic) and `smtpTransport.ts` (the real
`cloudflare:sockets` connector) are deliberately separate files for
exactly this reason: `smtp.ts`'s `smtpSend()` takes an injected
`SmtpConnector`, so the protocol itself is fully testable under plain
Node against a scripted fake server -- it's only the real connector that
needs the Workers runtime.

## What this package deliberately does NOT include

- **A frontend.** The UI (three-pane desktop, drawer-based mobile,
  composer, settings) is real work but is tightly coupled to whatever
  component library/design system your app already uses. Build your own,
  or copy ClientKeeper's `src/components/mail/*` as a starting point.
- **Your app's auth.** This package assumes a logged-in staff user already
  exists by the time a handler runs; it does not log anyone in.
- **A `users` table.** The schema's FKs assume one already exists.
