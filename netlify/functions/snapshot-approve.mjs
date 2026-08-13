/**
 * GET /api/snapshot-approve?ref=SNAP-…&k=<hmac>
 *
 * The human gate. snapshot-run-background prepares everything and stops; this
 * is the only thing that releases a snapshot to a prospect.
 *
 * Authorised by an HMAC over the reference rather than the admin token, so the
 * link is clickable straight from the review email without putting a reusable
 * credential in a URL. It is single-use: the stored record is marked sent, and
 * a second click reports that instead of emailing the lead twice.
 */
import { json, bad, verify, mail, shell, esc, NOTIFY, SITE } from "./_lib/util.mjs";
import { getJson, putJson } from "./_lib/blobs.mjs";
import { emailSnapshotToLead, STORE } from "./_lib/snapshot.mjs";

export const config = { path: "/api/snapshot-approve" };

const page = (title, body, tone = "#101828") => new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
       <meta name="viewport" content="width=device-width,initial-scale=1">
          <meta name="robots" content="noindex,nofollow"><title>${title} · AnswerFoundry</title></head>
             <body style="margin:0;background:#f7f8fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
                <div style="max-width:560px;margin:80px auto;background:#fff;border:1px solid #e6e9f0;border-radius:12px;padding:32px">
                   <h1 style="margin:0 0 12px;font-size:20px;color:${tone}">${title}</h1>${body}
                      <p style="margin-top:24px"><a href="${SITE}/" style="color:#98a2b3;font-size:13px">← answerfoundry.ai</a></p>
                         </div></body></html>`,
  { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );

export default async (req) => {
    const u = new URL(req.url);
    const reference = u.searchParams.get("ref") || "";
    const key = u.searchParams.get("k") || "";

    if (!reference) return bad("Missing ref");
    if (!verify(`approve:${reference}`, key)) return bad("Not authorised", 403);

    const rec = await getJson(STORE, `${reference}/snapshot`);
    if (!rec) return page("Snapshot not found", `<p style="color:#475467">Nothing stored for reference ${esc(reference)}. Stored snapshots don't last forever — if this is old, re-run it.</p>`, "#b42318");

    if (rec.sent) {
          return page("Already sent", `<p style="color:#475467">This snapshot was already emailed to
                <strong>${esc(rec.intake?.email || "the lead")}</strong> on ${esc(String(rec.sentAt || "").slice(0, 16).replace("T", " "))} UTC.
                      Nothing was sent again.</p>
                            <p style="margin-top:14px"><a href="${esc(rec.url)}" style="color:#c2410c;font-weight:700">View the snapshot →</a></p>`);
    }

    const sent = await emailSnapshotToLead({ email: rec.intake.email, payload: rec.payload, url: rec.url });

    if (!sent?.ok) {
          console.error(`[snapshot-approve ${reference}] send failed`, sent);
          return page("Send failed", `<p style="color:#475467">The snapshot could not be emailed to
                ${esc(rec.intake?.email || "the lead")}. Nothing was marked as sent, so you can click the approve link again
                      once mail is working.</p>
                            <p style="font-size:13px;color:#b42318">${esc(JSON.stringify(sent || {}).slice(0, 300))}</p>`, "#b42318");
    }

    await putJson(STORE, `${reference}/snapshot`, { ...rec, sent: true, sentAt: new Date().toISOString() });

    await mail({
          to: NOTIFY,
          tag: "snapshot-approved",
          subject: `Snapshot sent · ${rec.intake?.business || reference}`,
          html: shell({
                  heading: "Snapshot released to the lead",
                  body: `<p>${esc(rec.intake?.business || "")} — sent to ${esc(rec.intake?.email || "")}.</p>
                          <p><a href="${esc(rec.url)}" style="color:#c2410c">${esc(rec.url.slice(0, 90))}…</a></p>
                                  <p style="font-size:12.5px;color:#98a2b3">Reference ${esc(reference)}. ${rec.intake?.consent
                                                                                                                     ? "Call/text consent was given — phone follow-up is permitted."
                                                                                                                     : "No call/text consent — email only."}</p>`,
          }),
    });

    return page("Sent", `<p style="color:#475467">The snapshot is on its way to
        <strong>${esc(rec.intake.email)}</strong>.</p>
            <p style="margin-top:14px"><a href="${esc(rec.url)}" style="color:#c2410c;font-weight:700">View what they received →</a></p>
                <p style="margin-top:14px;font-size:13px;color:#98a2b3">${rec.intake?.consent
                                                                                ? "Call/text consent was given."
                                                                                : "No call/text consent on this lead — do not call or text."}</p>`, "#2e6b4f");
};
