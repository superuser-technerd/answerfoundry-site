/**
 * POST /api/run-audit   { ref, stage?, key }
 *
 * The audit orchestrator. Runs in stages, each finishing well inside a normal
 * function timeout, persisting state to blobs and then invoking itself for the
 * next stage. That design is deliberate: background functions aren't guaranteed
 * on every Netlify plan, and a 10-minute synchronous request isn't a thing. This
 * works anywhere and survives a stage failing.
 *
 *   discover → crawl (batched) → engines (batched) → finish
 *
 * `key` is an HMAC over the reference, so only our own functions can advance a job.
 */
import { json, bad, sign, verify, mail, shell, esc, SITE, NOTIFY } from "./_lib/util.mjs";
import { getJson, putJson, put } from "./_lib/blobs.mjs";
import { discover, crawlBatch, PAGE_CAP } from "./_lib/crawl.mjs";
import { buildPrompts, configuredProviders, runOne, providers } from "./_lib/engines.mjs";
import { score, plan } from "./_lib/score.mjs";
import { renderReport } from "./_lib/render.mjs";

export const config = { path: "/api/run-audit" };

const CRAWL_BATCH = 6;
const ENGINE_BATCH = 2;
const STORE = "audits";

/**
 * Hand off to the next stage.
 *
 * An un-awaited fetch does NOT survive here: the runtime freezes the execution
 * context the moment the handler returns its Response, so the request is never
 * sent and the job silently stalls. That bug cost us one stuck audit. Two
 * defences, because this is the load-bearing part of the whole pipeline:
 *
 *   1. context.waitUntil() where the runtime provides it — the supported way to
 *      keep background work alive past the response.
 *   2. Otherwise await the dispatch just long enough for the request to leave,
 *      then abort. We don't need the reply, only for it to have been sent.
 *
 * And regardless of both, GET /r/ pumps the job every time the client's status
 * page polls, so progress never depends solely on self-invocation.
 */
const advance = async (ref, context) => {
    const fire = async () => {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 1500);
          try {
                  await fetch(`${SITE}/.netlify/functions/run-audit-background`, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ ref, key: sign(ref) }),
                            signal: ac.signal,
                  });
          } catch (e) {
                  // AbortError is expected and fine — the request was already dispatched.
            if (e.name !== "AbortError") console.error("[run-audit] self-invoke failed", e.message);
          } finally {
                  clearTimeout(t);
          }
    };
    if (context && typeof context.waitUntil === "function") {
          context.waitUntil(fire());
          return;
    }
    await fire();
};

export default async (req, context) => {
    if (req.method !== "POST") return bad("POST only", 405);
    let b;
    try { b = await req.json(); } catch { return bad("Malformed body"); }
    const ref = String(b.ref || "");
    if (!ref || !verify(ref, b.key)) return bad("Not authorised", 403);

    const job = await getJson(STORE, `${ref}/job`);
    if (!job) return bad(`No job for ${ref}`, 404);
    if (job.stage === "done") return json({ ok: true, stage: "done", url: job.reportPath });

    // Two things can pump a job now — self-invocation and the client's status page.
    // A 25s soft lock stops them running the same stage twice, which would mean
    // paying for the same engine calls twice.
    const LOCK_MS = 25000;
    if (job.lockedAt && Date.now() - Date.parse(job.lockedAt) < LOCK_MS)
          return json({ ok: true, stage: job.stage, skipped: "already running" });
    job.lockedAt = new Date().toISOString();
    await putJson(STORE, `${ref}/job`, job);   // lock acquired

    const t0 = Date.now();
    const log = (...a) => console.log(`[audit ${ref}]`, ...a);

    try {
          /* ------------------------------------------------------ 1. discover */
      if (job.stage === "new") {
              const origin = new URL(job.intake.website).origin;
              const d = await discover(origin);
              job.site = {
                        origin, robots: d.robots, sitemapDeclared: d.sitemapDeclared, sitemapUrlCount: d.sitemapUrlCount,
                        llmsTxt: d.llmsTxt, blockedAgents: d.blockedAgents, pages: [], truncated: false,
              };
              const seeds = [origin + "/", ...d.urls];
              job.queue = [...new Set(seeds)].slice(0, PAGE_CAP);
              job.truncatedAt = d.urls.length > PAGE_CAP;
              job.stage = "crawl";
              job.lockedAt = null;   // release before handing on
            await putJson(STORE, `${ref}/job`, job);
              log("discovered", job.queue.length, "urls in", Date.now() - t0, "ms");
              await advance(ref, context);
              return json({ ok: true, stage: "crawl", queued: job.queue.length });
      }

      /* --------------------------------------------------------- 2. crawl */
      if (job.stage === "crawl") {
              const batch = job.queue.splice(0, CRAWL_BATCH);
              const { pages, discovered } = await crawlBatch(batch);
              job.site.pages.push(...pages);
              const known = new Set(job.site.pages.map((p) => p.url));
              for (const u of discovered) {
                        if (job.site.pages.length + job.queue.length >= PAGE_CAP) { job.site.truncated = true; break; }
                        if (!known.has(u) && !job.queue.includes(u)) job.queue.push(u);
              }
              if (!job.queue.length || job.site.pages.length >= PAGE_CAP) {
                        if (job.site.pages.length >= PAGE_CAP || job.truncatedAt) job.site.truncated = true;
                        job.stage = "engines";
                        job.prompts = buildPrompts({
                                    service: job.intake.service, city: job.intake.city, business: job.intake.business,
                                    competitors: job.intake.competitorList, questions: job.intake.questionList,
                        });
                        job.plan = [];
                        for (const p of job.prompts) for (const pr of configuredProviders()) job.plan.push({ prompt: p, providerId: pr.id });
                        job.runs = [];
                        log("crawl complete:", job.site.pages.length, "pages ·", job.plan.length, "engine runs planned");
              }
              job.lockedAt = null;   // release before handing on
            await putJson(STORE, `${ref}/job`, job);
              await advance(ref, context);
              return json({ ok: true, stage: job.stage, crawled: job.site.pages.length, remaining: job.queue.length });
      }

      /* ------------------------------------------------------- 3. engines */
      if (job.stage === "engines") {
              if (!job.plan.length) {
                        job.stage = "finish";
              } else {
                        const batch = job.plan.splice(0, ENGINE_BATCH);
                        for (const item of batch) {
                                    const provider = providers.find((p) => p.id === item.providerId);
                                    if (!provider) continue;
                                    const r = await runOne({
                                                  provider, prompt: item.prompt, business: job.intake.business,
                                                  competitors: job.intake.competitorList || [],
                                    });
                                    if (r) job.runs.push(r);
                        }
                        if (!job.plan.length) job.stage = "finish";
              }
              job.lockedAt = null;   // release before handing on
            await putJson(STORE, `${ref}/job`, job);
              log("engines:", job.runs.length, "done ·", job.plan.length, "left ·", Date.now() - t0, "ms");
              await advance(ref, context);
              return json({ ok: true, stage: job.stage, runs: job.runs.length, remaining: job.plan.length });
      }

      /* -------------------------------------------------------- 4. finish */
      if (job.stage === "finish") {
              const scoreObj = score({ site: job.site, runs: job.runs, intake: job.intake });
              const { technicalFindings } = await import("./_lib/crawl.mjs");
              const planObj = plan(technicalFindings(job.site), scoreObj, job.intake);
              const { html, stats } = renderReport({
                        intake: job.intake, site: job.site, runs: job.runs, scoreObj, planObj,
                        reference: ref, tier: job.tier,
              });

            await put(STORE, `${ref}/report.html`, html);
              job.stage = "done";
              job.stats = stats;
              job.reportPath = `/r/?id=${encodeURIComponent(ref)}&s=${sign("report:" + ref)}`;
              job.finishedAt = new Date().toISOString();
              job.lockedAt = null;   // release before handing on
            await putJson(STORE, `${ref}/job`, job);

            const url = `${SITE}${job.reportPath}`;
              const biz = job.intake.business;
              const sent = await mail({
                        to: job.intake.email,
                        replyTo: NOTIFY,
                        tag: "report-auto",
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
                                                                                                            <p>Two things worth knowing before you read it. Every run is logged with its exact prompt, timestamp, full
                                                                                                                        response and citations — including the runs where you didn't appear, and the ones that errored. And §3 is
                                                                                                                                    explicit that the assistant <em>APIs with web search</em> were queried rather than the phone apps: same
                                                                                                                                                retrieval substrate, not the same product. §20 sets out everything that wasn't tested.</p>
                                                                                                                                                            <p>If anything in it reads wrong, reply to this email and it gets corrected.</p>`,
                                    cta: "Open your report",
                                    ctaUrl: url,
                                    footNote: `Private link, not indexed and not listed anywhere · Reference ${esc(ref)}. The Foundry Audit is a
                                                fixed-scope diagnostic, non-refundable once delivered — see <a href="${SITE}/terms/" style="color:#98a2b3">Terms</a>.
                                                            AnswerFoundry does not guarantee placement, citation or ranking in any AI-generated answer.`,
                        }),
              });

            await mail({
                      to: NOTIFY,
                      tag: "report-auto-internal",
                      subject: `AUDIT DELIVERED · ${biz} · ${stats.score}/100 ${sent.ok ? "✓" : "✗ EMAIL FAILED"}`,
                      html: shell({
                                  heading: sent.ok ? `Delivered: ${esc(biz)}` : `Report built but email FAILED: ${esc(biz)}`,
                                  body: `<p><a href="${url}" style="color:#c2410c">${esc(url)}</a></p>
                                              <p style="font-size:13px;color:#98a2b3">${ref} · score ${stats.score}/100 · ${stats.findings} findings ·
                                                          ${stats.runs} runs · ${stats.pages} pages · ${job.runs.filter((r) => !r.ok).length} failed runs</p>
                                                                      <p>Read it before they do. If a finding is wrong, fix the report and reply to them — the generator is honest
                                                                                  but it has no judgment about their specific market.</p>`,
                      }),
            });

            log("finished:", JSON.stringify(stats));
              return json({ ok: true, stage: "done", url, stats, emailed: !!sent.ok });
      }

      return bad(`Unknown stage ${job.stage}`, 500);
    } catch (e) {
          console.error(`[audit ${ref}] stage ${job.stage} failed`, e);
          job.errors = (job.errors || []).concat({ stage: job.stage, error: String(e.message).slice(0, 300), at: new Date().toISOString() });
          job.attempts = (job.attempts || 0) + 1;
          if (job.attempts >= 3) {
                  job.stage = "failed";
                  job.lockedAt = null;   // release before handing on
            await putJson(STORE, `${ref}/job`, job);
                  await mail({
                            to: NOTIFY,
                            tag: "audit-failed",
                            subject: `AUDIT FAILED · ${job.intake?.business || ref} — needs you`,
                            html: shell({
                                        heading: `Automated audit failed: ${esc(job.intake?.business || ref)}`,
                                        body: `<p>Three attempts, all failed. The client has paid and is waiting.</p>
                                                    <p style="font-size:13px;color:#98a2b3">${ref} · last error at stage <strong>${esc(job.errors.at(-1).stage)}</strong>:
                                                                ${esc(job.errors.at(-1).error)}</p>
                                                                            <p>Their intake is in the <code>audit-intake</code> form in Netlify. Run it by hand and deliver with
                                                                                        <code>tools/publish-report.sh</code>, and email them today rather than tomorrow.</p>`,
                            }),
                  });
                  return bad("Audit failed after 3 attempts — operator notified", 500);
          }
          job.lockedAt = null;   // release before handing on
      await putJson(STORE, `${ref}/job`, job);
          await advance(ref, context);
          return bad(`Stage ${job.stage} failed, retrying (attempt ${job.attempts})`, 500);
    }
};
