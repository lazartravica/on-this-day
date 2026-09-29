/**
 * The agent rail: one $0.01 payment per lookup. The 402 offers Curvy's `curvy-transfer` (the agent
 * sends the tokens to the one-time portal itself) and, when an x402 facilitator is configured,
 * `exact` (an EIP-3009 authorization the facilitator settles, gasless for the agent). Either way
 * the portal broadcaster shields the funds into our note, as it does for human checkout, and the
 * SDK confirms them on chain. We only pass requests in and pricing out.
 *
 * Portals are derived with no usable recovery address: funds that reach a portal the broadcaster
 * never shields (failed screening, underpayment, wrong token) are lost for good.
 */
import { createX402Merchant, type X402Merchant } from "@0xcurvy/payments-sdk/x402/merchant";
import { config } from "./config.js";

let merchant: Promise<X402Merchant> | undefined;

export function x402Merchant(): Promise<X402Merchant> {
  merchant ??= createX402Merchant({
    broadcaster: config.broadcasterUrl,
    ...(config.facilitatorUrl ? { facilitator: config.facilitatorUrl } : {}),
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
  }).catch((error) => {
    merchant = undefined;
    throw error;
  });
  return merchant;
}
