/**
 * Shared snapshot assembly: turn a pre-scan plus a set of engine runs into the
 * payload that /snapshot/ renders, the signed viewer link, and the lead email.
 *
 * Used by snapshot-run-background (automated) and snapshot-create (manual), so
 * both produce byte-identical output and there is only one place to change copy.
 *
 * Honesty rules encoded here, not left to the caller:
 *   - an engine that was not queried is reported as not queried, never as absent
 *   - "accuracy" states what the branded run said and that nobody verified it
 *   - the score names its own formula so it can be argued with
 */
import { b64u, sign, esc, mail, shell, SITE, NOTIFY, STRIPE_AUDIT_LINK } from "./util.mjs";
import { coverage } from "./engines.mjs";

/** Blob store holding prepared-but-unsent snapshots, awaiting approval. */
export const STORE = "snapshots";

/** Unbranded runs carry 70%; the branded control carries 30%. */
export const W_UNBRANDED = 0.7;
export const W_BRANDED = 0.3;

/** Free snapshots preview three gaps. The rest is the paid audit. */
export const FREE_GAP_COUNT = 3;

export function scoreFromRuns(runs) {
    const ok = runs.filter((r) => r && r.ok);
    const scored = ok.filter((r) => r.scored);
    const branded = ok.find((r) => !r.scored);

  if (!scored.length && !branded) {
        return { score: null, appears: "no engine returned a usable answer", rate: null, scoredCount: 0, appearedCount: 0 };
  }

  const appeared = scored.filter((r) => r.appeared);
    const rate = scored.length ? appeared.length / scored.length : 0;
    const brandedKnown = branded ? !!branded.appeared : false;

  // If there is no branded control, don't silently score its 30% as zero —
  // renormalise onto what actually ran.
  const score = branded
      ? Math.round((W_UNBRANDED * rate + W_BRANDED * (brandedKnown ? 1 : 0)) * 100)
        : Math.round(rate * 100);

  return {
        score,
        rate,
        scoredCount: scored.length,
        appearedCount: appeared.length,
        brandedKnown,
        hasBranded: !!branded,
        appears: scored.length
          ? `${appeared.length} of ${scored.length} unbranded ${scored.length === 1 ? "query" : "queries"}`
                : "no unbranded query completed",
  };
}

export function verdictFor(s, business) {
    if (s.score === null) return `No engine returned a usable answer, so no score could be calculated for ${business}.`;
    if (s.appearedCount === 0 && !s.brandedKnown)
          return `${business} was not named in any unbranded query, and the branded check did not return a recognisable description either. That points at an entity problem before a discovery one.`;
    if (s.appearedCount === 0)
          return `${business} was not named in any unbranded query, though the branded check did return a description. The business is known but is not being recommended.`;
    if (s.rate < 0.5)
          return `${business} appeared in some unbranded queries but not most of them — recognised, but not the default recommendation.`;
    return `${business} appeared in the majority of unbranded queries tested.`;
}

/** Which named engines ran, which didn't, and why — straight from coverage(). */
export function platformRows(runs) {
    return coverage().map((c) => {
          const mine = runs.filter((r) => r && c.match.test(r.platform || ""));
          const usable = mine.filter((r) => r.ok);
          return {
                  name: c.name,
                  tested: c.live && usable.length > 0,
                  appeared: usable.some((r) => r.scored && r.appeared),
                  note: !c.live ? "not queried — no API access configured" : usable.length ? c.how : "queried, but no usable answer returned",
          };
    });
}

export function competitorsFrom(runs) {
    const tally = new Map();
    for (const r of runs) {
          if (!r?.ok) continue;
          for (const name of r.competitorsNamed || []) {
                  const k = name.toLowerCase();
                  tally.set(k, { name, count: (tally.get(k)?.count || 0) + 1 });
          }
    }
    return [...tally.values()].sort((a, b) => b.count - a.count).slice(0, 6).map((c) => c.name);
}

/** Accuracy is reported, not judged — we have no ground truth to check against. */
export function accuracyFrom(runs, business) {
    const branded = runs.find((r) => r?.ok && !r.scored);
    if (!branded) return "The branded check did not complete, so nothing can be said about accuracy.";
    if (!branded.appeared)
          return `Asked directly about ${business}, the assistant did not return a recognisable description. Nothing to check for accuracy — the gap is recognition, not correctness.`;
    const excerpt = String(branded.response || "").replace(/\s+/g, " ").trim().slice(0, 260);
    return `Asked directly about ${business}, the assistant said: "${excerpt}${excerpt.length >= 260 ? "…" : ""}" We have not verified this against your own records — read it and check whether the services, location and claims are right.`;
}

/** Top pre-scan findings become the previewed gaps. Detail is trimmed for the link budget. */
export function gapsFrom(scan, limit = FREE_GAP_COUNT) {
    const found = (scan?.findings || []).slice(0, limit).map((f) => ({
          title: `${f.sev === "Med" ? "Medium" : f.sev}: ${f.what}`,
          detail: String(f.detail || "").slice(0, 320),
    }));
    while (found.length < limit) {
          found.push({
                  title: "Nothing further detected automatically",
                  detail: "The automated pre-scan found no additional defect at this level. The paid audit checks signals a single-page scan cannot reach — citations, entity consistency across directories, and per-page structured data.",
          });
    }
    return found;
}

export function nextStepFrom(scan, s) {
    const first = (scan?.findings || [])[0];
    if (s.score === 0 || s.appearedCount === 0)
          return "Fix the entity foundation first — until a machine can tell what this business is and where it operates, nothing else moves the answer.";
    if (first) return `Start with: ${first.what.charAt(0).toLowerCase()}${first.what.slice(1)}.`;
    return "Re-test on a fixed prompt set in 30 days so any change can be attributed.";
}

export function buildPayload({ intake, scan, runs, reference, expiresDays = 45 }) {
    const s = scoreFromRuns(runs);
    const business = intake.business || "this business";
    return {
          reference,
          business,
          city: intake.city || "",
          service: intake.service || "",
          website: intake.website || "",
          ranAt: new Date().toISOString().slice(0, 10),
          score: s.score,
          scoreOutOf: 100,
          verdict: verdictFor(s, business),
          appears: s.appears,
          platforms: platformRows(runs),
          competitors: competitorsFrom(runs),
          accuracy: accuracyFrom(runs, business),
          gaps: gapsFrom(scan),
          findingsTotal: scan?.counts?.total ?? 0,
          nextStep: nextStepFrom(scan, s),
          buyUrl: STRIPE_AUDIT_LINK,
          expires: new Date(Date.now() + expiresDays * 864e5).toISOString(),
          _scoreNote: `Score = ${Math.round(W_UNBRANDED * 100)}% share of unbranded answers + ${Math.round(W_BRANDED * 100)}% branded recognition.`,
    };
}

export function snapshotUrl(payload) {
    const enc = b64u.enc(payload);
    return { url: `${SITE}/snapshot/?d=${enc}&s=${sign(enc)}`, length: enc.length + 80 };
}

/** Trim the payload until the signed link fits inside the URL budget. */
export function fitPayload(payload, max = 7500) {
    let p = { ...payload };
    let { url } = snapshotUrl(p);
    if (url.length <= max) return { payload: p, url, trimmed: false };

  p.gaps = p.gaps.map((g) => ({ ...g, detail: g.detail.slice(0, 180) }));
    ({ url } = snapshotUrl(p));
    if (url.length <= max) return { payload: p, url, trimmed: true };

  p.accuracy = String(p.accuracy).slice(0, 180);
    p.competitors = (p.competitors || []).slice(0, 3);
    ({ url } = snapshotUrl(p));
    return { payload: p, url, trimmed: true, tight: url.length > max };
}

export async function emailSnapshotToLead({ email, payload, url, expiresDays = 45 }) {
    return mail({
          to: email,
          replyTo: NOTIFY,
          tag: "snapshot-delivery",
          subject: `Your free Answer Snapshot — ${payload.business}`,
          html: shell({
                  preheader: `${payload.score != null ? `Visibility score ${payload.score}/100. ` : ""}Three gaps, one next step.`,
                  heading: "Your Answer Snapshot is ready",
                  body: `<p>We tested how ${esc(payload.business)} shows up when someone in ${esc(payload.city || "your area")} asks
                          an AI assistant about ${esc(payload.service || "your category")}. The result is on the page below —
                                  ${payload.score != null ? `including a visibility score of <strong>${payload.score}/100</strong>, ` : ""}the
                                          three gaps we found, and the one thing to do first.</p>
                                                  <p>It's a preliminary read from a limited prompt set on a single day, not a full diagnostic. The page lists
                                                          which assistants were queried and which were not, and where something couldn't be verified it says so
                                                                  instead of filling it in.</p>`,
                  cta: "Open your snapshot",
                  ctaUrl: url,
                  footNote: `Private link, just for you — it expires in ${expiresDays} days. Reference ${payload.reference}.
                          A snapshot reflects a limited set of test questions at one point in time, queried through developer APIs,
                                  which are not identical to the consumer apps. AnswerFoundry does not control ChatGPT, Google, Perplexity or
                                          any other AI system and does not guarantee placement, citation or ranking in any AI-generated answer.
                                                  <a href="${SITE}/ai-disclaimer/" style="color:#98a2b3">Full disclaimer</a>.`,
          }),
    });
}
