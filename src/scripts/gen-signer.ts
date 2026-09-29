/**
 * DEV ONLY: generate a request-signing key and throwaway Curvy receiving keys
 * for a local chain. docs.curvy.box does not document how a merchant obtains
 * their public S / V / BabyJubjub keys, so for local testing we derive them
 * straight from @0xcurvy/rs-core-wasm. In production, use keys exported from
 * your real Curvy account and keep the private halves offline.
 */
import { readFile } from "node:fs/promises";
import init, { new_meta, pubFromPrivateKey } from "@0xcurvy/rs-core-wasm/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const wasm = await readFile(new URL(import.meta.resolve("@0xcurvy/rs-core-wasm/core/curvy_wasm_bg.wasm")));
await init({ module_or_path: wasm });

const [k, v, K, V] = new_meta();
const bjj = pubFromPrivateKey(k);
const signerKey = generatePrivateKey();

console.log(`# --- public (safe on the server) ---
CURVY_PUBLIC_S=${K}
CURVY_PUBLIC_V=${V}
CURVY_PUBLIC_BABYJUBJUB=${bjj.join(".")}
MERCHANT_SIGNER_PRIVATE_KEY=${signerKey}
# signer address: ${privateKeyToAccount(signerKey).address}
# --- PRIVATE receiving keys: keep offline, NOT in the server env ---
# k=${k}
# v=${v}`);
