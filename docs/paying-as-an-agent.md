# Paying for a lookup as an agent

This is for the author of an AI agent (or any script) that needs to know what happened on today's
date and is willing to pay a few cents for the answer. The On This Day API charges per request over
[x402](https://www.x402.org/): the server answers `402 Payment Required` with its terms, the agent
pays, retries, and gets the data. Nothing is signed up for and no API key is issued.

Two working scripts accompany this page. Both were run end to end against the local Curvy stack
and, up to the payment step, against the live demo:

| Script | Uses | When to read it |
| --- | --- | --- |
| [`examples/agent.ts`](../examples/agent.ts) | `createX402Payer` from `@0xcurvy/payments-sdk/x402` + viem | You write TypeScript and want the shortest path |
| [`examples/agent-raw.ts`](../examples/agent-raw.ts) | `fetch` + viem only | You want the wire format, to port it to another language or agent framework |

## What the agent needs

- **A wallet on the service's chain** holding the payment token and a little native gas. The live
  demo runs on Ethereum Sepolia and charges **$0.50 in Sepolia USDC** per lookup. Get test USDC at
  <https://faucet.circle.com/> and Sepolia ETH from any Sepolia faucet.
- **A spending cap.** A 402 names its own price, so the agent must decide the most it will ever pay
  for one request (`MAX_AMOUNT`, in token base units; USDC has 6 decimals, so `500000` is $0.50).
- **No Curvy account, keys or SDK.** The merchant's privacy comes from Curvy; the agent just pays an
  address. The SDK helper is a convenience, not a requirement.

## Run it

```bash
git clone https://github.com/lazartravica/on-this-day && cd on-this-day && pnpm install

# Live demo (Sepolia). AGENT_KEY is the agent wallet's private key.
AGENT_KEY=0x… pnpm agent          # SDK payer
AGENT_KEY=0x… pnpm agent:raw      # fetch + viem only

# Local Curvy devenv (see README "Running locally"): Anvil account #1, $0.01 per lookup
BASE=http://localhost:8787 RPC_URL=http://127.0.0.1:8545 MAX_AMOUNT=10000 \
  AGENT_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d pnpm agent
```

Validated output against the local stack (2026-09-29; the archive is small, so today's date fell
back to the next archived one):

```
No events archived for 09-29; asking about 10-04 instead.

On this day, 10-04:
  1957: The Soviet Union launches Sputnik 1, the first artificial satellite.

Paid $0.01 to one-time portal 0x720fF63965569c080FE4f3ACfeffA49E27F3ce09
Settlement: ok in tx 0x4c6cda90e012d6f2b76746ed8803904edf2e4705ce87955945e7b34e9db06e47 on eip155:31337
```

Against the live demo with an unfunded wallet the script stops before paying:

```
Error: wallet 0x2F51…E043 holds 0 base units of 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 but the
lookup costs 500000. Get Sepolia USDC at https://faucet.circle.com/ and Sepolia ETH for gas.
```

## The flow, step by step

### 1. Pick the date and ask

The resource is `GET /api/on-this-day?date=MM-DD`. An agent that wants "today" formats the current
UTC date as `MM-DD`. Two things can come back before any payment:

- **404** when the archive has nothing for that date. It is free (never charged) and its body lists
  `availableDates`, so the agent can pick another date. The examples take the next archived date.
- **402** when there are events. The body is human-readable JSON; the machine-readable terms are in
  the `PAYMENT-REQUIRED` header.

An unpaid 402 creates no obligation. The agent can walk away.

### 2. Read the terms

`PAYMENT-REQUIRED` is base64-encoded JSON (x402 v2):

```json
{
  "x402Version": 2,
  "resource": { "url": "https://on-this-day-x402.fly.dev/api/on-this-day?date=10-04", "description": "What happened on 10-04", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "curvy-transfer",
      "network": "eip155:11155111",
      "asset": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
      "amount": "500000",
      "payTo": "0xc2a2306881D37E5528fCB1d4AdC27E6F93eE34F8",
      "maxTimeoutSeconds": 300,
      "extra": { "assetTransferMethod": "erc20-transfer" }
    }
  ]
}
```

Each row of `accepts` is one way to pay. Pick the row whose `network` is your chain and whose
`scheme` you support, and check `amount` against your cap. `payTo` is a **fresh one-time address per
request**; never reuse one from an earlier 402.

Two schemes exist:

| Scheme | How you pay | Needs |
| --- | --- | --- |
| `curvy-transfer` | Send a plain ERC-20 `transfer(payTo, amount)` yourself and present the transaction hash | A wallet with the token and gas |
| `exact` | Sign an EIP-3009 `TransferWithAuthorization`; Curvy's x402 facilitator submits it and pays gas | Any standard x402 client such as `@x402/fetch` speaks it |

The live demo offers `curvy-transfer` only. `createX402Payer` handles both: give it `send` for
`curvy-transfer`, `signer` for `exact`, or both, and it prefers `exact` when offered.

### 3. Pay

For `curvy-transfer`, one ERC-20 transfer of exactly `amount` to `payTo` on `network`. In viem:

```ts
const txHash = await walletClient.writeContract({
  address: accepted.asset, abi: erc20Abi, functionName: "transfer", args: [accepted.payTo, BigInt(accepted.amount)],
});
```

Send the exact amount. An underpayment is not credited, and because the merchant's one-time
addresses have no recovery owner, an underpaid or wrong-token transfer is lost for good.

### 4. Retry with the receipt

Repeat the same request with a `PAYMENT-SIGNATURE` header: base64 JSON echoing the row you accepted
plus your proof of payment.

```json
{
  "x402Version": 2,
  "resource": { "...": "copied from the 402" },
  "accepted": { "...": "the accepts[] row you paid, unchanged" },
  "payload": { "txHash": "0x6e779b27…21ee" }
}
```

The server checks that the echoed row is one it issued and that `payTo` really holds the amount on
chain. Until your transfer is mined it answers **402 again with the same `payTo`**: keep retrying
the same header every couple of seconds (the raw example gives up after 90 s). A 402 with a
**different** `payTo` means your payment was refused; the body's `error` says why.

### 5. Use the answer

The paid response is `200` with the JSON you asked for and a `PAYMENT-RESPONSE` header, base64
JSON like `{"success":true,"transaction":"0x…","network":"eip155:11155111","payer":"0x…"}`. Keep it
as your receipt. Replaying the same `PAYMENT-SIGNATURE` buys nothing: each challenge is served once.

## With the SDK helper

`createX402Payer` collapses steps 2 to 5 into a `fetch` that pays one 402 and returns the paid
response, retrying the same header while the transfer mines and never paying twice for one URL:

```ts
import { createX402Payer, paymentResponseFrom } from "@0xcurvy/payments-sdk/x402";

const payer = createX402Payer({
  maxAmount: 500_000n,                                  // the cap; a 402 asking more is refused
  send: ({ token, to, amount }) =>                      // curvy-transfer
    walletClient.writeContract({ address: token, abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
  // signer: privateKeyToAccount(AGENT_KEY),           // add for `exact` when the service offers it
});

const response = await payer.fetch(`${BASE}/api/on-this-day?date=${date}`);
const receipt = paymentResponseFrom(response);        // decoded PAYMENT-RESPONSE, or undefined
```

`payer.pay(required)` returns just the header value if you already hold a decoded 402.

## Where the money goes

The agent's transfer lands in a one-time entry portal. Curvy's portal broadcaster then shields it
into the merchant's private balance, and the merchant confirms its own payment reference on chain.
The agent's address is public on the transfer; the merchant's revenue is not. The merchant exposes
each payment's progress, without the payer's identity or the requested date, at
`GET /api/x402/payments` (`settled` → `shielded` → `confirmed`).

## Checklist for production agents

- Cap spend per request (`maxAmount`) and per session.
- Send the exact amount to the exact `payTo`; treat the 402 as single-use.
- Retry the same `PAYMENT-SIGNATURE` on a repeated 402 with the same `payTo`; stop on a new `payTo`.
- Log the `PAYMENT-RESPONSE` receipt with the resource URL.
- Prefer `exact` through a facilitator when offered if you want to avoid holding gas.
