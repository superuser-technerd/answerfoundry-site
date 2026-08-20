/**
 * The AI engine layer — the part of the audit that has to be honest about itself.
 *
 * These are the assistant *APIs with web search enabled*, not the consumer apps.
 * They share the retrieval substrate and the citation behaviour, which is what
 * the audit reasons about, but they are not the same product a customer opens on
 * their phone: no session history, no personalisation, no A/B-tested UI layer.
 * Every report generated from this must say so — see scopeDisclosure() below,
 * which the renderer drops into §3 verbatim.
 *
 * Every run records the exact prompt, the timestamp, the model string, the full
 * response text and the citations. Favourable or not. That log is the evidence,
 * and the reason the report is worth anything.
 */

const now = () => new Date().toISOString();

/** Prompt families, mirroring the sample audit's fixed methodology. */
export function buildPrompts({ service, city, business, competitors = [], questions = [] }) {
    const svc = service || "the service";
    const loc = city || "the area";
    const custom = questions
      .map((q) => String(q).trim())
      .filter((q) => q.length > 8)
      .slice(0, 3);

  const p = [
    { family: "Category discovery", scored: true, text: `Who are the best ${svc} providers in ${loc}? Name specific businesses.` },
    { family: "Category discovery", scored: true, text: `I need ${svc} in ${loc}. Who should I use, and why?` },
    { family: "Category discovery", scored: true, text: `Most trusted and highest rated ${svc} near ${loc}` },
    { family: "Service-specific", scored: true, text: `${svc} ${loc} — which providers come up, with reviews?` },
    { family: "Adjacent / qualifier", scored: true, text: `Independent, locally owned ${svc} in ${loc} — who is there?` },
        ...custom.map((q) => ({ family: "Customer's own question", scored: true, text: q })),
        ...(competitors.length
                  ? [{ family: "Comparative", scored: true, text: `How does ${business} compare with ${competitors.slice(0, 2).join(" and ")} for ${svc}?` }]
                  : []),
    { family: "Branded control", scored: false, text: `Tell me about ${business}${city ? ` in ${city}` : ""}. What do they do and what is their reputation?` },
      ];
    return p.slice(0, 9);
}

/* -------------------------------------------------------------- models */

/**
 * Model selection, with the flagship as the default in every case.
 *
 * These are env-overridable so a cheaper tier can be A/B'd without a deploy,
 * but the defaults below are deliberately the good models. A vaguer model names
 * fewer businesses, and that error is not random: it biases every report toward
 * "you do not appear", which overstates the exact problem this product is sold
 * to fix. Downgrade only with a measured comparison in hand, never to save
 * cents on a paid diagnostic deliverable.
 */
export const MODELS = {
    openai: process.env.OPENAI_MODEL || "gpt-4.1",
    perplexity: process.env.PERPLEXITY_MODEL || "sonar-pro",
    anthropic: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    gemini: process.env.GEMINI_MODEL || "gemini-2.5-flash",
};

/** Web-search depth for Claude. Fewer searches means less retrieval, so this
 *  floors at 1 and defaults to the value the baseline reports were built with. */
export const ANTHROPIC_MAX_SEARCHES = Math.max(
    1, parseInt(process.env.ANTHROPIC_MAX_SEARCHES || "4", 10) || 4);

/**
 * Engines used for the FREE snapshot.
 *
 * The snapshot is narrowed by ENGINE COUNT, not by model quality: every engine
 * it does run uses the identical flagship model the paid audit uses, so a
 * snapshot's "named / not named" verdict is exactly as trustworthy as a paid
 * one — there is simply less of it. This matters because the snapshot is a
 * sales asset: a cheaper model that named fewer businesses would understate a
 * prospect's visibility and inflate the problem we are quoting to solve.
 */
export const SNAPSHOT_ENGINES = (process.env.SNAPSHOT_ENGINES || "openai,perplexity")
  .split(",").map((x) => x.trim()).filter(Boolean);

/* ------------------------------------------------------------ providers */

async function openai(prompt, model = MODELS.openai) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return null;
    const r = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, input: prompt, tools: [{ type: "web_search" }], tool_choice: "auto" }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `openai ${r.status}`);
    let text = j.output_text || "";
    const cites = [];
    for (const item of j.output || []) {
          for (const c of item.content || []) {
                  if (typeof c.text === "string" && !j.output_text) text += c.text;
                  for (const a of c.annotations || []) if (a.url) cites.push({ url: a.url, title: a.title || "" });
          }
    }
    return { platform: "ChatGPT (OpenAI API, web search)", model: j.model || model, text, citations: cites };
}

async function perplexity(prompt, model = MODELS.perplexity) {
    const key = process.env.PERPLEXITY_API_KEY;
    if (!key) return null;
    const r = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `perplexity ${r.status}`);
    const text = j.choices?.[0]?.message?.content || "";
    const cites = (j.citations || j.search_results || []).map((c) =>
          typeof c === "string" ? { url: c, title: "" } : { url: c.url || "", title: c.title || "" });
    return { platform: "Perplexity (API)", model: j.model || model, text, citations: cites };
}

async function anthropic(prompt, model = MODELS.anthropic) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) return null;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
                  "x-api-key": key,
                  "anthropic-version": "2023-06-01",
                  "content-type": "application/json",
          },
          body: JSON.stringify({
                  model,
                  max_tokens: 1200,
                  messages: [{ role: "user", content: prompt }],
                  tools: [{ type: "web_search_20250305", name: "web_search", max_uses: ANTHROPIC_MAX_SEARCHES }],
          }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `anthropic ${r.status}`);
    let text = "";
    const cites = [];
    for (const b of j.content || []) {
          if (b.type === "text") {
                  text += b.text;
                  for (const c of b.citations || []) if (c.url) cites.push({ url: c.url, title: c.title || "" });
          }
          if (b.type === "web_search_tool_result")
                  for (const c of b.content || []) if (c.url) cites.push({ url: c.url, title: c.title || "" });
    }
    return { platform: "Claude (Anthropic API, web search)", model: j.model || model, text, citations: cites };
}

/**
 * Google Gemini with Google Search grounding.
 *
 * This is Google's model answering against Google Search, with the grounding
 * sources returned. It is NOT the AI Overviews block on the results page — a
 * different surface with different selection logic. Labelled accordingly
 * everywhere it appears, because conflating the two would be the exact
 * overclaim this codebase exists to avoid.
 */
async function gemini(prompt, model = MODELS.gemini) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
              method: "POST",
              headers: { "x-goog-api-key": key, "content-type": "application/json" },
              body: JSON.stringify({
                        contents: [{ parts: [{ text: prompt }] }],
                        tools: [{ google_search: {} }],
              }),
      });
    const j = await r.json();
    if (!r.ok) throw new Error(j?.error?.message || `gemini ${r.status}`);
    const cand = j.candidates?.[0];
    const text = (cand?.content?.parts || []).map((p) => p.text || "").join("");
    const cites = (cand?.groundingMetadata?.groundingChunks || [])
      .map((c) => ({ url: c.web?.uri || "", title: c.web?.title || "" }))
      .filter((c) => c.url);
    return { platform: "Google Gemini (API, Google Search grounding)", model, text, citations: cites };
}

/**
 * Google AI Overviews, captured through SerpApi.
 *
 * Two requests: a normal Google search to obtain the AI Overview page_token,
 * then the dedicated endpoint. The token expires in about a minute, so the
 * second call follows immediately. This is the only route that returns the
 * actual overview a searcher sees, with its cited references.
 */
async function googleAiOverview(prompt) {
    const key = process.env.SERPAPI_KEY;
    if (!key) return null;

  const s = await fetch(`https://serpapi.com/search.json?engine=google&${new URLSearchParams({
        q: prompt, api_key: key, hl: "en", gl: "us",
  })}`);
    const sj = await s.json();
    if (!s.ok) throw new Error(sj?.error || `serpapi ${s.status}`);

  let ov = sj.ai_overview;
    if (ov?.page_token) {
          const t = await fetch(`https://serpapi.com/search.json?engine=google_ai_overview&${new URLSearchParams({
                  page_token: ov.page_token, api_key: key,
          })}`);
          const tj = await t.json();
          if (t.ok && tj.ai_overview) ov = tj.ai_overview;
    }
    if (!ov) {
          // Not an error, and an important observation in its own right: Google chose
      // not to show an AI Overview for this query at all.
      return {
              platform: "Google AI Overviews (via SerpApi)", model: "google_ai_overview",
              text: "[No AI Overview was shown for this query at the time of testing. Google does not generate one for every query, and this absence is recorded rather than treated as a failure.]",
              citations: [], absent: true,
      };
    }

  const flat = (blocks) => (blocks || []).map((b) => {
        if (b.snippet) return b.snippet;
        if (b.list) return b.list.map((li) => `• ${li.title ? li.title + ": " : ""}${li.snippet || ""}`).join("\n");
        if (b.text_blocks) return flat(b.text_blocks);
        return "";
  }).filter(Boolean).join("\n\n");

  const cites = (ov.references || ov.sources || []).map((rf) => ({ url: rf.link || rf.url || "", title: rf.title || "" }))
      .filter((c) => c.url);
    return { platform: "Google AI Overviews (via SerpApi)", model: "google_ai_overview", text: flat(ov.text_blocks), citations: cites };
}

/**
 * Bing Copilot, through whichever third-party provider you subscribe to.
 *
 * Microsoft publishes no API for Copilot's answers, and Azure's "Grounding with
 * Bing Search" tool deliberately does not return its output to developers — so
 * it cannot be used as evidence. This adapter is provider-agnostic: point
 * COPILOT_API_URL at any endpoint that accepts {query} and returns text plus
 * citations. With nothing configured, Copilot is reported as not covered rather
 * than quietly implied.
 */
async function bingCopilot(prompt) {
    const url = process.env.COPILOT_API_URL;
    const key = process.env.COPILOT_API_KEY;
    if (!url || !key) return null;
    const r = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ query: prompt, q: prompt }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || j?.error || `copilot provider ${r.status}`);
    const text = j.answer || j.text || j.content || j.result?.answer || "";
    const raw = j.citations || j.sources || j.references || j.result?.citations || [];
    const cites = raw.map((c) => (typeof c === "string" ? { url: c, title: "" } : { url: c.url || c.link || "", title: c.title || "" }))
      .filter((c) => c.url);
    return { platform: "Bing Copilot (third-party capture)", model: j.model || "provider", text, citations: cites };
}

/**
 * `kind` drives how each engine is described in §3 of the report:
 *   api     — the model's own API with retrieval enabled
 *   serp    — captured from the live results page as a searcher would see it
 *   capture — third-party capture of a product with no API
 */
export const providers = [
  { id: "openai", label: "ChatGPT (OpenAI API)", run: openai, env: "OPENAI_API_KEY", kind: "api" },
  { id: "perplexity", label: "Perplexity (API)", run: perplexity, env: "PERPLEXITY_API_KEY", kind: "api" },
  { id: "anthropic", label: "Claude (Anthropic API)", run: anthropic, env: "ANTHROPIC_API_KEY", kind: "api" },
  { id: "gemini", label: "Google Gemini (Search grounding)", run: gemini, env: "GEMINI_API_KEY", kind: "api" },
  { id: "aioverview", label: "Google AI Overviews (SerpApi)", run: googleAiOverview, env: "SERPAPI_KEY", kind: "serp" },
  { id: "copilot", label: "Bing Copilot (third-party capture)", run: bingCopilot, env: "COPILOT_API_URL", kind: "capture" },
  ];

export const configuredProviders = () => providers.filter((p) => !!process.env[p.env]);

/**
 * The subset of engines a free snapshot runs. Same models, fewer of them.
 *
 * Restricted to `kind === "api"` as well, because the SerpApi-backed engine
 * costs metered searches per run — at the daily snapshot ceiling, free traffic
 * would exhaust a paying customer's quota. Paid audits still get the full set.
 */
export const snapshotProviders = () =>
    configuredProviders().filter((p) => p.kind === "api" && SNAPSHOT_ENGINES.includes(p.id));

/**
 * Engines named in the marketing copy, and whether each is actually live.
 * `match` identifies a run's platform string unambiguously — "Google" alone
 * would match both Gemini and AI Overviews, which are separate surfaces.
 */
export function coverage() {
    const on = (id) => configuredProviders().some((p) => p.id === id);
    return [
      { name: "ChatGPT", live: on("openai"), match: /openai/i, kind: "api",
             how: "OpenAI API with web search enabled" },
      { name: "Perplexity", live: on("perplexity"), match: /perplexity/i, kind: "api",
             how: "Perplexity API" },
      { name: "Claude", live: on("anthropic"), match: /anthropic/i, kind: "api",
             how: "Anthropic API with web search enabled" },
      { name: "Google Gemini", live: on("gemini"), match: /gemini/i, kind: "api",
             how: "Gemini API with Google Search grounding — Google's model answering against Google Search, not the AI Overviews block" },
      { name: "Google AI Overviews", live: on("aioverview"), match: /overview/i, kind: "serp",
             how: "Captured from the live results page via SerpApi, with the overview's own cited references" },
      { name: "Bing Copilot", live: on("copilot"), match: /copilot/i, kind: "capture",
             how: "Third-party capture. Microsoft publishes no API, and Azure's Bing-grounding tool does not return its output to developers" },
        ];
}

/* ------------------------------------------------------- mention detection */

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Legal-suffix-insensitive name matching, plus the distinctive first token. */
export function mentions(text, name) {
    const t = norm(text);
    const n = norm(name).replace(/\b(llc|inc|pllc|pc|pa|ltd|co|corp|the)\b/g, "").trim();
    if (!n) return false;
    if (t.includes(n)) return true;
    const parts = n.split(" ").filter((w) => w.length > 3);
    if (parts.length >= 2) {
          // require the two most distinctive tokens within a short window
      const i = t.indexOf(parts[0]);
          if (i >= 0 && t.slice(i, i + 90).includes(parts[1])) return true;
    }
    if (parts.length === 1 && parts[0].length > 6) return t.includes(parts[0]);
    return false;
}

/** Ordered list of which named businesses appeared, by first position in the text. */
export function rankNames(text, names) {
    const t = norm(text);
    return names
      .map((nm) => {
              const n = norm(nm).replace(/\b(llc|inc|pllc|pc|pa|ltd|co|corp|the)\b/g, "").trim();
              const idx = n ? t.indexOf(n.split(" ")[0]) : -1;
              return { name: nm, idx: mentions(text, nm) ? (idx < 0 ? 1e6 : idx) : -1 };
      })
      .filter((x) => x.idx >= 0)
      .sort((a, b) => a.idx - b.idx)
      .map((x) => x.name);
}

/** Run one prompt against one provider and return a fully-logged result row. */
export async function runOne({ provider, prompt, business, competitors }) {
    const started = now();
    try {
          const res = await provider.run(prompt.text);
          if (!res) return null;
          const appeared = mentions(res.text, business);
          const compsFound = rankNames(res.text, competitors);
          const order = rankNames(res.text, [business, ...competitors]);
          const cited = [...new Set((res.citations || []).map((c) => {
                  try { return new URL(c.url).host.replace(/^www\./, ""); } catch { return null; }
          }).filter(Boolean))];
          return {
                  ok: true,
                  platform: res.platform,
                  model: res.model,
                  family: prompt.family,
                  scored: prompt.scored,
                  prompt: prompt.text,
                  ranAt: started,
                  appeared,
                  position: appeared ? order.indexOf(business) + 1 : null,
                  competitorsNamed: compsFound,
                  citedDomains: cited,
                  citationCount: (res.citations || []).length,
                  responseChars: res.text.length,
                  response: res.text.slice(0, 4000),
          };
    } catch (e) {
          console.error("[engines]", provider.id, e.message);
          return {
                  ok: false, platform: provider.label, model: "—", family: prompt.family, scored: prompt.scored,
                  prompt: prompt.text, ranAt: started, error: e.message.slice(0, 200), appeared: null,
          };
    }
}

/**
 * The disclosure that must appear in §3 of any report built from this.
 *
 * Written from what actually ran, not from a template — so if an engine wasn't
 * queried, the report says so instead of implying it was.
 */
export function scopeDisclosure(usedProviders = []) {
    const kinds = new Set(usedProviders.map((p) => p.kind).filter(Boolean));
    const cov = coverage();
    const live = cov.filter((c) => c.live);
    const off = cov.filter((c) => !c.live);
    const body = [];

  body.push(`Queried in this cycle: **${live.length ? live.map((c) => c.name).join(", ") : "none — see the limitations in §20"}**.` +
                (off.length ? ` Not queried: **${off.map((c) => c.name).join(", ")}**, and no claim is made about them.` : ""));

  if (kinds.has("api"))
        body.push("Where an engine was reached **through its API with web search enabled**, that is stated rather than buried. Those APIs draw on the same retrieval substrate and expose the same citation behaviour, which is what this report reasons about — but they carry no session history, no personalisation, and none of the interface layer those products test on real users. Treat such results as evidence about the retrieval layer, not as a screenshot of what one specific person would see. **Google Gemini with Search grounding is not the same surface as the AI Overviews block**, and the two are reported separately for that reason.");

  if (kinds.has("serp"))
        body.push("**Google AI Overviews** results were captured from the live results page, with the overview's own cited references. Google does not generate an overview for every query; where none appeared, that absence is recorded as a result rather than treated as a failure.");

  if (kinds.has("capture"))
        body.push("**Bing Copilot** has no public API — Microsoft publishes none, and Azure's Bing-grounding tool deliberately withholds its output from developers. These results come from third-party capture, which is a weaker form of evidence than the rest of this report, and should be weighted accordingly.");

  body.push("Every run below is logged with its exact prompt text, timestamp, model version, full response and the sources cited — including the runs where the business was absent, and the runs that failed outright. Nothing was re-run to get a better answer, and no prompt was added or dropped once results were seen.");
    body.push("The full methodology, including what a single automated cycle cannot do, is published openly at answerfoundry.ai/ai-disclaimer/#methodology — not buried in a report you have already paid for.");

  return { title: "Scope disclosure — read before interpreting any result", body };
}
