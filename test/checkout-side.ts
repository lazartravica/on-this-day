// Plays the role of Curvy's hosted checkout: decode + verify our signed package.
import { verifyPaymentIntent } from "@0xcurvy/payments-sdk/intent";
import { decodePaymentIntentFragment } from "@0xcurvy/payments-sdk/transport";

const base = process.env.BASE ?? "http://localhost:8787";
const res = await fetch(`${base}/api/on-this-day?date=09-21`);
const { payment } = await res.json();
const signed = decodePaymentIntentFragment(new URL(payment.checkoutUrl).hash);
const keySet = await (await fetch(`${base}/.well-known/curvy-payments.json`)).json();
const verified = await verifyPaymentIntent(signed, {
  keySet,
  expectedChainId: Number(process.env.CHAIN_ID),
  expectedToken: process.env.PAYMENT_TOKEN as `0x${string}`,
});
console.log("checkout-side verify OK, signer", verified.signer, "amount", verified.intent.amount);

for (const [label, body] of [
  ["no txHash", {}],
  ["malformed txHash", { txHash: "0x1234" }],
  ["unknown txHash", { txHash: "0x" + "ab".repeat(32) }],
] as const) {
  const r = await fetch(`${base}/api/payments/${payment.id}/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  console.log(label, "→", r.status, JSON.stringify(await r.json()).slice(0, 160));
}
const bearer = await fetch(`${base}/api/on-this-day?date=09-21`, { headers: { authorization: `Bearer ${payment.id}` } });
console.log("unpaid bearer →", bearer.status);
