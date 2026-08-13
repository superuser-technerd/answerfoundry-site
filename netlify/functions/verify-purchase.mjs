/**
 * GET /api/verify-purchase?session_id=cs_...
 *
 * Confirms with Stripe that a checkout session was actually paid, then hands the
 * intake page a short-lived signed grant. The browser never gets to assert that
 * a payment happened — only Stripe does.
 */
import { json, bad, sign, stripeSession, mail, shell, esc, NOTIFY } from "./_lib/util.mjs";

export const config = { path: "/api/verify-purchase" };

/**
 * Somebody has paid and cannot be provisioned. That must never depend on the
 * customer choosing to chase us, so alert immediately with everything needed to
 * fix it by hand.
 *
 * Not alerted on: malformed ids and Stripe 404s. Those are guessed or stale
 * links, and paging on them would make this endpoint a way to spam the inbox.
 */
async function alertStuckPayment({ id, reason, misconfigured }) {
  try {
    await mail({
      to: NOTIFY,
      tag: "purchase-verify-failed",
      subject: misconfigured
        ? `PAYMENT STUCK · Stripe not configured · ${id.slice(0, 24)}`
        : `PAYMENT STUCK · verification failed · ${id.slice(0, 24)}`,
      html: shell({
        heading: "A customer paid and could not be provisioned",
        body: `<p style="color:#b42318"><strong>Act on this now.</strong> Someone completed checkout and the intake
            page could not confirm it, so they have paid and received nothing.</p>
          <table style="width:100%;border-collapse:collapse;background:#f7f8fb;border:1px solid #e6e9f0;border-radius:8px">
            <tr><td style="padding:6px 10px;color:#98a2b3;font-size:12.5px">Session</td>
                <td style="padding:6px 10px;font-size:13px">${esc(id)}</td></tr>
            <tr><td style="padding:6px 10px;color:#98a2b3;font-size:12.5px">Reason</td>
                <td style="padding:6px 10px;font-size:13px">${esc(reason)}</td></tr>
          </table>
          ${misconfigured
            ? `<p style="margin-top:14px"><strong>Cause: STRIPE_SECRET_KEY is not set in Netlify.</strong>
                 Every purchase will fail this way until it is. Set it, then send the customer their intake link again.</p>`
            : `<p style="margin-top:14px">Look this session up in the Stripe dashboard, confirm the charge, then send
                 the customer their intake link by hand.</p>`}
          <p style="font-size:12.5px;color:#98a2b3">The customer was told to email hello@answerfoundry.ai — but do not
            wait for them to do it.</p>`,
      }),
    });
  } catch (e) {
    console.error("[verify-purchase] stuck-payment alert failed", e?.message || e);
  }
}

export default async (req) => {
  const id = new URL(req.url).searchParams.get("session_id") || "";
  if (!id) return bad("Missing session_id");

  let s;
  try {
    s = await stripeSession(id);
  } catch (e) {
    console.error("[verify-purchase]", e.message);
    const misconfigured = /STRIPE_SECRET_KEY is not set/i.test(e.message || "");
    const malformed = /malformed session id/i.test(e.message || "");
    if (!malformed && e.status !== 404) {
      await alertStuckPayment({ id, reason: e.message || "unknown error", misconfigured });
    }
    return bad(
      e.status === 404 ? "We couldn't find that payment. Check the link in your Stripe receipt, or email hello@answerfoundry.ai."
                       : "We couldn't verify that payment right now — we've been alerted and will contact you shortly. If you'd rather not wait, email hello@answerfoundry.ai.",
      e.status === 404 ? 404 : 502);
  }

  if (s.payment_status !== "paid" && s.status !== "complete")
    return bad("That payment hasn't completed yet. If you were charged, email hello@answerfoundry.ai.", 402);

  const item = s.line_items?.data?.[0];
  return json({
    ok: true,
    session_id: s.id,
    grant: sign(s.id),                       // required by /api/submit-intake
    email: s.customer_details?.email || s.customer_email || "",
    name: s.customer_details?.name || "",
    phone: s.customer_details?.phone || "",
    product: item?.description || "Foundry Audit",
    amount: ((s.amount_total ?? 0) / 100).toFixed(2),
    currency: (s.currency || "usd").toUpperCase(),
    paidAt: s.created ? new Date(s.created * 1000).toISOString() : null,
  });
};
