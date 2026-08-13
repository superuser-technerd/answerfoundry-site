/**
 * POST /api/snapshot-create        (admin only — header: x-admin-token)
 *
 * Turns finished snapshot findings into a signed, unguessable viewer link and
 * emails it to the prospect. One call per snapshot; nothing to deploy.
 *
 * Body: { email, business, city, service, website, score, verdict, appears,
 *         platforms:[{name,tested,appeared}], competitors:[...], accuracy,
 *         gaps:[{title,detail}], findingsTotal, nextStep, send:true }
 */
import { json, bad, isAdmin, sign, b64u, mail, shell, esc, ref, NOTIFY, SITE, STRIPE_AUDIT_LINK } from "./_lib/util.mjs";

export const config = { path: "/api/snapshot-create" };

export default async (req) => {
    if (req.method !== "POST") return bad("POST only", 405);
    if (!isAdmin(req)) return bad("Not authorised", 401);

    let d;
    try { d = await req.json(); } catch { return bad("Malformed request body"); }
    if (!d.business) return bad("business is required");
    if (!Array.isArray(d.gaps) || d.gaps.length < 3)
          return bad("gaps must contain at least 3 items — the snapshot page promises three");

    const reference = d.reference || ref("SNAP");
    const days = Number(d.expiresDays ?? 45);

    const payload = {
          reference,
          business: d.business,
          city: d.city || "",
          service: d.service || "",
          website: d.website || "",
          ranAt: d.ranAt || new Date().toISOString().slice(0, 10),
          score: d.score ?? null,
          scoreOutOf: d.scoreOutOf ?? 100,
          verdict: d.verdict || "",
          appears: d.appears || "",
          platforms: d.platforms || [],
          competitors: d.competitors || [],
          accuracy: d.accuracy || "",
          gaps: d.gaps,
          findingsTotal: d.findingsTotal ?? d.gaps.length,
          nextStep: d.nextStep || "",
          buyUrl: d.buyUrl || STRIPE_AUDIT_LINK,
          expires: new Date(Date.now() + days * 864e5).toISOString(),
    };

    const enc = b64u.enc(payload);
    const url = `${SITE}/snapshot/?d=${enc}&s=${sign(enc)}`;
    if (url.length > 7500) return bad(`Snapshot payload is too large for a link (${url.length} chars). Trim the gap detail text.`);

    let sent = null;
    if (d.send !== false && d.email) {
          sent = await mail({
                  to: d.email,
                  replyTo: NOTIFY,
                  tag: "snapshot-delivery",
                  subject: `Your free Answer Snapshot — ${d.business}`,
                  html: shell({
                            preheader: `${payload.score != null ? `Visibility score ${payload.score}/${payload.scoreOutOf}. ` : ""}Three gaps, one next step.`,
                            heading: "Your Answer Snapshot is ready",
                            body: `<p>We tested how ${esc(d.business)} shows up when someone in ${esc(d.city || "your area")} asks
                                      an AI assistant about ${esc(d.service || "your category")}. The result is on the page below —
                                                ${payload.score != null ? `including a visibility score of <strong>${payload.score}/${payload.scoreOutOf}</strong>, ` : ""}the
                                                          three gaps we found, and the one thing to do first.</p>
                                                                    <p>It's a preliminary read from a limited prompt set on a single day, not a full diagnostic. Where
                                                                              something couldn't be verified, the page says so instead of filling it in.</p>`,
                            cta: "Open your snapshot",
                            ctaUrl: url,
                            footNote: `Private link, just for you — it expires in ${days} days. Reference ${reference}.
                                      A snapshot reflects a limited set of test questions at one point in time. AnswerFoundry does not control
                                                ChatGPT, Google, Perplexity or any other AI system and does not guarantee placement, citation or ranking
                                                          in any AI-generated answer. <a href="${SITE}/ai-disclaimer/" style="color:#98a2b3">Full disclaimer</a>.`,
                  }),
          });
    }

    return json({ ok: true, reference, url, urlLength: url.length, emailed: sent ? !!sent.ok : false, mail: sent });
};
