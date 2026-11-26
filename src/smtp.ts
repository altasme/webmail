// A real SMTP client (RFC 5321 + RFC 3207 STARTTLS + RFC 4954 AUTH) that
// runs on the Cloudflare Workers runtime over raw TCP. The socket itself is
// injected (SmtpConnector), so this file has no `cloudflare:sockets` import
// and is unit-tested under Node against a scripted fake server
// (tests/mail/smtp.test.ts); the real connector lives in smtpTransport.ts.
//
// Deliberately NOT Resend or any HTTP email API: the operator asked for
// literal SMTP for the webmail module (the existing Resend helper in
// functions/_lib/email.ts is untouched and still used by its own callers).
//
// Error model (drives retry policy in send.ts):
//   - 4xx reply / network error / timeout BEFORE the end-of-data marker
//     was sent  -> transient (safe to retry: the server hasn't accepted it)
//   - 5xx reply  -> permanent (never auto-retried)
//   - connection lost / timeout AFTER the end-of-data marker was written
//     but before the server's reply was read -> outcome UNKNOWN (the
//     server may have accepted and queued it). Never auto-retried, because
//     retrying could send a duplicate; surfaced to a human instead.
// Error messages carry the SMTP reply code and the server's reply text
// (e.g. "550 5.1.1 mailbox unavailable") but never any AUTH payload or a
// session transcript, and are length-capped.

export type SmtpSecurity = "tls" | "starttls" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  clientName?: string; // EHLO name
  timeoutMs?: number;
}

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void> | void;
  /** Upgrades a plaintext connection to TLS (STARTTLS); returns the new socket. */
  startTls?(): SmtpSocket;
}

export type SmtpConnector = (opts: { host: string; port: number; security: SmtpSecurity }) => SmtpSocket | Promise<SmtpSocket>;

export interface SmtpEnvelope {
  from: string;
  recipients: string[];
}

export interface SmtpResult {
  code: number;
  response: string; // server's final reply text, e.g. "2.0.0 Ok: queued as ABC123"
}

export type SmtpFailureKind = "transient" | "permanent" | "unknown";

export class SmtpError extends Error {
  code: number | null;
  kind: SmtpFailureKind;
  stage: string;
  constructor(message: string, opts: { code?: number | null; kind: SmtpFailureKind; stage: string }) {
    super(message.slice(0, 400));
    this.name = "SmtpError";
    this.code = opts.code ?? null;
    this.kind = opts.kind;
    this.stage = opts.stage;
  }
}

// Distinguishable from other read failures so smtpVerifyLogin() can report
// a timeout as such. Same message text as before, so smtpSend()'s error
// wording is unchanged.
class SmtpTimeoutError extends Error {}

interface Reply {
  code: number;
  lines: string[];
}

class LineReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = "";
  private decoder = new TextDecoder();
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }
  async readLine(timeoutMs: number): Promise<string> {
    while (true) {
      const idx = this.buffer.indexOf("\n");
      if (idx !== -1) {
        const line = this.buffer.slice(0, idx).replace(/\r$/, "");
        this.buffer = this.buffer.slice(idx + 1);
        return line;
      }
      if (this.buffer.length > 64 * 1024) throw new Error("Reply line too long");
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SmtpTimeoutError("Timed out waiting for server")), timeoutMs);
      });
      try {
        const { value, done } = await Promise.race([this.reader.read(), timeout]);
        if (done) throw new Error("Connection closed by server");
        this.buffer += this.decoder.decode(value, { stream: true });
      } finally {
        clearTimeout(timer);
      }
    }
  }
  release() {
    try {
      this.reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export function dotStuff(data: string): string {
  const normalized = data.replace(/\r?\n/g, "\r\n");
  const stuffed = normalized.replace(/(^|\r\n)\./g, "$1..");
  return stuffed.endsWith("\r\n") ? stuffed : `${stuffed}\r\n`;
}

function b64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function assertSafeCommandArg(value: string) {
  if (/[\r\n<>]/.test(value)) throw new SmtpError("Invalid address in SMTP envelope", { kind: "permanent", stage: "envelope" });
}
// One SMTP connection: reply parsing, command/expect helpers, and the
// shared opening handshake (greeting, EHLO, STARTTLS, AUTH) used by both
// smtpSend() and smtpVerifyLogin(). One implementation, so the login check
// and real sending can never disagree about how a server is spoken to.
class SmtpSession {
  stage = "connect";
  private socket?: SmtpSocket;
  private reader?: LineReader;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private readonly encoder = new TextEncoder();

  constructor(private readonly timeoutMs: number) {}

  private attach(s: SmtpSocket) {
    this.socket = s;
    this.reader = new LineReader(s.readable);
    this.writer = s.writable.getWriter();
  }

  async readReply(): Promise<Reply> {
    const lines: string[] = [];
    while (true) {
      const line = await this.reader!.readLine(this.timeoutMs);
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (!m) throw new Error(`Malformed server reply`);
      lines.push(m[3]!);
      if (m[2] === " ") return { code: Number(m[1]), lines };
      if (lines.length > 200) throw new Error("Reply too long");
    }
  }

  async write(s: string) {
    await this.writer!.write(this.encoder.encode(s));
  }

  async expect(accept: number[], label: string, redact = false): Promise<Reply> {
    const reply = await this.readReply();
    if (!accept.includes(reply.code)) {
      const text = redact ? "" : ` ${reply.lines.join(" ").slice(0, 200)}`;
      throw new SmtpError(`${label} rejected: ${reply.code}${text}`, {
        code: reply.code,
        kind: reply.code >= 500 ? "permanent" : "transient",
        stage: label,
      });
    }
    return reply;
  }

  async command(cmd: string, accept: number[], label: string, redact = false): Promise<Reply> {
    this.stage = label;
    await this.write(`${cmd}\r\n`);
    return this.expect(accept, label, redact);
  }

  /**
   * Connects and runs the opening handshake: greeting, EHLO, STARTTLS (when
   * configured), then AUTH with `config.username`/`config.password` if a
   * username is set. Returns the (post-TLS) EHLO reply. The AUTH exchange
   * is always redacted from thrown errors.
   */
  async open(connector: SmtpConnector, config: SmtpConfig): Promise<Reply> {
    this.attach(await connector({ host: config.host, port: config.port, security: config.security }));
    this.stage = "greeting";
    await this.expect([220], "greeting");
    const ehloName = (config.clientName || "localhost").replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
    let ehlo = await this.command(`EHLO ${ehloName}`, [250], "EHLO");

    if (config.security === "starttls") {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) {
        throw new SmtpError("Server does not offer STARTTLS", { kind: "permanent", stage: "STARTTLS" });
      }
      await this.command("STARTTLS", [220], "STARTTLS");
      if (!this.socket!.startTls) throw new SmtpError("TLS upgrade not supported by transport", { kind: "permanent", stage: "STARTTLS" });
      this.reader!.release();
      this.writer!.releaseLock();
      this.attach(this.socket!.startTls());
      ehlo = await this.command(`EHLO ${ehloName}`, [250], "EHLO");
    }

    const authLine = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l)) ?? "";
    const mechanisms = authLine.toUpperCase().split(/[ =]+/).slice(1);
    if (config.username) {
      this.stage = "AUTH";
      if (mechanisms.includes("PLAIN") || !mechanisms.includes("LOGIN")) {
        await this.command(`AUTH PLAIN ${b64(`\u0000${config.username}\u0000${config.password}`)}`, [235], "AUTH", true);
      } else {
        await this.command("AUTH LOGIN", [334], "AUTH", true);
        await this.command(b64(config.username), [334], "AUTH", true);
        await this.command(b64(config.password), [235], "AUTH", true);
      }
    }
    return ehlo;
  }

  /** Best-effort polite QUIT; never throws. */
  async quit(waitForReply: boolean) {
    try {
      if (!this.writer) return;
      await this.write("QUIT\r\n");
      if (waitForReply) await this.readReply();
    } catch {
      /* ignore */
    }
  }

  async close() {
    try {
      this.reader?.release();
      this.writer?.releaseLock();
    } catch {
      /* ignore */
    }
    try {
      await this.socket?.close();
    } catch {
      /* ignore */
    }
  }
}

function assertSafeTransport(config: SmtpConfig) {
  if (config.security === "none" && !isLocalHost(config.host)) {
    // Plaintext SMTP with credentials over the public internet would leak
    // the password; only allowed against a local test server.
    throw new SmtpError("Refusing unencrypted SMTP to a non-local host", { kind: "permanent", stage: "config" });
  }
}

/**
 * Sends one message over one SMTP session. `data` is the full RFC 5322
 * message (headers + body, CRLF line endings, NOT yet dot-stuffed).
 */
export async function smtpSend(connector: SmtpConnector, config: SmtpConfig, envelope: SmtpEnvelope, data: string): Promise<SmtpResult> {
  assertSafeTransport(config);
  if (!envelope.recipients.length) throw new SmtpError("No recipients", { kind: "permanent", stage: "envelope" });
  assertSafeCommandArg(envelope.from);
  envelope.recipients.forEach(assertSafeCommandArg);

  const encoder = new TextEncoder();
  const session = new SmtpSession(config.timeoutMs ?? 30_000);
  let dataTerminatorSent = false;

  try {
    const ehlo = await session.open(connector, config);

    const sizeSupported = ehlo.lines.some((l) => /^SIZE\b/i.test(l));
    const payload = dotStuff(data);
    const byteLength = encoder.encode(payload).length;
    await session.command(`MAIL FROM:<${envelope.from}>${sizeSupported ? ` SIZE=${byteLength}` : ""}`, [250], "MAIL FROM");
    for (const rcpt of envelope.recipients) {
      await session.command(`RCPT TO:<${rcpt}>`, [250, 251], "RCPT TO");
    }
    await session.command("DATA", [354], "DATA");
    session.stage = "message body";
    // Write in chunks so a large attachment doesn't build one giant buffer.
    const CHUNK = 64 * 1024;
    for (let i = 0; i < payload.length; i += CHUNK) await session.write(payload.slice(i, i + CHUNK));
    await session.write(".\r\n");
    dataTerminatorSent = true;
    session.stage = "end of data";
    const final = await session.expect([250], "end of data");
    // The message is already accepted; a failed QUIT changes nothing.
    await session.quit(true);
    return { code: final.code, response: final.lines.join(" ").slice(0, 300) };
  } catch (err) {
    if (err instanceof SmtpError) {
      // Politely abort the transaction where possible.
      if (err.kind !== "unknown") await session.quit(false);
      throw err;
    }
    const message = err instanceof Error ? err.message : "SMTP failure";
    if (dataTerminatorSent) {
      throw new SmtpError(`Connection problem after the message was handed to the server (${message}); it may or may not have been accepted`, {
        kind: "unknown",
        stage: session.stage,
      });
    }
    throw new SmtpError(`Network error during ${session.stage}: ${message}`, { kind: "transient", stage: session.stage });
  } finally {
    await session.close();
  }
}

export type SmtpLoginResult = { ok: true } | { ok: false; reason: "auth_failed" | "connection_failed" | "timeout" };

/**
 * Checks whether `username`/`password` is a valid login on the SMTP server
 * described by `config`, WITHOUT sending anything: connect, EHLO, STARTTLS
 * (if configured), AUTH with the CALLER-SUPPLIED credentials, then QUIT.
 * `config.username`/`config.password` (the identity's own outbound login)
 * are deliberately ignored -- this exists to test a different credential,
 * e.g. a mailbox owner proving they know their own real password.
 *
 * Never throws, and never puts the password (or any AUTH payload) in
 * anything it returns. An empty username or password is refused up front
 * as `auth_failed`: the shared handshake skips AUTH entirely when there is
 * no username, so without this guard an empty login would "succeed"
 * against any server. A server that answers AUTH with anything other than
 * 235 is a failure; there is no path to `ok: true` that skips AUTH.
 */
export async function smtpVerifyLogin(connector: SmtpConnector, config: SmtpConfig, username: string, password: string): Promise<SmtpLoginResult> {
  if (!username || !password || /[\r\n\u0000]/.test(username) || /[\r\n\u0000]/.test(password)) return { ok: false, reason: "auth_failed" };
  const loginConfig: SmtpConfig = { ...config, username, password, timeoutMs: config.timeoutMs ?? 15_000 };
  const session = new SmtpSession(loginConfig.timeoutMs!);
  try {
    assertSafeTransport(loginConfig);
    await session.open(connector, loginConfig);
    await session.quit(true);
    return { ok: true };
  } catch (err) {
    if (err instanceof SmtpError) {
      await session.quit(false);
      // A 5xx reply to AUTH is the server saying "wrong credentials" (535)
      // or "no such mechanism" -- either way, not logged in.
      if (err.stage === "AUTH" && err.code !== null && err.code >= 500) return { ok: false, reason: "auth_failed" };
      return { ok: false, reason: "connection_failed" };
    }
    if (err instanceof SmtpTimeoutError) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "connection_failed" };
  } finally {
    await session.close();
  }
}
