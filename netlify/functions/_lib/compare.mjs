/**
 * Cycle comparison — the thing that turns a one-off diagnosis into a retainer.
 *
 * §19 of every report promises re-testing on the identical prompt set and a
 * comparison that includes the results which did NOT move. This builds that
 * honestly: same prompts, same engines, matched pairwise, and anything that
 * regressed or stayed flat is reported as prominently as anything that improved.
 *
 * The temptation with a monthly report is to show only what got better. That is
 * exactly the behaviour this business is positioned against, so the renderer
 * below deliberately gives "no change" its own column and its own count.
 */

const key = (r) => `${r.platform}||${r.prompt}`;

/** Pair runs from two cycles by platform + exact prompt text. */
export function diffRuns(baseRuns = [], nowRuns = []) {
    const base = new Map(baseRuns.map((r) => [key(r), r]));
    const now = new Map(nowRuns.map((r) => [key(r), r]));
    const pairs = [];

  for (const [k, n] of now) {
        const b = base.get(k);
        if (!b) { pairs.push({ status: "new", prompt: n.prompt, platform: n.platform, now: n, base: null }); continue; }
        const wasIn = b.ok ? !!b.appeared : null;
        const isIn = n.ok ? !!n.appeared : null;
        let status = "unchanged";
        if (wasIn === false && isIn === true) status = "gained";
        else if (wasIn === true && isIn === false) status = "lost";
        else if (wasIn === true && isIn === true) {
                if ((b.position || 99) > (n.position || 99)) status = "improved";
                else if ((b.position || 99) < (n.position || 99)) status = "slipped";
                else status = "held";
        } else if (wasIn === null || isIn === null) status = "incomparable";
        pairs.push({ status, prompt: n.prompt, platform: n.platform, now: n, base: b });
  }
    for (const [k, b] of base) if (!now.has(k))
          pairs.push({ status: "dropped-from-set", prompt: b.prompt, platform: b.platform, now: null, base: b });

  const count = (s) => pairs.filter((p) => p.status === s).length;
    return {
          pairs,
          summary: {
                  gained: count("gained"), lost: count("lost"), improved: count("improved"),
                  slipped: count("slipped"), held: count("held"), unchanged: count("unchanged"),
                  incomparable: count("incomparable"), added: count("new"), removed: count("dropped-from-set"),
                  total: pairs.length,
          },
    };
}

/** Domains cited in one cycle but not the other — the leading indicator. */
export function diffCitations(baseRuns = [], nowRuns = []) {
    const set = (runs) => new Set(runs.flatMap((r) => r.citedDomains || []));
    const b = set(baseRuns), n = set(nowRuns);
    return {
          gained: [...n].filter((d) => !b.has(d)).sort(),
          lost: [...b].filter((d) => !n.has(d)).sort(),
          kept: [...n].filter((d) => b.has(d)).sort(),
    };
}

export function shareOf(runs = []) {
    const scored = runs.filter((r) => r.ok && r.scored);
    if (!scored.length) return null;
    return Math.round((scored.filter((r) => r.appeared).length / scored.length) * 100);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * A comparison section appended to the report as §21. Written to be readable by
 * someone who did not commission the work and is looking for the catch.
 */
export function renderComparison({ baseline, current, cycleNumber, baselineDate, currentDate, scoreBase, scoreNow }) {
    const d = diffRuns(baseline, current);
    const c = diffCitations(baseline, current);
    const sBase = shareOf(baseline), sNow = shareOf(current);
    const s = d.summary;
    const delta = (a, b) => (a == null || b == null) ? "—" : (b - a > 0 ? `+${b - a}` : `${b - a}`);
    const flat = s.held + s.unchanged;

  const row = (p) => {
        const label = {
                gained: ["Newly named", "ok"], improved: ["Named higher", "ok"], held: ["Held position", "l"],
                unchanged: ["No change", "l"], slipped: ["Named lower", "m"], lost: ["No longer named", "h"],
                incomparable: ["Not comparable", "m"], new: ["New to the set", "l"],
                "dropped-from-set": ["Not re-run", "m"],
        }[p.status] || ["—", "l"];
        const was = p.base ? (p.base.ok ? (p.base.appeared ? `Yes${p.base.position ? ` (#${p.base.position})` : ""}` : "No") : "error") : "—";
        const now = p.now ? (p.now.ok ? (p.now.appeared ? `Yes${p.now.position ? ` (#${p.now.position})` : ""}` : "No") : "error") : "—";
        return `<tr><td>${esc(p.platform)}</td><td>${esc(p.prompt)}</td><td>${was}</td><td>${now}</td>
              <td class="sev sev--${label[1]}">${label[0]}</td></tr>`;
  };

  const order = ["lost", "slipped", "gained", "improved", "held", "unchanged", "incomparable", "new", "dropped-from-set"];
    const sorted = [...d.pairs].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));

  return `
  <section id="s21">
  <h2><span class="num">21</span> Movement since baseline &mdash; cycle ${cycleNumber}</h2>
  <p class="lede">The identical prompt set, re-run against the same engines on ${esc(currentDate)} and matched
  pairwise against the baseline of ${esc(baselineDate)}. Nothing was added, removed or rephrased between cycles,
  because doing so would make the comparison meaningless.</p>

  <div class="sh">
    <div class="sh__n">${sNow == null ? "&mdash;" : sNow}<span>%</span></div>
      <div class="sh__b"><p class="sh__l">Share of answer now</p>
        <p>Baseline was ${sBase == null ? "not measurable" : sBase + "%"} &mdash; a change of ${delta(sBase, sNow)} points.
          Visibility score ${scoreBase ?? "—"} &rarr; ${scoreNow ?? "—"}. Neither number means anything on its own; the run
            log below is the evidence.</p></div>
            </div>

            <div class="pw-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0">
              <div class="stat"><span class="stat__n">${s.gained + s.improved}</span><span class="stat__l">improved &mdash; newly named or named higher</span></div>
                <div class="stat"><span class="stat__n">${flat}</span><span class="stat__l">no change at all</span></div>
                  <div class="stat"><span class="stat__n">${s.lost + s.slipped}</span><span class="stat__l">went backwards</span></div>
                    <div class="stat"><span class="stat__n">${s.total}</span><span class="stat__l">runs compared</span></div>
                    </div>

                    ${flat >= s.gained + s.improved ? `<div class="co co--warn"><p class="co__t">Read the middle number first</p>
                    <p>${flat} of ${s.total} runs did not move. That is the honest headline of this cycle, and it is placed before the
                    wins on purpose. Visibility work compounds over quarters, not weeks &mdash; but if this pattern repeats next cycle,
                    the plan needs changing rather than repeating.</p></div>` : ""}

                    <p class="vl">Visual &mdash; run-by-run comparison</p>
                    <table class="t t--dense">
                    <tr><th>Platform</th><th>Prompt</th><th>Baseline</th><th>Now</th><th>Change</th></tr>
                    ${sorted.map(row).join("\n")}
                    </table>

                    <h3>Sources gained and lost</h3>
                    <p>Citations move before rankings do, so this table is the leading indicator &mdash; it usually changes a cycle
                    before share of answer does.</p>
                    <table class="t">
                    <tr><th>Newly citing you or your category</th><th>No longer appearing</th><th>Consistent across both cycles</th></tr>
                    <tr>
                      <td>${c.gained.length ? c.gained.map((x) => `<code>${esc(x)}</code>`).join("<br>") : "None"}</td>
                        <td>${c.lost.length ? c.lost.map((x) => `<code>${esc(x)}</code>`).join("<br>") : "None"}</td>
                          <td>${c.kept.length ? c.kept.slice(0, 12).map((x) => `<code>${esc(x)}</code>`).join("<br>") : "None"}</td>
                          </tr>
                          </table>

                          <p class="note">A domain appearing or disappearing here is not proof that anything we did caused it. These systems
                          change their own retrieval constantly. What this table supports is a judgment about where to spend the next cycle's
                          effort &mdash; not a causal claim, and we will not make one.</p>
                          </section>`;
}
