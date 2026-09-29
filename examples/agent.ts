/**
 * An agent that wants to know what happened on today's date, and pays for the answer over x402.
 *
 *   AGENT_KEY=0x… pnpm agent                       # live demo: Sepolia, $0.50 in Sepolia USDC per lookup
 *   BASE=http://localhost:8787 RPC_URL=http://127.0.0.1:8545 AGENT_KEY=0x… MAX_AMOUNT=10000 pnpm agent
 *
 * The agent needs a wallet on the service's chain holding the payment token and a little gas. It never
 * needs Curvy keys: `createX402Payer` answers the 402 by sending a plain ERC-20 transfer (`curvy-transfer`),
 * or by signing an EIP-3009 authorization (`exact`) when the service offers that too.
 */
import { createX402Payer, paymentResponseFrom } from "@0xcurvy/payments-sdk/x402";
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.BASE ?? "https://on-this-day-x402.fly.dev";
const RPC = process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
/** The most this agent will pay for one lookup, in token base units (USDC has 6 decimals). */
const MAX_AMOUNT = BigInt(process.env.MAX_AMOUNT ?? 500_000);
const key = process.env.AGENT_KEY as `0x${string}` | undefined;
if (!key) throw new Error("AGENT_KEY (the agent's wallet private key) is required");

// 1. The agent's wallet. One chain object built from the RPC is enough for viem to send transfers.
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ transport: http(RPC) });
const chainId = await publicClient.getChainId();
const chain = {
  id: chainId,
  name: `eip155:${chainId}`,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

// 2. Which date? Today, unless the archive has nothing for it. That probe is free: a date with no events
//    is a 404 and is never charged, and a date with events answers 402 (unpaid, no obligation).
const today = new Date().toISOString().slice(5, 10); // MM-DD, UTC
let date = today;
const probe = await fetch(`${BASE}/api/on-this-day?date=${today}`);
if (probe.status === 404) {
  const { availableDates } = (await probe.json()) as { availableDates: string[] };
  date = availableDates.find((d) => d >= today) ?? availableDates[0];
  console.log(`No events archived for ${today}; asking about ${date} instead.`);
} else if (probe.status !== 402) {
  throw new Error(`unexpected ${probe.status} from the service: ${await probe.text()}`);
}

// 3. The payer: pays one 402 per request, never more than MAX_AMOUNT, by sending the tokens itself.
const payer = createX402Payer({
  maxAmount: MAX_AMOUNT,
  send: async ({ token, to, amount }) => {
    const balance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
    if (balance < amount) {
      throw new Error(
        `wallet ${account.address} holds ${balance} base units of ${token} but the lookup costs ${amount}. ` +
          (chainId === 11155111 ? "Get Sepolia USDC at https://faucet.circle.com/ and Sepolia ETH for gas." : "Fund it first."),
      );
    }
    return walletClient.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
  },
});

// 4. One call: GET → 402 → transfer → retry with PAYMENT-SIGNATURE → 200. Retries by itself while the transfer mines.
const response = await payer.fetch(`${BASE}/api/on-this-day?date=${date}`);
if (!response.ok) throw new Error(`paid call failed: ${response.status} ${await response.text()}`);
const body = (await response.json()) as {
  date: string;
  events: { year: number; text: string }[];
  price: string; // formatted, e.g. "$0.50"
  payment: { payTo: string };
};
const settlement = paymentResponseFrom(response);

console.log(`\nOn this day, ${body.date}:`);
for (const event of body.events) console.log(`  ${event.year}: ${event.text}`);
console.log(`\nPaid ${body.price} to one-time portal ${body.payment.payTo}`);
console.log(`Settlement: ${settlement?.success ? "ok" : "not reported"} in tx ${settlement?.transaction} on ${settlement?.network}`);
