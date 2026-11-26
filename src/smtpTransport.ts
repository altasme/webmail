// The real TCP connector for smtp.ts, using the Workers runtime's raw
// socket API (`cloudflare:sockets`, available to both Pages Functions and
// standalone Workers). Kept separate from smtp.ts so the protocol logic
// can be unit-tested under Node, where this module doesn't exist.
//
// Note: Cloudflare blocks outbound connections to port 25, so the relay
// must accept submission on 465 (implicit TLS) or 587 (STARTTLS).

import { connect } from "cloudflare:sockets";
import { smtpSend, smtpVerifyLogin, type SmtpConfig, type SmtpConnector, type SmtpEnvelope, type SmtpLoginResult, type SmtpResult, type SmtpSocket } from "./smtp";

export const cloudflareSmtpConnector: SmtpConnector = ({ host, port, security }) => {
  const socket = connect(
    { hostname: host, port },
    { secureTransport: security === "tls" ? "on" : security === "starttls" ? "starttls" : "off", allowHalfOpen: false }
  );
  const wrap = (s: typeof socket): SmtpSocket => ({
    readable: s.readable as ReadableStream<Uint8Array>,
    writable: s.writable as WritableStream<Uint8Array>,
    close: () => s.close(),
    startTls: security === "starttls" ? () => wrap(s.startTls()) : undefined,
  });
  return wrap(socket);
};

export type SmtpTransport = (config: SmtpConfig, envelope: SmtpEnvelope, data: string) => Promise<SmtpResult>;

export const cloudflareSmtpTransport: SmtpTransport = (config, envelope, data) => smtpSend(cloudflareSmtpConnector, config, envelope, data);

/**
 * Real-network credential check: does `username`/`password` log in to the
 * SMTP server in `config`? Only the config's host/port/security/EHLO name
 * are used -- its own username/password are ignored. Sends no message.
 * See smtpVerifyLogin() in smtp.ts for the exact contract; the protocol
 * logic is unit-testable there against a fake connector, this binding to
 * `cloudflare:sockets` is not (it only exists in the Workers runtime).
 */
export function verifySmtpLogin(config: SmtpConfig, username: string, password: string): Promise<SmtpLoginResult> {
  return smtpVerifyLogin(cloudflareSmtpConnector, config, username, password);
}
