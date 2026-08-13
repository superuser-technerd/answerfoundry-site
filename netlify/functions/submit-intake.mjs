/**
 * POST /api/submit-intake
 *
 * The onboarding submit, for all four tiers.
 *   1. re-verify the Stripe session — the browser never gets to claim a payment
 *   2. store the intake and, for the audit tier, kick off the automated pipeline
 *   3. tell the client what is happening, in the same breath
 *   4. tell Kenny, with everything he needs to act
 *   5. mirror to a Netlify form so nothing depends on email being delivered
 *
 * Returns immediately. The audit itself runs in staged background invocations —
 * see run-audit.mjs — so a slow crawl never times out the customer's request.
 */
import {
  json, bad, verify, sign, stripeSession, mail, shell, mirrorToForm, ref as makeRef,
  esc, isEmail, normUrl, NOTIFY, SITE,
} from "./_lib/util.mjs";
import { putJson } from "./_lib/blobs.mjs";
import { upsertJob } from "./_lib/jobindex.mjs";
import { configuredProviders } from "./_lib/engines.mjs";

export const config = { path: "/api/submit-intake" };

export const TIERS = {
  audit: { label: "Foundry Audit", auto: true, eta: "a few minutes" },
  forge: { label: "Forge & Monitor", auto: true, eta: "a few minutes for the audit; implementation starts this week" },
  leader: { label: "Category Leader", auto: true, eta: "a few minutes for the baseline audit; strategy call within two business days" },
  founding: { label: "Founding Client", auto: true, eta: "a few minutes for the audit; implementation starts this week" },
};

const FIELDS = [
  ["business", "Business name", true],
  ["website", "Website", true],
  ["service", "Primary service", true],
  ["city", "City / service area", true],
  ["email", "Contact email", true],
  ["contact_name", "Contact name", false],
  ["phone", "Phone", false],
  ["questions", "Questions customers ask", false],
  ["competitors", "Competitors", false],
  ["gbp", "Google Business Profile", false],
  ["other_locations", "Other locations", false],
  ["web_manager", "Who manages the website", false],
  ["cms", "Website platform", false],
  ["access", "Access notes", false],
  ["compliance", "Claims and compliance limits", false],
  ["terms_required", "Required terminology", false],
  ["avoid_competitors", "Competitors not to mention", false],
  ["notes", "Anything else", false],
];

const lines = (s) => String(s || "").split(/[\n;]+/).map((x) => x.trim()).filter(Boolean).slice(0, 8);

export default async (req) => {
  if (req.method !== "POST") return bad("POST only", 405);
  let d;
  try { d = await req.json(); } catch { return bad("Malformed request body"); }

  /* ---- proof of payment */
  const sid = String(d.session_id || "");
  if (!sid || !verify(sid, d.grant))
    return bad("This onboarding link isn't valid. Please reopen the link in your Stripe receipt.", 403);
  let s;
  try { s = await stripeSession(sid); }
  catch { return bad("We couldn't re-verify your payment. Email hello@answerfoundry.ai and we'll start you manually today.", 502); }
  if (s.payment_status !== "paid" && s.status !== "complete")
    return bad("That payment hasn't completed yet. If you were charged, email hello@answerfoundry.ai.", 402);

  /* ---- validate */
  const tierKey = TIERS[String(d.tier || "audit")] ? String(d.tier) : "audit";
  const tier = TIERS[tierKey];
  const v = {};
  for (const [k] of FIELDS) v[k] = String(d[k] ?? "").trim().slice(0, 2000);
  const missing = FIELDS.filter(([k, , req_]) => req_ && !v[k]).map(([, l]) => l);
  if (missing.length) return bad(`Please fill in: ${missing.join(", ")}`);
  if (!isEmail(v.email)) return bad("That email address doesn't look right.");
  const site = normUrl(v.website);
  if (!site) return bad("That website URL doesn't look right — include the domain, e.g. yourbusiness.com");
  v.website = site;

  const reference = makeRef(tierKey === "audit" ? "FA" : "AF");
  const paid = ((s.amount_total ?? 0) / 100).toFixed(2);
  const intake = { ...v, competitorList: lines(v.competitors), questionList: lines(v.questions) };
  const engines = configuredProviders();

  /* ---- create the job and start the pipeline */
  let started = false;
  if (tier.auto && engines.length) {
    await putJson("audits", `${reference}/job`, {
      ref: reference, stage: "new", tier: tier.label, sessionId: s.id, amount: paid,
      intake, createdAt: new Date().toISOString(),
    });
    await upsertJob({
      ref: reference, kind: "audit", tier: tier.label, business: v.business, website: v.website,
      email: v.email, city: v.city, service: v.service, amount: paid, stage: "new",
    });
    fetch(`${SITE}/.netlify/functions/run-audit-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: reference, key: sign(reference) }),
    }).catch((e) => console.error("[submit-intake] could not start audit", e.message));
    started = true;
  }
  const statusUrl = `${SITE}/r/?id=${encodeURIComponent(reference)}&s=${sign("report:" + reference)}`;

  const rows = FIELDS.filter(([k]) => v[k]).map(([k, label]) =>
    `<tr><td style="padding:6px 10px;color:#98a2b3;font-size:12.5px;white-space:nowrap;vertical-align:top">${label}</td>
      <td style="padding:6px 10px;font-size:13px;color:#101828">${esc(v[k])}</td></tr>`).join("");

  /* ---- client email */
  const toClient = mail({
    to: v.email,
    replyTo: NOTIFY,
    tag: "onboarding-client",
    subject: started ? `Your audit is running now — ${reference}` : `You're onboarded — ${reference}`,
    html: shell({
      preheader: started ? "It's running right now. You'll have the report shortly." : `Reference ${reference}.`,
      heading: started ? "Your audit is running right now" : `Welcome aboard, ${esc(v.contact_name || v.business)}`,
      body: `<p>Payment received ($${paid}) for <strong>${esc(tier.label)}</strong>. Your reference is
        <strong>${reference}</strong> — quote it on any email and it lands in the right place.</p>
        ${started ? `<p>We're crawling ${esc(v.website)} and querying the AI assistants with your prompt set as you read
          this. Expected: <strong>${esc(tier.eta)}</strong>. You'll get a second email the moment the report is ready —
          or watch it happen on the status page below.</p>
          <p>Every query gets logged with its exact wording, the timestamp, the full response and the sources cited.
          Including the ones where you don't show up. That's the part worth reading.</p>`
        : `<p>Your audit is queued and will be produced by hand — we'll have it to you shortly, and you'll hear from a
          person, not an automation.</p>`}
        ${tierKey !== "audit" ? `<p><strong>What happens beyond the audit.</strong> The audit is your baseline. Implementation
          starts from it, in the priority order the report sets out, and you get a monthly report showing what moved and
          what didn't — including the things that didn't.</p>` : ""}
        ${v.compliance ? `<p><strong>Noted on compliance:</strong> "${esc(v.compliance.slice(0, 220))}". Nothing we recommend
          will ask you to publish something you've told us you can't.</p>` : ""}
        <p style="margin-top:18px"><strong>What we recorded</strong></p>
        <table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px">${rows}</table>
        <p style="margin-top:14px">Anything wrong above? Reply and it's corrected before anything else happens.</p>`,
      cta: started ? "Watch your audit run" : "Read the sample report meanwhile",
      ctaUrl: started ? statusUrl : `${SITE}/sample-audit/`,
      footNote: `Reference ${reference}. The Foundry Audit is a fixed-scope diagnostic, non-refundable once delivered —
        see <a href="${SITE}/terms/" style="color:#98a2b3">Terms</a>. AnswerFoundry does not control ChatGPT, Google,
        Perplexity or any other AI system and does not guarantee placement, citation or ranking in any AI-generated answer.`,
    }),
  });

  /* ---- internal */
  const toKenny = mail({
    to: NOTIFY,
    replyTo: v.email,
    tag: "onboarding-internal",
    subject: `PAID $${paid} · ${tier.label} · ${v.business} (${reference})${started ? " · audit running" : " · NEEDS MANUAL RUN"}`,
    html: shell({
      preheader: `${v.business} — ${v.city} — ${started ? "pipeline started" : "no engine keys configured, run it by hand"}`,
      heading: `${esc(tier.label)}: ${esc(v.business)}`,
      body: `<p><strong>${reference}</strong> · $${paid} ${(s.currency || "usd").toUpperCase()} ·
        Stripe <code style="font-size:12px">${esc(s.id)}</code></p>
        ${started
          ? `<p style="color:#2e6b4f"><strong>Automated audit started</strong> across ${engines.length} engine(s):
             ${engines.map((e) => esc(e.label)).join(", ")}. You'll get a second email when it delivers, and the client
             gets the report directly. Read it before they act on it.</p>`
          : `<p style="color:#b42318"><strong>No engine API keys are configured, so nothing is running.</strong> Add
             OPENAI_API_KEY, PERPLEXITY_API_KEY or ANTHROPIC_API_KEY in Netlify, or run this one by hand today. The
             client has been told a person will produce it, so that promise is still true — but it's on you now.</p>`}
        <table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px">${rows}</table>
        <p style="margin-top:16px"><a href="${statusUrl}" style="color:#c2410c;font-weight:700">Status / report link →</a></p>`,
      cta: "Open Stripe payment",
      ctaUrl: `https://dashboard.stripe.com/payments/${encodeURIComponent(s.payment_intent || "")}`,
    }),
  });

  const mirror = mirrorToForm("audit-intake", {
    reference, session_id: s.id, amount: paid, tier: tier.label,
    ...Object.fromEntries(FIELDS.map(([k]) => [k, v[k]])),
    auto_started: started ? "yes" : "no",
  });

  const [c] = await Promise.all([toClient, toKenny, mirror]);
  return json({
    ok: true, reference, tier: tier.label, started, statusUrl,
    engines: engines.map((e) => e.label), emailed: !!c.ok, eta: tier.eta,
  });
};
