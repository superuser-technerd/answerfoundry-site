/**
 * A listable index of work.
 *
 * Our minimal blob client can read and write a key but not enumerate a prefix,
 * so nothing could answer "show me every audit." Rather than add a dependency,
 * every job registers itself in one index blob. Small, append-mostly, and the
 * only structure the dashboard and the re-test scheduler need.
 *
 * Writes are last-write-wins. Two audits registering in the same instant could
 * in principle lose one entry — acceptable at this volume, and the job blob
 * itself is always the source of truth, so nothing is actually lost, only its
 * appearance in a list.
 */
import { getJson, putJson } from "./blobs.mjs";

const STORE = "audits";
const KEY = "index/jobs";
const CAP = 500;

export async function listJobs() {
    const idx = await getJson(STORE, KEY);
    return Array.isArray(idx?.jobs) ? idx.jobs : [];
}

/** Register or update one entry. Safe to call repeatedly for the same ref. */
export async function upsertJob(entry) {
    if (!entry?.ref) return;
    const jobs = await listJobs();
    const i = jobs.findIndex((j) => j.ref === entry.ref);
    const merged = i >= 0 ? { ...jobs[i], ...entry, updatedAt: new Date().toISOString() }
                              : { createdAt: new Date().toISOString(), ...entry, updatedAt: new Date().toISOString() };
    if (i >= 0) jobs[i] = merged; else jobs.unshift(merged);
    await putJson(STORE, KEY, { jobs: jobs.slice(0, CAP) });
}

/**
 * Audits whose most recent cycle is at least `days` old and which completed
 * successfully — the candidates for a re-test. Ninety days is the first point at
 * which a comparison says anything, per §19 of every report we issue.
 */
export async function jobsDueForRetest(days = 90) {
    const cutoff = Date.now() - days * 864e5;
    return (await listJobs()).filter((j) => {
          if (j.stage !== "done") return false;
          const last = Date.parse(j.lastCycleAt || j.finishedAt || j.createdAt || 0);
          return Number.isFinite(last) && last < cutoff;
    });
}
