-- Webmail module schema -- staff mailboxes inside your own app's D1 database.
--
-- This is for one business's own staff mailboxes (hello@/support@/sales@
-- are typical starting addresses -- which addresses exist is data in
-- mail_accounts below, never hardcoded in your app's code). This is NOT
-- per-client/multi-tenant mail: every mail_accounts row belongs to the one
-- business running the app, so there is no tenant_id anywhere in this
-- block -- `account_id` (the mailbox identity) is the scoping unit for
-- every message/thread/label/draft, and mail_account_access is the
-- explicit, grantable list of which staff users may read (and optionally
-- send from) which mailbox. Default is nobody: an owner/admin grants
-- access, including to themselves -- a staff role alone never implies
-- mailbox access.
--
-- REQUIRES a `users` table with a TEXT `id` primary key to already exist
-- in your database (every `REFERENCES users(id)` below assumes it). If
-- your app's staff/user table has a different name, either rename it to
-- `users` for this block's FKs, or edit every `REFERENCES users(id)` below
-- to match your schema before running this file.
--
-- Writers: your app's own backend routes (staff-authenticated, built with
-- @altasme/webmail-kit) and a separate standalone inbound Email Worker
-- (@altasme/webmail-kit/worker), bound to this same database, since
-- Cloudflare Email Routing's email() handler can't be a Pages Function.
--
-- Attachment bytes and raw .eml copies live in a PRIVATE Cloudflare R2
-- bucket (binding MAIL_ATTACHMENTS, bound to both your app and the Worker)
-- -- these tables only hold the object keys. There are no public URLs:
-- every download must go through an authenticated, access-checked route
-- in your own app.
--
-- All brand-new tables: running this whole file again against an
-- already-deployed database is safe (every statement here is
-- CREATE ... IF NOT EXISTS / INSERT OR IGNORE). See the migration note at
-- the end of this file for the exact commands.
-- =====================================================================

-- A mailbox identity: the address mail is received at and sent from.
-- smtp_profile names an optional per-identity SMTP credential set held
-- server-side in the MAIL_SMTP_PROFILES_JSON secret (NULL = the default
-- MAIL_SMTP_* relay, which must be authorized to send as this address).
-- No credential of any kind is ever stored in this table.
CREATE TABLE IF NOT EXISTS mail_accounts (
  id TEXT PRIMARY KEY,
  email_address TEXT NOT NULL UNIQUE,        -- stored lowercased
  display_name TEXT NOT NULL,
  reply_to TEXT,                             -- optional Reply-To header for mail sent from this identity
  smtp_profile TEXT,
  inbound_enabled INTEGER NOT NULL DEFAULT 1, -- 0 = the mail worker rejects mail to this address
  outbound_enabled INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Explicit per-staff mailbox access. can_send = 0 is read-only access
-- (the identity never appears in that person's composer From list).
CREATE TABLE IF NOT EXISTS mail_account_access (
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  can_send INTEGER NOT NULL DEFAULT 1,
  granted_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_account_access_user_id ON mail_account_access(user_id);

-- Per-identity signatures. use_for_new/use_for_reply pick which one the
-- composer inserts automatically (at most one of each per account,
-- enforced in application code); an account with no use_for_reply
-- signature simply inserts none on replies ("disable signature on reply").
CREATE TABLE IF NOT EXISTS mail_signatures (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  name TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  use_for_new INTEGER NOT NULL DEFAULT 0,
  use_for_reply INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_signatures_account_id ON mail_signatures(account_id);

-- A conversation. Thread membership is resolved from standard headers
-- (Message-ID / In-Reply-To / References), never from subject alone.
-- participants is a JSON string[] of lowercased addresses.
CREATE TABLE IF NOT EXISTS mail_threads (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  subject TEXT NOT NULL DEFAULT '',
  participants TEXT NOT NULL DEFAULT '[]',
  message_count INTEGER NOT NULL DEFAULT 0,
  latest_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_threads_account_latest ON mail_threads(account_id, latest_message_at);

-- One row per real email (inbound or outbound). Drafts are NOT here --
-- they live in mail_drafts until sent. `folder` is persistent server
-- state (inbox/sent/archive/junk/trash); previous_folder remembers where a
-- message was before Junk/Trash so Restore puts it back. `status` tracks
-- the outbound lifecycle honestly: 'sent' means the SMTP server accepted
-- it (250 after DATA), never "delivered". dedupe_key makes inbound
-- processing idempotent per mailbox: normalized Message-ID when present,
-- otherwise a SHA-256 over sender/date/subject/body (see the mail
-- worker's computeDedupeKey()).
CREATE TABLE IF NOT EXISTS mail_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  thread_id TEXT NOT NULL REFERENCES mail_threads(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive', 'junk', 'trash')),
  previous_folder TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'queued', 'sending', 'sent', 'failed', 'retry_scheduled')),
  message_id_header TEXT,                    -- as sent/received, with angle brackets
  message_id_normalized TEXT,                -- lowercased, no brackets; lookup key for threading
  in_reply_to TEXT,
  references_header TEXT,
  dedupe_key TEXT NOT NULL,
  from_name TEXT,
  from_email TEXT NOT NULL,
  reply_to TEXT,
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',        -- untrusted for inbound; only ever rendered after server-side sanitization
  snippet TEXT NOT NULL DEFAULT '',
  is_read INTEGER NOT NULL DEFAULT 0,
  is_starred INTEGER NOT NULL DEFAULT 0,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  raw_storage_key TEXT,                      -- R2 key of the original .eml (inbound) when stored
  auth_results TEXT,                         -- raw Authentication-Results header, display only
  trashed_at TEXT,
  received_at TEXT,
  sent_at TEXT,
  created_by TEXT REFERENCES users(id),     -- staff sender for outbound; NULL for inbound
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_mail_messages_account_folder ON mail_messages(account_id, folder, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_messages_thread_id ON mail_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_mail_messages_msgid ON mail_messages(account_id, message_id_normalized);
CREATE INDEX IF NOT EXISTS idx_mail_messages_starred ON mail_messages(account_id, is_starred);

CREATE TABLE IF NOT EXISTS mail_recipients (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES mail_messages(id),
  recipient_type TEXT NOT NULL CHECK (recipient_type IN ('to', 'cc', 'bcc')),
  display_name TEXT,
  email TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_mail_recipients_message_id ON mail_recipients(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_recipients_email ON mail_recipients(email);

-- Unsent work. to/cc/bcc are JSON arrays of {name, email}. `version` is
-- an optimistic-concurrency counter so a stale autosave from a second
-- tab can't silently overwrite newer content (PATCH with an old version
-- -> 409). compose_mode/source_message_id remember what a reply/forward
-- draft is attached to so threading headers survive a page refresh.
CREATE TABLE IF NOT EXISTS mail_drafts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  thread_id TEXT REFERENCES mail_threads(id),
  compose_mode TEXT NOT NULL DEFAULT 'new' CHECK (compose_mode IN ('new', 'reply', 'reply_all', 'forward')),
  source_message_id TEXT REFERENCES mail_messages(id),
  to_json TEXT NOT NULL DEFAULT '[]',
  cc_json TEXT NOT NULL DEFAULT '[]',
  bcc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_drafts_account_id ON mail_drafts(account_id, updated_at);

-- Attachment metadata; bytes live in R2 under storage_key. A row belongs
-- to a message (received/sent) or a draft (still being composed), never
-- both. Forwarding re-references the same storage_key in a new row, so
-- R2 objects are only deleted once no row references them any more.
-- storage_status = 'failed' records an inbound attachment whose R2 write
-- failed -- the message itself is still stored (never discarded) and the
-- original bytes remain recoverable from the raw .eml copy.
CREATE TABLE IF NOT EXISTS mail_attachments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  message_id TEXT REFERENCES mail_messages(id),
  draft_id TEXT REFERENCES mail_drafts(id),
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  content_id TEXT,                           -- for cid: inline images
  is_inline INTEGER NOT NULL DEFAULT 0,
  storage_status TEXT NOT NULL DEFAULT 'stored' CHECK (storage_status IN ('stored', 'failed')),
  uploaded_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_message_id ON mail_attachments(message_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_draft_id ON mail_attachments(draft_id);
CREATE INDEX IF NOT EXISTS idx_mail_attachments_storage_key ON mail_attachments(storage_key);

CREATE TABLE IF NOT EXISTS mail_labels (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#0D68EF',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, name)
);

CREATE TABLE IF NOT EXISTS mail_message_labels (
  message_id TEXT NOT NULL REFERENCES mail_messages(id),
  label_id TEXT NOT NULL REFERENCES mail_labels(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_mail_message_labels_label_id ON mail_message_labels(label_id);

-- The outbound send pipeline. A job is created in the SAME D1 batch as
-- its mail_messages row, before any SMTP traffic, so an email can never
-- be sent without a record of it. idempotency_key (client-supplied per
-- compose session) makes a double-click / retried request return the
-- existing job instead of sending twice. locked_until is a lease: a job
-- found still 'sending' after its lease expired (a crash mid-SMTP) is
-- marked failed with an "outcome unknown" error rather than auto-resent,
-- because the server may already have accepted it -- a human decides.
CREATE TABLE IF NOT EXISTS mail_send_jobs (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE REFERENCES mail_messages(id),
  account_id TEXT NOT NULL REFERENCES mail_accounts(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'retry_scheduled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_retry_at TEXT,
  locked_until TEXT,
  last_error TEXT,                           -- redacted, human-readable; never an SMTP transcript
  last_attempted_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_send_jobs_due ON mail_send_jobs(status, next_retry_at);
CREATE INDEX IF NOT EXISTS idx_mail_send_jobs_created_by ON mail_send_jobs(created_by, created_at);

CREATE TABLE IF NOT EXISTS mail_send_attempts (
  id TEXT PRIMARY KEY,
  send_job_id TEXT NOT NULL REFERENCES mail_send_jobs(id),
  attempt_number INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'transient_failure', 'permanent_failure', 'unknown')),
  smtp_code INTEGER,
  error TEXT,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_send_attempts_job_id ON mail_send_attempts(send_job_id);

-- Mailbox audit trail (moves, label changes, sends, deletions, settings
-- and access changes). message_id deliberately has no REFERENCES so the
-- trail survives a permanent delete of the message it describes.
CREATE TABLE IF NOT EXISTS mail_events (
  id TEXT PRIMARY KEY,
  account_id TEXT,
  message_id TEXT,
  event_type TEXT NOT NULL,
  event_data TEXT,                           -- JSON
  actor_id TEXT,                             -- users.id, or 'mail-worker' for inbound processing
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mail_events_account_id ON mail_events(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mail_events_message_id ON mail_events(message_id);

-- Inbound mail the worker could not fully process. The raw message is
-- kept in R2 (raw_storage_key) so nothing is ever lost; resolved_at is
-- set once a human has dealt with it.
CREATE TABLE IF NOT EXISTS mail_inbound_failures (
  id TEXT PRIMARY KEY,
  envelope_from TEXT,
  envelope_to TEXT,
  raw_storage_key TEXT,
  error TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

-- Per-staff webmail preferences (default account/folder, sort, density,
-- refresh interval, notification toggles). JSON, validated/whitelisted in
-- application code on write.
CREATE TABLE IF NOT EXISTS mail_user_settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- Business-wide webmail policy (attachment limits, send rate limits,
-- remote image policy). Owner/admin only. Keys are whitelisted in
-- application code; values are JSON-encoded.
CREATE TABLE IF NOT EXISTS mail_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Full-text search index (SQLite FTS5, which D1 supports). Maintained by
-- application code on insert/delete, not triggers, so both writers (the
-- Pages Functions and the mail worker) control exactly what's indexed.
-- message_id/account_id are UNINDEXED join/scoping keys -- every search
-- query also filters by the caller's accessible account ids. The API
-- falls back to LIKE matching if this table is unavailable.
-- Note: `wrangler d1 export` does not export virtual tables; this index
-- can be rebuilt from mail_messages at any time.
CREATE VIRTUAL TABLE IF NOT EXISTS mail_messages_fts USING fts5(
  message_id UNINDEXED,
  account_id UNINDEXED,
  sender,
  recipients,
  subject,
  body,
  attachments,
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Migration: every object in this file is new, so it's applied by running
-- the whole file against your database (every statement here is
-- IF NOT EXISTS / INSERT OR IGNORE, so it's also safe to re-run later):
--   npx wrangler d1 execute <your-database-name> --remote --file=./mail-schema.sql
-- (or paste it into the D1 Console, one statement at a time if the
-- console rejects a multi-statement paste.) Run it BEFORE deploying any
-- code built on this package: every route and the inbound Worker query
-- these tables unconditionally and fail with "no such table" until it's
-- run.
--
-- Then create at least one mailbox and grant yourself access (or do it
-- from your app's own Mail settings UI once the code is live; the SQL
-- below is for a first bootstrap, since granting access through a UI
-- normally requires already being owner/admin):
--   INSERT INTO mail_accounts (id, email_address, display_name, created_at, updated_at)
--     VALUES ('<uuid>', 'hello@yourdomain.com', 'Your Business', '<iso-now>', '<iso-now>');
--   INSERT INTO mail_account_access (account_id, user_id, can_send, created_at)
--     VALUES ('<that uuid>', '<your users.id>', 1, '<iso-now>');
-- Typical starting identities (examples, not requirements):
-- hello@, support@, sales@, billing@ yourdomain.com.
