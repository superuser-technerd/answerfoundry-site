/**
 * Site crawler for the automated audit.
 *
 * Everything returned here is directly observed from the live rendered HTML on a
 * stated date — never inferred, never assumed. It feeds report sections 10
 * (website technical), 11 (entity consistency, in part) and 12 (content gaps).
 *
 * Deliberately polite: one page at a time, a declared user-agent, obeys a
 * page cap, and never touches anything behind a login.
 */
const UA = "Mozilla/5.0 (compatible; AnswerFoundryAudit/1.0; +https://answerfoundry.ai/)";
export const PAGE_CAP = 24;

async function fetchText(url, ms = 11000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
          const r = await fetch(url, { redirect: "follow", signal: ac.signal, headers: { "user-agent": UA } });
          const ct = r.headers.get("content-type") || "";
          const text = r.ok && /text\/html|xml|text\/plain/i.test(ct) ? await r.text() : "";
          return { ok: r.ok, status: r.status, finalUrl: r.url, text, contentType: ct };
    } catch (e) {
          return { ok: false, status: 0, error: e.name === "AbortError" ? "timeout" : e.message, text: "" };
    } finally {
          clearTimeout(t);
    }
}

const strip = (h) =>
    h.replace(/<script[\s\S]*?<\/script>/gi, " ")
   .replace(/<style[\s\S]*?<\/style>/gi, " ")
   .replace(/<[^>]+>/g, " ")
   .replace(/&nbsp;/gi, " ")
   .replace(/&[a-z#0-9]+;/gi, " ");

function schemaTypes(html) {
    const blocks = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    const types = new Set();
    let invalid = 0;
    const walk = (n) => {
          if (Array.isArray(n)) return n.forEach(walk);
          if (n && typeof n === "object") {
                  const t = n["@type"];
                  if (typeof t === "string") types.add(t);
                  else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && types.add(x));
                  Object.values(n).forEach(walk);
          }
    };
    for (const b of blocks) {
          try { walk(JSON.parse(b)); } catch { invalid++; }
    }
    return { blocks: blocks.length, invalid, types: [...types].sort() };
}

function pageFacts(url, html) {
    const s = schemaTypes(html);
    const text = strip(html);
    const h1s = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => strip(m[1]).trim().replace(/\s+/g, " "));
    return {
          url,
          title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim().replace(/\s+/g, " "),
          metaDescription: (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1] || "").trim(),
          canonical: html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] || "",
          h1Count: h1s.length,
          h1: h1s[0]?.slice(0, 160) || "",
          h2Count: (html.match(/<h2\b/gi) || []).length,
          words: (text.match(/[A-Za-z][A-Za-z'’-]+/g) || []).length,
          schemaBlocks: s.blocks,
          invalidSchema: s.invalid,
          schemaTypes: s.types,
          iframes: (html.match(/<iframe\b/gi) || []).length,
          images: (html.match(/<img\b/gi) || []).length,
          imagesNoAlt: (html.match(/<img\b(?![^>]*\salt=)[^>]*>/gi) || []).length,
          hasReviewMarkup: /"@type"\s*:\s*"(Review|AggregateRating)"/i.test(html),
          hasPrice: /\$\s?\d{2,}/.test(text) || /"price"\s*:/i.test(html),
          noindex: /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html),
    };
}

function sameHost(a, b) {
    try { return new URL(a).host.replace(/^www\./, "") === new URL(b).host.replace(/^www\./, ""); }
    catch { return false; }
}

/** Discover candidate URLs from sitemaps, following one level of sitemap index. */
export async function discover(origin) {
    const out = { sitemaps: [], urls: [], robots: null, llmsTxt: false, sitemapDeclared: false, blockedAgents: [] };

  const robots = await fetchText(origin + "/robots.txt", 8000);
    if (robots.ok) {
          out.robots = true;
          out.sitemapDeclared = /sitemap:\s*http/i.test(robots.text);
          for (const m of robots.text.matchAll(/sitemap:\s*(\S+)/gi)) out.sitemaps.push(m[1]);
          const agents = ["*", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Perplexity-User",
                                "ClaudeBot", "Claude-SearchBot", "Claude-User", "Google-Extended", "Applebot-Extended", "Bingbot", "Googlebot"];
          for (const a of agents) {
                  const re = new RegExp(`user-agent:\\s*${a.replace("*", "\\*")}\\s*([\\s\\S]*?)(?=user-agent:|$)`, "i");
                  const blk = robots.text.match(re)?.[1] || "";
                  if (/disallow:\s*\/\s*(?:$|[\r\n])/im.test(blk)) out.blockedAgents.push(a);
          }
    } else out.robots = false;

  if (!out.sitemaps.length) out.sitemaps.push(origin + "/sitemap.xml");

  const seen = new Set();
    for (const sm of out.sitemaps.slice(0, 3)) {
          const r = await fetchText(sm, 9000);
          if (!r.ok) continue;
          const locs = [...r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
          const isIndex = /<sitemapindex/i.test(r.text);
          if (isIndex) {
                  for (const child of locs.slice(0, 3)) {
                            const cr = await fetchText(child, 9000);
                            if (!cr.ok) continue;
                            for (const m of cr.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi))
                                        if (sameHost(m[1], origin) && !seen.has(m[1])) { seen.add(m[1]); out.urls.push(m[1]); }
                  }
          } else {
                  for (const l of locs) if (sameHost(l, origin) && !seen.has(l)) { seen.add(l); out.urls.push(l); }
          }
    }

  const llms = await fetchText(origin + "/llms.txt", 6000);
    out.llmsTxt = llms.ok && llms.text.length > 20;
    out.sitemapUrlCount = out.urls.length;
    return out;
}

/** Fetch and analyse one batch of pages. Stateless — the orchestrator holds the queue. */
export async function crawlBatch(urls) {
    const pages = [];
    const discovered = [];
    for (const u of urls) {
          const r = await fetchText(u);
          if (!r.ok) { pages.push({ url: u, error: r.error || `HTTP ${r.status}`, status: r.status }); continue; }
          pages.push(pageFacts(r.finalUrl || u, r.text));
          for (const m of r.text.matchAll(/<a\b[^>]+href=["']([^"'#?]+)["']/gi)) {
                  let href = m[1];
                  try { href = new URL(href, r.finalUrl || u).toString(); } catch { continue; }
                  if (sameHost(href, u) && !/\.(pdf|jpe?g|png|gif|svg|webp|zip|mp4|mov|css|js)$/i.test(href))
                            discovered.push(href.split("#")[0]);
          }
    }
    return { pages, discovered: [...new Set(discovered)] };
}

/** Turn crawl output into report-ready findings for §10. */
export function technicalFindings(site) {
    const f = [];
    const add = (sev, what, detail) => f.push({ sev, what, detail });
    const pages = (site.pages || []).filter((p) => !p.error);
    const n = pages.length || 1;
    const failed = (site.pages || []).filter((p) => p.error);

  const noSchema = pages.filter((p) => p.schemaBlocks === 0);
    const invalid = pages.filter((p) => p.invalidSchema > 0);
    const noH1 = pages.filter((p) => p.h1Count === 0);
    const multiH1 = pages.filter((p) => p.h1Count > 1);
    const noCanon = pages.filter((p) => !p.canonical);
    const thin = pages.filter((p) => p.words < 300);
    const noDesc = pages.filter((p) => !p.metaDescription);
    const allTypes = new Set(pages.flatMap((p) => p.schemaTypes));
    const reviewMarkup = pages.some((p) => p.hasReviewMarkup);
    const iframed = pages.filter((p) => p.iframes > 0);
    const noAlt = pages.filter((p) => p.images > 3 && p.imagesNoAlt / p.images > 0.4);
    const dupTitles = (() => {
          const m = new Map();
          for (const p of pages) if (p.title) m.set(p.title, (m.get(p.title) || 0) + 1);
          return [...m.entries()].filter(([, c]) => c > 1);
    })();

  if (noSchema.length === n)
        add("High", "No structured data anywhere on the site",
                  `All ${n} pages crawled carry zero JSON-LD. Structured data is the machine-readable description of the business; there is none to read.`);
    else if (noSchema.length)
          add("High", `${noSchema.length} of ${n} pages carry no structured data`,
                    `Including: ${noSchema.slice(0, 4).map((p) => new URL(p.url).pathname).join(", ")}${noSchema.length > 4 ? ", …" : ""}. These pages can't be quoted with confidence.`);
    if (invalid.length)
          add("High", `${invalid.length} page(s) have JSON-LD that fails to parse`,
                    "Malformed structured data is generally discarded wholesale rather than partially, so any correct fields inside are wasted.");
    const orgTypes = ["Organization", "LocalBusiness", "MedicalBusiness", "Dentist", "Physician",
                          "ProfessionalService", "LegalService", "HealthAndBeautyBusiness", "HomeAndConstructionBusiness"];
    if (![...allTypes].some((t) => orgTypes.includes(t)))
          add("High", "No business entity declared in structured data",
                    `Types found across the site: ${[...allTypes].join(", ") || "none"}. Nothing tells a machine this is a business, which makes resolving scattered mentions to one entity harder.`);
    if (![...allTypes].some((t) => ["Service", "Offer", "Product", "MedicalProcedure"].includes(t)))
          add("High", "No service or offer markup on any page",
                    "The pages that would answer “where do I get X near me” carry nothing a machine can read as a service or a price.");
    if (![...allTypes].includes("FAQPage"))
          add("Med", "No FAQ markup anywhere",
                    "FAQ markup is the most directly quotable structure available, and the cheapest to add to pages that already answer questions.");
    if (!reviewMarkup)
          add("High", "Reviews are not marked up",
                    `No Review or AggregateRating markup found on any crawled page${iframed.length ? `, and ${iframed.length} page(s) embed third-party iframes — review widgets inside iframes are invisible to crawlers and models` : ""}.`);
    if (![...allTypes].includes("Person"))
          add("Med", "No named person in structured data",
                    "In professional services the practitioner is often what a customer is actually choosing. No Person node means that name isn't machine-readable.");
    if (noH1.length)
          add(noH1.length > n / 3 ? "High" : "Med", `${noH1.length} of ${n} pages have no H1`,
                    `The strongest on-page statement of what a page is about is missing. Including: ${noH1.slice(0, 3).map((p) => new URL(p.url).pathname).join(", ")}.`);
    if (multiH1.length)
          add("Low", `${multiH1.length} page(s) have multiple H1 elements`,
                    "Often a page-builder rendering desktop and mobile variants of the same heading. Dilutes the signal.");
    if (dupTitles.length)
          add("Med", `${dupTitles.length} title tag(s) are duplicated across pages`,
                    `E.g. “${dupTitles[0][0].slice(0, 70)}” appears on ${dupTitles[0][1]} pages. Duplicate titles make pages compete with each other.`);
    if (noCanon.length > n / 2)
          add("Med", `${noCanon.length} of ${n} pages declare no canonical URL`,
                    "Without canonicals, URL variants of the same page can split signals.");
    if (thin.length)
          add("Med", `${thin.length} of ${n} pages carry under 300 words`,
                    `Thin pages give a model little to quote. Including: ${thin.slice(0, 3).map((p) => new URL(p.url).pathname).join(", ")}.`);
    if (noDesc.length > n / 2)
          add("Low", `${noDesc.length} of ${n} pages have no meta description`,
                    "Not a ranking factor, but frequently the snippet a summariser reuses verbatim.");
    if (noAlt.length)
          add("Low", `${noAlt.length} page(s) have most images missing alt text`,
                    "Alt text is both an accessibility requirement and a machine-readable description of the image.");
    if (site.blockedAgents?.length)
          add("High", `robots.txt blocks ${site.blockedAgents.length} crawler(s) outright`,
                    `Blocked: ${site.blockedAgents.join(", ")}. A blocked AI search crawler cannot cite this site at all, no matter what else is fixed.`);
    if (site.robots === false)
          add("Low", "No robots.txt found", "Not required, and everything is crawlable by default — but it's the conventional place to declare a sitemap and to control AI crawlers one line at a time.");
    else if (!site.sitemapDeclared)
          add("Low", "robots.txt declares no sitemap", "Discovery then leans entirely on internal linking.");
    if (!site.sitemapUrlCount)
          add("Med", "No reachable XML sitemap", "Deeper pages depend on internal links alone to be found.");
    if (!site.llmsTxt)
          add("Low", "No llms.txt",
                    "An emerging, not-yet-standard convention for telling AI crawlers what a site is and what matters on it. Cheap to add; no engine is known to require it.");
    if (failed.length)
          add("Med", `${failed.length} page(s) did not respond to an automated fetch`,
                    `${failed.slice(0, 3).map((p) => `${new URL(p.url).pathname} (${p.error})`).join(", ")}. Bot-hostile hosting can block AI crawlers the same way.`);
    if (pages.some((p) => p.noindex))
          add("High", `${pages.filter((p) => p.noindex).length} page(s) carry a noindex tag`,
                    "A noindex page cannot be cited by anything. Worth confirming each one is deliberate.");

  const order = { High: 0, Med: 1, Low: 2 };
    f.sort((a, b) => order[a.sev] - order[b.sev]);
    return f;
}

/** Content-gap observations for §12. */
export function contentFindings(site) {
    const pages = (site.pages || []).filter((p) => !p.error);
    const paths = pages.map((p) => { try { return new URL(p.url).pathname; } catch { return p.url; } });
    const has = (re) => paths.some((p) => re.test(p));
    const rows = [];
    rows.push(["Pages crawled", String(pages.length) + (site.truncated ? ` (capped at ${PAGE_CAP})` : ""), "—"]);
    rows.push(["Blog or editorial section", has(/\/(blog|news|articles|insights|resources)/i) ? "Present" : "None found",
                   "Category roundups and explainers are what generated answers quote most often"]);
    rows.push(["FAQ content", has(/\/faq/i) ? "Present" : "None found",
                   "The most directly quotable format there is, and the easiest to mark up"]);
    rows.push(["Service-area or location pages", has(/\/(location|areas?-served|service-area|near-me)/i) ? "Present" : "None found",
                   "How a machine matches “near me” intent to a business"]);
    rows.push(["Named-practitioner or team page", has(/\/(about|team|staff|our-|doctors?|attorneys?|providers?)/i) ? "Present" : "None found",
                   "In professional services the person is often what's being chosen"]);
    rows.push(["Pricing visible on site", pages.some((p) => p.hasPrice) ? "Yes, at least in part" : "Not published",
                   "If a third party publishes your prices and you don't, theirs is the number that gets quoted"]);
    const avg = pages.length ? Math.round(pages.reduce((s, p) => s + p.words, 0) / pages.length) : 0;
    rows.push(["Average words per page", String(avg),
                   avg < 400 ? "Thin by the standards of pages that get quoted" : "Enough substance to be quotable"]);
    return rows;
}
