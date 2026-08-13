/**
* GET /r/?id=<reference>&s=<signature>
*
* Serves a finished report out of blob storage. The signature is an HMAC over the
* reference, so the URL is unguessable and unforgeable, and there is no listing
* anywhere that enumerates them.
*
* While an audit is still running this returns a live status page that refreshes
* itself — a client who clicks the link early sees progress rather than a 404.
*/
import { verify, sign, esc, SITE } from "./_lib/util.mjs";
import { get, getJson } from "./_lib/blobs.mjs";

export const config = { path: "/r/" };

const page = (title, inner, refresh = 0) => new Response(
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow, noarchive">
  ${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ""}
  <title>${esc(title)} | AnswerFoundry</title>
  <style>
  :root{--ink:#101828;--slate:#475467;--mist:#98a2b3;--line:#e6e9f0;--fog:#f7f8fb;--forge:#e8590c;--forge-dk:#c2410c;--ember:#fff3ec;--navy:#0b1b34}
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:"Avenir Next","Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);line-height:1.65;background:var(--fog)}
  .bar{background:var(--navy);padding:16px 0}
  .in{max-width:620px;margin:0 auto;padding:0 24px}
  .lg{font-size:1.1rem;font-weight:800;color:#fff;text-decoration:none}.lg span{color:var(--forge)}
  main{max-width:620px;margin:60px auto;padding:0 24px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:34px 32px}
  h1{font-size:1.5rem;letter-spacing:-.02em;margin-bottom:14px}
  p{color:var(--slate);margin-bottom:12px}
  .spin{width:32px;height:32px;border:3px solid var(--line);border-top-color:var(--forge);border-radius:50%;
  animation:sp .9s linear infinite;margin:0 0 20px}
  @keyframes sp{to{transform:rotate(360deg)}}
  .steps{list-style:none;margin:20px 0 0;padding:0;font-size:.93rem}
  .steps li{padding:8px 0 8px 28px;position:relative;color:var(--mist);border-bottom:1px solid var(--line)}
  .steps li:last-child{border:none}
  .steps li.on{color:var(--ink);font-weight:600}
  .steps li.done{color:var(--slate)}
  .steps li::before{content:"○";position:absolute;left:4px;color:var(--mist)}
  .steps li.done::before{content:"●";color:#2e6b4f}
  .steps li.on::before{content:"●";color:var(--forge)}
  code{background:var(--fog);padding:2px 6px;border-radius:4px;font-size:.88em}
  a{color:var(--forge-dk);font-weight:600}
  .note{font-size:.85rem;color:var(--mist);margin-top:22px}
  </style></head><body>
  <div class="bar"><div class="in"><a class="lg" href="${SITE}/">Answer<span>Foundry</span></a></div></div>
  <main><div class="card">${inner}</div></main></body></html>`,
  { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive" } });

export default async (req, context) => {
  const u = new URL(req.url);
  const id = u.searchParams.get("id") || "";
  const s = u.searchParams.get("s") || "";

  if (!id || !s || !verify("report:" + id, s))
    return page("Report not found",
                `<h1>That link isn't valid</h1>
                <p>Report links are private and specific to one audit. Please use the link exactly as it appears in your email —
                some mail clients break long URLs across lines.</p>
                <p>Reply to that email, or write to <a href="mailto:hello@answerfoundry.ai">hello@answerfoundry.ai</a>, and we'll
                send a fresh one straight away.</p>`);

  const html = await get("audits", `${id}/report.html`);
  if (html)
    return new Response(html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow, noarchive" },
    });

  const job = await getJson("audits", `${id}/job`);
  if (!job)
    return page("Report not found",
                `<h1>We can't find that report</h1>
                <p>The reference <code>${esc(id)}</code> checks out, but there's no report stored against it. That shouldn't
                happen — please reply to your confirmation email and we'll sort it out today.</p>`);

  if (job.stage === "failed")
    return page("Audit needs a human",
                `<h1>Your audit hit a snag</h1>
                <p>The automated run failed and a person has been alerted — this isn't sitting in a queue unnoticed. You'll hear
                from us today, and your audit will be produced by hand.</p>
                <p>Reference <code>${esc(id)}</code>. Nothing is lost, and nothing further is needed from you.</p>`);

  // Pump the pipeline. The client's auto-refresh becomes the clock that drives
  // the audit forward, so progress never depends on a function successfully
  // invoking itself — which is exactly the failure mode that stalled it once.
  const pump = async () => {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 2000);
    try {
      await fetch(`${SITE}/.netlify/functions/run-audit-background`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: id, key: sign(id) }),
        signal: ac.signal,
      });
    } catch (e) {
      if (e.name !== "AbortError") console.error("[get-report] pump failed", e.message);
    } finally {
      clearTimeout(to);
    }
  };
  if (context && typeof context.waitUntil === "function") context.waitUntil(pump());
  else await pump();

  const order = ["new", "crawl", "engines", "finish"];
  const at = order.indexOf(job.stage);
  const step = (i, label, detail) =>
    `<li class="${i < at ? "done" : i === at ? "on" : ""}">${label}${detail ? ` <span style="font-weight:400;color:var(--mist)">— ${detail}</span>` : ""}</li>`;

  return page("Your audit is running",
              `<div class="spin" role="status" aria-label="Audit in progress"></div>
              <h1>Your audit is running</h1>
              <p>This page refreshes itself. Typically a few minutes — you'll also get an email the moment it's ready, so you can
              close this tab safely.</p>
              <ol class="steps">
              ${step(0, "Reading your site's structure", "sitemap, robots, llms.txt")}
              ${step(1, "Crawling your pages", `${(job.site?.pages || []).length} done`)}
              ${step(2, "Querying the AI assistants", `${(job.runs || []).length} runs logged`)}
              ${step(3, "Scoring and writing the report", "")}
              </ol>
              <p class="note">Reference ${esc(id)}. Every query is logged with its exact prompt, timestamp, full response and
              citations — including the ones where you don't appear. That's the part that makes it worth reading.</p>`, 10);
};
