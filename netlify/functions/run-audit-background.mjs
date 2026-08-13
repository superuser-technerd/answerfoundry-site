/**
* The audit pipeline, as a Netlify background function.
*
* Why this exists: the staged synchronous version could not work. A single
* engine call with web search enabled takes 5-15 seconds, and a synchronous
* function gets 10. The invocation was killed mid-call, so the job was never
* saved, the lock stayed held, and the next pump repeated the same doomed step
* forever — visible as "Querying the AI assistants — 0 runs logged" that never
* advanced. Crawling survived only because page fetches are fast.
*
* Background functions get 15 minutes, which is the right shape for this work.
* The whole audit runs in one invocation: discover, crawl, query every engine,
* score, render, store, email. Progress is written to blobs after each unit so
* the client's status page keeps showing live counts.
*
* It is safe to invoke more than once: a lock makes concurrent runs no-ops, and
* every stage resumes from whatever was already persisted.
*/
import { sign, mail, shell, esc, SITE, NOTIFY } from "./_lib/util.mjs";
import { getJson, putJson, put } from "./_lib/blobs.mjs";
import { upsertJob } from "./_lib/jobindex.mjs";
import { discover, crawlBatch, technicalFindings, PAGE_CAP } from "./_lib/crawl.mjs";
import { buildPrompts, configuredProviders, runOne, providers } from "./_lib/engines.mjs";
import { score, plan } from "./_lib/score.mjs";
import { renderReport } from "./_lib/render.mjs";

const STORE = "audits";
const CRAWL_BATCH = 6;
/** Leave headroom under the 15-minute ceiling for scoring, rendering and email. */
const TIME_BUDGET_MS = 11 * 60 * 1000;
/** A run that hasn't checkpointed in this long is presumed dead and may be taken over. */
const LOCK_MS = 90 * 1000;

export default async (req) => {
  let body = {};
  try { body = await req.json(); } catch { /* background invocations may arrive bare */ }
  const ref = String(body.ref || "");
  const started = Date.now();
  const log = (...a) => console.log(`[audit-bg ${ref}]`, ...a);

  if (!ref) return new Response("missing ref", { status: 400 });

  let job = await getJson(STORE, `${ref}/job`);
  if (!job) return new Response("no such job", { status: 404 });
  if (job.stage === "done" || job.stage === "failed")
    return new Response(job.stage, { status: 200 });

  if (job.lockedAt && Date.now() - Date.parse(job.lockedAt) < LOCK_MS) {
    log("another run holds the lock — standing down");
    return new Response("already running", { status: 200 });
  }

  const save = async (patch = {}) => {
    Object.assign(job, patch, { lockedAt: new Date().toISOString() });
    await putJson(STORE, `${ref}/job`, job);
    if (patch.stage) await upsertJob({ ref, stage: patch.stage });
  };
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;

  try {
    await save();

  /* ------------------------------------------------------------ discover */
  if (job.stage === "new") {
    const origin = new URL(job.intake.website).origin;
    const d = await discover(origin);
    job.site = {
      origin, robots: d.robots, sitemapDeclared: d.sitemapDeclared,
      sitemapUrlCount: d.sitemapUrlCount, llmsTxt: d.llmsTxt,
      blockedAgents: d.blockedAgents, pages: [], truncated: false,
    };
    job.queue = [...new Set([origin + "/", ...d.urls])].slice(0, PAGE_CAP);
    job.truncatedAt = d.urls.length > PAGE_CAP;
    await save({ stage: "crawl" });
    log("discovered", job.queue.length, "urls");
  }

  /* --------------------------------------------------------------- crawl */
  while (job.stage === "crawl" && !outOfTime()) {
    const batch = (job.queue || []).splice(0, CRAWL_BATCH);
    if (batch.length) {
      const { pages, discovered } = await crawlBatch(batch);
      job.site.pages.push(...pages);
      const known = new Set(job.site.pages.map((p) => p.url));
      for (const u of discovered) {
        if (job.site.pages.length + job.queue.length >= PAGE_CAP) { job.site.truncated = true; break; }
        if (!known.has(u) && !job.queue.includes(u)) job.queue.push(u);
      }
    }
    if (!job.queue.length || job.site.pages.length >= PAGE_CAP) {
      if (job.site.pages.length >= PAGE_CAP || job.truncatedAt) job.site.truncated = true;
      job.prompts = buildPrompts({
        service: job.intake.service, city: job.intake.city, business: job.intake.business,
        competitors: job.intake.competitorList, questions: job.intake.questionList,
      });
      job.plan = [];
      for (const p of job.prompts) for (const pr of configuredProviders()) job.plan.push({ prompt: p, providerId: pr.id });
      job.runs = job.runs || [];
      await save({ stage: "engines" });
      log(`crawl done: ${job.site.pages.length} pages · ${job.plan.length} engine runs planned across ${configuredProviders().length} engines`);
    } else {
      await save();
      log(`crawled ${job.site.pages.length}, ${job.queue.length} queued`);
    }
  }

  /* ------------------------------------------------------------- engines */
  while (job.stage === "engines" && (job.plan || []).length && !outOfTime()) {
    const item = job.plan.shift();
    const provider = providers.find((p) => p.id === item.providerId);
    if (provider) {
      const r = await runOne({
        provider, prompt: item.prompt, business: job.intake.business,
        competitors: job.intake.competitorList || [],
      });
      // A null result means the provider key vanished mid-run. Record it rather
    // than silently logging nothing, so §5 and §20 can be honest about it.
    job.runs.push(r || {
      ok: false, platform: provider.label, model: "—", family: item.prompt.family,
      scored: item.prompt.scored, prompt: item.prompt.text, ranAt: new Date().toISOString(),
      error: "provider not configured at run time", appeared: null,
    });
    }
    await save();
    log(`engines: ${job.runs.length} logged, ${job.plan.length} left`);
  }
    if (job.stage === "engines" && !(job.plan || []).length) await save({ stage: "finish" });

  /* -------------------------------------------------------------- finish */
  if (job.stage === "finish") {
    const scoreObj = score({ site: job.site, runs: job.runs, intake: job.intake });
    const planObj = plan(technicalFindings(job.site), scoreObj, job.intake);
    const { html, stats } = renderReport({
      intake: job.intake, site: job.site, runs: job.runs, scoreObj, planObj,
      reference: ref, tier: job.tier,
    });
    await put(STORE, `${ref}/report.html`, html);
    job.stats = stats;
    job.reportPath = `/r/?id=${encodeURIComponent(ref)}&s=${sign("report:" + ref)}`;
    job.finishedAt = new Date().toISOString();
    job.lockedAt = null;
    job.stage = "done";
    job.lastCycleAt = job.finishedAt;
    job.cycles = job.cycles || 1;
    // Freeze the first cycle as the baseline. Every later comparison is measured
    // against this, and the prompt set is kept verbatim so cycles stay comparable.
    if (!job.baselineRuns) {
      job.baselineRuns = job.runs;
      job.baselineAt = job.finishedAt;
      job.baselineScore = stats.score;
    }
    await putJson(STORE, `${ref}/job`, job);
    await upsertJob({
      ref, stage: "done", score: stats.score, findings: stats.findings, high: stats.high,
      runs: stats.runs, pages: stats.pages, reportPath: job.reportPath,
      finishedAt: job.finishedAt, lastCycleAt: job.finishedAt, cycles: job.cycles,
    });

    const url = `${SITE}${job.reportPath}`;
    const biz = job.intake.business;
    const failed = job.runs.filter((r) => !r.ok).length;

    const sent = await mail({
      to: job.intake.email, replyTo: NOTIFY, tag: "report-auto",
      subject: `Your AI Visibility Audit is ready — ${biz}`,
      html: shell({
        preheader: `Score ${stats.score}/100 · ${stats.findings} findings · ${stats.runs} logged engine runs.`,
        heading: "Your audit is ready",
        body: `<p>Done. We crawled ${stats.pages} pages of your site and ran ${stats.runs} logged queries against the
        AI assistants, then scored what came back.</p>
        <p style="font-size:15px"><strong>Visibility score ${stats.score}/100.</strong> ${stats.findings} documented
        findings${stats.high ? `, ${stats.high} of them rated High` : ""}.</p>
        <p>Read §1 first, then §15 for the score and its reasoning, then §16 for what to do in the next 30 days.
        Everything in between is the evidence for those three.</p>
        <p>Every run is logged with its exact prompt, timestamp, full response and citations — including the ones
        where you didn't appear${failed ? `, and the ${failed} that errored` : ""}. §3 states which engines were
        reached and how; §20 sets out what wasn't tested.</p>
        <p>If anything in it reads wrong, reply to this email and it gets corrected.</p>`,
        cta: "Open your report", ctaUrl: url,
        footNote: `Private link, not indexed and not listed anywhere · Reference ${esc(ref)}. The Foundry Audit is a
        fixed-scope diagnostic, non-refundable once delivered — see <a href="${SITE}/terms/" style="color:#98a2b3">Terms</a>.
        AnswerFoundry does not guarantee placement, citation or ranking in any AI-generated answer.`,
      }),
    });

    await mail({
      to: NOTIFY, tag: "report-auto-internal",
      subject: `AUDIT DELIVERED · ${biz} · ${stats.score}/100 ${sent.ok ? "✓" : "✗ EMAIL FAILED"}`,
      html: shell({
        heading: sent.ok ? `Delivered: ${esc(biz)}` : `Report built but email FAILED: ${esc(biz)}`,
        body: `<p><a href="${url}" style="color:#c2410c">${esc(url)}</a></p>
        <p style="font-size:13px;color:#98a2b3">${esc(ref)} · score ${stats.score}/100 · ${stats.findings} findings ·
        ${stats.runs} runs (${failed} failed) · ${stats.pages} pages</p>
        <p>Read it before they act on it. The generator is honest but it has no judgment about their market.</p>`,
      }),
    });

    log("finished", JSON.stringify(stats), "emailed:", !!sent.ok);
    return new Response("done", { status: 200 });
  }

  // Ran out of budget mid-way. Release the lock so the next pump resumes.
  job.lockedAt = null;
    await putJson(STORE, `${ref}/job`, job);
    log("time budget reached, checkpointed at stage", job.stage);
    return new Response("checkpointed", { status: 200 });
  } catch (e) {
    console.error(`[audit-bg ${ref}] failed at ${job.stage}`, e);
    job.errors = (job.errors || []).concat({ stage: job.stage, error: String(e.message).slice(0, 300), at: new Date().toISOString() });
    job.attempts = (job.attempts || 0) + 1;
    job.lockedAt = null;
    if (job.attempts >= 3) {
      job.stage = "failed";
      await putJson(STORE, `${ref}/job`, job);
      await upsertJob({ ref, stage: "failed", lastError: job.errors.at(-1)?.error });
      await mail({
        to: NOTIFY, tag: "audit-failed",
        subject: `AUDIT FAILED · ${job.intake?.business || ref} — needs you`,
        html: shell({
          heading: `Automated audit failed: ${esc(job.intake?.business || ref)}`,
          body: `<p>Three attempts, all failed. The client has paid and is waiting.</p>
          <p style="font-size:13px;color:#98a2b3">${esc(ref)} · last error at stage
          <strong>${esc(job.errors.at(-1).stage)}</strong>: ${esc(job.errors.at(-1).error)}</p>
          <p>Their intake is in the <code>audit-intake</code> form in Netlify. Run it by hand and email them today.</p>`,
        }),
      });
      return new Response("failed", { status: 500 });
    }
    await putJson(STORE, `${ref}/job`, job);
    return new Response("error, will retry", { status: 500 });
  }
};
