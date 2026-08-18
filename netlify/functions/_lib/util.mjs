/**
 * Shared helpers for the AnswerFoundry functions.
 * No npm dependencies on purpose: the site deploys as a prebuilt directory, so
 * anything that needs `npm install` at build time is a liability. Everything
 * here uses the Node standard library and fetch.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const SITE = "https://answerfoundry.ai";
export const FROM = process.env.MAIL_FROM || "AnswerFoundry <hello@answerfoundry.ai>";
export const NOTIFY = process.env.NOTIFY_EMAIL || "hello@answerfoundry.ai";
export const STRIPE_AUDIT_LINK =
    process.env.STRIPE_AUDIT_LINK || "https://buy.stripe.com/eVqdR81KG1hO1035l9fjG00";

/* ------------------------------------------------------------------ replies */
export const json = (body, status = 200, headers = {}) =>
    new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
    });

export const bad = (msg, status = 400) => json({ ok: false, error: msg }, status);

/* ---------------------------------------------------------------- signing */
function secret() {
    const s = process.env.AF_SECRET;
    if (!s) throw new Error("AF_SECRET is not set");
    return s;
}

export const sign = (value) =>
    createHmac("sha256", secret()).update(String(value)).digest("base64url");

export function verify(value, signature) {
    try {
          const a = Buffer.from(sign(value));
          const b = Buffer.from(String(signature || ""));
          return a.length === b.length && timingSafeEqual(a, b);
    } catch {
          return false;
    }
}

export const b64u = {
    enc: (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url"),
    dec: (s) => JSON.parse(Buffer.from(String(s), "base64url").toString("utf8")),
};

export const ref = (prefix = "AF") =>
    `${prefix}-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;

export const token = (bytes = 16) => randomBytes(bytes).toString("hex");

/* -------------------------------------------------------- admin protection */
/**
 * Token check for background functions, which are invoked with a JSON body
 * rather than custom headers. Constant-time so it can't be probed by timing.
 */
export function isAdminToken(value) {
    const want = process.env.ADMIN_TOKEN;
    if (!want || !value) return false;
    const a = Buffer.from(String(want)), b = Buffer.from(String(value));
    return a.length === b.length && timingSafeEqual(a, b);
}

export function isAdmin(req) {
    const want = process.env.ADMIN_TOKEN;
    if (!want) return false;
    const got = req.headers.get("x-admin-token") || "";
    const a = Buffer.from(want), b = Buffer.from(got);
    return a.length === b.length && timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ escape */
export const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
          ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(s || "").trim());

export function normUrl(u) {
    let s = String(u || "").trim();
    if (!s) return "";
    if (!/^https?:\/\//i.test(s)) s = "https://" + s;
    try { return new URL(s).toString(); } catch { return ""; }
}

/* -------------------------------------------------------------------- mail */

/** Split `Name <addr@host>` into its parts. Bare addresses pass straight through. */
function parseFrom(v) {
    const m = String(v || "").match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
    return m ? { name: m[1].replace(/^"|"$/g, "") || undefined, address: m[2] }
                 : { name: undefined, address: String(v || "").trim() };
}

/**
 * Gmail / Workspace SMTP fallback. Used when RESEND_API_KEY is absent so the
 * system is never silently mute — a dropped lead email is worse than a noisy
 * failure. Zero dependencies, same as everything else here.
 */
async function mailViaSmtp({ to, subject, html, text, replyTo }) {
    const user = (process.env.GMAIL_USER || "").trim();
    const pass = (process.env.GMAIL_APP_PASSWORD || "").trim();
    if (!user || !pass) {
          console.error("[mail] no transport configured: set RESEND_API_KEY, or GMAIL_USER + GMAIL_APP_PASSWORD", { to, subject });
          return { ok: false, skipped: true, reason: "no mail transport configured" };
    }
    const { sendMail } = await import("./smtp.mjs");
    const from = parseFrom(FROM);
    try {
          await sendMail({
                  user,
                  pass,
                  // Gmail rewrites From to the authenticated account anyway; keep them aligned.
                  from: user,
                  fromName: from.name || process.env.FROM_NAME || "AnswerFoundry",
                  to,
                  replyTo,
                  subject,
                  html,
                  text,
          });
          console.log("[mail] sent via SMTP", { to, subject });
          return { ok: true, via: "smtp" };
    } catch (e) {
          console.error("[mail] SMTP send failed", e?.message || e);
          return { ok: false, via: "smtp", error: String(e?.message || e) };
    }
}

export async function mail({ to, subject, html, text, replyTo, tag }) {
    const key = process.env.RESEND_API_KEY;
    if (!key) return mailViaSmtp({ to, subject, html, text, replyTo });
    const body = {
          from: FROM,
          to: Array.isArray(to) ? to : [to],
          subject,
          html,
          ...(text ? { text } : {}),
          ...(replyTo ? { reply_to: replyTo } : {}),
          ...(tag ? { tags: [{ name: "kind", value: tag }] } : {}),
    };
    // Never let a transport problem throw: callers do `await Promise.all([...])`,
  // and an unhandled rejection here loses the lead entirely. Degrade instead.
  let r, j;
    try {
          r = await fetch("https://api.resend.com/emails", {
                  method: "POST",
                  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
                  body: JSON.stringify(body),
                  signal: AbortSignal.timeout(20000),
          });
          j = await r.json().catch(() => ({}));
    } catch (e) {
          console.error("[mail] Resend unreachable", e?.message || e);
          return mailViaSmtp({ to, subject, html, text, replyTo });
    }
    if (!r.ok) {
          console.error("[mail] send failed", r.status, j);
          // 4xx is our mistake (bad key, unverified domain) and will not fix itself;
      // try the other transport rather than dropping the message.
      return mailViaSmtp({ to, subject, html, text, replyTo });
    }
    return { ok: true, status: r.status, id: j.id, via: "resend", detail: j };
}

/* --------------------------------------------------------------------- sms */
/**
 * SMS ping to the owner via GoHighLevel (Contacts + Conversations scopes
 * only — nothing broader is needed). GHL's conversations API sends to a
 * contact record, not a bare phone number, so this upserts a minimal
 * contact for NOTIFY_PHONE first and then messages that contact.
 *
 * All three env vars (GHL_PIT, GHL_LOCATION_ID, NOTIFY_PHONE) are
 * independent of mail delivery — this silently no-ops rather than
 * throwing so a missing/misconfigured SMS setup never blocks the rest of
 * the flow.
 */
export async function smsNotify(message) {
    const pit = process.env.GHL_PIT;
    const locationId = process.env.GHL_LOCATION_ID;
    const phone = process.env.NOTIFY_PHONE;
    if (!pit || !locationId || !phone) {
          console.warn("[sms] skipped — GHL_PIT, GHL_LOCATION_ID or NOTIFY_PHONE not set");
          return { ok: false, skipped: true };
    }
    const headers = {
          authorization: `Bearer ${pit}`,
          version: "2021-07-28",
          "content-type": "application/json",
    };
    try {
          const upsert = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ locationId, phone, name: "AnswerFoundry Owner" }),
                  signal: AbortSignal.timeout(15000),
          });
          const uj = await upsert.json().catch(() => ({}));
          const contactId = uj?.contact?.id;
          if (!upsert.ok || !contactId) {
                  console.error("[sms] contact upsert failed", upsert.status, uj);
                  return { ok: false, error: "contact upsert failed", detail: uj };
          }
          const send = await fetch("https://services.leadconnectorhq.com/conversations/messages", {
                  method: "POST",
                  headers,
                  body: JSON.stringify({ type: "SMS", contactId, message: String(message).slice(0, 480) }),
                  signal: AbortSignal.timeout(15000),
          });
          const sj = await send.json().catch(() => ({}));
          if (!send.ok) {
                  console.error("[sms] send failed", send.status, sj);
                  return { ok: false, error: "send failed", detail: sj };
          }
          return { ok: true, detail: sj };
    } catch (e) {
          console.error("[sms] GHL request failed", e?.message || e);
          return { ok: false, error: String(e?.message || e) };
    }
}

/** Branded email wrapper. Tables and inline styles, because email clients. */
export function shell({ preheader = "", heading, body, cta, ctaUrl, footNote = "" }) {
    return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f8fb">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fb;padding:28px 12px">
    <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border:1px solid #e6e9f0;border-radius:14px;overflow:hidden;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif">
    <tr><td style="background:#0b1b34;padding:20px 28px">
      <span style="color:#fff;font-size:18px;font-weight:800;letter-spacing:-.3px">Answer<span style="color:#e8590c">Foundry</span></span>
      </td></tr>
      <tr><td style="padding:30px 28px 8px">
        <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#101828">${heading}</h1>
          <div style="font-size:15px;line-height:1.62;color:#475467">${body}</div>
          </td></tr>
          ${cta && ctaUrl ? `<tr><td style="padding:8px 28px 26px">
            <a href="${ctaUrl}" style="display:inline-block;background:#e8590c;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:13px 24px;border-radius:8px">${cta}</a>
            </td></tr>` : ""}
            ${footNote ? `<tr><td style="padding:0 28px 24px;font-size:12.5px;line-height:1.6;color:#98a2b3">${footNote}</td></tr>` : ""}
            <tr><td style="background:#0a1526;padding:18px 28px;font-size:12px;line-height:1.6;color:#8fa0ba">
              <strong style="color:#fff">AnswerFoundry LLC</strong><br>
                2445 S Hiawassee Rd, PMB 1021, Orlando, FL 32835<br>
                  <a href="mailto:hello@answerfoundry.ai" style="color:#c4cfe0">hello@answerfoundry.ai</a> &middot;
                    <a href="${SITE}/privacy/" style="color:#c4cfe0">Privacy</a> &middot;
                      <a href="${SITE}/terms/" style="color:#c4cfe0">Terms</a><br>
                        <span style="color:#6d7f99">AnswerFoundry does not control ChatGPT, Google, Perplexity or any other AI system and
                          does not guarantee placement, citation or ranking in any AI-generated answer.</span>
                          </td></tr>
                          </table></td></tr></table></body></html>`;
}

/* ------------------------------------------------------------------ stripe */
export async function stripeSession(id) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not set");
    if (!/^cs_[A-Za-z0-9_]+$/.test(String(id || ""))) throw new Error("malformed session id");
    const r = await fetch(
          `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=line_items`,
      { headers: { authorization: `Bearer ${key}` } });
    const j = await r.json();
    if (!r.ok) {
          const e = new Error(j?.error?.message || `stripe ${r.status}`);
          e.status = r.status;
          throw e;
    }
    return j;
}

/* ----------------------------------------------------- durable form mirror */
/**
 * Mirrors a record into a Netlify Form so it is stored and visible in the
 * dashboard even if email delivery fails. The form must exist — the hidden
 * forms in /forms/index.html register them at deploy time.
 */
export async function mirrorToForm(formName, fields) {
    try {
          const body = new URLSearchParams({ "form-name": formName, ...fields });
          const r = await fetch(`${SITE}/forms/`, {
                  method: "POST",
                  headers: { "content-type": "application/x-www-form-urlencoded" },
                  body: body.toString(),
          });
          return { ok: r.ok, status: r.status };
    } catch (e) {
          console.error("[mirror] failed", e.message);
          return { ok: false, error: e.message };
    }
}

/* ----------------------------------------------------------------- prescan */
const UA = "Mozilla/5.0 (compatible; AnswerFoundryAudit/1.0; +https://answerfoundry.ai/)";

async function grab(url, ms = 12000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
          const r = await fetch(url, { redirect: "follow", signal: ac.signal, headers: { "user-agent": UA } });
          const text = r.ok ? await r.text() : "";
          return { ok: r.ok, status: r.status, finalUrl: r.url, text };
    } catch (e) {
          return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message, text: "" };
    } finally {
          clearTimeout(t);
    }
}

/**
 * Automated technical pre-scan of a public homepage. Everything returned here is
 * directly observed, not inferred — it becomes the first draft of report
 * sections 10 and 11, and it is the part of the audit that is honestly
 * automatable. AI-engine testing is not, and is not attempted here.
 */
export async function prescan(rawUrl) {
    const url = normUrl(rawUrl);
    const out = { url, checkedAt: new Date().toISOString(), findings: [], facts: {} };
    if (!url) { out.error = "unparseable url"; return out; }

  const home = await grab(url);
    out.facts.reachable = home.ok;
    out.facts.status = home.status;
    out.facts.finalUrl = home.finalUrl || url;
    if (!home.ok) {
          out.error = home.error || `HTTP ${home.status}`;
          out.findings.push({ sev: "High", what: "Homepage did not return a usable response to an automated fetch",
                                   detail: `Requested ${url} — ${out.error}. Bot-hostile hosting or aggressive protection can also block AI crawlers.` });
          return out;
    }

  const h = home.text;
    const F = out.facts;
    const origin = new URL(F.finalUrl).origin;

  F.https = F.finalUrl.startsWith("https://");
    F.bytes = h.length;
    F.title = (h.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim().replace(/\s+/g, " ");
    F.metaDescription = (h.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || "").trim();
    F.canonical = h.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || "";
    F.h1Count = (h.match(/<h1\b/gi) || []).length;
    F.h1Text = (h.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").replace(/<[^>]+>/g, " ").trim().replace(/\s+/g, " ").slice(0, 140);
    F.h2Count = (h.match(/<h2\b/gi) || []).length;
    F.imgCount = (h.match(/<img\b/gi) || []).length;
    F.imgMissingAlt = (h.match(/<img\b(?![^>]*\salt=)[^>]*>/gi) || []).length;
    F.hasOpenGraph = /property=["']og:/i.test(h);
    F.hasViewport = /name=["']viewport["']/i.test(h);
    F.iframeCount = (h.match(/<iframe\b/gi) || []).length;

  const visible = h
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ");
    F.wordCount = (visible.match(/[A-Za-z][A-Za-z'’-]+/g) || []).length;
    F.phones = [...new Set((visible.match(/(?:\+1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g) || []))].slice(0, 5);

  // ---- structured data
  const blocks = [...h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    F.jsonLdBlocks = blocks.length;
    const types = new Set();
    let invalid = 0;
    const walk = (n) => {
          if (Array.isArray(n)) return n.forEach(walk);
          if (n && typeof n === "object") {
                  const t = n["@type"];
                  if (typeof t === "string") types.add(t);
                  else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x));
                  Object.values(n).forEach(walk);
          }
    };
    for (const b of blocks) {
          try { walk(JSON.parse(b)); } catch { invalid++; }
    }
    F.schemaTypes = [...types].sort();
    F.invalidJsonLd = invalid;
    F.microdata = /itemtype=["']https?:\/\/schema\.org/i.test(h);

  // ---- robots + sitemap
  const robots = await grab(origin + "/robots.txt", 8000);
    F.robotsFound = robots.ok;
    F.robotsBlocksAi = [];
    if (robots.ok) {
          const agents = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User",
                                "ClaudeBot", "Claude-SearchBot", "Claude-User", "Google-Extended", "Applebot-Extended", "Bingbot", "*"];
          const txt = robots.text;
          for (const a of agents) {
                  const re = new RegExp(`user-agent:\\s*${a.replace(/[*]/g, "\\*")}\\s*([\\s\\S]*?)(?=user-agent:|$)`, "i");
                  const blk = txt.match(re)?.[1] || "";
                  if (/disallow:\s*\/\s*(?:$|[\r\n])/im.test(blk)) F.robotsBlocksAi.push(a);
          }
          F.sitemapDeclared = /sitemap:\s*http/i.test(txt);
    }
    const sm = await grab(origin + "/sitemap.xml", 8000);
    F.sitemapReachable = sm.ok && /<(urlset|sitemapindex)/i.test(sm.text);
    F.sitemapUrls = sm.ok ? (sm.text.match(/<loc>/gi) || []).length : 0;
    const llms = await grab(origin + "/llms.txt", 6000);
    F.llmsTxt = llms.ok && llms.text.length > 20;

  // ---- derived findings
  const add = (sev, what, detail) => out.findings.push({ sev, what, detail });
    const wanted = ["Service", "FAQPage", "Offer", "Product", "MedicalProcedure", "MedicalBusiness"];
    const org = ["Organization", "LocalBusiness", "MedicalBusiness", "Dentist", "Physician",
                     "ProfessionalService", "LegalService", "HomeAndConstructionBusiness", "HealthAndBeautyBusiness"];

  if (F.jsonLdBlocks === 0 && !F.microdata)
        add("High", "No structured data on the homepage",
                  "Zero JSON-LD blocks and no microdata. This is the machine-readable description of the business, and it is absent.");
    else if (!F.schemaTypes.some((t) => org.includes(t)))
          add("High", "No business entity in structured data",
                    `Schema types present: ${F.schemaTypes.join(", ") || "none"}. Nothing identifies this as a business, so scattered mentions are harder to resolve to one entity.`);
    if (F.invalidJsonLd)
          add("High", `${F.invalidJsonLd} JSON-LD block(s) fail to parse`,
                    "Malformed structured data is generally ignored wholesale rather than partially, so any correct fields inside are wasted.");
    if (!F.schemaTypes.some((t) => wanted.includes(t)))
          add("Med", "No service, offer or FAQ markup",
                    "The pages that answer treatment or service questions carry nothing a machine can quote as a service, price or answer.");
    if (!F.schemaTypes.includes("AggregateRating") && !F.schemaTypes.includes("Review"))
          add("Med", "Reviews are not marked up",
                    `No Review or AggregateRating markup found${F.iframeCount ? `, and ${F.iframeCount} iframe(s) are present — review widgets in iframes are invisible to crawlers and models` : ""}.`);
    if (F.h1Count === 0) add("High", "Homepage has no H1", "Zero H1 elements. The single strongest on-page signal of what this page is about is missing.");
    else if (F.h1Count > 1) add("Low", `Homepage has ${F.h1Count} H1 elements`, `Duplicate top-level headings dilute the signal. First: “${F.h1Text}”`);
    if (!F.title) add("High", "Homepage has no title tag", "The title is what most surfaces display and quote as the page's name.");
    else if (F.title.length > 65) add("Low", "Homepage title is long", `${F.title.length} characters — likely truncated in results. “${F.title}”`);
    if (!F.metaDescription) add("Low", "No meta description on the homepage", "Not a ranking factor, but it is frequently the snippet a summariser reuses.");
    if (!F.canonical) add("Med", "No canonical URL declared", "Without a canonical, duplicate variants of a page can compete with each other.");
    if (!F.https) add("High", "Site does not resolve over HTTPS", "A trust signal every engine weighs, and a hard blocker for some.");
    if (F.robotsBlocksAi.length)
          add("High", `robots.txt blocks ${F.robotsBlocksAi.length} crawler(s) outright`,
                    `Blocked: ${F.robotsBlocksAi.join(", ")}. A blocked AI search crawler cannot cite this site at all.`);
    if (!F.sitemapReachable) add("Med", "No reachable XML sitemap at /sitemap.xml", "Discovery of deeper pages then depends entirely on internal linking.");
    if (F.wordCount < 350)
          add("Med", "Homepage carries very little readable text", `About ${F.wordCount} words of visible copy. Thin pages give a model little to quote.`);
    if (F.imgCount && F.imgMissingAlt / F.imgCount > 0.4)
          add("Low", `${F.imgMissingAlt} of ${F.imgCount} images have no alt text`, "Alt text is both an accessibility requirement and machine-readable description.");
    if (!F.phones.length) add("Med", "No phone number in the homepage HTML", "A phone number is one of the strongest entity-matching signals across directories.");

  const order = { High: 0, Med: 1, Low: 2 };
    out.findings.sort((a, b) => order[a.sev] - order[b.sev]);
    out.counts = {
          total: out.findings.length,
          high: out.findings.filter((f) => f.sev === "High").length,
          med: out.findings.filter((f) => f.sev === "Med").length,
          low: out.findings.filter((f) => f.sev === "Low").length,
    };
    return out;
}

export function prescanHtml(scan) {
    if (scan.error && !scan.findings.length)
          return `<p style="color:#b42318"><strong>Pre-scan could not read ${esc(scan.url)}</strong> — ${esc(scan.error)}.</p>`;
    const f = scan.facts || {};
    const rows = (scan.findings || []).map((x) => {
          const c = x.sev === "High" ? "#b42318" : x.sev === "Med" ? "#8a6212" : "#98a2b3";
          return `<tr><td style="padding:8px 10px;border-bottom:1px solid #e6e9f0;color:${c};font-weight:700;font-size:12px;white-space:nowrap">${x.sev}</td>
                <td style="padding:8px 10px;border-bottom:1px solid #e6e9f0;font-size:13px"><strong>${esc(x.what)}</strong><br>
                      <span style="color:#475467">${esc(x.detail)}</span></td></tr>`;
    }).join("");
    const fact = (k, v) => `<tr><td style="padding:5px 10px;color:#98a2b3;font-size:12px;white-space:nowrap">${k}</td>
        <td style="padding:5px 10px;font-size:12px;color:#101828">${esc(v)}</td></tr>`;
    return `<p style="margin:0 0 10px"><strong>Automated pre-scan</strong> of ${esc(f.finalUrl || scan.url)} —
        ${scan.counts?.total || 0} findings (${scan.counts?.high || 0} High, ${scan.counts?.med || 0} Med, ${scan.counts?.low || 0} Low),
            observed ${esc(scan.checkedAt)}.</p>
              <table style="width:100%;border-collapse:collapse;margin:0 0 16px">${rows || '<tr><td style="font-size:13px;color:#2e6b4f;padding:8px 0">No automated defects detected — unusual, and worth verifying by hand.</td></tr>'}</table>
                <table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px">
                    ${fact("Title", f.title || "—")}
                        ${fact("H1 / H2", `${f.h1Count} / ${f.h2Count}`)}
                            ${fact("Schema types", (f.schemaTypes || []).join(", ") || "none")}
                                ${fact("JSON-LD blocks", `${f.jsonLdBlocks}${f.invalidJsonLd ? ` (${f.invalidJsonLd} invalid)` : ""}`)}
                                    ${fact("Canonical", f.canonical || "none")}
                                        ${fact("Sitemap", f.sitemapReachable ? `${f.sitemapUrls} URLs` : "not reachable")}
                                            ${fact("robots.txt", f.robotsFound ? (f.robotsBlocksAi?.length ? `blocks ${f.robotsBlocksAi.join(", ")}` : "no blanket blocks") : "not found")}
                                                ${fact("llms.txt", f.llmsTxt ? "present" : "absent")}
                                                    ${fact("Visible words", f.wordCount)}
                                                        ${fact("iframes", f.iframeCount)}
                                                            ${fact("Phones found", (f.phones || []).join(", ") || "none")}
                                                              </table>`;
}
