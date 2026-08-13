/**
 * Minimal zero-dependency SMTP client (implicit TLS, AUTH LOGIN).
 *
 * WHY NOT NODEMAILER: this site deploys by drag-and-drop, so Netlify never runs
 * `npm install`. Any bundled dependency would be missing at runtime. Everything
 * here uses Node built-ins only, so the function works on a drag-drop deploy.
 *
 * Gmail / Workspace: smtp.gmail.com:465 with a 16-char app password.
 * SMTP relay alternative: set SMTP_HOST=smtp-relay.gmail.com.
 */

import tls from "node:tls";

const CRLF = "\r\n";

class SmtpError extends Error {
    constructor(message, code) {
          super(message);
          this.name = "SmtpError";
          this.code = code;
    }
}

/** Wrap a socket in a promise-based line protocol reader. */
function createSession(socket) {
    let buffer = "";
    let pending = null;

  socket.setEncoding("utf8");

  const tryResolve = () => {
        if (!pending) return;
        // A complete SMTP reply ends with "NNN <space>...CRLF". Continuation
        // lines use "NNN-". Scan for the final line.
        const lines = buffer.split(CRLF);
        for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (/^\d{3} /.test(line)) {
                          const consumed = lines.slice(0, i + 1).join(CRLF) + CRLF;
                          buffer = buffer.slice(consumed.length);
                          const code = parseInt(line.slice(0, 3), 10);
                          const { resolve, reject, expect } = pending;
                          pending = null;
                          if (expect && !expect.includes(code)) {
                                      reject(new SmtpError(`SMTP expected ${expect.join("/")}, got: ${line}`, code));
                          } else {
                                      resolve({ code, text: consumed.trim() });
                          }
                          return;
                }
        }
  };

  socket.on("data", (chunk) => {
        buffer += chunk;
        tryResolve();
  });

  return {
        read(expect) {
                return new Promise((resolve, reject) => {
                          pending = { resolve, reject, expect };
                          tryResolve();
                });
        },
        write(line) {
                socket.write(line + CRLF);
        },
  };
}

function b64(s) {
    return Buffer.from(String(s), "utf8").toString("base64");
}

/** Encode a header value that may contain non-ASCII (RFC 2047). */
function encodeHeader(value) {
    const v = String(value ?? "");
    // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(v)) return v;
    return `=?UTF-8?B?${b64(v)}?=`;
}

/** Split base64 into 76-char lines. Base64 never contains ".", so no dot-stuffing needed. */
function wrap76(s) {
    return (s.match(/.{1,76}/g) || []).join(CRLF);
}

function addrList(v) {
    if (!v) return [];
    return (Array.isArray(v) ? v : String(v).split(","))
      .map((s) => String(s).trim())
      .filter(Boolean);
}

function buildMessage({ from, fromName, to, cc, subject, html, text, replyTo }) {
    const boundary = `=_af_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const headers = [
          `From: ${fromName ? `${encodeHeader(fromName)} <${from}>` : from}`,
          `To: ${addrList(to).join(", ")}`,
        ];
    if (addrList(cc).length) headers.push(`Cc: ${addrList(cc).join(", ")}`);
    if (replyTo) headers.push(`Reply-To: ${replyTo}`);
    headers.push(
          `Subject: ${encodeHeader(subject)}`,
          `Date: ${new Date().toUTCString()}`,
          `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@answerfoundry.ai>`,
          "MIME-Version: 1.0",
          `Content-Type: multipart/alternative; boundary="${boundary}"`,
        );

  const plain = text || String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  const body = [
        "",
        `--${boundary}`,
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        wrap76(b64(plain)),
        `--${boundary}`,
        "Content-Type: text/html; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        wrap76(b64(html || "")),
        `--${boundary}--`,
        "",
      ].join(CRLF);

  return headers.join(CRLF) + CRLF + body;
}

/**
 * Send one message. Resolves on success, throws SmtpError otherwise.
 * bcc recipients get RCPT TO but never appear in headers.
 */
export async function sendMail(opts) {
    const {
          host = process.env.SMTP_HOST || "smtp.gmail.com",
          port = Number(process.env.SMTP_PORT || 465),
          user,
          pass,
          from = user,
          fromName,
          to,
          cc,
          bcc,
          subject,
          html,
          text,
          replyTo,
          timeoutMs = 30000,
    } = opts;

  if (!user || !pass) throw new SmtpError("Missing SMTP credentials (GMAIL_USER / GMAIL_APP_PASSWORD)");

  const recipients = [...addrList(to), ...addrList(cc), ...addrList(bcc)];
    if (!recipients.length) throw new SmtpError("No recipients");

  const socket = tls.connect({ host, port, servername: host });
    socket.setTimeout(timeoutMs);

  const cleanup = () => {
        try {
                socket.destroy();
        } catch {
                /* already gone */
        }
  };

  try {
        await new Promise((resolve, reject) => {
                socket.once("secureConnect", resolve);
                socket.once("error", reject);
                socket.once("timeout", () => reject(new SmtpError("SMTP connect timeout")));
        });

      const s = createSession(socket);
        socket.on("error", () => {
                /* surfaced through read() rejections */
        });

      await s.read([220]);
        s.write("EHLO answerfoundry.ai");
        await s.read([250]);

      s.write("AUTH LOGIN");
        await s.read([334]);
        s.write(b64(user));
        await s.read([334]);
        s.write(b64(pass));
        await s.read([235]); // 535 here = bad app password

      s.write(`MAIL FROM:<${from}>`);
        await s.read([250]);

      for (const rcpt of recipients) {
              s.write(`RCPT TO:<${rcpt}>`);
              await s.read([250, 251]);
      }

      s.write("DATA");
        await s.read([354]);
        socket.write(buildMessage({ from, fromName, to, cc, subject, html, text, replyTo }));
        socket.write(CRLF + "." + CRLF);
        await s.read([250]);

      s.write("QUIT");
        return { ok: true, recipients };
  } finally {
        cleanup();
  }
}

export { SmtpError };
