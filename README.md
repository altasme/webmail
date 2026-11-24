# @altasme/webmail-kit

A portable Cloudflare Workers/Pages backend for a real business webmail
module -- inbound via Cloudflare Email Routing + a standalone Worker,
outbound via real SMTP over `cloudflare:sockets`, D1-backed storage, no
mocked functionality. Extracted from `altasme/clientkeeper`'s `/mail`
build (the first real deployment, for `altasme.com`) so the next project
that needs staff webmail imports this instead of rebuilding it.

## What's here

- **`src/`** -- the shared library: address parsing, threading, MIME,
  the SMTP protocol client + Workers TCP-socket transport, inbound HTML
  sanitization, mailbox access control, message query/detail/actions/
  drafts/compose, the outbound send pipeline, settings/policy, audit
  events. Import the default export (`@altasme/webmail-kit`) from your
  Pages Functions app.
- **`src/worker/`** -- the standalone inbound/retry Worker's logic
  (`@altasme/webmail-kit/worker`). This has to be its own Cloudflare
  Worker deployment, separate from your Pages app -- see
  `docs/architecture.md` for why.
- **`schema/mail-schema.sql`** -- the D1 tables this all runs on.
  Requires a `users` table to already exist in your database.
- **`docs/architecture.md`** -- how it fits together, the data model,
  the security measures already built in, and how to wire routes in your
  own app.
- **`docs/cloudflare-provisioning-runbook.md`** -- the exact, ordered
  steps to take a domain from "no webmail" to "staff sending and
  receiving real mail," including the Cloudflare API permission groups
  actually needed (there's a real gotcha here -- see below).
- **`docs/troubleshooting.md`** -- real failures hit during the first
  setup (an SMTP `535` rejection, Email Routing refusing to enable over
  conflicting SPF records, a Cloudflare permission split that isn't
  obvious from the dashboard) and how they were actually resolved.
- **`SKILL.md`** -- a Claude Code skill wrapping all of the above into a
  step-by-step procedure. Drop it at `.claude/skills/webmail-setup/
  SKILL.md` in a project (or point Claude at this file directly) to reuse
  this entire workflow on a future setup instead of re-deriving it.

## Using it in a project

```bash
npm install github:altasme/webmail
```

```ts
import { mailHandler, listMessages, jsonResponse } from "@altasme/webmail-kit";
```

Pin to a tag/commit once one exists, rather than tracking `main`
indefinitely in a production app's `package.json`.

This package ships plain TypeScript source (no build step) via
`package.json`'s `exports` map -- it works directly with any bundler-mode
resolution (`"moduleResolution": "bundler"`), which is what Wrangler,
Vite, and esbuild all already use.

**This package is a library, not a finished app.** It does not include a
frontend, your app's auth, or the HTTP route files themselves (Cloudflare
Pages' file-based routing needs real files in your own repo). See
`docs/architecture.md`'s "Wiring routes in your app" and "What this
package deliberately does NOT include" sections.

## The one real Cloudflare gotcha worth knowing up front

**"Email Routing Rules" is a separate token permission from the general
Email Routing settings/enable/DNS permission.** You can have a token that
successfully enables Email Routing and reads its status, and still get a
`403` specifically on creating or editing the actual routing rule that
sends mail to your Worker. See `docs/troubleshooting.md` for the exact
symptom and fix -- this cost real time during the first setup and is
easy to miss since the dashboard's permission picker has several
similarly-named Email Routing options.

## Status

Built from a real, now-live production deployment (`altasme.com`, via
`altasme/clientkeeper`) -- schema, Worker, SMTP client, and routes were
all exercised against real SMTP credentials and real inbound mail before
this extraction, not just unit-tested in isolation. The extraction itself
(removing the two small ClientKeeper-specific type imports) was
typechecked clean standalone (`npm run typecheck`) but has not yet been
re-consumed by a second real project -- if you're the first to actually
`npm install` this into a new app, that's genuinely the first time this
exact package boundary gets exercised, so budget a little slack for
anything the extraction missed.
