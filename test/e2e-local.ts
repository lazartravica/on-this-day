/**
 * Local end-to-end: pay for lookups through the Curvy demo stack without a
 * browser. Stands in for the hosted checkout page (buyer driver :4034 pays the
 * portal, broadcaster :4035 shields) and then exercises both merchant
 * confirmation paths of this service:
 *   A. API client: confirm by id (+txHash), call with Bearer token
 *   B. Browser: session cookie + POST /api/checkout/complete
 * Also checks the bundle is spent exactly (N lookups, then 402).
 */
import assert from "node:assert/strict";
import { decodePaymentIntentFragment } from "@0xcurvy/payments-sdk/transport";

const BASE = process.env.BASE ?? "http://localhost:8787";
const BUYER = process.env.BUYER_DRIVER ?? "http://127.0.0.1:4034";
const BROADCASTER = process.env.BROADCASTER ?? "http://127.0.0.1:4035";

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { res, body: await res.json() };
}

/** Everything Curvy's checkout does between "open checkoutUrl" and "redirect to #txHash=". */
async function payLikeCheckout(checkoutUrl: string): Promise<`0x${string}`> {
  const signed = decodePaymentIntentFragment(new URL(checkoutUrl).hash);
  const transfer = await post(`${BUYER}/api/demo/transfer`, signed);
  assert.equal(transfer.res.status, 200, `buyer transfer failed: ${JSON.stringify(transfer.body)}`);
  const { intent } = signed;
  const reg = await post(`${BROADCASTER}/portal/payments`, {
    ownerHash: intent.ownerHash,
    ephemeralKeyX: intent.ephemeralKeyX,
    ephemeralKeyY: intent.ephemeralKeyY,
    viewTag: intent.viewTag,
    recovery: transfer.body.payer,
    expectedAmount: intent.amount,
    expiry: intent.expiry,
    chainId: intent.chainId,
    token: intent.token,
  });
  assert.ok(reg.res.ok, `portal registration failed: ${JSON.stringify(reg.body)}`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = (await (await fetch(`${BROADCASTER}/portal/status?address=${transfer.body.portalAddress}`)).json()).data;
    if (status?.state === "shielded") return status.txHash;
    if (["compliance_failed", "expired", "failed"].includes(status?.state)) throw new Error(`portal ${status.state}: ${JSON.stringify(status)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("portal never shielded");
}

async function pollConfirm(id: string, txHash?: string) {
  for (let i = 0; i < 60; i++) {
    const { res, body } = await post(`${BASE}/api/payments/${id}/confirm`, txHash ? { txHash } : {});
    assert.ok(res.ok, `confirm failed: ${JSON.stringify(body)}`);
    if (body.status === "paid") return body;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("payment never confirmed");
}

// --- A. API client flow -----------------------------------------------------
{
  const challenge = await fetch(`${BASE}/api/on-this-day?date=07-20`);
  assert.equal(challenge.status, 402);
  const { payment } = await challenge.json();
  console.log("A: 402 received, payment", payment.id);

  const txHash = await payLikeCheckout(payment.checkoutUrl);
  console.log("A: shielded in", txHash);

  // A different payment's reference must NOT verify against this tx.
  const other = (await post(`${BASE}/api/payments`, { date: "07-20" })).body;
  const cross = await post(`${BASE}/api/payments/${other.id}/confirm`, { txHash });
  assert.notEqual(cross.body.status, "paid", "tx hash of payment A must not unlock payment B");
  console.log("A: cross-payment tx reuse rejected →", cross.res.status, cross.body.status ?? cross.body.error);

  const confirmed = await pollConfirm(payment.id, txHash);
  const bundle: number = confirmed.lookupsRemaining;
  console.log(`A: confirmed, ${bundle} lookups prepaid for ${confirmed.price}`);

  const auth = { authorization: `Bearer ${payment.id}` };
  const first = await fetch(`${BASE}/api/on-this-day?date=07-20`, { headers: auth });
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.lookupsRemaining, bundle - 1);
  console.log("A: 200 →", JSON.stringify(firstBody.events[0]), `(${firstBody.lookupsRemaining} left)`);

  for (let i = 1; i < bundle; i++) {
    const r = await fetch(`${BASE}/api/on-this-day?date=${i % 2 ? "10-04" : "11-09"}`, { headers: auth });
    assert.equal(r.status, 200, `lookup ${i + 1} of ${bundle} should be prepaid`);
  }
  const exhausted = await fetch(`${BASE}/api/on-this-day?date=07-20`, { headers: auth });
  assert.equal(exhausted.status, 402, "bundle must buy exactly its number of lookups");
  console.log(`A: spent all ${bundle} lookups, next call → 402`);
}

// --- B. Browser flow (session cookie + return page) ----------------------------
{
  const challenge = await fetch(`${BASE}/api/on-this-day?date=09-21`);
  const cookie = challenge.headers.get("set-cookie")!.split(";")[0];
  const { payment } = await challenge.json();
  const txHash = await payLikeCheckout(payment.checkoutUrl);
  console.log("B: shielded in", txHash, "→ return URL", `${BASE}/checkout/complete#txHash=${txHash}`);

  const page = await fetch(`${BASE}/checkout/complete`);
  assert.equal(page.status, 200);
  let result;
  for (let i = 0; i < 60 && !result?.events; i++) {
    result = (await post(`${BASE}/api/checkout/complete`, { txHash }, { cookie })).body;
    if (!result.events) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.ok(result.events, `return page never unlocked: ${JSON.stringify(result)}`);
  console.log("B: return page unlocked", result.events.length, "events for", result.date);
}

console.log("E2E OK");
