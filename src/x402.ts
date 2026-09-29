/**
 * The agent rail: one $0.01 payment per lookup. The 402 offers `exact` (an EIP-3009 authorization
 * that Curvy's x402 facilitator settles, gasless for the agent) and Curvy's `curvy-transfer` (the
 * agent sends the tokens to the one-time portal itself). Either way the portal broadcaster shields
 * the funds into our note, as it does for human checkout, and the SDK confirms them on chain. We
 * only pass requests in and pricing out; broadcaster and facilitator are the SDK's defaults.
 *
 * Portals are derived with no usable recovery address: funds that reach a portal the broadcaster
 * never shields (failed screening, underpayment, wrong token) are lost for good.
 */
import { createX402Merchant, type X402Merchant } from "@0xcurvy/payments-sdk/x402/merchant";
import { config } from "./config.js";

let merchant: Promise<X402Merchant> | undefined;

export function x402Merchant(): Promise<X402Merchant> {
  merchant ??= createMerchant(config.facilitator)
    .catch((error: unknown) => {
      // The default facilitator is the one the broadcaster serves. If it is down or does not serve this
      // chain, keep the agent rail up with `curvy-transfer` alone rather than losing it altogether.
      if (config.facilitator !== undefined || !/facilitator/i.test(String(error))) throw error;
      console.warn(`x402 facilitator unavailable, offering curvy-transfer only: ${String(error)}`);
      return createMerchant(false);
    })
    .catch((error: unknown) => {
      merchant = undefined;
      throw error;
    });
  return merchant;
}

function createMerchant(facilitator: string | false | undefined): Promise<X402Merchant> {
  return createX402Merchant({
    ...(config.broadcasterUrl ? { broadcaster: config.broadcasterUrl } : {}),
    ...(facilitator === undefined ? {} : { facilitator }),
    rpcUrl: config.rpcUrl,
    token: config.token,
    recipient: config.recipient,
    merchantOrigin: config.merchantOrigin,
    confirmations: config.confirmations,
    // The broadcaster reports the portal factory and vault; pin the aggregator we confirm against.
    addresses: { aggregator: config.aggregatorAddress },
    onEvent: ({ type, payment }) => {
      const detail =
        type === "confirmed"
          ? `net ${payment.netAmount} in note ${payment.noteId}`
          : type === "challenged"
            ? `offers ${payment.accepts.map((row) => row.scheme).join(", ")}`
          : type === "settled"
            ? `from ${payment.payer} in ${payment.settleTxHash}`
            : type === "shielded"
              ? `in ${payment.shieldTxHash}`
              : (payment.error ?? "");
      console.log(`x402 ${type} ${payment.payTo} ${detail}`.trim());
    },
  });
}
