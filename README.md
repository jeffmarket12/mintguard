# MintGuard

A read-only pre-mint safety checker for BSC free-mint contracts. Paste a contract address, get a verdict on what can be checked from public data — **before** you sign anything.

Built for the [zkVerify Agent Games](https://agentgames.zkverify.io/) Wildcard track. Original code, written for this project. No API keys, no private keys, no signing, no transactions — ever.

## What it checks

`POST /api/check` with `{"contract": "0x...", "function": "mint", "args": [1]}`:

| Check | What it does |
|---|---|
| Contract code | `eth_getCode` via public BSC RPC — is anything deployed here? |
| Source verification | Sourcify v2 API — exact / partial / not verified |
| ABI | Retrieved from Sourcify when verified; lists the mint-like functions |
| Owner | `owner()` call — reports the owner address, or that ownership is renounced |
| Token metadata | `name()` / `symbol()` / `decimals()` / `totalSupply()` (read-only) |
| Mint simulation | `eth_call` of the requested mint function from a dummy sender, 0 value — reports success or the revert reason (including custom-error selectors, looked up on 4byte.directory) |

Every check reports what it **proves** and what it **does not prove**. The verdict is one of:

- `SAFE_TO_REVIEW` — verified source, mint path understood; still review it yourself
- `CAUTION` — something could not be verified, or the mint simulation reverts
- `HIGH_RISK` — no contract at the address, the mint function is missing, or an unverified mint path reverts

## Honest limits (read this)

- **A `SAFE_TO_REVIEW` verdict is not a safety guarantee.** Verified source can still contain a backdoor, a honeypot, or a rug pull. Verification proves the source matches the bytecode — not that it is honest.
- **A successful simulation does not mean a real mint will succeed.** The simulation uses a dummy sender and 0 value; a real mint uses your address (allowlist, per-wallet limits), may require payment, and runs against a later block.
- **A reverting simulation does not mean minting is impossible.** Common innocent causes: the mint window is closed, the dummy sender is not allowlisted, or the call needs a payment value.
- **"Not verified" means "not verified on Sourcify".** BscScan is not queried (it needs an API key), so a contract can be verified there but not here. The report says so.
- **The checker never sees your wallet.** It takes only a contract address and a function name. It cannot check what it cannot see: off-chain allowlists, website phishing, or social-engineering around a mint.

## Try it

Live demo: https://mintguard-virid.vercel.app/ (form + API)

```bash
curl -X POST https://mintguard-virid.vercel.app/api/check \
  -H 'content-type: application/json' \
  -d '{"contract":"0xdEAa9aaec224c7429dA2501b159aaf8D79019Ba3","function":"mint","args":[1]}'
```

`GET /api/health` returns `{"ok":true}`.

## Run locally

```bash
npm install
npm test        # unit tests + live checks against real BSC contracts
npm start       # local server on http://localhost:8788
```

## How it works

- `src/checker.js` — the check pipeline: parallel read-only calls, then function resolution, then simulation, then verdict.
- `src/rpc.js` — BSC JSON-RPC client with failover across public endpoints (no key).
- `src/sourcify.js` — Sourcify API v2 (match status + ABI in one call).
- `src/fourbyte.js` — 4byte.directory selector lookup (fallback hint only).
- `src/abi.js` — from-scratch ABI encoding/decoding (selectors, static args, return-data decoding, revert reasons). Dynamic argument types are refused rather than guessed.
- `api/check.js` / `api/health.js` — Vercel serverless entry points. `public/index.html` — the demo page.

Calls are built only from ABI entries or from an explicit user-supplied signature — the API never executes arbitrary calldata. Input is validated (address format, max 5 static args, 8 KB body cap).

## Why it exists

Free-mint season on BSC means a new contract every day, and the cost of a wrong mint is a drained wallet. The checks here are the same ones a careful human runs by hand — code present, source public, function exists, simulation clean — automated into one call that takes seconds and costs nothing. It does not replace judgment; it gives judgment better raw material.
