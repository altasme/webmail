// Barrel export for the shared mail library -- everything a Cloudflare
// Pages Functions app needs to serve /api/.../mail/* routes: addresses,
// threading, MIME, the SMTP client + cloudflare:sockets transport, inbound
// HTML sanitization, text helpers, mailbox access control, message
// query/detail/actions/drafts/compose, the outbound send pipeline, labels/
// settings/policy (config.ts), events (audit log) and a small http helper.
//
// The inbound Worker (`@altasme/webmail-kit/worker`) is intentionally NOT
// re-exported here: it depends on `postal-mime`, which this barrel's
// consumers (your Pages Functions routes) don't need to pull in.

export * from "./access";
export * from "./actions";
export * from "./address";
export * from "./compose";
export * from "./config";
export * from "./detail";
export * from "./drafts";
export * from "./events";
export * from "./http";
export * from "./mime";
export * from "./query";
export * from "./route";
export * from "./sanitize";
export * from "./send";
export * from "./sendRoute";
export * from "./smtp";
export * from "./smtpTransport";
export * from "./storage";
export * from "./store";
export * from "./text";
export * from "./threading";
