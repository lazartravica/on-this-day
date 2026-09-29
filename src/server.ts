import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { config } from "./config.js";
import { availableDates, eventsOn, normalizeDate } from "./data/events.js";
import { checkoutCompletePage, indexPage } from "./pages.js";
import { x402Merchant } from "./x402.js";
import { PAYMENT_SIGNATURE_HEADER } from "@0xcurvy/payments-sdk/x402";
import type { X402ChargeResult } from "@0xcurvy/payments-sdk/x402/merchant";
import {
  confirmPayment,
  consumeLookup,
  createPayment,
  getPayment,
  InvalidPaymentEvidence,
  merchantKeySet,
  type Payment,
  pricing,
  publicView,
} from "./payments.js";

const PAYMENT_COOKIE = "otd_payment";

const app = new Hono();

// Curvy's hosted checkout fetches this cross-origin to verify our signature.
app.get("/.well-known/curvy-payments.json", (c) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Cache-Control", "public, max-age=60");
  return c.json(merchantKeySet);
});

app.get("/", (c) => c.html(indexPage(availableDates(), pricing)));
app.get(config.checkoutCompletePath, (c) => c.html(checkoutCompletePage()));

/**
 * The paid resource, $0.01 per call, on two rails:
 *  - Agents: x402. Without `PAYMENT-SIGNATURE` the 402 carries a `PAYMENT-REQUIRED`
 *    header offering `exact` (settled through an x402 facilitator) and `curvy-transfer`
 *    (the agent sends the tokens itself); with a valid one the call is settled before
 *    we answer, and the portal broadcaster shields it afterwards.
 *  - Humans: a prepaid bundle bought through Curvy checkout, spent one lookup
 *    per call via `Authorization: Bearer <paymentId>` or the session cookie.
 * The same 402 serves both: x402 clients read the header, browsers and API
 * clients read `payment.checkoutUrl` from the body.
 */
app.get("/api/on-this-day", async (c) => {
  const date = normalizeDate(c.req.query("date"));
  if (!date) return c.json({ error: "date must be MM-DD" }, 400);
  // Don't charge for dates we know nothing about.
  const events = eventsOn(date);
  if (!events) return c.json({ error: `no events archived for ${date}`, availableDates: availableDates() }, 404);

  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const payment = getPayment(bearer ?? getCookie(c, PAYMENT_COOKIE));

  if (payment && consumeLookup(payment)) {
    return c.json({ date, events, lookupsRemaining: payment.lookupsRemaining, price: pricing.perLookup });
  }

  // Agent rail. If the facilitator or RPC is down, agents get no x402 offer but humans still get checkout.
  let charge: X402ChargeResult | undefined;
  try {
    charge = await (await x402Merchant()).charge(c.req.raw, {
      price: config.pricePerLookupBaseUnits,
      description: `What happened on ${date}`,
    });
  } catch (error) {
    console.error("x402 unavailable", error);
  }
  if (charge?.status === "paid") {
    // Settled: the agent's $0.01 sits in our one-time portal and is being shielded.
    return c.json({ date, events, price: pricing.perLookup, payment: { payTo: charge.payment.payTo } }, 200, charge.headers);
  }

  // Human rail. An agent retrying with PAYMENT-SIGNATURE never wants a checkout bundle, so don't mint one.
  const agentRetry = c.req.header(PAYMENT_SIGNATURE_HEADER) !== undefined;
  const fresh = payment?.status === "pending" ? payment : agentRetry ? undefined : await createPayment(date);
  if (fresh) rememberInSession(c, fresh);
  return c.json(
    {
      ...charge?.response.body,
      error: charge?.error ?? "payment required",
      message: `Each lookup costs ${pricing.perLookup}. Agents: answer the PAYMENT-REQUIRED header (x402 exact, or curvy-transfer). Humans: buy a bundle of ${pricing.lookupsPerPurchase} (${pricing.purchase}) at payment.checkoutUrl, confirm, then call with Authorization: Bearer <id>.`,
      ...(fresh ? { payment: publicView(fresh) } : {}),
    },
    402,
    charge?.response.headers ?? {},
  );
});

/**
 * x402 payment records (agent rail), newest first: on-chain status per one-time portal.
 * The private payment reference, the payer's wallet and the requested resource are not exposed.
 */
app.get("/api/x402/payments", async (c) => {
  const x402 = await x402Merchant();
  const payments = (await x402.listPayments()).slice(-50).reverse();
  return c.json(
    payments.map((p) => ({
      payTo: p.payTo,
      status: p.status,
      portalState: p.portalState,
      amount: p.amount,
      netAmount: p.netAmount,
      noteId: p.noteId,
      settleTxHash: p.settleTxHash,
      shieldTxHash: p.shieldTxHash,
      createdAt: new Date(p.createdAt).toISOString(),
      expiresAt: new Date(p.expiresAt).toISOString(),
    })),
  );
});

app.post("/api/payments", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const date = normalizeDate(body.date);
  if (!date || !eventsOn(date)) return c.json({ error: "unknown or invalid date (MM-DD)" }, 400);
  const payment = await createPayment(date);
  rememberInSession(c, payment);
  return c.json(publicView(payment), 201);
});

app.get("/api/payments/:id", (c) => {
  const payment = getPayment(c.req.param("id"));
  return payment ? c.json(publicView(payment)) : c.json({ error: "unknown payment" }, 404);
});

/** API clients: confirm a payment by id, optionally with the shield tx hash. Poll until status is "paid". */
app.post("/api/payments/:id/confirm", async (c) => {
  const payment = getPayment(c.req.param("id"));
  if (!payment) return c.json({ error: "unknown payment" }, 404);
  const body = await c.req.json().catch(() => ({}));
  return confirmAndRespond(c, payment, body.txHash);
});

/**
 * Browsers: the return page posts the `#txHash` fragment here. Curvy's return
 * URL carries no order id, so we pair it with the payment in the session cookie.
 */
app.post("/api/checkout/complete", async (c) => {
  const payment = getPayment(getCookie(c, PAYMENT_COOKIE));
  if (!payment) return c.json({ error: "no checkout in this session" }, 404);
  const body = await c.req.json().catch(() => ({}));
  const response = await confirmAndRespond(c, payment, body.txHash);
  // Spend the first lookup on the date the buyer originally asked for, once.
  if (payment.status === "paid" && !payment.returnPageServed && consumeLookup(payment)) {
    payment.returnPageServed = true;
    return c.json({ ...publicView(payment), events: eventsOn(payment.date) });
  }
  return response;
});

async function confirmAndRespond(c: import("hono").Context, payment: Payment, txHash: unknown) {
  if (txHash !== undefined && typeof txHash !== "string") return c.json({ error: "txHash must be a string" }, 400);
  try {
    await confirmPayment(payment, txHash);
  } catch (error) {
    if (error instanceof InvalidPaymentEvidence) return c.json({ error: error.message, payment: publicView(payment) }, 400);
    console.error("verifyPayment failed", error);
    return c.json({ error: "could not reach the chain, retry shortly" }, 503);
  }
  return c.json(publicView(payment));
}

function rememberInSession(c: import("hono").Context, payment: Payment) {
  setCookie(c, PAYMENT_COOKIE, payment.id, {
    httpOnly: true,
    sameSite: "Lax", // must survive the top-level redirect back from Curvy checkout
    secure: config.merchantOrigin.startsWith("https://"),
    path: "/",
    maxAge: 60 * 60,
  });
}

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(`on-this-day listening on http://localhost:${port} (merchant origin ${config.merchantOrigin})`);
  // Warm up the agent rail so misconfiguration shows at boot, not on the first customer's request.
  void x402Merchant()
    .then((x402) => console.log(`x402 ready on ${x402.network}: schemes ${x402.schemes.join(", ")}, token id ${x402.tokenId}`))
    .catch((error) => console.error("x402 unavailable at boot (will retry on demand)", error));
});
