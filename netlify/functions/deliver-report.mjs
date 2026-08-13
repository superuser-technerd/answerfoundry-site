/**
 * POST /api/deliver-report        (admin only — header: x-admin-token)
 *
 * The last step of the pipeline: emails a finished report to the client and
 * confirms delivery back to Kenny. Called by tools/publish-report.sh once the
 * report has been rendered and deployed to its unguessable path.
 *
 * Body: { email, business, reference, path:"/r/<token>", pdf?:"/r/<token>/report.pdf",
 *         findings?:number, high?:number, score?:number, callUrl?:string }
 */
import { json, bad, isAdmin, mail, shell, esc, isEmail, NOTIFY, SITE } from "./_lib/util.mjs";

export const config = { path: "/api/deliver-report" };

export default async (req) => {
    if (req.method !== "POST") return bad("POST only", 405);
    if (!isAdmin(req)) return bad("Not authorised", 401);

    let d;
    try { d = await req.json(); } catch { return bad("Malformed request body"); }
    if (!isEmail(d.email)) return bad("A valid client email is required");
    if (!d.path || !d.path.startsWith("/")) return bad("path must be the site-relative report path, e.g. /r/ab12…");

    const url = `${SITE}${d.path.replace(/\/?$/, "/")}`;
    const pdf = d.pdf ? `${SITE}${d.pdf}` : "";
    const ref = d.reference || "";
    const stat = [
          d.findings ? `${d.findings} documented findings` : "",
          d.high ? `${d.high} rated High or Critical` : "",
          d.score != null ? `visibility score ${d.score}/100` : "",
        ].filter(Boolean).join(" · ");

    const toClient = await mail({
          to: d.email,
          replyTo: NOTIFY,
          tag: "report-delivery",
          subject: `Your Foundry Audit is ready — ${d.business || ref}`,
          html: shell({
                  preheader: stat || "Your full report and the prioritized 30/60/90-day plan.",
                  heading: "Your Foundry Audit is ready",
                  body: `<p>The full report for ${esc(d.business || "your business")} is live at the private link below.
                          ${stat ? `<strong>${esc(stat)}.</strong>` : ""}</p>
                                  <p>Read §1 first, then §15 for the score and priority matrix, then §16 for what to do in the next 30 days.
                                          Everything in between is the evidence for those three.</p>
                                                  ${pdf ? `<p><a href="${pdf}" style="color:#c2410c;font-weight:700">Download the PDF →</a></p>` : ""}
                                                          <p>Two things to know before you read it. Every finding carries a source and an observation date, including
                                                                  the ones that don't flatter anyone — if a result was favourable to you it's logged the same way. And §20
                                                                          sets out what wasn't tested and what these systems can't be made to promise. That section is not filler.</p>
                                                                                  ${d.callUrl ? `<p>Your review call: <a href="${esc(d.callUrl)}" style="color:#c2410c;font-weight:700">book a time →</a></p>`
                                                                                                        : `<p>When you've read it, reply here and we'll set up the review call.</p>`}`,
                  cta: "Open your report",
                  ctaUrl: url,
                  footNote: `Private link, not indexed and not listed anywhere${ref ? ` · Reference ${ref}` : ""}. The Foundry Audit is a
                          fixed-scope diagnostic, non-refundable once delivered — see <a href="${SITE}/terms/" style="color:#98a2b3">Terms</a>.
                                  If you start a Forge &amp; Monitor plan within 14 days, the audit fee is credited toward your first month.
                                          AnswerFoundry does not guarantee placement, citation or ranking in any AI-generated answer.`,
          }),
    });

    await mail({
          to: NOTIFY,
          tag: "report-delivery-internal",
          subject: `Delivered: ${d.business || ref} ${toClient.ok ? "✓" : "✗ EMAIL FAILED"}`,
          html: shell({
                  heading: toClient.ok ? "Report delivered" : "Report NOT delivered — email failed",
                  body: `<p>${esc(d.business || "")} ${ref ? `· ${esc(ref)}` : ""}</p>
                          <p><a href="${url}" style="color:#c2410c">${esc(url)}</a></p>
                                  <p style="color:#98a2b3;font-size:13px">To: ${esc(d.email)} · ${stat || "no stats supplied"}</p>
                                          ${toClient.ok ? "" : `<p style="color:#b42318"><strong>Send this by hand.</strong> ${esc(JSON.stringify(toClient.detail || {}).slice(0, 400))}</p>`}`,
          }),
    });

    if (!toClient.ok) return bad("Report email failed to send — see the internal alert for details.", 502);
    return json({ ok: true, url, pdf: pdf || null });
};
