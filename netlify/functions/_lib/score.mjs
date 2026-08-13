/**
 * Scoring. Every category shows its reasoning, because a number nobody can argue
 * with is a number nobody should trust. Same five categories and weights as the
 * published sample, so a client's score is comparable to it.
 */

export function score({ site, runs, intake }) {
    const scored = runs.filter((r) => r.ok && r.scored);
    const appeared = scored.filter((r) => r.appeared);
    const pages = (site.pages || []).filter((p) => !p.error);
    const n = pages.length || 1;
    const types = new Set(pages.flatMap((p) => p.schemaTypes || []));
    const hasOrg = [...types].some((t) => ["Organization", "LocalBusiness", "MedicalBusiness", "Dentist",
                                               "Physician", "ProfessionalService", "LegalService", "HealthAndBeautyBusiness", "HomeAndConstructionBusiness"].includes(t));
    const hasService = [...types].some((t) => ["Service", "Offer", "Product", "MedicalProcedure"].includes(t));
    const hasReview = pages.some((p) => p.hasReviewMarkup);
    const withH1 = pages.filter((p) => p.h1Count === 1).length;
    const withCanon = pages.filter((p) => p.canonical).length;
    const substantial = pages.filter((p) => p.words >= 400).length;
    const paths = pages.map((p) => { try { return new URL(p.url).pathname; } catch { return ""; } });
    const hasBlog = paths.some((p) => /\/(blog|news|articles|insights|resources)/i.test(p));
    const hasFaq = paths.some((p) => /\/faq/i.test(p)) || types.has("FAQPage");
    const hasAreas = paths.some((p) => /\/(location|areas?-served|service-area)/i.test(p));

  const ownDomain = (() => {
        try { return new URL(intake.website).host.replace(/^www\./, ""); } catch { return ""; }
  })();
    const citedOwn = scored.filter((r) => (r.citedDomains || []).some((d) => d === ownDomain)).length;
    const allCited = [...new Set(scored.flatMap((r) => r.citedDomains || []))];

  const cats = [];
    const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));

  // 1. Entity accuracy — 20
  {
        let v = 8;
        const reasons = [];
        if (hasOrg) { v += 5; reasons.push("a business entity is declared in structured data"); }
        else reasons.push("no business entity is declared in structured data, so scattered mentions are harder to resolve to one business");
        if ([...types].includes("Person")) { v += 3; reasons.push("a named person appears in structured data"); }
        else reasons.push("no named person appears in structured data");
        if (pages.some((p) => p.invalidSchema)) { v -= 4; reasons.push("at least one JSON-LD block fails to parse, which usually voids the whole block"); }
        if (hasReview) { v += 4; reasons.push("review data is machine-readable"); }
        else reasons.push("review data is not machine-readable");
        cats.push({ name: "Entity accuracy", max: 20, value: clamp(v, 20), reasoning: reasons.join("; ") + "." });
  }

  // 2. Website technical readiness — 15
  {
        let v = 3;
        const reasons = [];
        v += 4 * (withH1 / n);
        reasons.push(`${withH1} of ${n} crawled pages carry exactly one H1`);
        v += 3 * (withCanon / n);
        reasons.push(`${withCanon} declare a canonical URL`);
        if (hasService) { v += 3; reasons.push("service or offer markup is present"); }
        else reasons.push("no service or offer markup on any page");
        if (site.sitemapUrlCount) { v += 1.5; reasons.push(`an XML sitemap resolves with ${site.sitemapUrlCount} URLs`); }
        else reasons.push("no reachable XML sitemap");
        if (site.blockedAgents?.length) { v -= 4; reasons.push(`robots.txt blocks ${site.blockedAgents.join(", ")} outright`); }
        else if (site.robots) { v += 0.5; reasons.push("no crawler is blocked wholesale"); }
        cats.push({ name: "Website technical readiness", max: 15, value: clamp(v, 15), reasoning: reasons.join("; ") + "." });
  }

  // 3. Content coverage — 20
  {
        let v = 4;
        const reasons = [`${n} pages crawled, ${substantial} of them carrying 400+ words`];
        v += 6 * (substantial / n);
        if (hasBlog) { v += 4; reasons.push("an editorial section exists"); } else reasons.push("no blog or editorial section found");
        if (hasFaq) { v += 3; reasons.push("FAQ content exists"); } else reasons.push("no FAQ content found");
        if (hasAreas) { v += 3; reasons.push("service-area pages exist"); } else reasons.push("no service-area pages found");
        if (pages.some((p) => p.hasPrice)) { v += 1; reasons.push("some pricing is published"); }
        cats.push({ name: "Content coverage", max: 20, value: clamp(v, 20), reasoning: reasons.join("; ") + "." });
  }

  // 4. Authority and citations — 20
  {
        let v = 2;
        const reasons = [];
        if (scored.length) {
                v += 10 * (citedOwn / scored.length);
                reasons.push(`the business's own domain was cited in ${citedOwn} of ${scored.length} scored runs`);
        }
        v += Math.min(6, allCited.length * 0.4);
        reasons.push(`${allCited.length} distinct domains were cited across all runs — these are the sources that decide this category's answers`);
        if (!citedOwn) reasons.push("being absent from the cited set is the finding that explains most of the others");
        cats.push({ name: "Authority and citations", max: 20, value: clamp(v, 20), reasoning: reasons.join("; ") + "." });
  }

  // 5. Answer presence — 25
  {
        let v = 0;
        const reasons = [];
        if (scored.length) {
                const rate = appeared.length / scored.length;
                v = 25 * rate;
                reasons.push(`named in ${appeared.length} of ${scored.length} scored unbranded runs (${Math.round(rate * 100)}%)`);
                const firsts = appeared.filter((r) => r.position === 1).length;
                if (firsts) reasons.push(`named first in ${firsts}`);
                const branded = runs.find((r) => r.ok && !r.scored);
                if (branded) reasons.push(branded.appeared
                                                  ? "the branded control run did return the business, so this is a discovery problem rather than an indexing one"
                                                  : "the branded control run did not return the business either, which points at an indexing or entity problem before a discovery one");
        } else reasons.push("no scored runs completed");
        cats.push({ name: "Answer presence", max: 25, value: clamp(v, 25), reasoning: reasons.join("; ") + "." });
  }

  const total = cats.reduce((s, c) => s + c.value, 0);
    return {
          total,
          outOf: cats.reduce((s, c) => s + c.max, 0),
          categories: cats,
          shareOfAnswer: scored.length ? Math.round((appeared.length / scored.length) * 100) : null,
          appearedCount: appeared.length,
          scoredCount: scored.length,
          citedDomains: allCited,
          ownDomainCited: citedOwn,
    };
}

/** Effort/impact matrix and the 30/60/90 plan, derived from what was actually found. */
export function plan(findings, scoreObj, intake) {
    const has = (needle) => findings.some((f) => f.what.toLowerCase().includes(needle));
    const a = [], b = [], c = [];

  if (has("no h1") || has("multiple h1"))
        a.push(["Give every page exactly one H1 containing the service and the city", "Web", "2 hrs"]);
    if (has("title tag") )
          a.push(["De-duplicate title tags so no two pages compete for the same phrase", "Web", "1 hr"]);
    if (has("no meta description"))
          a.push(["Write meta descriptions for the pages that answer buying questions", "Web", "2 hrs"]);
    if (has("robots.txt blocks"))
          a.push(["Unblock the AI search crawlers in robots.txt — they cannot cite what they cannot fetch", "Web", "10 min"]);
    if (has("noindex"))
          a.push(["Review every noindex tag and remove the ones that aren't deliberate", "Web", "30 min"]);
    a.push(["Confirm the business name, address and phone are byte-identical on the site, Google Business Profile and every directory that already lists you", "Practice", "3 hrs"]);
    a.push([`Claim or correct any profile that publishes ${intake.business || "the business"} without your involvement, starting with the highest-traffic one`, "Practice", "2 hrs"]);
    if (!scoreObj.ownDomainCited)
          a.push(["Baseline recorded. Do not change anything else until the prompt set has been re-run once, or improvement can't be attributed", "AnswerFoundry", "—"]);

  if (has("no business entity") || has("no structured data"))
        b.push(["Add a business entity node (Organization / LocalBusiness or the industry-specific type) to every page, with consistent name, address, phone and sameAs links", "Web", "3 hrs"]);
    if (has("service or offer markup"))
          b.push(["Add Service or Offer markup to every service page, each linked to the business entity", "Web", "5 hrs"]);
    if (has("fails to parse"))
          b.push(["Fix the malformed JSON-LD — invalid markup is discarded wholesale, so the correct fields inside it are currently wasted", "Web", "1 hr"]);
    if (has("reviews are not marked up"))
          b.push(["Bring a rotating subset of reviews on-page as crawlable HTML with Review markup; keep the widget if you like it, but stop depending on it", "Web", "4 hrs"]);
    if (has("no named person"))
          b.push(["Add a Person node for the named practitioner, with sameAs pointing at verifiable profiles", "Web", "2 hrs"]);
    if (has("no faq"))
          b.push(["Turn the questions you already answer on calls into an FAQ page with FAQPage markup", "Practice + Web", "4 hrs"]);
    if (has("under 300 words"))
          b.push(["Deepen the thin service pages — the head term, the city, the practitioner, and what actually happens", "Web", "6 hrs"]);

  const cited = scoreObj.citedDomains.slice(0, 4);
    if (cited.length)
          c.push([`Pursue presence in the sources these answers actually cite: ${cited.join(", ")}. Several accept submissions; all have a contactable author`, "AnswerFoundry", "6 hrs"]);
    c.push(["Publish one genuinely useful category resource of your own — the format that already ranks here. It must be useful to a reader who never becomes a customer", "Practice + AnswerFoundry", "10 hrs"]);
    c.push(["Add service-area pages for each area you actually serve", "Web", "8 hrs"]);
    c.push(["Formalise review generation across both major platforms with a documented, compliant request process", "Practice", "2 hrs + ongoing"]);
    c.push(["Re-run the identical prompt set and produce the 90-day comparison against baseline, including the results that did not move", "AnswerFoundry", "3 hrs"]);

  const number = (rows, start) => rows.map((r, i) => [String(start + i), ...r]);
    return {
          d30: number(a, 1),
          d60: number(b, a.length + 1),
          d90: number(c, a.length + b.length + 1),
          total: a.length + b.length + c.length,
    };
}
