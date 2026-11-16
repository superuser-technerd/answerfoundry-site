/**
 * Scheduled: start the monthly re-test for every active monthly-plan client.
 *
 * Monthly tiers are sold with "monthly reporting", but re-tests were only ever
 * started by hand from /admin. This runs once a day and dispatches
 * retest-background for any monthly client whose last cycle is RETEST_DAYS old.
 *
 * Guards:
 *  - monthly tiers only (a one-time Foundry Audit is never re-run automatically)
 *  - the Stripe subscription behind the purchase must be active or trialing,
 *    so a cancelled client is never re-tested or emailed
 *  - at most MAX_PER_RUN dispatches per day, to cap API spend
 *  - a job dispatched in the last 3 days is skipped, so a slow or failed run is
 *    not stacked; retest-background emails its own failure alert
 *
 * Emails NOTIFY only when it started something or hit a problem. A quiet day
 * sends nothing.
 */
import { mail, shell, esc, SITE, NOTIFY, stripeSession } from "./_lib/util.mjs";
import { getJson } from "./_lib/blobs.mjs";
import { listJobs, upsertJob } from "./_lib/jobindex.mjs";

export const config = { schedule: "17 13 * * *" };

const MONTHLY_TIERS = new Set(["Forge & Monitor", "Category Leader", "Founding Client"]);
const RETEST_DAYS = Number(process.env.RETEST_DAYS || 30);
const MAX_PER_RUN = Number(process.env.RETEST_MAX_PER_RUN || 3);
const DAY = 864e5;

async function subscriptionStatus(sessionId) {
  const s = await stripeSession(sessionId);
  const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
  if (!subId) return { status: "none" };
  const r = await fetch(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subId)}`, {
    headers: { authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `stripe ${r.status}`);
  return { status: j.status, id: subId };
}

export default async () => {
  const now = Date.now();
  const jobs = await listJobs();
  const candidates = jobs.filter((j) => {
    if (!MONTHLY_TIERS.has(j.tier) || j.stage !== "done") return false;
    const last = Date.parse(j.lastCycleAt || j.finishedAt || j.createdAt || 0);
    const lastAuto = Date.parse(j.autoRetestAt || 0);
    return Number.isFinite(last) && now - last >= RETEST_DAYS * DAY
      && !(Number.isFinite(lastAuto) && now - lastAuto < 3 * DAY);
  });

  const started = [], skipped = [], problems = [];

  for (const j of candidates) {
    if (started.length >= MAX_PER_RUN) { skipped.push(`${j.ref}: daily cap reached, picked up tomorrow`); continue; }

    const job = await getJson("audits", `${j.ref}/job`);
    if (!job?.prompts?.length) { problems.push(`${j.ref}: no stored prompt set, cannot re-test`); continue; }

    const sessionId = j.sessionId || job.sessionId;
    if (!sessionId) { problems.push(`${j.ref}: no Stripe session on record, cannot confirm the plan is active`); continue; }
    let sub;
    try { sub = await subscriptionStatus(sessionId); }
    catch (e) { problems.push(`${j.ref}: Stripe check failed (${e.message})`); continue; }
    if (!["active", "trialing"].includes(sub.status)) {
      skipped.push(`${j.ref}: subscription ${sub.status}, not re-tested`);
      continue;
    }

    const r = await fetch(`${SITE}/.netlify/functions/retest-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: j.ref, adminToken: process.env.ADMIN_TOKEN }),
    }).catch((e) => ({ status: 0, err: e.message }));

    if (r.status === 202) {
      await upsertJob({ ref: j.ref, autoRetestAt: new Date().toISOString() });
      started.push(`${j.ref} · ${job.intake?.business || ""} · cycle ${(job.cycles || 1) + 1}`);
    } else {
      problems.push(`${j.ref}: dispatch returned ${r.status}${r.err ? ` (${r.err})` : ""}`);
    }
  }

  console.log(`[monthly-retest] candidates=${candidates.length} started=${started.length} problems=${problems.length}`);

  if (started.length || problems.length) {
    const list = (title, items) => items.length
      ? `<p><strong>${title}</strong></p><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
    await mail({
      to: NOTIFY,
      tag: "monthly-retest",
      subject: problems.length
        ? `MONTHLY RE-TEST · ${problems.length} problem${problems.length > 1 ? "s" : ""} — needs you`
        : `Monthly re-test started · ${started.length} client${started.length > 1 ? "s" : ""}`,
      html: shell({
        heading: "Monthly re-tests",
        body: list("Started", started) + list("Problems", problems) + list("Skipped", skipped),
      }),
    }).catch((e) => console.error("[monthly-retest] summary mail failed", e?.message || e));
  }

  return new Response("ok");
};
