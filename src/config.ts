import type { Address, Hex } from "viem";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  // Must be a bare origin: scheme + host (+ port). Curvy returns buyers to
  // `${merchantOrigin}${checkoutCompletePath}#txHash=...`.
  merchantOrigin: process.env.MERCHANT_ORIGIN ?? "http://localhost:8787",
  checkoutCompletePath: "/checkout/complete",

  chainId: Number(process.env.CHAIN_ID ?? 31337),
  rpcUrl: process.env.RPC_URL ?? "http://127.0.0.1:8545",
  confirmations: Number(process.env.CONFIRMATIONS ?? 1),
  aggregatorAddress: required("CURVY_AGGREGATOR") as Address,
  checkoutOrigin: required("CURVY_CHECKOUT_ORIGIN"),
  // Curvy's portal broadcaster shields agent payments (the same service as for human checkout) and
  // tells the SDK the contract addresses. Unset: the SDK's default, Curvy's production broadcaster
  // (https://api.curvy.box). Its USD minimum per portal must be at most the price: lower payments
  // are settled and then failed, unrecoverably.
  broadcasterUrl: process.env.CURVY_BROADCASTER_URL || undefined,
  // The x402 facilitator that settles the gasless `exact` scheme. Unset: the SDK's default, Curvy's
  // facilitator served by the broadcaster in use (`<broadcaster>/portal/x402`). Any x402 v2
  // facilitator URL overrides it; `none` offers `curvy-transfer` only.
  facilitator: (process.env.X402_FACILITATOR_URL === "none"
    ? false
    : process.env.X402_FACILITATOR_URL || undefined) as string | false | undefined,

  // Each lookup costs $0.01 (10_000 base units of a 6-decimal USD stablecoin).
  // Agents pay exactly that per call over x402. Human checkout can't take $0.01:
  // Curvy's portal broadcaster fails any portal worth under $0.50 (after the
  // buyer has paid), so humans prepay a bundle of lookups in one checkout.
  // Protocol fees are only ~160 base units either way.
  token: required("PAYMENT_TOKEN") as Address,
  pricePerLookupBaseUnits: BigInt(process.env.PRICE_PER_LOOKUP_BASE_UNITS ?? 10_000),
  tokenDecimals: 6,
  lookupsPerPurchase: Number(process.env.LOOKUPS_PER_PURCHASE ?? 100),

  recipient: {
    S: required("CURVY_PUBLIC_S"),
    V: required("CURVY_PUBLIC_V"),
    babyJubjubPublicKey: required("CURVY_PUBLIC_BABYJUBJUB"),
  },
  signerPrivateKey: required("MERCHANT_SIGNER_PRIVATE_KEY") as Hex,
  signerNotAfter: process.env.MERCHANT_SIGNER_NOT_AFTER ?? "2027-01-01T00:00:00.000Z",
};
