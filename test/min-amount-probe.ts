// Finds the smallest amount the human checkout rail will shield on this stack.
import { signPaymentIntent } from "@0xcurvy/payments-sdk/intent";
import { initialize } from "@0xcurvy/payments-sdk/merchant";
import { privateKeyToAccount } from "viem/accounts";

const sdk = initialize({
  recipient: { S: process.env.CURVY_PUBLIC_S!, V: process.env.CURVY_PUBLIC_V!, babyJubjubPublicKey: process.env.CURVY_PUBLIC_BABYJUBJUB! },
  chainId: 31337, merchantOrigin: process.env.MERCHANT_ORIGIN!, confirmations: 1,
});
const signer = privateKeyToAccount(process.env.MERCHANT_SIGNER_PRIVATE_KEY as `0x${string}`);
const post = async (u: string, b: unknown) => { const r = await fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }); return { ok: r.ok, body: await r.json() }; };

for (const amount of (process.argv.slice(2).map(BigInt))) {
  const intent = await sdk.createPaymentRequest({ amount, token: process.env.PAYMENT_TOKEN as `0x${string}` });
  const signed = await signPaymentIntent(intent, (td) => signer.signTypedData(td));
  const t = await post("http://127.0.0.1:4034/api/demo/transfer", signed);
  if (!t.ok) { console.log(amount, "transfer failed", t.body); continue; }
  await post("http://127.0.0.1:4035/portal/payments", { ownerHash: intent.ownerHash, ephemeralKeyX: intent.ephemeralKeyX, ephemeralKeyY: intent.ephemeralKeyY, viewTag: intent.viewTag, recovery: t.body.payer, expectedAmount: intent.amount, expiry: intent.expiry, chainId: intent.chainId, token: intent.token });
  let s: any;
  for (let i = 0; i < 60; i++) { s = (await (await fetch(`http://127.0.0.1:4035/portal/status?address=${t.body.portalAddress}`)).json()).data; if (["shielded","failed","compliance_failed","expired"].includes(s?.state)) break; await new Promise(r => setTimeout(r, 500)); }
  console.log(`${amount} ($${Number(amount)/1e6}) → ${s?.state} ${s?.error ?? s?.txHash ?? ""}`);
}
