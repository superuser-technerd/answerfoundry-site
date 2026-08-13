/**
 * Spend guard for the free Answer Snapshot.
 *
 * Every automated snapshot costs real money in engine calls, and the form is
 * public. This caps three things independently:
 *
 *   per email   — one business does not need a second snapshot this week
 *   per IP      — blunts a single scripted source
 *   per day     — a hard ceiling on total spend, whatever gets past the others
 *
 * Deliberately NOT a security boundary. Netlify Blobs has no atomic increment,
 * so a tight burst can slip a few extra through before the counters catch up.
 * It bounds the bill; it does not repel a determined attacker. If this ever
 * needs to be airtight, it belongs at the edge, not here.
 *
 * Failure mode is deliberate too: if the blob store is unavailable we ALLOW the
 * run and say so in the log. Silently dropping real leads is worse than the
 * occasional duplicate — but the daily cap means the exposure is still bounded
 * whenever the store is healthy.
 *
 * Identifiers are hashed before use as keys, so the store holds no plain emails
 * or IP addresses.
 */
import { createHash } from "node:crypto";
import { getJson, putJson, blobsAvailable } from "./blobs.mjs";

const STORE = "ratelimit";

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

export const LIMITS = {
    /** Days before the same email may trigger another automated snapshot. */
    emailCooldownDays: num(process.env.SNAPSHOT_EMAIL_COOLDOWN_DAYS, 7),
    /** Automated snapshots per IP per rolling 24h. */
    perIpPerDay: num(process.env.SNAPSHOT_MAX_PER_IP_DAY, 3),
    /** Hard ceiling on automated snapshots per calendar day (UTC), all sources. */
    perDay: num(process.env.SNAPSHOT_MAX_PER_DAY, 25),
};

const h = (s) => createHash("sha256").update(String(s || "").trim().toLowerCase()).digest("hex").slice(0, 32);
const today = () => new Date().toISOString().slice(0, 10);
const DAY = 864e5;

/**
 * Decide whether this submission may trigger a paid run, and record it if so.
 * Returns { allowed, reason, detail, counts }.
 */
export async function checkSnapshotAllowance({ email, ip }) {
    if (!blobsAvailable()) {
          console.warn("[ratelimit] blob store unavailable — allowing run unchecked");
          return { allowed: true, reason: "unchecked", detail: "Rate-limit store unavailable; run allowed rather than dropping a lead." };
    }

  const now = Date.now();
    const counts = {};

  try {
        // ---- global daily ceiling
      const dayKey = `day/${today()}`;
        const day = (await getJson(STORE, dayKey)) || { count: 0 };
        counts.today = day.count;
        if (LIMITS.perDay && day.count >= LIMITS.perDay) {
                return {
                          allowed: false,
                          reason: "daily-cap",
                          detail: `Daily automated-snapshot cap reached (${day.count}/${LIMITS.perDay} today). Raise SNAPSHOT_MAX_PER_DAY if this is legitimate volume.`,
                          counts,
                };
        }

      // ---- per email cooldown
      if (email && LIMITS.emailCooldownDays) {
              const key = `email/${h(email)}`;
              const rec = await getJson(STORE, key);
              if (rec?.last) {
                        const ageDays = (now - new Date(rec.last).getTime()) / DAY;
                        counts.emailRuns = rec.count || 0;
                        if (ageDays < LIMITS.emailCooldownDays) {
                                    return {
                                                  allowed: false,
                                                  reason: "email-cooldown",
                                                  detail: `This address already had an automated snapshot ${ageDays < 1 ? "today" : `${Math.floor(ageDays)} day(s) ago`}. Cooldown is ${LIMITS.emailCooldownDays} days — resend the existing one instead of paying for another.`,
                                                  counts,
                                    };
                        }
              }
      }

      // ---- per IP rolling 24h
      if (ip && LIMITS.perIpPerDay) {
              const key = `ip/${h(ip)}`;
              const rec = await getJson(STORE, key);
              const fresh = rec?.windowStart && now - new Date(rec.windowStart).getTime() < DAY ? rec : null;
              counts.ipToday = fresh?.count || 0;
              if (fresh && fresh.count >= LIMITS.perIpPerDay) {
                        return {
                                    allowed: false,
                                    reason: "ip-cap",
                                    detail: `This IP has already triggered ${fresh.count} automated snapshots in 24h (cap ${LIMITS.perIpPerDay}).`,
                                    counts,
                        };
              }
      }

      // ---- allowed: record against all three counters
      await Promise.all([
              putJson(STORE, `day/${today()}`, { count: day.count + 1, updated: new Date().toISOString() }),
              email ? putJson(STORE, `email/${h(email)}`, {
                        count: (counts.emailRuns || 0) + 1, last: new Date().toISOString(),
              }) : null,
              ip ? (async () => {
                        const key = `ip/${h(ip)}`;
                        const rec = await getJson(STORE, key);
                        const fresh = rec?.windowStart && now - new Date(rec.windowStart).getTime() < DAY;
                        return putJson(STORE, key, {
                                    count: fresh ? (rec.count || 0) + 1 : 1,
                                    windowStart: fresh ? rec.windowStart : new Date().toISOString(),
                        });
              })() : null,
            ].filter(Boolean));

      return { allowed: true, reason: "ok", counts };
  } catch (e) {
        console.error("[ratelimit] check failed — allowing run", e?.message || e);
        return { allowed: true, reason: "error", detail: `Rate-limit check failed (${String(e?.message || e)}); run allowed.` };
  }
}
