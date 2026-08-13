/**
 * Background function: runs the automated free Answer Snapshot.
 *
 * Invoked fire-and-forget by submission-created. Background functions get ~15
 * minutes, so this does not need the staged self-invoke dance that run-audit
 * uses — engine calls with web search routinely exceed the 10s synchronous
 * limit, which is exactly what that limit would otherwise break.
 *
 * Deliberately lean: LEAN_SCORED unbranded prompts plus one branded control,
 * across whichever providers are configured. The paid audit runs the full
 * prompt set against a full crawl; this one answers only what the free page
 * promises — do you appear, who appears instead, is the description accurate.
 *
 * Nothing here emails the prospect. It emails Kenny a review with an approve
 * link, and only that link releases the snapshot.
 */
import { json, sign, verify, mail, shell, esc, ref as mkRef, NOTIFY, SITE } from "./_lib/util.mjs";
import { putJson } from "./_lib/blobs.mjs";
import { buildPrompts, configuredProviders, snapshotProviders, runOne } from "./_lib/engines.mjs";
import { buildPayload, fitPayload, scoreFromRuns, STORE } from "./_lib/snapshot.mjs";

/** Unbranded prompts to run for a free snapshot. Each one costs money. */
const LEAN_SCORED = 3;
/** How many provider×prompt calls to run at once. */
const CONCURRENCY = 3;

const chunk = (arr, n) => arr.reduce((a, _, i) => (i % n ? a : [...a, arr.slice(i, i + n)]), []);

export default async (req) => {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad body" }, 400); }

  const { intake, key } = body || {};
  if (!intake?.email) return json({ ok: false, error: "intake.email required" }, 400);
  // Only our own functions may spend API credit.
  if (!verify(intake.email, key)) return json({ ok: false, error: "not authorised" }, 403);

  const reference = body.reference || mkRef("SNAP");
  const scan = body.scan || { findings: [], counts: { total: 0 } };
  const log = (...a) => console.log(`[snapshot ${reference}]`, ...a);

  try {
    // Free snapshots are narrowed by ENGINE COUNT, never by model quality — every
    // engine below runs the identical flagship model a paid audit uses, so the
    // "named / not named" verdict carries the same weight. A cheaper model would
    // name fewer businesses, understating a prospect's visibility and inflating
    // the very problem we then quote to fix; that is not a trade worth cents.
    //
    // The metered SERP providers are excluded too: a snapshot is 4 prompts and each
    // AI-Overviews prompt costs up to 2 SerpApi searches, so at the daily snapshot
    // ceiling free traffic would burn a 250/month quota in about a day and a half
    // and leave paying customers with nothing. Paid audits still get the full set.
    let providers = snapshotProviders();
    // A mistyped SNAPSHOT_ENGINES must degrade to "run something" rather than
    // silently ship an empty snapshot that reads as "you appear nowhere".
    if (!providers.length) {
      providers = configuredProviders().filter((p) => p.kind === "api");
      if (providers.length) log("SNAPSHOT_ENGINES matched no configured engine — falling back to all API engines");
    }
    log("snapshot engines:", providers.map((p) => p.id).join(", ") || "none");
    if (!providers.length) {
      log("no providers configured — aborting before any spend");
      await notifyFailure({ reference, intake, reason: "No AI provider API keys are configured, so nothing could be queried." });
      return json({ ok: false, error: "no providers" });
    }

    const all = buildPrompts({
      service: intake.service,
      city: intake.city,
      business: intake.business,
      competitors: intake.competitor ? [intake.competitor] : [],
      questions: intake.question ? [intake.question] : [],
    });
    const scored = all.filter((p) => p.scored).slice(0, LEAN_SCORED);
    const branded = all.find((p) => !p.scored);
    const prompts = branded ? [...scored, branded] : scored;

    const jobs = [];
    for (const provider of providers) for (const prompt of prompts) jobs.push({ provider, prompt });
    log(`${providers.length} providers × ${prompts.length} prompts = ${jobs.length} calls`);

    const runs = [];
    for (const batch of chunk(jobs, CONCURRENCY)) {
      const settled = await Promise.allSettled(batch.map(({ provider, prompt }) =>
        runOne({ provider, prompt, business: intake.business, competitors: intake.competitor ? [intake.competitor] : [] })));
      for (const s of settled) if (s.status === "fulfilled" && s.value) runs.push(s.value);
    }

    const usable = runs.filter((r) => r.ok);
    log(`${usable.length}/${runs.length} calls returned usable answers`);

    const payload = buildPayload({ intake, scan, runs, reference });
    const { payload: fitted, url, trimmed, tight } = fitPayload(payload);
    if (trimmed) log("payload trimmed to fit the link budget", tight ? "(still tight)" : "");

    const s = scoreFromRuns(runs);
    const approveKey = sign(`approve:${reference}`);
    const approveUrl = `${SITE}/api/snapshot-approve?ref=${encodeURIComponent(reference)}&k=${encodeURIComponent(approveKey)}`;

    await putJson(STORE, `${reference}/snapshot`, {
      reference, createdAt: new Date().toISOString(), intake, payload: fitted, url,
      runs: runs.map((r) => ({ platform: r.platform, prompt: r.prompt, scored: r.scored, ok: r.ok,
        appeared: r.appeared, error: r.error || null, response: String(r.response || "").slice(0, 1500) })),
      sent: false,
    });

    await mail({
      to: NOTIFY,
      replyTo: intake.email,
      tag: "snapshot-review",
      subject: `REVIEW SNAPSHOT · ${intake.business} · ${s.score ?? "—"}/100 · ${s.appears}`,
      html: shell({
        preheader: `Automated snapshot ready for ${intake.business}. Nothing has been sent to them yet.`,
        heading: `Snapshot ready for review — ${esc(intake.business)}`,
        body: `<p style="margin:0 0 14px"><strong>Nothing has gone to the prospect yet.</strong> Open the snapshot,
            read it, then approve if it holds up.</p>
          <table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px;margin-bottom:16px">
            ${[["Business", intake.business], ["Website", intake.website], ["Service", intake.service],
               ["City", intake.city], ["Lead email", intake.email], ["Phone", intake.phone],
               ["Call/text consent", intake.consent ? "YES — box ticked" : "NO — email only, do not call or text"],
               ["Score", s.score == null ? "not calculated" : `${s.score}/100`],
               ["Appears in", s.appears],
               ["Engine calls", `${usable.length} usable of ${runs.length}`],
               ["Pre-scan findings", `${scan.counts?.total ?? 0} (${scan.counts?.high ?? 0} High)`]]
              .filter(([, v]) => v !== undefined && v !== "")
              .map(([k, v]) => `<tr><td style="padding:6px 10px;color:#98a2b3;font-size:12.5px;white-space:nowrap;vertical-align:top">${k}</td>
                <td style="padding:6px 10px;font-size:13px;color:#101828">${esc(String(v))}</td></tr>`).join("")}
          </table>
          <p style="margin:0 0 6px"><a href="${url}" style="color:#c2410c;font-weight:700">Preview the snapshot they would see →</a></p>
          <p style="margin:0 0 16px;font-size:12.5px;color:#98a2b3">Reference ${esc(reference)}. Approving emails this exact page to ${esc(intake.email)}.</p>
          ${runs.filter((r) => !r.ok).length
            ? `<p style="font-size:12.5px;color:#b42318"><strong>${runs.filter((r) => !r.ok).length} call(s) failed:</strong>
               ${esc([...new Set(runs.filter((r) => !r.ok).map((r) => `${r.platform}: ${r.error}`))].join(" · ").slice(0, 400))}</p>`
            : ""}`,
        cta: "Approve and send to the lead",
        ctaUrl: approveUrl,
        footNote: `If it doesn't hold up, just don't click. Nothing is sent unless you approve it, and the stored
          snapshot expires with the link.`,
      }),
    });

    log("review email sent; awaiting approval");
    return json({ ok: true, reference, awaitingApproval: true });
  } catch (e) {
    console.error(`[snapshot ${reference}] failed`, e?.message || e);
    await notifyFailure({ reference, intake, reason: String(e?.message || e) });
    return json({ ok: false, error: String(e?.message || e) });
  }
};

async function notifyFailure({ reference, intake, reason }) {
  try {
    await mail({
      to: NOTIFY,
      replyTo: intake?.email,
      tag: "snapshot-failed",
      subject: `SNAPSHOT FAILED · ${intake?.business || intake?.email || reference} — handle by hand`,
      html: shell({
        heading: "Automated snapshot failed",
        body: `<p>The prospect saw no error and is still expecting their snapshot. Run this one by hand.</p>
          <p style="font-size:13px;color:#b42318"><strong>Reason:</strong> ${esc(reason)}</p>
          <table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px">
            ${Object.entries(intake || {}).filter(([, v]) => v).map(([k, v]) =>
              `<tr><td style="padding:6px 10px;color:#98a2b3;font-size:12.5px">${esc(k)}</td>
               <td style="padding:6px 10px;font-size:13px">${esc(String(v).slice(0, 300))}</td></tr>`).join("")}
          </table>
          <p style="font-size:12.5px;color:#98a2b3">Reference ${esc(reference)}</p>`,
      }),
    });
  } catch (e) {
    console.error("[snapshot] failure notice also failed", e?.message || e);
  }
}
