/**
 * POST /api/unlock-sample  { email }
 *
 * The soft gate on the sample audit: emails the full report to anyone who asks,
 * and tells Kenny a named lead just read the preview all the way to the paywall.
 */
import { json, bad, mail, shell, mirrorToForm, isEmail, esc, NOTIFY, SITE, STRIPE_AUDIT_LINK } from "./_lib/util.mjs";

export const config = { path: "/api/unlock-sample" };

// Defaults to the real unguessable path so this works with no env var set —
// Netlify env writes have proven unreliable here, and a dead link in a lead
// magnet is worse than a hardcoded constant.
const FULL = process.env.FULL_SAMPLE_PATH || "/s/4cc5a873bbeedb7999eb5a06";

export default async (req) => {
  if (req.method !== "POST") return bad("POST only", 405);

  let d;
  try { d = await req.json(); } catch { return bad("Malformed request body"); }
  const email = String(d.email || "").trim().toLowerCase();
  if (!isEmail(email)) return bad("Please enter a valid email address.");

  const url = `${SITE}${FULL}/`;
  const pdf = `${SITE}${FULL}/AnswerFoundry-Sample-Audit.pdf`;

  const toLead = mail({
    to: email,
    replyTo: NOTIFY,
    tag: "sample-unlock",
    subject: "The full sample audit — all 78 findings",
    html: shell({
      preheader: "Complete 20-section report plus the 34-page PDF. No call, no follow-up sequence.",
      heading: "Here's the whole thing",
      body: `<p>The complete sample Foundry Audit — all 20 sections, 78 documented findings, 27 prioritized
        actions, run on a real Orlando med spa with its identity changed.</p>
        <p style="margin:0 0 6px"><a href="${url}" style="color:#c2410c;font-weight:700">Read it in your browser →</a></p>
        <p style="margin:0 0 18px"><a href="${pdf}" style="color:#c2410c;font-weight:700">Download the 34-page PDF →</a></p>
        <p>Two things worth saying plainly. First, §3 discloses what wasn't tested in the sample: no conversational
        assistant was queried, because it was compiled without a client engagement. A paid audit queries ChatGPT,
        Perplexity and Claude and logs every run verbatim. Second, §20 is the limitations section, and it's there because a report that
        only tells you the flattering parts isn't worth paying for.</p>
        <p>If it holds up, the standard Foundry Audit is $795. The founding launch price is $495 through September 19, 2026 or the first 10 paid audits, whichever comes first.</p>`,
      cta: "Claim the founding audit — $495",
      ctaUrl: STRIPE_AUDIT_LINK,
      footNote: `You asked for this on ${SITE}/sample-audit/ — that's the only reason you're getting it. No sequence,
        no list, no sales calls. AnswerFoundry does not guarantee placement or citation in any AI-generated answer.`,
    }),
  });

  const toKenny = mail({
    to: NOTIFY,
    replyTo: email,
    tag: "sample-unlock-internal",
    subject: `Sample unlock: ${email}`,
    html: shell({
      heading: "Someone read the preview to the paywall",
      body: `<p><strong>${esc(email)}</strong> requested the full sample.</p>
        <p style="color:#98a2b3;font-size:13px">Page: ${esc(d.page || "/sample-audit/")} ·
        ${new Date().toISOString()}</p>
        <p>They reached the bottom of the gated preview and gave an email rather than buying. Warm, not hot.</p>`,
    }),
  });

  const mirror = mirrorToForm("sample-unlock", { email, page: String(d.page || "/sample-audit/") });
  const [lead] = await Promise.all([toLead, toKenny, mirror]);

  if (!lead.ok)
    return bad("We couldn't send that email. Write to hello@answerfoundry.ai and we'll send it by hand.", 502);
  return json({ ok: true });
};
