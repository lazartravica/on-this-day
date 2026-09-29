# On This Day: a pay-per-request API on Curvy

A small service that tells you what happened on a given date. Every lookup costs
**$0.01**, paid privately through Curvy with `@0xcurvy/payments-sdk`, on two rails:

| Who pays | Rail | How |
| --- | --- | --- |
| An AI agent or script | **x402** | `GET /api/on-this-day?date=MM-DD` answers `402` with a `PAYMENT-REQUIRED` header offering `curvy-transfer` (send the $0.01 to the one-time portal yourself) and, when `X402_FACILITATOR_URL` names any x402 facilitator such as Coinbase's, `exact` (sign one $0.01 EIP-3009 authorization, gasless). Curvy's portal broadcaster shields either into our note; Curvy runs no facilitator. **True $0.01 per call.** |
| A human in a browser | **Human checkout**, prepaid bundle | The same `402` body carries a signed Curvy `checkoutUrl`. One checkout buys `LOOKUPS_PER_PURCHASE` lookups (default 100 = $1.00); each call then spends one $0.01 credit. |

Both rails are shielded by Curvy's portal broadcaster, whose `PORTAL_MIN_USD_VALUE` (0.5 by
default) fails any portal worth less, after the payer has already paid, with
`Portal don't have enough funds to be bridged`. For this service that value must be at most
$0.01; the demo stack sets 0.001. Humans still prepay bundles because checkout is a
per-payment browser round trip. (On-chain fees are tiny: on the local devenv 160 base units on a
$0.01 payment, so an agent's $0.01 nets us $0.00984.) An agent payment below the broadcaster's
minimum is settled and then failed, and since the portals have no usable recovery address it is
unrecoverable, so never run this service against a broadcaster with a higher minimum.

## How the agent rail works

The whole merchant side is one object from the SDK, `createX402Merchant` in `src/x402.ts`,
and one call per request in `src/server.ts`:

```ts
const charge = await x402.charge(c.req.raw, { price: 10_000n, description: `What happened on ${date}` });
if (charge.status === "paid") return c.json({ date, events }, 200, charge.headers);
// otherwise send charge.response (402 + PAYMENT-REQUIRED) back
```

1. Without `PAYMENT-SIGNATURE`, `charge()` derives a fresh note and a one-time `payTo`
   portal for it, stores the challenge, and returns the 402.
2. With a valid `PAYMENT-SIGNATURE`, it checks the echoed requirements against the stored
   challenge, then verifies and settles through the facilitator. Only then does it return
   `paid`, so we never serve an unpaid lookup, and a replayed header is refused.
3. In the background the SDK registers the funded portal with Curvy's portal broadcaster,
   the same service that shields human checkout, follows it until the portal is shielded into
   our note, then confirms **our** payment reference on chain with `verifyPayment`.
   `GET /api/x402/payments` shows each payment's status (`settled` → `shielded` → `confirmed`),
   without the payer's wallet or the requested date.

Portals are derived with no usable recovery address (`NO_RECOVERY_ADDRESS`): funds that reach
a portal the broadcaster never shields, because the payer fails screening, underpays, or sends
the wrong token, are lost for good. The 402 terms should say so.

If the facilitator or the RPC is unreachable, agents get no x402 offer but the human rail keeps
working. Agent retries never create a checkout bundle, and expired unpaid bundles are pruned.

An agent needs no Curvy code: any wallet that can send a transfer works for `curvy-transfer`,
and any x402 v2 client works for `exact` when a facilitator is configured. `test/x402-agent.ts`
uses the SDK's `createX402Payer` for both. Contract addresses come from the broadcaster
(`GET /portal/networks/:chainId`); the aggregator is pinned in `src/x402.ts`.

## How the human rail works

1. `GET /api/on-this-day?date=MM-DD` with no remaining credit returns **402** with a
   `payment.id` and a signed Curvy `checkoutUrl` for a bundle. The payment reference
   (`ephemeralKeyX/Y`) stays on the server.
2. The buyer pays at `checkoutUrl`. Curvy sends them back to
   `/checkout/complete#txHash=<shield tx>`.
3. The return page posts the hash to `/api/checkout/complete`, which pairs it with the
   payment held in the httpOnly session cookie. It then polls `verifyPayment` and shows
   the events once the payment is confirmed.
4. API clients can instead poll `POST /api/payments/:id/confirm` (optionally with `{ txHash }`)
   and then call `GET /api/on-this-day?date=MM-DD` with `Authorization: Bearer <id>`.

A payment id works like a prepaid API key: every successful call returns
`lookupsRemaining`, and once it reaches 0 the next call is a 402 again. Dates with no
archived events return 404 and are never charged.

| Route | Purpose |
| --- | --- |
| `GET /` | Minimal UI: pick a date and pay |
| `GET /api/on-this-day?date=MM-DD` | Paid resource (402 until paid, both rails) |
| `GET /api/x402/payments` | Agent-rail payment records and their on-chain status |
| `POST /api/payments` `{date}` | Create a bundle checkout explicitly |
| `GET /api/payments/:id` | Bundle payment status |
| `POST /api/payments/:id/confirm` `{txHash?}` | Check the chain via `verifyPayment` |
| `POST /api/checkout/complete` `{txHash?}` | Browser return-page confirmation (cookie-bound) |
| `GET /.well-known/curvy-payments.json` | Published signer set (CORS `*`) |

## Running locally

```bash
# 1. Curvy local stack (needs Foundry's anvil on PATH), then the payments demo stack in a
#    second terminal: portal broadcaster :4035 (PORTAL_MIN_USD_VALUE=0.001), checkout :4032
cd ../../curvy-monorepo && pnpm run dev:quick
cd ../../curvy-monorepo && pnpm demo:payments

# 2. This service
pnpm install
cp .env.example .env
pnpm keys                # prints throwaway dev receiving keys + signer; paste into .env
# CURVY_CHECKOUT_ORIGIN: the demo checkout is http://127.0.0.1:4032/ (pnpm demo:payments)
# CURVY_BROADCASTER_URL: the demo broadcaster is http://127.0.0.1:4035 (same stack; the default)
# X402_FACILITATOR_URL: optional. The local stack runs no facilitator, so agents pay by
#   `curvy-transfer`; set any x402 v2 facilitator to also offer `exact`.
# If `pnpm dev` refuses to run (ERR_PNPM_IGNORED_BUILDS), use ./node_modules/.bin/tsx --env-file=.env src/server.ts
pnpm dev
```

## Public demo (Fly.io, Ethereum Sepolia)

A live instance runs at **<https://on-this-day-x402.fly.dev>** against Curvy's production portal
broadcaster on the Ethereum Sepolia testnet, so nobody pays with real money. `fly.toml` holds
the whole non-secret configuration:

| Setting | Value |
| --- | --- |
| Chain | Ethereum Sepolia (`11155111`) |
| Token | Circle's Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (6 decimals) |
| Portal broadcaster | `https://api3.curvy.box` (serves `GET /portal/networks/11155111`) |
| Aggregator | `0x5d4a04d6c9bdf4613e7acd92e570539a5a6dba84`, pinned in `CURVY_AGGREGATOR` |
| Price | **$0.50** per lookup (`PRICE_PER_LOOKUP_BASE_UNITS=500000`), one lookup per checkout |

The price is $0.50 rather than $0.01 because the production broadcaster's `PORTAL_MIN_USD_VALUE`
is 0.5, and a portal funded below it is failed after the agent has paid, unrecoverably. Get
Sepolia USDC from [Circle's faucet](https://faucet.circle.com/) and pay a lookup as an agent:

```bash
curl -i "https://on-this-day-x402.fly.dev/api/on-this-day?date=07-20"   # 402 + PAYMENT-REQUIRED
AGENT_KEY=0x… BASE=https://on-this-day-x402.fly.dev RPC_URL=https://ethereum-sepolia-rpc.publicnode.com \
  CURVY_BROADCASTER_URL=https://api3.curvy.box pnpm test:x402                # pays by curvy-transfer
```

`CURVY_CHECKOUT_ORIGIN` points at `https://app3.curvy.box/checkout`; Curvy does not yet document
its hosted checkout page, so treat the human rail on the demo as unverified and use the agent rail.

To run your own copy:

```bash
fly apps create <name> --org <org>
pnpm keys                                    # receiving keys + signer; keep the private halves offline
fly secrets set --app <name> CURVY_PUBLIC_S=… CURVY_PUBLIC_V=… CURVY_PUBLIC_BABYJUBJUB=… MERCHANT_SIGNER_PRIVATE_KEY=…
# edit app, MERCHANT_ORIGIN and the network values in fly.toml
fly deploy --ha=false                        # one machine: payments are in memory
```

## Tests

`pnpm test:x402` pays $0.01 per lookup over x402 as an agent (anvil account #1, funded by
minting the devnet token). It checks the 402, the paid 200 with `PAYMENT-RESPONSE`, that a
replayed `PAYMENT-SIGNATURE` is refused, and that the merchant's record reaches
`confirmed` with `netAmount` equal to gross minus the on-chain fees read from the vault.
It needs the portal broadcaster on `:4035` from `pnpm demo:payments` (which sets
`PORTAL_MIN_USD_VALUE=0.001`) and reads the vault address from it. No facilitator is needed: it
pays by `curvy-transfer`, and uses `exact` only when the service has `X402_FACILITATOR_URL` set.
Knobs: `BASE`, `RPC_URL`, `CURVY_BROADCASTER_URL`, `AGENT_KEY`. If the demo e2e has time-warped
Anvil, the test dates its authorization from the chain clock.

`pnpm test:e2e` pays for real on the local stack. It needs `pnpm demo:payments` running
(buyer driver :4034, broadcaster :4035) and stands in for the hosted checkout page:
it pays the portal, waits for the shield, and then drives both confirmation paths
(API bearer and browser cookie + return page). It also checks that a tx hash from one
payment can't unlock another and that a bundle buys exactly N lookups. The e2e needs a
bundle of at least $0.50 (e.g. `LOOKUPS_PER_PURCHASE=50`).

`test/min-amount-probe.ts <amounts…>` probes which checkout amounts the broadcaster accepts.
`test/no-txhash-probe.ts` checks confirmation through batch commitment alone (no `txHash`).

```bash
pnpm test:checkout-side   # decode + verifyPaymentIntent the way Curvy checkout does
```

The service is in-memory: payments are lost on restart.

The service depends on [`@0xcurvy/payments-sdk`](https://www.npmjs.com/package/@0xcurvy/payments-sdk) 0.1.1 from npm.
