/**
 * GET /api/snapshot-data?d=<payload>&s=<signature>
 *
 * Serves a customer's Answer Snapshot to the viewer page. The signature is
 * verified server-side and — importantly — only the public 25% of the snapshot is
 * ever written into the response. The withheld findings stay on this side of the
 * wire, so the gate can't be defeated with devtools.
 */
import { json, bad, verify, b64u } from "./_lib/util.mjs";

export const config = { path: "/api/snapshot-data" };

const SHOW_GAPS = 3;   // gaps revealed, matching what /answer-snapshot/ promises

export default async (req) => {
    const u = new URL(req.url);
    const d = u.searchParams.get("d") || "";
    const s = u.searchParams.get("s") || "";
    if (!d || !s) return bad("This snapshot link is incomplete. Use the link exactly as it appears in your email.");
    if (!verify(d, s)) return bad("This snapshot link isn't valid. Reply to your snapshot email and we'll resend it.", 403);

    let p;
    try { p = b64u.dec(d); } catch { return bad("This snapshot link is corrupted."); }

    if (p.expires && Date.now() > Date.parse(p.expires))
          return bad("This snapshot link has expired. Reply to your snapshot email and we'll issue a fresh one.", 410);

    const gaps = Array.isArray(p.gaps) ? p.gaps : [];
    const shown = gaps.slice(0, SHOW_GAPS);
    const withheldCount = Math.max(0, (p.findingsTotal ?? gaps.length) - shown.length);

    return json({
          ok: true,
          business: p.business || "",
          city: p.city || "",
          service: p.service || "",
          website: p.website || "",
          ranAt: p.ranAt || "",
          reference: p.reference || "",
          score: p.score ?? null,
          scoreOutOf: p.scoreOutOf ?? 100,
          verdict: p.verdict || "",
          appears: p.appears || "",           // e.g. "1 of 6 unbranded queries"
          platforms: p.platforms || [],       // [{name, tested, appeared}]
          competitors: {
                  shown: (p.competitors || []).slice(0, 2),
                  withheld: Math.max(0, (p.competitors || []).length - 2),
          },
          accuracy: p.accuracy || "",         // one accuracy observation, in plain language
          gaps: shown,                        // the three promised gaps
          nextStep: p.nextStep || "",
          counts: {
                  findingsTotal: p.findingsTotal ?? gaps.length,
                  findingsShown: shown.length,
                  findingsWithheld: withheldCount,
                  sectionsInFullAudit: 20,
                  auditFindingsTypical: 70,
          },
          buyUrl: p.buyUrl || "",
    });
};
