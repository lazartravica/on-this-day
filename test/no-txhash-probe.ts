// Docs: omitting txHash makes verifyPayment check CommittedNotes (batch settlement) only.
import { decodePaymentIntentFragment } from "@0xcurvy/payments-sdk/transport";
const BASE = "http://localhost:8787";
const post = async (u: string, b: unknown) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json();
const p = await post(`${BASE}/api/payments`, { date: "12-17" });
const signed = decodePaymentIntentFragment(new URL(p.checkoutUrl).hash);
const t = await post("http://127.0.0.1:4034/api/demo/transfer", signed);
const i = signed.intent;
await post("http://127.0.0.1:4035/portal/payments", { ownerHash: i.ownerHash, ephemeralKeyX: i.ephemeralKeyX, ephemeralKeyY: i.ephemeralKeyY, viewTag: i.viewTag, recovery: t.payer, expectedAmount: i.amount, expiry: i.expiry, chainId: i.chainId, token: i.token });
const start = Date.now();
for (let n = 0; n < 180; n++) {
  const r = await post(`${BASE}/api/payments/${p.id}/confirm`, {});
  if (r.status === "paid") { console.log(`confirmed WITHOUT txHash after ${((Date.now() - start) / 1000).toFixed(0)}s`); process.exit(0); }
  await new Promise((res) => setTimeout(res, 2000));
}
console.log("not confirmed without txHash within 6 minutes (batch commitment never observed)");
