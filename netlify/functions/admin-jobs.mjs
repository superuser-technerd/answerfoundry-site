/**
 * POST /api/admin-jobs   { adminToken, action?, ref? }
 *
 * The dashboard's only backend. Token in the body rather than a header so the
 * page can hold it in sessionStorage and never put it in a URL, where it would
 * end up in logs and browser history.
 *
 * actions: "list" (default) · "job" (one job in detail) · "retest" (start a cycle)
 */
import { json, bad, isAdminToken, SITE } from "./_lib/util.mjs";
import { listJobs, jobsDueForRetest } from "./_lib/jobindex.mjs";
import { getJson } from "./_lib/blobs.mjs";

export const config = { path: "/api/admin-jobs" };

const STORE = "audits";

export default async (req) => {
    if (req.method !== "POST") return bad("POST only", 405);
    let b;
    try { b = await req.json(); } catch { return bad("Malformed body"); }
    if (!isAdminToken(b.adminToken)) return bad("Not authorised", 401);

    const action = String(b.action || "list");

    if (action === "list") {
          const jobs = await listJobs();
          const due = (await jobsDueForRetest(90)).map((j) => j.ref);
          return json({
                  ok: true,
                  counts: {
                            total: jobs.length,
                            done: jobs.filter((j) => j.stage === "done").length,
                            running: jobs.filter((j) => !["done", "failed"].includes(j.stage)).length,
                            failed: jobs.filter((j) => j.stage === "failed").length,
                            dueForRetest: due.length,
                  },
                  jobs: jobs.map((j) => ({ ...j, dueForRetest: due.includes(j.ref) })),
          });
    }

    if (action === "job") {
          const ref = String(b.ref || "");
          const job = await getJson(STORE, `${ref}/job`);
          if (!job) return bad("No such job", 404);
          // Never return the whole job: full engine responses run to megabytes and the
      // dashboard has no use for them.
      return json({
              ok: true,
              ref, stage: job.stage, tier: job.tier, cycles: job.cycles || 1,
              intake: job.intake, stats: job.stats || null, errors: job.errors || [],
              reportPath: job.reportPath || null,
              baselineAt: job.baselineAt || null, lastCycleAt: job.lastCycleAt || null,
              pages: (job.site?.pages || []).length,
              runs: (job.runs || []).length,
              planRemaining: (job.plan || []).length,
              engines: [...new Set((job.runs || []).map((r) => r.platform))],
              failedRuns: (job.runs || []).filter((r) => !r.ok).length,
      });
    }

    if (action === "retest") {
          const ref = String(b.ref || "");
          if (!ref) return bad("ref required");

      // ---- pre-flight, and the reason it has to live here
      //
      // A background function returns 202 the instant Netlify ACCEPTS it — before a
      // single line of its code runs. So the 401/404/409 that retest-background
      // returns for a bad token, missing job or incomplete baseline never reach this
      // caller: we get 202 either way, and the dashboard would cheerfully report
      // "Re-test started" for a run that died immediately and silently.
      //
      // The only way to give the operator a true answer is to make the same checks
      // here, synchronously, before dispatching. These MUST stay in step with the
      // guards at the top of retest-background.mjs.
      const pre = await getJson(STORE, `${ref}/job`);
          if (!pre) return json({ ok: true, started: false, status: 404, detail: "No job with that reference." });
          if (pre.stage !== "done")
                  return json({ ok: true, started: false, status: 409,
                                       detail: `Baseline is not complete — the job is at stage "${pre.stage}". Only a finished audit can be re-tested.` });
          if (!pre.prompts?.length)
                  return json({ ok: true, started: false, status: 409,
                                       detail: "This audit stored no prompt set, so there is nothing to re-run identically. It predates cycle tracking and cannot be compared." });
          // A background function answers 202 immediately and runs on for minutes. If
      // Netlify has NOT dispatched it as background (wrong plan, bad deploy) the
      // same call instead blocks and dies at the 10s synchronous ceiling — so a
      // non-202 here is a genuine signal that re-test is broken, not a nicety.
      const r = await fetch(`${SITE}/.netlify/functions/retest-background`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ref, adminToken: b.adminToken }),
      }).catch((e) => ({ ok: false, status: 0, err: e.message }));

      const status = r.status ?? 0;
          const started = status === 202;
          return json({
                  ok: true,
                  started,
                  status,
                  cycle: (pre.cycles || 1) + 1,
                  business: pre.intake?.business || null,
                  // 202 means Netlify accepted the dispatch — it does NOT mean the run
                  // succeeded. Everything checkable was checked above; what remains is
                  // whether the platform took the job at all.
                  detail: started
                    ? `Accepted. Cycle ${(pre.cycles || 1) + 1} is running in the background and ${pre.intake?.email || "the client"} is emailed on completion.`
                            : status === 0 ? `Could not reach the re-test function${r.err ? `: ${r.err}` : ""}.`
                            : status === 404 ? "Netlify has no such function deployed — check that retest-background.mjs shipped."
                            : `Unexpected status ${status}. A 200 here rather than 202 means the function is NOT running as a background function and will be killed at the 10-second ceiling.`,
          });
    }

    return bad(`Unknown action: ${action}`);
};
