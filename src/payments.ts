import { randomUUID } from "node:crypto";
import { signPaymentIntent } from "@0xcurvy/payments-sdk/intent";
import { initialize } from "@0xcurvy/payments-sdk/merchant";
import { buildMerchantKeySet } from "@0xcurvy/payments-sdk/merchant/keys";
import { buildCheckoutUrl } from "@0xcurvy/payments-sdk/transport";
import { createPublicClient, defineChain, type Hex, http, isHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { config } from "./config.js";

export type PaymentStatus = "pending" | "paid" | "expired";

export interface Payment {
  id: string;
  /** Payment reference: the on-chain identity of this attempt. Never sent to the client. */
  ephemeralKey: readonly [string, string];
  /** The date the buyer asked for first, so the return page can show the result. */
  date: string;
  /** Prepaid lookups left. Each one is worth `pricePerLookupBaseUnits`. */
  lookupsRemaining: number;
  checkoutUrl: string;
  expiry: number;
  status: PaymentStatus;
  txHash?: Hex;
  /** Set once the checkout return page has shown (and charged for) `date`. */
  returnPageServed?: boolean;
}

const sdk = initialize({
  recipient: config.recipient,
  chainId: config.chainId,
  merchantOrigin: config.merchantOrigin,
  checkoutCompletePath: config.checkoutCompletePath,
  confirmations: config.confirmations,
  ttlSeconds: 600,
});

const signer = privateKeyToAccount(config.signerPrivateKey);

const purchaseAmount = config.pricePerLookupBaseUnits * BigInt(config.lookupsPerPurchase);

const publicClient = createPublicClient({
  chain: defineChain({
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  }),
  transport: http(config.rpcUrl),
});

// In-memory store: fine for a demo, lost on restart. Expired unpaid checkouts are dropped
// once the map grows, so unpaid probes cannot fill memory.
const payments = new Map<string, Payment>();
const PRUNE_ABOVE = 1_000;

function pruneExpired(): void {
  if (payments.size < PRUNE_ABOVE) return;
  const now = Date.now() / 1000;
  for (const [id, payment] of payments) {
    if (payment.status !== "paid" && payment.expiry < now) payments.delete(id);
  }
}

export const merchantKeySet = buildMerchantKeySet([{ address: signer.address, notAfter: config.signerNotAfter }]);

export async function createPayment(date: string): Promise<Payment> {
  pruneExpired();
  const request = await sdk.createPaymentRequest({ amount: purchaseAmount, token: config.token });
  const signed = await signPaymentIntent(request, (typedData) => signer.signTypedData(typedData));

  const payment: Payment = {
    id: randomUUID(),
    ephemeralKey: [request.ephemeralKeyX, request.ephemeralKeyY],
    date,
    lookupsRemaining: config.lookupsPerPurchase,
    checkoutUrl: buildCheckoutUrl(config.checkoutOrigin, signed),
    expiry: request.expiry,
    status: "pending",
  };
  payments.set(payment.id, payment);
  return payment;
}

export function getPayment(id: string | undefined): Payment | undefined {
  if (!id) return undefined;
  const payment = payments.get(id);
  // Only a pending request can lapse; once paid, the credit stays redeemable.
  if (payment?.status === "pending" && payment.expiry < Date.now() / 1000) payment.status = "expired";
  return payment;
}

export class InvalidPaymentEvidence extends Error {}

/**
 * Checks the chain for this payment. `txHash` (from the checkout return URL)
 * is an untrusted hint; without it the SDK looks for batch commitment only.
 * Expired requests are still checked: a buyer who paid just before expiry
 * must not lose the credit.
 */
export async function confirmPayment(payment: Payment, txHash?: string): Promise<Payment> {
  if (payment.status === "paid") return payment;
  if (txHash !== undefined && !isHash(txHash)) throw new InvalidPaymentEvidence("txHash must be a 32-byte hex string");

  let confirmed: boolean;
  try {
    confirmed = await sdk.verifyPayment({
      publicClient,
      aggregatorAddress: config.aggregatorAddress,
      ephemeralKey: payment.ephemeralKey,
      txHash: txHash as Hex | undefined,
    });
  } catch (error) {
    // Documented throws: malformed/unknown hash, non-shield tx, reverted shield.
    throw new InvalidPaymentEvidence((error as Error).message);
  }

  if (confirmed) {
    payment.status = "paid";
    payment.txHash = txHash as Hex | undefined;
  }
  return payment;
}

/** Spends one prepaid lookup. Returns false if the payment is unpaid or used up. */
export function consumeLookup(payment: Payment): boolean {
  if (payment.status !== "paid" || payment.lookupsRemaining <= 0) return false;
  payment.lookupsRemaining -= 1;
  return true;
}

const usd = (baseUnits: bigint) => `$${(Number(baseUnits) / 10 ** config.tokenDecimals).toFixed(2)}`;

export const pricing = {
  perLookup: usd(config.pricePerLookupBaseUnits),
  lookupsPerPurchase: config.lookupsPerPurchase,
  purchase: usd(purchaseAmount),
};

export function publicView(payment: Payment) {
  return {
    id: payment.id,
    status: payment.status,
    date: payment.date,
    price: pricing.purchase,
    lookupsRemaining: payment.lookupsRemaining,
    checkoutUrl: payment.status === "pending" ? payment.checkoutUrl : undefined,
    expiresAt: new Date(payment.expiry * 1000).toISOString(),
  };
}
