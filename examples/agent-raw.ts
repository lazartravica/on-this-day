/**
 * The same agent without the Curvy SDK: only `fetch` and viem. Shows the x402 v2 wire format so you can
 * port it to any language.
 *
 *   AGENT_KEY=0x… pnpm agent:raw
 *   BASE=http://localhost:8787 RPC_URL=http://127.0.0.1:8545 AGENT_KEY=0x… MAX_AMOUNT=10000 pnpm agent:raw
 */
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.BASE ?? "https://on-this-day-x402.fly.dev";
const RPC = process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const MAX_AMOUNT = BigInt(process.env.MAX_AMOUNT ?? 500_000);
const key = process.env.AGENT_KEY as `0x${string}` | undefined;
if (!key) throw new Error("AGENT_KEY is required");

type Requirements = { scheme: string; network: string; asset: string; amount: string; payTo: string; maxTimeoutSeconds: number; extra?: Record<string, unknown> };
type PaymentRequired = { x402Version: number; error?: string; resource: unknown; accepts: Requirements[] };

const decode = <T>(header: string): T => JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ transport: http(RPC) });
const chainId = await publicClient.getChainId();
const chain = { id: chainId, name: `eip155:${chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

// 1. Ask. Today first; a date without events is a free 404 that lists the archived dates.
const today = new Date().toISOString().slice(5, 10);
let url = `${BASE}/api/on-this-day?date=${today}`;
let response = await fetch(url);
if (response.status === 404) {
  const { availableDates } = (await response.json()) as { availableDates: string[] };
  const date = availableDates.find((d) => d >= today) ?? availableDates[0];
  console.log(`No events archived for ${today}; asking about ${date} instead.`);
  url = `${BASE}/api/on-this-day?date=${date}`;
  response = await fetch(url);
}
if (response.status !== 402) throw new Error(`expected 402, got ${response.status}: ${await response.text()}`);

// 2. Read the terms from the PAYMENT-REQUIRED header (base64 JSON). Pick the plain-transfer scheme on our chain.
const required = decode<PaymentRequired>(response.headers.get("PAYMENT-REQUIRED") ?? "");
const accepted = required.accepts.find((row) => row.scheme === "curvy-transfer" && row.network === `eip155:${chainId}`);
if (!accepted) throw new Error(`no curvy-transfer offer for eip155:${chainId}; offered: ${JSON.stringify(required.accepts)}`);
const amount = BigInt(accepted.amount);
if (amount > MAX_AMOUNT) throw new Error(`the service asks ${amount} base units, more than MAX_AMOUNT=${MAX_AMOUNT}`);
console.log(`402: pay ${accepted.amount} base units of ${accepted.asset} to one-time portal ${accepted.payTo}`);

// 3. Pay: a plain ERC-20 transfer of exactly `amount` to `payTo`. The agent pays gas.
const txHash = await walletClient.writeContract({
  address: getAddress(accepted.asset),
  abi: erc20Abi,
  functionName: "transfer",
  args: [getAddress(accepted.payTo), amount],
});
console.log(`sent transfer ${txHash}`);

// 4. Retry the same request with PAYMENT-SIGNATURE: the accepted terms echoed back plus the transaction hash.
//    Until the transfer is mined the service answers 402 again, re-offering the same portal: keep the same header.
const signature = encode({ x402Version: 2, resource: required.resource, accepted, payload: { txHash } });
const deadline = Date.now() + 90_000;
let paid: Response;
for (;;) {
  paid = await fetch(url, { headers: { "PAYMENT-SIGNATURE": signature } });
  if (paid.status !== 402) break;
  const again = decode<PaymentRequired>(paid.headers.get("PAYMENT-REQUIRED") ?? "");
  const samePortal = again.accepts.some((row) => row.payTo.toLowerCase() === accepted.payTo.toLowerCase());
  if (!samePortal || Date.now() > deadline) throw new Error(`payment refused: ${again.error ?? "unknown reason"}`);
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
if (!paid.ok) throw new Error(`paid call failed: ${paid.status} ${await paid.text()}`);

// 5. The resource, plus the settlement receipt in PAYMENT-RESPONSE (base64 JSON).
const body = (await paid.json()) as { date: string; events: { year: number; text: string }[] };
const receipt = decode<{ success: boolean; transaction: string; network: string; payer?: string }>(paid.headers.get("PAYMENT-RESPONSE") ?? "");
console.log(`\nOn this day, ${body.date}:`);
for (const event of body.events) console.log(`  ${event.year}: ${event.text}`);
console.log(`\nSettled: ${receipt.success} in ${receipt.transaction} on ${receipt.network}`);
