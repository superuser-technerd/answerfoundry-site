/**
 * Minimal Netlify Blobs client — no npm dependency.
 *
 * The site deploys as a prebuilt directory with no build step, so anything
 * requiring `npm install` at deploy time can't be relied on. The official
 * @netlify/blobs package is a thin wrapper over an HTTP API whose URL and token
 * Netlify injects into the function runtime as NETLIFY_BLOBS_CONTEXT, so we can
 * talk to it directly in about forty lines.
 *
 * Falls back to an in-memory map when the context is absent (local runs, tests),
 * so callers never need to branch on environment.
 */
const memory = new Map();

function ctx() {
    const raw = process.env.NETLIFY_BLOBS_CONTEXT;
    if (!raw) return null;
    try {
          const c = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
          if (!c?.url && !c?.edgeURL) return null;
          return { base: c.url || c.edgeURL, token: c.token, siteID: c.siteID, deployID: c.deployID };
    } catch {
          return null;
    }
}

function endpoint(c, store, key) {
    const u = new URL(`${c.base.replace(/\/$/, "")}/${encodeURIComponent(c.siteID)}/${encodeURIComponent(store)}/${encodeURIComponent(key)}`);
    return u.toString();
}

export const blobsAvailable = () => !!ctx();

export async function put(store, key, value) {
    const c = ctx();
    const body = typeof value === "string" ? value : JSON.stringify(value);
    if (!c) { memory.set(`${store}/${key}`, body); return { ok: true, backend: "memory" }; }
    const r = await fetch(endpoint(c, store, key), {
          method: "PUT",
          headers: { authorization: `Bearer ${c.token}`, "content-type": "application/octet-stream" },
          body,
    });
    if (!r.ok) {
          console.error("[blobs] put failed", store, key, r.status, await r.text().catch(() => ""));
          memory.set(`${store}/${key}`, body);
          return { ok: false, backend: "memory", status: r.status };
    }
    return { ok: true, backend: "blobs" };
}

export async function get(store, key) {
    const c = ctx();
    if (!c) return memory.get(`${store}/${key}`) ?? null;
    const r = await fetch(endpoint(c, store, key), { headers: { authorization: `Bearer ${c.token}` } });
    if (r.status === 404) return memory.get(`${store}/${key}`) ?? null;
    if (!r.ok) {
          console.error("[blobs] get failed", store, key, r.status);
          return memory.get(`${store}/${key}`) ?? null;
    }
    return await r.text();
}

export async function getJson(store, key) {
    const t = await get(store, key);
    if (!t) return null;
    try { return JSON.parse(t); } catch { return null; }
}

export const putJson = (store, key, obj) => put(store, key, JSON.stringify(obj));
