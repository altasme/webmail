// Shared wrapper for every mail route handler: resolves the caller's
// mailbox access once, and turns any unexpected exception into a generic
// 500 (details go to the Workers log only -- never to the browser, so no
// SQL, stack trace or SMTP detail ever leaks in a response).
//
// This package's one real requirement on your app: your own auth
// middleware must already have run and stored the logged-in staff user on
// `ctx.data.staffUser` (that exact key) before a request reaches a handler
// built with mailHandler(). The type of that user only needs to satisfy
// MailUser (`{ id, role }`) -- pass your app's real user type as `U` for
// full typing on `args.user` inside your handler, e.g.
// `mailHandler<MyParams, MyStaffUser>(async ({ user }) => ...)`.

import { loadAccess, type MailAccess, type MailUser } from "./access";
import type { MailEnv } from "./config";
import { errorResponse } from "./http";

export type MailContext<P extends string = string, U extends MailUser = MailUser> = EventContext<
  MailEnv & { SESSION_SECRET?: string },
  P,
  { staffUser: U }
>;

export interface MailHandlerArgs<P extends string, U extends MailUser = MailUser> {
  ctx: MailContext<P, U>;
  db: D1Database;
  user: U;
  access: MailAccess;
}

export function mailHandler<P extends string = string, U extends MailUser = MailUser>(
  fn: (args: MailHandlerArgs<P, U>) => Promise<Response>
): PagesFunction<MailEnv, P, { staffUser: U }> {
  return async (ctx) => {
    const db = ctx.env.DB;
    if (!db) return errorResponse(500, "Not configured");
    try {
      const user = ctx.data.staffUser;
      const access = await loadAccess(db, user.id);
      return await fn({ ctx: ctx as MailContext<P, U>, db, user, access });
    } catch (err) {
      console.error("mail route error", ctx.request.method, new URL(ctx.request.url).pathname, err instanceof Error ? err.stack || err.message : err);
      return errorResponse(500, "Something went wrong processing this mail request.");
    }
  };
}
