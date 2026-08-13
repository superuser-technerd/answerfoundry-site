/**
 * Renders the client report. Same twenty sections, same voice and same
 * stylesheet family as the published sample, so what a client buys looks like
 * what convinced them to buy.
 *
 * The CSS is embedded rather than linked because this HTML is served from a blob,
 * not from the publish directory — it has to stand on its own.
 */
import { esc } from "./util.mjs";
import { technicalFindings, contentFindings, PAGE_CAP } from "./crawl.mjs";
import { scopeDisclosure, coverage } from "./engines.mjs";

/** Inline markdown only. Does NOT escape — callers escape their own dynamic values. */
const inline = (s) => String(s ?? "")
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  .replace(/`([^`]+)`/g, "<code>$1</code>");

/** Escape first, then apply inline markdown. Use for anything client-supplied. */
const md = (s) => inline(String(s ?? "")
                           .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));

const CSS = `
:root{--ink:#101828;--slate:#475467;--mist:#98a2b3;--line:#e6e9f0;--paper:#fff;--fog:#f7f8fb;
--forge:#e8590c;--forge-dk:#c2410c;--ember:#fff3ec;--navy:#0b1b34;--navy2:#12294d}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Avenir Next","Segoe UI",system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--paper);line-height:1.6}
.bar{background:var(--navy);color:#eef2f9;padding:16px 0}
.bar .in{max-width:860px;margin:0 auto;padding:0 24px;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:center}
.bar .lg{font-size:1.1rem;font-weight:800;color:#fff;text-decoration:none}
.bar .lg span{color:var(--forge)}
.bar .rf{font-size:.8rem;color:#9fb0c8;font-family:ui-monospace,Consolas,monospace}
.hero{background:linear-gradient(180deg,var(--fog),#fff);padding:56px 0 40px;text-align:center}
.hero .in{max-width:860px;margin:0 auto;padding:0 24px}
.kick{display:inline-block;background:var(--ember);color:var(--forge-dk);font-size:.72rem;font-weight:800;
letter-spacing:.09em;text-transform:uppercase;padding:6px 13px;border-radius:99px;margin-bottom:18px}
h1{font-size:clamp(1.7rem,4vw,2.5rem);line-height:1.15;letter-spacing:-.03em;font-weight:800;margin:0 auto 14px;max-width:700px}
h1 em{font-style:normal;color:var(--forge)}
.sub{color:var(--slate);max-width:640px;margin:0 auto;font-size:1rem}
.privnote{max-width:620px;margin:20px auto 0;font-size:.87rem;color:var(--slate);background:var(--ember);
border:1px solid #ffd8c2;border-radius:10px;padding:12px 16px;text-align:left}
.rep{max-width:860px;margin:0 auto;padding:0 24px}
.rep section{padding:40px 0;border-top:1px solid var(--line)}
.rep section:first-of-type{border-top:none}
.rep h2{font-size:clamp(1.3rem,2.8vw,1.7rem);margin:0 0 16px;padding-bottom:11px;border-bottom:2px solid var(--ink)}
.rep h2 .num{display:inline-block;font-size:.7rem;color:var(--forge);letter-spacing:.12em;margin-right:12px;vertical-align:3px;font-weight:800}
.rep h3{font-size:1.03rem;margin:24px 0 9px;font-weight:700}
.rep p{margin:0 0 12px;color:var(--slate)}
.rep .lede{font-size:1.04rem;color:var(--ink)}
.rep ul,.rep ol{margin:0 0 14px;padding-left:22px;color:var(--slate)}
.rep li{margin-bottom:7px}
.rep code{font-family:ui-monospace,Consolas,monospace;font-size:.85em;background:var(--fog);padding:1px 5px;border-radius:4px;color:var(--ink)}
.rep .note{font-size:.86rem;color:var(--mist);border-left:2px solid var(--line);padding-left:14px;margin:16px 0}
.vl{font-size:.7rem;text-transform:uppercase;letter-spacing:.14em;color:var(--forge);font-weight:800;margin:22px 0 8px}
.toc{background:var(--fog);border:1px solid var(--line);border-radius:12px;padding:22px 26px;margin:34px 0 0}
.toc h2{font-size:.74rem!important;text-transform:uppercase;letter-spacing:.12em;border:none!important;padding:0!important;margin:0 0 13px!important;color:var(--mist)}
.toc ol{column-count:2;column-gap:34px;font-size:.86rem;padding-left:20px;margin:0}
.toc li{margin-bottom:5px;break-inside:avoid}
.toc a{color:var(--slate);text-decoration:none}
.sh{display:flex;align-items:center;gap:24px;background:var(--navy);color:#fff;padding:26px 28px;margin:24px 0;border-radius:12px;flex-wrap:wrap}
.sh__n{font-size:3.2rem;font-weight:800;line-height:1;letter-spacing:-.03em;white-space:nowrap}
.sh__n span{font-size:1.25rem;opacity:.55;font-weight:400}
.sh__l{font-weight:800;margin-bottom:5px}
.sh__b p{margin:0;font-size:.89rem;line-height:1.55;color:#b9c4d8}
table.t{width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:.89rem;line-height:1.45}
table.t th{text-align:left;font-size:.69rem;text-transform:uppercase;letter-spacing:.08em;color:var(--mist);
font-weight:800;border-bottom:1.5px solid var(--ink);padding:8px 10px 7px;vertical-align:bottom}
table.t td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--slate)}
table.t.dense{font-size:.83rem}
.y{color:#2e6b4f;font-weight:700}.n{color:#b42318;font-weight:700}.na{color:var(--mist);font-weight:700}
.sev{font-size:.71rem;font-weight:800;white-space:nowrap}
.sev--h{color:#b42318}.sev--m{color:#8a6212}.sev--l{color:var(--mist)}.sev--ok{color:#2e6b4f}
.co{background:var(--fog);border-left:3px solid var(--mist);border-radius:0 10px 10px 0;padding:16px 20px;margin:20px 0;font-size:.93rem}
.co p{margin:0 0 10px;color:var(--slate)}.co p:last-child{margin:0}
.co__t{font-weight:800;color:var(--ink)!important}
.co--good{background:#f0f9f4;border-left-color:#2e6b4f}.co--good .co__t{color:#2e6b4f!important}
.co--warn{background:var(--ember);border-left-color:var(--forge)}.co--warn .co__t{color:var(--forge-dk)!important}
.co--legal{background:#fff;border:1px solid var(--line);border-left:3px solid var(--ink);font-size:.86rem}
.kf{counter-reset:kf;list-style:none;padding:0}
.kf li{counter-increment:kf;position:relative;padding-left:34px;margin-bottom:12px}
.kf li::before{content:counter(kf);position:absolute;left:0;top:1px;font-size:.71rem;font-weight:800;width:22px;height:22px;
line-height:22px;text-align:center;background:var(--forge);color:#fff;border-radius:50%}
.plan td:first-child{font-weight:800;color:var(--forge);width:30px}
.plan td:nth-child(3),.plan td:nth-child(4){font-size:.8rem;color:var(--mist);white-space:nowrap}
details{border-bottom:1px solid var(--line);padding:12px 0}
summary{cursor:pointer;font-size:.86rem;color:var(--forge-dk);font-weight:700}
details pre{white-space:pre-wrap;font-size:.8rem;line-height:1.55;color:var(--slate);background:var(--fog);
padding:14px;border-radius:8px;margin-top:10px;font-family:ui-monospace,Consolas,monospace}
footer{background:#0a1526;color:#8fa0ba;padding:38px 0;font-size:.84rem;margin-top:40px}
footer .in{max-width:860px;margin:0 auto;padding:0 24px}
footer a{color:#c4cfe0}
@media(max-width:720px){.toc ol{column-count:1}table.t{display:block;overflow-x:auto}.sh{flex-direction:column;text-align:center}}
@media print{
  .bar,details,.pdfbtn{display:none!important}
    @page{margin:16mm 14mm}
      body{font-size:10pt;line-height:1.5}
        .hero{padding:0 0 12pt;background:none;text-align:left;break-after:page}
          .privnote{display:none}
            .rep{max-width:none;padding:0}
              .rep section{padding:14pt 0;break-inside:auto;break-before:page;border-top:none}
                .rep section:first-of-type{break-before:avoid}
                  .rep h2{break-after:avoid;font-size:13pt}
                    .rep h3{break-after:avoid}
                      table.t{break-inside:auto;font-size:8.5pt}
                        table.t tr{break-inside:avoid}
                          table.t th{background:#f3f4f6!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
                            .sh,.co{break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact}
                              .toc{break-after:page}
                                a[href^="http"]::after{content:" (" attr(href) ")";font-size:7.5pt;color:#666;word-break:break-all}
                                  a[href^="#"]::after{content:""}
                                  }
                                  .pdfbtn{display:inline-block;margin-top:16px;background:var(--forge);color:#fff;border:0;border-radius:8px;
                                    padding:11px 20px;font:inherit;font-weight:700;font-size:.92rem;cursor:pointer}
                                    .pdfbtn:hover{background:var(--forge-dk)}
                                    `;

/**
 * Cells are treated as HTML the caller has already made safe. Every dynamic
 * value below goes through esc() at the point it's interpolated — that split is
 * deliberate, because a lot of these cells legitimately contain <code> and
 * <strong>, and escaping them centrally would print the tags to the client.
 */
const tbl = (headers, rows, cls = "t") =>
    `<table class="${cls}"><tr>${headers.map((h) => `<th>${inline(h)}</th>`).join("")}</tr>` +
    rows.map((r) => `<tr>${r.map((c) => (c && typeof c === "object" && "v" in c)
                                     ? `<td class="sev sev--${c.sev}">${inline(c.v)}</td>` : `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
    `</table>`;

const sevClass = (s) => ({ High: "h", Med: "m", Low: "l", Critical: "h", Clean: "ok" }[s] || "l");

export function renderReport({ intake, site, runs, scoreObj, planObj, reference, tier }) {
    const tech = technicalFindings(site);
    const content = contentFindings(site);
    const scored = runs.filter((r) => r.ok && r.scored);
    const appeared = scored.filter((r) => r.appeared);
    const failed = runs.filter((r) => !r.ok);
    const platforms = [...new Set(runs.map((r) => r.platform))];
    const cov = coverage();
    const kindOf = (platform) => /SerpApi|AI Overviews/i.test(platform) ? "serp"
          : /Copilot/i.test(platform) ? "capture" : "api";
    const usedProviders = platforms.map((p) => ({ label: p, kind: kindOf(p) }));
    const disc = scopeDisclosure(usedProviders);
    const date = new Date().toISOString().slice(0, 10);
    const biz = intake.business || "your business";
    const competitors = (intake.competitorList || []);

  // competitor tally across runs
  const compTally = new Map();
    for (const r of scored) for (const c of r.competitorsNamed || []) compTally.set(c, (compTally.get(c) || 0) + 1);
    // domains cited, ranked
  const domTally = new Map();
    for (const r of runs) for (const d of r.citedDomains || []) domTally.set(d, (domTally.get(d) || 0) + 1);
    const ownDomain = (() => { try { return new URL(intake.website).host.replace(/^www\./, ""); } catch { return ""; } })();
    const topDomains = [...domTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const findingsCount = tech.length + compTally.size + topDomains.length + content.length;
    const highCount = tech.filter((f) => f.sev === "High").length;

  const S = [];
    const push = (title, inner) => S.push({ title, inner });

  /* 1 */ push("Executive summary", `
      <p class="lede">${scoreObj.shareOfAnswer === null
                              ? `No scored runs completed for ${esc(biz)}, so this report covers the technical and content evidence only — see §20.`
                              : appeared.length === 0
                                ? `Asked the questions your customers would ask, no AI assistant named ${esc(biz)} — not once across ${scored.length} scored runs. Every answer named someone else, or named nobody.`
                                : `${esc(biz)} was named in ${appeared.length} of ${scored.length} scored unbranded runs (${scoreObj.shareOfAnswer}%). That is the headline, and the detail beneath it is what matters.`}</p>
                                    <p>${scoreObj.ownDomainCited
                                               ? `Your own site was cited in ${scoreObj.ownDomainCited} of ${scored.length} scored runs, so the retrieval layer can see you.`
                                               : `Your own domain was cited in none of the scored runs. The sources these answers are built from are other people's pages — that single fact explains most of what follows.`}</p>
                                                   <div class="sh"><div class="sh__n">${scoreObj.total}<span>/${scoreObj.outOf}</span></div>
                                                         <div class="sh__b"><p class="sh__l">AnswerFoundry Visibility Score</p>
                                                               <p>A proprietary assessment, not a standardised industry metric. It is not calibrated against an external benchmark and implies no scientific precision. §15 shows the reasoning for every category so the number can be argued with.</p></div></div>
                                                                   <h3>The things that matter most</h3>
                                                                       <ol class="kf">
                                                                             <li><strong>${appeared.length} of ${scored.length} scored runs named you</strong>${appeared.length ? `, first in ${appeared.filter((r) => r.position === 1).length}` : ""}. The full log is §5 — including the runs that failed.</li>
                                                                                   ${topDomains.length ? `<li><strong>${topDomains.length} distinct domains supplied these answers.</strong> ${ownDomain && domTally.has(ownDomain) ? "Yours is among them." : `Yours is not among them. The most-cited was <code>${esc(topDomains[0][0])}</code>.`}</li>` : ""}
                                                                                         ${highCount ? `<li><strong>${highCount} technical findings rated High.</strong> ${esc(tech.find((f) => f.sev === "High")?.what || "")}.</li>` : ""}
                                                                                               ${compTally.size ? `<li><strong>${compTally.size} competitor${compTally.size === 1 ? "" : "s"} appeared where you were asked about.</strong> §6 names each and what they hold that you don't.</li>` : ""}
                                                                                                     <li><strong>${planObj.total} prioritised actions</strong> follow in §16–§18, each with an owner and an hour estimate.</li>
                                                                                                         </ol>
                                                                                                             <div class="co co--good"><p class="co__t">What's already working</p><p>${
                                                                                                                     [scoreObj.ownDomainCited ? "your site is in the cited set for at least one query" : null,
                                                                                                                             site.sitemapUrlCount ? `a sitemap resolves with ${site.sitemapUrlCount} URLs` : null,
                                                                                                                             !site.blockedAgents?.length ? "no AI crawler is blocked wholesale in robots.txt" : null,
                                                                                                                             (site.pages || []).some((p) => p.schemaBlocks > 0) ? "some structured data is already present to build on" : null,
                                                                                                                             appeared.length ? "you are retrievable, which is a far easier starting point than not being indexed at all" : null,
                                                                                                                            ].filter(Boolean).join("; ") || "the site responded cleanly to automated inspection, which is more than many do"}.</p></div>`);

  /* 2 */ push("Business profile and tested entity", `
      <p>An audit is only as good as the entity it tests. Everything below came from you at onboarding or from directly observing your public pages — nothing is inferred.</p>
          ${tbl(["Attribute", "Value", "Source"], [
                  ["Business", esc(biz), "Onboarding"],
                  ["Website", `<code>${esc(intake.website || "—")}</code>`, "Onboarding; fetched and crawled on " + date],
                  ["Primary service tested", esc(intake.service || "—"), "Onboarding"],
                  ["Service area tested", esc(intake.city || "—"), "Onboarding"],
                  ["Competitors benchmarked", competitors.length ? competitors.map(esc).join(", ") : "None supplied — competitors were taken from whatever the answers named", "Onboarding"],
                  ["Pages crawled", String((site.pages || []).filter((p) => !p.error).length) + (site.truncated ? ` (capped at ${PAGE_CAP})` : ""), "Live crawl, " + date],
                  ["Engagement", esc(tier || "Foundry Audit"), "Stripe"],
                ])}
                    <p class="note">The tested entity is the business, not the website. AI systems resolve a business across many sources; your site is only one of them, and several of the others you neither control nor have claimed.</p>`);

  /* 3 */ push("Platforms tested", `
      <div class="co co--warn"><p class="co__t">${md(disc.title)}</p>${disc.body.map((b) => `<p>${md(b)}</p>`).join("")}</div>
          ${tbl(["Surface", "Tested", "Method"], [
                  ...cov.map((c) => {
                            // Attempted is not the same as answered. A present-but-invalid API key
                                     // produces a full set of runs that all failed, and counting those as
                                     // "Tested: Yes" would tell the client an engine was measured when it
                                     // returned nothing — the exact overclaim this section exists to prevent.
                                     // So the verdict is driven by runs that actually came back OK.
                                     const mine = runs.filter((r) => c.match.test(r.platform || ""));
                            const okRuns = mine.filter((r) => r.ok);
                            const failed = mine.length - okRuns.length;
                            const n = okRuns.length;

                                     if (n > 0) {
                                                 // Partial failures still get disclosed rather than rounded away.
                              const caveat = failed ? ` ${failed} further run${failed === 1 ? "" : "s"} errored and ${failed === 1 ? "is" : "are"} excluded from every count in this report.` : "";
                                                 return [c.name, { v: "Yes", sev: "ok" },
                                                                     `${n} run${n === 1 ? "" : "s"} on ${date}. ${c.how}${caveat}`];
                                     }

                                     // Configured and attempted, but nothing usable came back: say so plainly,
                                     // and surface the provider's own error rather than a vague failure.
                                     if (c.live && mine.length) {
                                                 const why = [...new Set(mine.map((r) => String(r.error || "").trim()).filter(Boolean))][0] || "no usable response";
                                                 return [c.name, { v: "Attempted — failed", sev: "h" },
                                                                     `${mine.length} run${mine.length === 1 ? "" : "s"} attempted on ${date}, all failed, so this surface contributes nothing to any score or finding below. Reported error: ${esc(String(why).slice(0, 160))}. ${c.how}`];
                                     }

                                     return [c.name, { v: "Not tested", sev: c.kind === "capture" ? "l" : "m" },
                                                       `Not queried in this cycle. ${c.how}`];
                  }),
                  ["Your website", { v: "Yes", sev: "ok" }, `${(site.pages || []).length} URLs fetched and parsed from the live rendered HTML on ${date}`],
                  ["robots.txt, sitemap, llms.txt", { v: "Yes", sev: "ok" }, "Fetched directly"],
                ])}
                    <p class="note">A row marked “Not tested” means exactly that — it was not queried, and nothing in this report
                        should be read as a finding about it. Which engines are covered, and why two of them are harder to reach than
                            the others, is set out at <a href="https://answerfoundry.ai/ai-disclaimer/#methodology">answerfoundry.ai/ai-disclaimer</a>.</p>`);

  /* 4 */ push("Prompt methodology", `
      <p>Prompts are written the way a prospective customer would ask, not the way a marketer would search. The set was fixed before any result was seen.</p>
          ${tbl(["Family", "Measures", "Count"], [...new Set(runs.map((r) => r.family))].map((f) => [
                  `<strong>${esc(f)}</strong>`,
                  f === "Branded control" ? "Baseline — separates a discovery failure from an indexing failure"
                    : f === "Comparative" ? "How you are characterised directly against a named rival"
                    : f === "Customer's own question" ? "Your customers' actual wording, supplied by you at onboarding"
                    : "Whether you are a candidate answer at all for unbranded, high-intent demand",
                  String(new Set(runs.filter((r) => r.family === f).map((r) => r.prompt)).size),
                ]))}
                    <h3>Rules of the method</h3>
                        <ul>
                              <li><strong>Fixed in advance.</strong> No prompt was added or dropped once results were seen.</li>
                                    <li><strong>Every run logged, favourable or not.</strong> ${failed.length ? `${failed.length} run(s) errored and are listed in §5 rather than quietly dropped.` : "Nothing was re-run to get a better answer."}</li>
                                          <li><strong>One cycle, one day.</strong> Every result here carries the same date. AI answers change; a single cycle is a snapshot.</li>
                                                <li><strong>Exact text preserved</strong>, so the next cycle is comparable to this one.</li>
                                                    </ul>`);

  /* 5 */ push("Share of answer", `
      <p>Share of answer is the percentage of scored, unbranded runs in which the business appears as a candidate answer. On its own it means little, which is why the full log follows.</p>
          ${scoreObj.shareOfAnswer !== null ? `<div class="sh"><div class="sh__n">${scoreObj.shareOfAnswer}<span>%</span></div>
                <div class="sh__b"><p class="sh__l">Share of answer</p><p>Named in ${appeared.length} of ${scored.length} scored runs across ${platforms.length} platform(s), ${date}.</p></div></div>` : ""}
                    <p class="vl">Visual 1 — full run log</p>
                        ${tbl(["#", "Platform", "Prompt", "Named?", "Pos.", "Also named", "Sources cited"],
                                    runs.map((r, i) => [
                                              String(i + 1), esc(r.platform), esc(r.prompt),
                                              r.ok ? (r.appeared ? { v: "Yes", sev: "ok" } : { v: "No", sev: "h" }) : { v: "Error", sev: "m" },
                                              r.position ? String(r.position) : "—",
                                              r.ok ? ((r.competitorsNamed || []).map(esc).join(", ") || "—") : esc(r.error || ""),
                                              r.ok ? ((r.citedDomains || []).slice(0, 4).map((d) => `<code>${esc(d)}</code>`).join(" ") || "none shown") : "—",
                                            ]), "t dense")}
                                                <p class="vl">Full responses</p>
                                                    ${runs.filter((r) => r.ok).map((r, i) => `<details><summary>Run ${i + 1} — ${esc(r.platform)} · ${esc(r.model)} · ${esc(r.ranAt)}</summary>
                                                          <pre>${esc(r.prompt)}\n\n---\n\n${esc(r.response || "")}</pre></details>`).join("")}
                                                              <p class="note">Responses are stored verbatim and truncated only for length. Where a response was unflattering it appears here unedited.</p>`);

  /* 6 */ push("Competitors appearing", compTally.size || competitors.length ? `
      <p>Characterised only by what was observed in these answers. No judgment is offered about anyone's quality of work.</p>
          ${tbl(["Business", "Runs named in", "Observed"], [
                  [`<strong>${esc(biz)} (you)</strong>`, `${appeared.length} of ${scored.length}`, appeared.length ? "Present" : "Absent from every scored run"],
                  ...[...compTally.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => [esc(c), `${n} of ${scored.length}`,
                                                                                                   n > appeared.length ? "Named more often than you for the same questions" : "Named alongside you"]),
                  ...competitors.filter((c) => !compTally.has(c)).map((c) => [esc(c), "0", "You supplied this name; it did not appear in any answer"]),
                ])}
                    ${compTally.size && appeared.length === 0 ? `<div class="co"><p class="co__t">Read this row carefully</p><p>Businesses were named for these questions — just not you. This is not a category where AI declines to recommend anyone. It is a category where it recommends someone else.</p></div>` : ""}`
                   : `<p>No competitor names were extracted from these runs, and none were supplied at onboarding. That usually means the answers stayed generic rather than naming businesses — itself a finding, and one worth re-testing next cycle.</p>`);

  /* 7 */ push("Accuracy findings", `
      <p>Every row is a data-consistency observation with a source and an observation date. None is a characterisation of the business.</p>
          ${(() => {
                  const rows = [];
                  let i = 1;
                  const branded = runs.find((r) => r.ok && !r.scored);
                  if (branded) rows.push([String(i++), "How the branded control run described you",
                                                  esc(branded.platform), esc((branded.response || "").slice(0, 220)) + "…",
                                          { v: branded.appeared ? "Review" : "High", sev: branded.appeared ? "m" : "h" }]);
                  const p0 = (site.pages || []).find((p) => !p.error);
                  if (p0) {
                            rows.push([String(i++), "Homepage title as published", "Your site", esc(p0.title || "(empty)"), { v: p0.title ? "Info" : "High", sev: p0.title ? "l" : "h" }]);
                            rows.push([String(i++), "Homepage H1 as published", "Your site", esc(p0.h1 || "(none)"), { v: p0.h1Count === 1 ? "Info" : "High", sev: p0.h1Count === 1 ? "l" : "h" }]);
                  }
                  for (const [d, n] of topDomains.slice(0, 5))
                            rows.push([String(i++), `Source cited by these answers`, `<code>${esc(d)}</code>`,
                                                 d === ownDomain ? "Your own domain — you control this text" : "A page you do not control is describing your category, and possibly you",
                                       { v: d === ownDomain ? "Good" : "Review", sev: d === ownDomain ? "ok" : "m" }]);
                  return rows.length ? tbl(["#", "Observation", "Where", "Detail", "Sev."], rows, "t dense")
                            : "<p>No accuracy conflicts could be established automatically from this cycle.</p>";
          })()}
              <p class="note">A fully automated cycle can only compare what it can fetch. Directory-by-directory reconciliation — the part that finds four different suite numbers in circulation — needs a human pass, and is included in Forge &amp; Monitor rather than in a single automated audit. This is a real limit, stated here rather than papered over.</p>`);

  /* 8 */ push("Missing services and attributes", `
      <p>A narrow question: if a customer described what they wanted in plain language, is there text anywhere a machine could match to you?</p>
          ${(() => {
                  const pages = (site.pages || []).filter((p) => !p.error);
                  const anyText = (re) => pages.some((p) => re.test(`${p.title} ${p.h1} ${p.metaDescription}`));
                  const svc = intake.service || "";
                  const city = intake.city || "";
                  return tbl(["Attribute a customer might specify", "Stated in a title, heading or description?"], [
                            [`Your primary service (“${esc(svc)}”)`, anyText(new RegExp(svc.split(/\s+/)[0] || "zzz", "i")) ? { v: "Yes", sev: "ok" } : { v: "No", sev: "h" }],
                            [`Your city or service area (“${esc(city)}”)`, anyText(new RegExp(city.split(/[,\s]+/)[0] || "zzz", "i")) ? { v: "Yes", sev: "ok" } : { v: "No", sev: "h" }],
                            ["A named practitioner or owner", [...new Set(pages.flatMap((p) => p.schemaTypes))].includes("Person") ? { v: "Yes, in schema", sev: "ok" } : { v: "Not in structured data", sev: "m" }],
                            ["Pricing", pages.some((p) => p.hasPrice) ? { v: "Yes", sev: "ok" } : { v: "No", sev: "m" }],
                            ["Reviews a machine can read", pages.some((p) => p.hasReviewMarkup) ? { v: "Yes", sev: "ok" } : { v: "No", sev: "h" }],
                            ["Questions answered in FAQ form", [...new Set(pages.flatMap((p) => p.schemaTypes))].includes("FAQPage") ? { v: "Yes", sev: "ok" } : { v: "No", sev: "m" }],
                          ]);
          })()}
              <div class="co"><p class="co__t">Why this section exists</p><p>Most of what a business is true of never makes it into a title, a heading or a schema field. That isn't a content-creation problem, it's a transcription problem — and it is the cheapest work in this report.</p></div>`);

  /* 9 */ push("Source and citation findings", `
      <p>The section most visibility reports skip, and the one that explains the results. Not “why aren't we ranking” but: <strong>which sources decide this category's answers, and are you in them?</strong></p>
          ${topDomains.length ? tbl(["Source domain", "Runs citing it", "Your status"],
                                          topDomains.map(([d, n]) => [`<code>${esc(d)}</code>`, `${n} of ${runs.length}`,
                                                                              d === ownDomain ? { v: "Yours — working", sev: "ok" } : { v: "Not you", sev: "m" }]))
                  : "<p>No citations were exposed by these runs, which itself limits what can be concluded — see §20.</p>"}
                      ${topDomains.length && !domTally.has(ownDomain) ? `<div class="co co--warn"><p class="co__t">The finding that explains the others</p>
                            <p>Not one of the ${topDomains.length} domains feeding these answers is yours. Improving your own pages matters, but it is not where these answers come from. Earning presence in this list is §18.</p></div>` : ""}`);

  /* 10 */ push("Website technical findings", `
      <p>Everything below was read from your live rendered HTML on ${date} — not inferred from a crawler summary.</p>
          ${tech.length ? tbl(["Finding", "Detail", "Sev."], tech.map((f) => [`<strong>${esc(f.what)}</strong>`, esc(f.detail), { v: f.sev, sev: sevClass(f.sev) }]))
                  : "<p>No automated technical defects were detected. Unusual, and worth a manual pass to confirm.</p>"}`);

  /* 11 */ push("Entity consistency findings", `
      <p>Entity consistency is how confidently a machine can conclude that scattered mentions refer to one business. Low confidence produces hedged answers, or omission.</p>
          ${(() => {
                  const pages = (site.pages || []).filter((p) => !p.error);
                  const titles = new Set(pages.map((p) => p.title).filter(Boolean));
                  const canon = new Set(pages.map((p) => { try { return new URL(p.canonical || p.url).host; } catch { return ""; } }).filter(Boolean));
                  const types = [...new Set(pages.flatMap((p) => p.schemaTypes))];
                  return tbl(["Identifier", "Observed", "Assessment"], [
                            ["Host variants in canonicals", String(canon.size), canon.size > 1 ? { v: "Review", sev: "m" } : { v: "Clean", sev: "ok" }],
                            ["Business entity in schema", types.filter((t) => /Organization|LocalBusiness|Business|Service|Physician|Dentist/.test(t)).join(", ") || "none", types.length ? { v: "Present", sev: "ok" } : { v: "Critical", sev: "h" }],
                            ["Named person in schema", types.includes("Person") ? "Present" : "Absent", types.includes("Person") ? { v: "Clean", sev: "ok" } : { v: "Review", sev: "m" }],
                            ["sameAs links to external profiles", pages.some((p) => (p.schemaTypes || []).length) && JSON.stringify(types).includes("sameAs") ? "Present" : "Not detected", { v: "Review", sev: "m" }],
                            ["Distinct title patterns", String(titles.size) + ` across ${pages.length} pages`, titles.size < pages.length ? { v: "Duplicates", sev: "m" } : { v: "Clean", sev: "ok" }],
                          ]);
          })()}
              <p class="note">Off-site identity — the suite number on a review platform, the credential wording on a directory, the second social page nobody remembers creating — requires claiming and reading each profile by hand. That work is Forge &amp; Monitor, not this automated cycle.</p>`);

  /* 12 */ push("Content gaps", `${tbl(["Gap", "Observed", "Why it matters"], content.map((r) => r.map(md)))}
      <div class="co"><p class="co__t">Where the real gains are</p><p>The instinct is “publish more.” That is the slow path. Say what you already are first — §8 — then make it machine-readable — §10 — then earn presence in §9's source list. Publishing volume comes fourth.</p></div>`);

  /* 13 */ push("Local visibility findings", `
      ${tbl(["Signal", "Status"], [
              ["Google Business Profile", intake.gbp ? `Supplied at onboarding: <code>${esc(intake.gbp)}</code> — claimed and readable` : { v: "Not supplied at onboarding — unverified", sev: "m" }],
              ["Service area stated on the website", (site.pages || []).some((p) => new RegExp((intake.city || "zzz").split(/[,\s]+/)[0], "i").test(`${p.title} ${p.h1}`)) ? "Named in a title or heading" : { v: "Not named in any title or heading", sev: "h" }],
              ["Additional locations", intake.other_locations ? esc(intake.other_locations) : "None supplied"],
              ["Apple Maps / Bing Places", { v: "Not checked in an automated cycle", sev: "l" }],
            ])}
                <p class="note">Local surfaces mostly resist automated inspection without an API key for each one. What could be verified is above; what couldn't is named as such rather than guessed at.</p>`);

  /* 14 */ push("Risk and compliance observations", `
      <p>Observations from public sources. Not legal, medical or regulatory advice — anything below with regulatory implications should go to your own counsel or compliance advisor.</p>
          ${tbl(["Observation", "Why it matters", "Priority"], [
                  ...(intake.compliance ? [["You told us at onboarding: “" + esc(String(intake.compliance).slice(0, 300)) + "”",
                                                    "Recorded so that no recommendation in this report asks you to publish something you can't", { v: "Noted", sev: "ok" }]] : []),
                  ...((() => {
                            const branded = runs.find((r) => r.ok && !r.scored);
                            return branded && branded.appeared ? [["An AI assistant is describing your business unprompted",
                                                                             "Its description is in §5. If any of it is wrong, that wrongness is being repeated to customers, and correcting the underlying source is the only fix", { v: "High", sev: "h" }]] : [];
                  })()),
                  ...(!(site.pages || []).some((p) => p.hasPrice) && (topDomains.length && !domTally.has(ownDomain))
                              ? [["Third-party pages describe your category and you publish no pricing",
                                            "If a source you don't control publishes prices for your services, that figure is the one being quoted", { v: "Med", sev: "m" }]] : []),
                  ["No credential or licence verification path on the site",
                           "Not required — but it is the cheapest trust signal available in a category where customers screen for credentials, and it strengthens machine entity resolution at the same time", { v: "Med", sev: "m" }],
                ])}`);

  /* 15 */ push("Scoring and priority matrix", `
      <div class="sh"><div class="sh__n">${scoreObj.total}<span>/${scoreObj.outOf}</span></div>
            <div class="sh__b"><p class="sh__l">AnswerFoundry Visibility Score</p>
                  <p>Proprietary. Not a standardised industry metric, not calibrated against an external benchmark, and not a prediction. Its only honest uses are comparing you against yourself over time, and against observable competitor attributes.</p></div></div>
                      ${tbl(["Category", "Score", "Reasoning"], scoreObj.categories.map((c) => [c.name, `<strong>${c.value} / ${c.max}</strong>`, esc(c.reasoning)]))}
                          ${tbl(["", "Do first — high impact, low effort", "Plan — high impact, real effort"], [[
                                  "", `<ul>${planObj.d30.slice(0, 4).map((r) => `<li>${md(r[1])}</li>`).join("")}</ul>`,
                                  `<ul>${planObj.d60.slice(0, 4).map((r) => `<li>${md(r[1])}</li>`).join("")}</ul>`]])}`);

  /* 16-18 */
  push("30-day actions", `<p>Objective: stop publishing contradictory information about yourself, and put the head terms where machines look.</p>
      ${tbl(["#", "Action", "Owner", "Effort"], planObj.d30.map((r) => r.map(md)), "t plan")}
          <p class="note">Item ordering matters less than the baseline: this cycle is your baseline. Changes made before it existed could not have been measured.</p>`);
    push("60-day actions", `<p>Objective: make the assets you already have machine-readable.</p>
        ${tbl(["#", "Action", "Owner", "Effort"], planObj.d60.map((r) => r.map(md)), "t plan")}`);
    push("90-day actions", `<p>Objective: earn presence in the third-party sources that decide this category's answers.</p>
        ${tbl(["#", "Action", "Owner", "Effort"], planObj.d90.map((r) => r.map(md)), "t plan")}`);

  /* 19 */ push("Measurement plan", `
      <p>Every run — in this baseline and in every cycle after — records the following. All of them, every time, whether the result flatters you or not.</p>
          ${tbl(["Field", "Why it's recorded"], [
                  ["Date and time", "Answers change; an undated result is not evidence"],
                  ["Platform and model version", "Results are not comparable across platforms or model versions"],
                  ["Exact prompt text", "Paraphrasing between cycles destroys comparability"],
                  ["Named — yes/no", "The primary measure"],
                  ["Position in the answer", "Being named third differs from being named first"],
                  ["Competitors named, in order", "Share of answer is relative"],
                  ["Citations shown", "The most actionable field in the log — it names what to influence"],
                  ["Full response text", "So the claim can be checked by someone who wasn't there"],
                  ["Failed runs", "A silent failure is indistinguishable from a bad result unless it's recorded"],
                ])}
                    <p><strong>Cadence.</strong> This cycle is the baseline. A single re-run 30 days out will mostly measure noise; the first meaningful comparison is at 90 days, and it will include the results that did not move.</p>
                        <p><strong>Deliberately not promised as a metric:</strong> traffic from AI assistants (referrer data is incomplete and improving unevenly), and any causal claim linking a change here to a change in revenue.</p>`);

  /* 20 */ push("Limitations and no-guarantee disclaimer", `
      <h3>What this report is</h3>
          <p>A structured record of what specific AI systems and public sources said about one business on ${date}, and a professional assessment of the signals most likely influencing that. A diagnosis and a plan — not a prediction.</p>
              <h3>What was not tested</h3>
                  <ul>
                        <li><strong>The consumer apps.</strong> Where an engine was reached through its API, that is not the same as the phone app a customer opens. §3 sets out which engines were reached which way, and why it matters.</li>
                              ${cov.filter((c) => !c.live).map((c) => `<li><strong>${c.name}.</strong> Not queried in this cycle, and nothing here is a finding about it. ${esc(c.how)}</li>`).join("\n      ")}
                                    ${cov.filter((c) => {
                                              // An engine that was configured and queried but returned nothing usable
                                                         // belongs in "what was not tested" just as much as one never queried —
                                                         // otherwise the omission reads as coverage.
                                                         const mine = runs.filter((r) => c.match.test(r.platform || ""));
                                              return c.live && mine.length > 0 && !mine.some((r) => r.ok);
                                    }).map((c) => `<li><strong>${c.name} — attempted but unavailable.</strong> Every request to this surface failed on ${date}, so it contributes nothing to the score, the share of answer, or any finding. This is a gap in this cycle's evidence, not a result about your visibility there. ${esc(c.how)}</li>`).join("\n      ")}
                                          <li><strong>Off-site directory reconciliation.</strong> Claiming and reading each third-party profile by hand is not automatable and is not included in a single automated cycle.</li>
                                                <li><strong>Apple Maps, Bing Places</strong> and platform-specific review data were not checked.</li>
                                                      <li><strong>Traffic, ranking history, backlinks and Search Console data</strong> — not supplied${intake.access ? ", though you offered access at onboarding; that goes into the next cycle" : ""}.</li>
                                                            <li><strong>Pages behind a login</strong>, and any page that did not respond to an automated fetch.</li>
                                                                  ${site.truncated ? `<li><strong>Pages beyond the first ${PAGE_CAP}</strong> were not crawled in this cycle.</li>` : ""}
                                                                        ${failed.length ? `<li><strong>${failed.length} engine run(s) failed outright</strong> and are listed as errors in §5 rather than excluded.</li>` : ""}
                                                                            </ul>
                                                                                <h3>Inherent limitations of AI visibility testing</h3>
                                                                                    <ul>
                                                                                          <li><strong>AI outputs change.</strong> The same prompt run twice, minutes apart, can return different answers. Any single result is a snapshot, not a measurement.</li>
                                                                                                <li><strong>Results vary</strong> by date, model version, location, personalisation, session history and platform.</li>
                                                                                                      <li><strong>These systems are opaque.</strong> Correlation between a change and a shift in mentions can be observed; causation generally cannot be proven, and this report does not claim it.</li>
                                                                                                            <li><strong>Third-party corrections are requests, not commands.</strong> Platforms accept, reject or ignore them on their own timelines.</li>
                                                                                                                  <li><strong>One business, one cycle</strong> establishes nothing that generalises.</li>
                                                                                                                      </ul>
                                                                                                                          <div class="co co--legal"><p class="co__t">No-guarantee statement</p>
                                                                                                                                <p>AnswerFoundry does not control ChatGPT, Google, Bing, Perplexity, Gemini, Claude or any other third-party AI or search system, and <strong>does not guarantee placement, citation, ranking, recommendation or mention in any AI-generated answer.</strong> No representation is made that any specific result, position, traffic level, lead volume or revenue outcome will be achieved. Recommendations reflect observed data and professional judgment as of the test date. Client results vary. Historical visibility does not indicate future visibility. Some work described here may also affect traditional search performance, but AI visibility and traditional SEO are not the same thing and should not be expected to move together.</p>
                                                                                                                                      <p>This report contains no legal, medical, regulatory or financial advice. Observations touching on professional licensure or advertising should be reviewed by your own counsel or compliance advisor.</p></div>
                                                                                                                                          <h3>How this report was produced</h3>
                                                                                                                                              <p>Generated automatically on ${date} from a live crawl of ${(site.pages || []).filter((p) => !p.error).length} pages and ${runs.length} logged engine runs across ${platforms.length} platform(s). No finding was written by hand, which is both its strength — nothing was cherry-picked — and its limit: the judgment calls a person would make about your specific market are not in here. If something reads wrong, reply and it gets corrected.</p>`);

  const toc = S.map((s, i) => `<li><a href="#s${i + 1}">${md(s.title)}</a></li>`).join("");
    const body = S.map((s, i) => `<section id="s${i + 1}"><h2><span class="num">${String(i + 1).padStart(2, "0")}</span> ${md(s.title)}</h2>${s.inner}</section>`).join("\n");

  return {
        html: `<!DOCTYPE html><html lang="en"><head>
        <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta name="robots" content="noindex, nofollow, noarchive">
        <title>AI Visibility Audit — ${esc(biz)} | AnswerFoundry</title>
        <style>${CSS}</style></head><body>
        <div class="bar"><div class="in"><a class="lg" href="https://answerfoundry.ai/">Answer<span>Foundry</span></a>
        <span class="rf">${esc(reference)} · ${date}</span></div></div>
        <header class="hero"><div class="in">
          <span class="kick">Foundry Audit</span>
            <h1>AI Visibility Audit<br><em>${esc(biz)}</em></h1>
              <p class="sub">${scored.length} scored runs across ${platforms.length} platform(s), ${(site.pages || []).filter((p) => !p.error).length} pages crawled, ${findingsCount} documented findings. Every one dated and sourced — including the ones that don't flatter anyone.</p>
                <p class="privnote">Private report prepared for ${esc(biz)}. This link isn't listed anywhere and isn't indexed.</p>
                  <button class="pdfbtn" onclick="window.print()">Save as PDF</button>
                  </div></header>
                  <div class="rep"><nav class="toc"><h2>What's in this report</h2><ol>${toc}</ol></nav>
                  ${body}</div>
                  <footer><div class="in"><strong style="color:#fff">AnswerFoundry LLC</strong><br>
                  2445 S Hiawassee Rd, PMB 1021, Orlando, FL 32835 · <a href="mailto:hello@answerfoundry.ai">hello@answerfoundry.ai</a><br>
                  <a href="https://answerfoundry.ai/terms/">Terms</a> · <a href="https://answerfoundry.ai/privacy/">Privacy</a> · <a href="https://answerfoundry.ai/ai-disclaimer/">AI Visibility Disclaimer</a><br>
                  <span style="color:#6d7f99">AnswerFoundry does not guarantee placement, citation or ranking in any AI-generated answer.</span></div></footer>
                  </body></html>`,
        stats: { findings: findingsCount, high: highCount, score: scoreObj.total, runs: runs.length, pages: (site.pages || []).filter((p) => !p.error).length },
  };
}
