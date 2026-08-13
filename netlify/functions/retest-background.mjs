/**
* Re-test an existing audit and report the movement.
*
* POST /.netlify/functions/retest-background  { ref, adminToken }
*
* Re-runs the *identical* prompt set stored on the baseline job — not a freshly
* generated one, because regenerating prompts between cycles would silently
* destroy comparability and make every subsequent report a lie by omission.
*
* The site is re-crawled too, so technical findings reflect whatever was
* actually implemented since. The result is stored as its own cycle and the
* report gains §21, the comparison.
*/
import { sign, mail, shell, esc, isAdminToken, SITE, NOTIFY } from "./_lib/util.mjs";
import { getJson, putJson, put } from "./_lib/blobs.mjs";
import { upsertJob } from "./_lib/jobindex.mjs";
import { discover, crawlBatch, technicalFindings, PAGE_CAP } from "./_lib/crawl.mjs";
import { configuredProviders, runOne, providers } from "./_lib/engines.mjs";
import { score, plan } from "./_lib/score.mjs";
import { renderReport } from "./_lib/render.mjs";
import { renderComparison, shareOf } from "./_lib/compare.mjs";

const STORE = "audits";
const CRAWL_BATCH = 6;
const TIME_BUDGET_MS = 11 * 60 * 1000;

export default async (req) => {
  let body = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const ref = String(body.ref || "");
  if (!ref) return new Response("missing ref", { status: 400 });
  if (!isAdminToken(body.adminToken)) return new Response("not authorised", { status: 401 });

  const started = Date.now();
  const log = (...a) => console.log(`[retest ${ref}]`, ...a);

  const job = await getJson(STORE, `${ref}/job`);
  if (!job) return new Response("no such job", { status: 404 });
  if (job.stage !== "done") return new Response(`baseline not complete (stage ${job.stage})`, { status: 409 });
  if (!job.prompts?.length) return new Response("baseline has no stored prompt set", { status: 409 });

  const cycleNumber = (job.cycles || 1) + 1;
  const baselineRuns = job.baselineRuns || job.runs || [];
  const baselineDate = (job.baselineAt || job.finishedAt || "").slice(0, 10);

  try {
    // ---- re-crawl, so §10 and §12 reflect what was actually implemented
  const origin = new URL(job.intake.website).origin;
    const d = await discover(origin);
    const site = {
      origin, robots: d.robots, sitemapDeclared: d.sitemapDeclared, sitemapUrlCount: d.sitemapUrlCount,
      llmsTxt: d.llmsTxt, blockedAgents: d.blockedAgents, pages: [], truncated: false,
    };
    let queue = [...new Set([origin + "/", ...d.urls])].slice(0, PAGE_CAP);
    while (queue.length && site.pages.length < PAGE_CAP && Date.now() - started < TIME_BUDGET_MS / 3) {
      const { pages, discovered } = await crawlBatch(queue.splice(0, CRAWL_BATCH));
      site.pages.push(...pages);
      const known = new Set(site.pages.map((p) => p.url));
      for (const u of discovered) {
        if (site.pages.length + queue.length >= PAGE_CAP) { site.truncated = true; break; }
        if (!known.has(u) && !queue.includes(u)) queue.push(u);
      }
    }
    log("re-crawled", site.pages.length, "pages");

  // ---- the SAME prompts, against whatever engines are configured now
  const runs = [];
    const active = configuredProviders();
    for (const prompt of job.prompts) {
      for (const pr of active) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        const provider = providers.find((p) => p.id === pr.id);
        const r = await runOne({ provider, prompt, business: job.intake.business, competitors: job.intake.competitorList || [] });
        runs.push(r || {
          ok: false, platform: provider.label, model: "—", family: prompt.family, scored: prompt.scored,
          prompt: prompt.text, ranAt: new Date().toISOString(), error: "provider not configured at run time", appeared: null,
        });
      }
    }
    log("re-ran", runs.length, "engine runs across", active.length, "engines");

  // ---- score, render, then append the comparison
  const scoreObj = score({ site, runs, intake: job.intake });
    const planObj = plan(technicalFindings(site), scoreObj, job.intake);
    const { html, stats } = renderReport({
      intake: job.intake, site, runs, scoreObj, planObj, reference: ref, tier: job.tier,
    });
    const comparison = renderComparison({
      baseline: baselineRuns, current: runs, cycleNumber,
      baselineDate, currentDate: new Date().toISOString().slice(0, 10),
      scoreBase: job.baselineScore ?? job.stats?.score, scoreNow: stats.score,
    });
    const withComparison = html.replace("</div>\n<footer", comparison + "\n</div>\n<footer")
    .replace(/(<nav class="toc"[\s\S]*?<\/ol>)/, (m) =>
      m.replace("</ol>", `<li><a href="#s21">Movement since baseline &mdash; cycle ${cycleNumber}</a></li></ol>`));

  await put(STORE, `${ref}/cycle-${cycleNumber}.json`, JSON.stringify({ cycleNumber, runs, stats, at: new Date().toISOString() }));
    await put(STORE, `${ref}/report.html`, withComparison);

  const now = new Date().toISOString();
    Object.assign(job, {
      cycles: cycleNumber, lastCycleAt: now, stats,
      baselineRuns, baselineAt: job.baselineAt || job.finishedAt,
      baselineScore: job.baselineScore ?? job.stats?.score,
      runs, site, finishedAt: now, lockedAt: null,
    });
    await putJson(STORE, `${ref}/job`, job);
    await upsertJob({
      ref, stage: "done", cycles: cycleNumber, lastCycleAt: now,
      score: stats.score, findings: stats.findings, runs: stats.runs, pages: stats.pages,
    });

  const url = `${SITE}${job.reportPath}`;
    const sBase = shareOf(baselineRuns), sNow = shareOf(runs);
    const move = (sBase == null || sNow == null) ? "not comparable" :
      sNow > sBase ? `up ${sNow - sBase} points` : sNow < sBase ? `down ${sBase - sNow} points` : "unchanged";

  const sent = await mail({
    to: job.intake.email, replyTo: NOTIFY, tag: "retest",
    subject: `Cycle ${cycleNumber} results — ${job.intake.business}`,
    html: shell({
      preheader: `Share of answer ${move}. Score ${job.baselineScore ?? "—"} → ${stats.score}.`,
      heading: `Cycle ${cycleNumber} is in`,
      body: `<p>We re-ran the identical prompt set against the same engines and re-crawled your site. The
      comparison is §21 of your report, and it reports what didn't move as prominently as what did.</p>
      <p style="font-size:15px"><strong>Share of answer: ${move}.</strong> Visibility score
      ${job.baselineScore ?? "—"} &rarr; ${stats.score}.</p>
      <p>The sources table is the one to read first &mdash; citations tend to shift a cycle before rankings do,
      so it tells you where the next cycle's effort should go.</p>`,
      cta: "Open the updated report", ctaUrl: url,
      footNote: `Reference ${esc(ref)}, cycle ${cycleNumber}. Results vary by date, model version and location, and
      no causal claim is made between work performed and any change observed. See §20.`,
    }),
  });

  await mail({
    to: NOTIFY, tag: "retest-internal",
    subject: `CYCLE ${cycleNumber} · ${job.intake.business} · share ${move}`,
    html: shell({
      heading: `Cycle ${cycleNumber}: ${esc(job.intake.business)}`,
      body: `<p><a href="${url}" style="color:#c2410c">${esc(url)}</a></p>
      <p style="font-size:13px;color:#98a2b3">${esc(ref)} · score ${job.baselineScore ?? "—"} → ${stats.score} ·
      ${runs.length} runs · ${site.pages.length} pages · client emailed: ${sent.ok ? "yes" : "NO"}</p>`,
    }),
  });

  return new Response(JSON.stringify({ ok: true, ref, cycle: cycleNumber, share: { was: sBase, now: sNow } }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  } catch (e) {
    console.error(`[retest ${ref}] failed`, e);
    await mail({
      to: NOTIFY, tag: "retest-failed",
      subject: `RE-TEST FAILED · ${job.intake?.business || ref}`,
      html: shell({ heading: "Re-test failed", body: `<p>${esc(ref)}</p><p>${esc(String(e.message).slice(0, 300))}</p>` }),
    });
    return new Response("error", { status: 500 });
  }
};
