// Ready-made inbound/retry Worker entry. A standalone Cloudflare Worker is
// required here, not a Pages Function: Email Routing can only deliver to a
// Worker's email() handler, and Pages Functions have no cron.
//
//   email()     -> inbound mail from Cloudflare Email Routing -> D1/R2 (inbound.ts)
//   scheduled() -> every minute: retry due outbound sends, reap sends stuck
//                  mid-flight, purge Trash older than 30 days (send.ts)
//
// This Worker must bind the SAME D1 database (binding DB) and the same
// private R2 bucket (binding MAIL_ATTACHMENTS) as your Pages project, so
// both write identical rows. If you want custom behavior on top, don't
// edit this file -- import `processInbound`/`processDueSendJobs`/
// `cloudflareSmtpTransport` from this package's subpaths and write your
// own entry instead; this file is just the common case, ready to use.

import { processDueSendJobs } from "../send";
import { cloudflareSmtpTransport } from "../smtpTransport";
import { processInbound, type WorkerEnv } from "./inbound";

export default {
  async email(message: ForwardableEmailMessage, env: WorkerEnv): Promise<void> {
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    try {
      const outcome = await processInbound(env, { raw, envelopeFrom: message.from, envelopeTo: message.to });
      if (outcome.status === "rejected") message.setReject(outcome.reason);
    } catch (err) {
      console.error("inbound processing failed", err instanceof Error ? err.message : err);
      if (env.MAIL_FALLBACK_FORWARD) {
        // The raw copy is already in R2 and the failure is recorded; also
        // hand the message to a human-monitored mailbox so it's not stuck.
        await message.forward(env.MAIL_FALLBACK_FORWARD);
        return;
      }
      // No fallback configured: fail the delivery so the sending server
      // knows the message didn't arrive (rather than accepting and losing it).
      throw err;
    }
  },

  async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      processDueSendJobs(env, cloudflareSmtpTransport).then(
        (r) => {
          if (r.reaped || r.attempted || r.purged) console.log("mail cron", JSON.stringify(r));
        },
        (err) => console.error("mail cron failed", err instanceof Error ? err.message : err)
      )
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
