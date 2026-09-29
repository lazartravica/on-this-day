/**
 * Agent e2e: pay $0.01 per lookup over x402 `exact` with `createX402Payer`, against the
 * local stack (anvil :8545 + portal broadcaster :4035, from `pnpm demo:payments`). The payer
 * is an anvil account funded by minting the devnet "Local USDC" mock.
 *
 *  1. GET without payment → 402 with PAYMENT-REQUIRED (and the human checkout body)
 *  2. payer.fetch pays it (exact if a facilitator is configured, else plain transfer) → 200 + PAYMENT-RESPONSE
 *  3. replaying the same PAYMENT-SIGNATURE → 402 again, no double charge
 *  3b. the agent pays a second lookup by plain ERC-20 transfer (curvy-transfer scheme)
 *  4. both records go settled → shielded (by the portal broadcaster) → confirmed, net = gross − fees
 *
 * Knobs: BASE (service, default http://localhost:8787), RPC_URL, CURVY_BROADCASTER_URL, AGENT_KEY.
 * Needs the portal broadcaster (:4035, PORTAL_MIN_USD_VALUE ≤ 0.01); a facilitator is optional.
 */
import assert from "node:assert/strict";
import { quotePayment, readChainFees } from "@0xcurvy/payments-sdk/economics";
import {
  createBroadcasterClient,
  createX402Payer,
  decodePaymentRequired,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  paymentResponseFrom,
} from "@0xcurvy/payments-sdk/x402";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

const BASE = process.env.BASE ?? "http://localhost:8787";
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const BROADCASTER = process.env.CURVY_BROADCASTER_URL ?? "http://127.0.0.1:4035";
/** Anvil account #1. */
const AGENT_KEY = (process.env.AGENT_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as `0x${string}`;
const PRICE = 10_000n;

const account = privateKeyToAccount(AGENT_KEY);
const publicClient = createPublicClient({ chain: foundry, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: foundry, transport: http(RPC) });
const tokenAbi = parseAbi([
  "function mockMint(address account, uint256 amount)",
  "function balanceOf(address account) view returns (uint256)",
]);

// 1. The unpaid call: one 402 for both rails.
const unpaid = await fetch(`${BASE}/api/on-this-day?date=07-20`);
assert.equal(unpaid.status, 402);
const required = decodePaymentRequired(unpaid.headers.get(PAYMENT_REQUIRED_HEADER) ?? assert.fail("no PAYMENT-REQUIRED header"));
const [offer] = required.accepts;
assert.ok(offer, "402 must offer a payment option");
const token = getAddress(offer.asset);
// `exact` leads: the broadcaster serves Curvy's facilitator, which the SDK uses by default.
assert.ok(["exact", "curvy-transfer"].includes(offer.scheme), `unexpected scheme ${offer.scheme}`);
assert.equal(offer.amount, PRICE.toString());
const body = await unpaid.json();
assert.equal(body.x402Version, 2, "body mirrors the x402 challenge");
assert.ok(body.payment?.checkoutUrl, "body still carries the human checkout bundle");
console.log(`1: 402 → pay ${offer.amount} base units (${offer.scheme}) to one-time portal ${offer.payTo} on ${offer.network}`);

// Fund the agent with exactly what it needs, if it is short.
const balance = await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [account.address] });
if (balance < PRICE * 3n) {
  const hash = await walletClient.writeContract({ address: token, abi: tokenAbi, functionName: "mockMint", args: [account.address, PRICE * 3n] });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log("   minted Local USDC for the agent");
}

// 2. Pay with the SDK's payer: one 402 → one signature → one paid response.
// Anvil's clock runs ahead of the wall clock once the demo e2e has time-warped it, and the token
// checks `block.timestamp < validBefore`, so date the authorization from whichever clock is later.
const chainNow = async () => Number((await publicClient.getBlock()).timestamp);
let chainClock = await chainNow();
const sendTransfer = ({ token: t, to, amount }: { token: `0x${string}`; to: `0x${string}`; amount: bigint }) =>
  walletClient.writeContract({
    address: t,
    abi: parseAbi(["function transfer(address to, uint256 value) returns (bool)"]),
    functionName: "transfer",
    args: [to, amount],
  });
// Prefers `exact` when the service offers it, otherwise pays by plain transfer.
const payer = createX402Payer({
  signer: account,
  send: sendTransfer,
  maxAmount: PRICE,
  now: () => Math.max(chainClock, Math.floor(Date.now() / 1000)),
});
const paid = await payer.fetch(`${BASE}/api/on-this-day?date=07-20`);
assert.equal(paid.status, 200, `paid call failed: ${await paid.clone().text()}`);
const result = await paid.json();
assert.equal(result.date, "07-20");
assert.ok(Array.isArray(result.events) && result.events.length > 0);
// payer.fetch answered its own fresh 402, so the paid portal is the one in the response body.
const paidPayTo: string = result.payment.payTo;
const settlement = paymentResponseFrom(paid);
assert.ok(settlement?.success, "PAYMENT-RESPONSE must report a successful settlement");
assert.equal(settlement.payer?.toLowerCase(), account.address.toLowerCase());
console.log(`2: 200 → ${result.events[0].year}: ${result.events[0].text.slice(0, 60)}… (settled in ${settlement.transaction})`);

// 3. Replay: the same signed header must not buy a second lookup.
chainClock = await chainNow();
const header = await payer.pay(decodePaymentRequired((await fetch(`${BASE}/api/on-this-day?date=07-20`)).headers.get(PAYMENT_REQUIRED_HEADER) ?? assert.fail("no header")));
const once = await fetch(`${BASE}/api/on-this-day?date=07-20`, { headers: { [PAYMENT_SIGNATURE_HEADER]: header } });
assert.equal(once.status, 200);
const twice = await fetch(`${BASE}/api/on-this-day?date=07-20`, { headers: { [PAYMENT_SIGNATURE_HEADER]: header } });
assert.equal(twice.status, 402, "a replayed PAYMENT-SIGNATURE must be refused");
assert.match((await twice.json()).error, /payment challenge is (being settled|settling|settled|shielded|confirmed)/);
console.log("3: replayed PAYMENT-SIGNATURE → 402");

// 3b. The second scheme: the agent sends the tokens itself, no facilitator involved.
const transferChallenge = decodePaymentRequired(
  (await fetch(`${BASE}/api/on-this-day?date=10-04`)).headers.get(PAYMENT_REQUIRED_HEADER) ?? assert.fail("no header"),
);
assert.ok(transferChallenge.accepts.some((row) => row.scheme === "curvy-transfer"), "the 402 must offer curvy-transfer");
const sender = createX402Payer({ send: sendTransfer, maxAmount: PRICE });
const paidByTransfer = await sender.fetch(`${BASE}/api/on-this-day?date=10-04`);
assert.equal(paidByTransfer.status, 200, `transfer-paid call failed: ${await paidByTransfer.clone().text()}`);
const transferResult = await paidByTransfer.json();
const transferPayTo: string = transferResult.payment.payTo;
const transferSettlement = paymentResponseFrom(paidByTransfer);
assert.ok(transferSettlement?.success, "PAYMENT-RESPONSE must report the transfer settlement");
assert.equal(transferSettlement.payer?.toLowerCase(), account.address.toLowerCase());
console.log(`3b: paid by plain transfer → 200 (${transferResult.events[0].year}), portal ${transferPayTo}`);

// 4. The merchant's own evidence: shielded by the broadcaster, then confirmed with net = gross − fees.
// The merchant discovers the vault from the broadcaster; do the same rather than hard-code it.
const deployment = await createBroadcasterClient({ url: BROADCASTER }).network(foundry.id);
assert.ok(deployment, "broadcaster must serve the local chain");
const fees = await readChainFees({ publicClient, vaultAddress: deployment.vault, token });
const expectedNet = quotePayment({ grossAmount: PRICE, fees, rail: "portal" }).netAmount;
const deadline = Date.now() + 180_000;
for (const [label, portal] of [[offer.scheme, paidPayTo], ["curvy-transfer", transferPayTo]] as const) {
  let record: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const payments: Array<Record<string, unknown>> = await (await fetch(`${BASE}/api/x402/payments`)).json();
    record = payments.find((p) => String(p.payTo).toLowerCase() === portal.toLowerCase());
    if (record?.status === "confirmed") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(record?.status, "confirmed", `${label} payment never confirmed: ${JSON.stringify(record)}`);
  assert.equal(record?.netAmount, expectedNet, "net credited to the note must equal gross minus on-chain fees");
  assert.ok(!("note" in (record ?? {})), "the private payment reference must not be exposed");
  console.log(`4: ${label} confirmed on chain: ${PRICE} gross → ${record?.netAmount} net in note ${record?.noteId} (shield ${record?.shieldTxHash}, portal ${record?.portalState})`);
}

console.log("X402 AGENT E2E OK");
