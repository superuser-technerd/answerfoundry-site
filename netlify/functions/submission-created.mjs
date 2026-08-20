/**
 * Netlify fires this automatically on every form submission. No changes to the
 * existing forms were needed to wire it up.
 *
 * visibility-score (the free Answer Snapshot request):
 *   - acknowledges the requester immediately, with a real expectation set
 *   - runs the automated technical pre-scan on their site
 *   - sends Kenny a work-ready brief: the pre-scan plus the exact prompt set to
 *     run, and the one-line curl that delivers the finished snapshot
 *
 * The AI-engine testing deliberately stays manual. An automated snapshot that
 * claimed to know what ChatGPT said, without having asked it, would be a lie —
 * and this business is sold on not doing that.
 *
 * contact: formats and forwards, so a paid-service enquiry can't sit unseen in a dashboard.
 */
import { prescan, prescanHtml, mail, shell, esc, normUrl, isEmail, sign, ref as mkRef, NOTIFY, SITE } from "./_lib/util.mjs";
import { checkSnapshotAllowance, LIMITS } from "./_lib/ratelimit.mjs";

const pick = (o, ...keys) => {
  for (const k of keys) if (o?.[k]) return String(o[k]).trim();
  return "";
};

export default async (req) => {
  let payload = {};
  try {
    const body = await req.json();
    payload = body?.payload || body || {};
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const form = payload.form_name || payload.formName || "";
  const d = payload.data || payload;

  /* ---------------------------------------------- free Answer Snapshot */
  if (form === "visibility-score" || d.form_name === "visibility-score") {
    const email = pick(d, "email", "Email", "email-address");
    // The live form posts snake_case (business_name, primary_service, …). The
    // hyphenated spellings are kept so older submissions still parse.
    const business = pick(d, "business", "business_name", "business-name", "businessName", "company") || "your business";
    const website = normUrl(pick(d, "website", "url", "business-website", "site"));
    const service = pick(d, "service", "primary_service", "primary-service", "primaryService") || "your category";
    const city = pick(d, "city", "location", "service_area", "service-area", "serviceArea") || "your area";
    const phone = pick(d, "phone", "telephone");
    const competitor = pick(d, "competitor", "top_competitor", "top-competitor", "topCompetitor");
    const question = pick(d, "question", "main_question", "main-question", "customer_question", "customer-question");
    const budget = pick(d, "budget", "budget_range", "monthly-budget");
    const provider = pick(d, "provider", "current_provider", "current-provider");
    // Consent is evidence, not decoration — surface it so SMS outreach can be justified.
    const consent = /^(on|true|yes|1|checked)$/i.test(String(d.phone_consent ?? d.contact_consent ?? "").trim());

    const scan = website ? await prescan(website).catch((e) => ({ url: website, error: e.message, findings: [] }))
                         : { url: "", error: "no website supplied", findings: [] };

    const prompts = [
      `best ${service} in ${city}`,
      `top rated ${service} near ${city}`,
      `who should I use for ${service} in ${city}`,
      `${service} ${city} reviews`,
      `is ${business} good for ${service}`,
      competitor ? `${business} vs ${competitor}` : `most trusted ${service} ${city}`,
      question || `${service} cost ${city}`,
    ];

    const reference = mkRef("SNAP");

    // Decided before anything is dispatched: engine calls cost money and this
    // form is public. A blocked run still emails the lead and still tells Kenny.
    const allowance = await checkSnapshotAllowance({ email, ip: d.ip });
    if (!allowance.allowed) console.warn(`[snapshot] run blocked (${allowance.reason}) for ${email}`);

    const ack = mail({
      to: email,
      replyTo: NOTIFY,
      tag: "snapshot-ack",
      subject: `We're running your Answer Snapshot — ${business}`,
      html: shell({
        preheader: "Here's exactly what we're doing and when you'll have it.",
        heading: "We're on it",
        body: `<p>Your Answer Snapshot request came through. Here's what actually happens next, so there's no mystery.</p>
          <ol style="padding-left:20px;margin:0 0 16px">
            <li style="margin-bottom:6px"><strong>Now</strong> — an automated technical scan of ${esc(website || "your site")}.</li>
            <li style="margin-bottom:6px"><strong>Then</strong> — we put the questions your customers ask to several AI
            assistants and record exactly what comes back. We query them through their developer APIs, which is close
            to but not identical to the consumer apps; your snapshot names which assistants were asked and which
            weren't, rather than implying we checked everything.</li>
            <li style="margin-bottom:6px"><strong>Then a human reads it.</strong> Nothing is sent to you automatically —
            we check the result makes sense before it reaches you.</li>
            <li><strong>Within 1 business day</strong> — your snapshot arrives as a private link: whether you show up,
            who shows up instead, whether the description of you is accurate, a visibility score, three gaps, and one
            next step.</li>
          </ol>
          <p>No call required to get it, and no sales sequence afterwards.</p>
          <p>While you wait, the sample audit is the honest version of what a full report looks like — the first
          quarter is open, including the section listing what wasn't tested.</p>`,
        cta: "Read the sample audit",
        ctaUrl: `${SITE}/sample-audit/`,
        footNote: `A snapshot is a preliminary read from a limited prompt set on a single day, not a comprehensive audit.
          AnswerFoundry does not control ChatGPT, Google, Perplexity or any other AI system and does not guarantee
          placement, citation or ranking in any AI-generated answer.`,
      }),
    });

    const brief = mail({
      to: NOTIFY,
      replyTo: isEmail(email) ? email : undefined,
      tag: "snapshot-brief",
      subject: `SNAPSHOT REQUEST · ${business} · ${city}${scan.counts?.high ? ` · ${scan.counts.high} High already` : ""}`,
      html: shell({
        preheader: `${service} in ${city}. Pre-scan done, prompt set below.`,
        heading: `Snapshot request: ${esc(business)}`,
        body: `<table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px">
            ${[["Business", business], ["Website", website || "(none given)"], ["Service", service], ["City", city],
               ["Email", email], ["Phone", phone], ["Competitor", competitor], ["Their question", question],
               ["Current provider", provider], ["Budget", budget],
               ["Call/text consent", consent ? "YES — box ticked" : "NO — email only, do not call or text"]]
              .filter(([, v]) => v)
              .map(([k, v]) => `<tr><td style="padding:6px 10px;color:#98a2b3;font-size:12.5px;white-space:nowrap;vertical-align:top">${k}</td>
                <td style="padding:6px 10px;font-size:13px;color:#101828">${esc(v)}</td></tr>`).join("")}
          </table>

          <p style="margin:18px 0 8px"><strong>Pre-scan</strong> — automated, already done</p>
          ${prescanHtml(scan)}

          <p style="margin:18px 0 6px"><strong>Prompt set to run by hand</strong> (ChatGPT, Perplexity, Claude — log date, exact text, full response, cited sources)</p>
          <ol style="padding-left:20px;font-size:13px;color:#475467">${prompts.map((p) => `<li style="margin-bottom:4px">${esc(p)}</li>`).join("")}</ol>

          ${allowance.allowed
            ? `<p style="margin:18px 0 6px"><strong>Automated run started.</strong> The engines are being queried now.
                 A second email will arrive with the finished snapshot and an approve button — nothing reaches the
                 prospect until you click it. If that email never comes, run the prompts above by hand.</p>`
            : `<p style="margin:18px 0 6px;padding:12px;background:#fff6ed;border:1px solid #f5c9a3;border-radius:8px">
                 <strong style="color:#8a6212">Automated run was NOT started — no API spend on this one.</strong><br>
                 <span style="font-size:13px;color:#475467">${esc(allowance.detail || allowance.reason)}</span><br>
                 <span style="font-size:12.5px;color:#98a2b3">The lead still got their acknowledgement. Run the prompts
                 above by hand, or raise the limit and resubmit.</span></p>`}
          <p style="font-size:12.5px;color:#98a2b3">Reference ${esc(reference)}.${allowance.counts?.today != null
            ? ` Automated snapshots today: ${allowance.counts.today}/${LIMITS.perDay}.` : ""}</p>`,
      }),
    });

    // Fire-and-forget: the background function owns the slow work (engine calls
    // with web search routinely exceed this function's 10s synchronous budget).
    // Failure to *dispatch* is worth logging; failure to *complete* emails Kenny.
    const dispatch = allowance.allowed
      ? fetch(`${SITE}/.netlify/functions/snapshot-run-background`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reference,
            scan,
            key: sign(email),
            intake: { email, business, website, service, city, phone, competitor, question, provider, budget, consent },
          }),
        }).catch((e) => console.error("[snapshot] dispatch failed", e.message))
      : Promise.resolve();

    await Promise.all([ack, brief, dispatch]);
    return new Response("ok");
  }

  /* --------------------------------------------------------- contact form */
  if (form === "contact" || d.form_name === "contact") {
    const reason = pick(d, "reason", "why");
    const rows = Object.entries(d)
      .filter(([k, v]) => v && !/^(form-name|bot-field|ip|user_agent|referrer)$/i.test(k))
      .map(([k, v]) => `<tr><td style="padding:6px 10px;color:#98a2b3;font-size:12.5px;white-space:nowrap;vertical-align:top">${esc(k)}</td>
        <td style="padding:6px 10px;font-size:13px;color:#101828">${esc(String(v).slice(0, 1200))}</td></tr>`).join("");
    await mail({
      to: NOTIFY,
      replyTo: isEmail(pick(d, "email")) ? pick(d, "email") : undefined,
      tag: "contact-alert",
      subject: `CONTACT${reason ? ` · ${reason}` : ""} · ${pick(d, "business", "name", "email") || "new enquiry"}`,
      html: shell({
        heading: reason ? `New enquiry — ${esc(reason)}` : "New enquiry",
        body: `<table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px">${rows}</table>
          <p style="margin-top:14px;font-size:13px;color:#98a2b3">Reply straight to this email to answer them.</p>`,
      }),
    });
    return new Response("ok");
  }

  return new Response("ignored");
};
