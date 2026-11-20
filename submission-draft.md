# MintGuard — Wildcard submission draft

Repo: https://github.com/jeffmarket12/mintguard
Live endpoint: https://mintguard-virid.vercel.app/api/check
Demo page: https://mintguard-virid.vercel.app/

## Title (75/100 chars)

```
MintGuard — a read-only pre-mint safety checker for BSC free-mint contracts
```

## What it does (1436/2000 chars)

```
MintGuard checks a BSC free-mint contract BEFORE you mint from it. POST a contract address (and optionally a mint function) to the public API and it returns a verdict — SAFE_TO_REVIEW, CAUTION, or HIGH_RISK — with a per-check report.

It runs six read-only checks, all against public data, with no API key and no wallet connection: (1) bytecode present at the address (eth_getCode); (2) source verification on Sourcify (exact / partial / none); (3) ABI retrieved and the requested mint function confirmed in it, with a 4byte.directory fallback for the selector; (4) owner() — reports the owner address or that ownership is renounced; (5) token metadata (name, symbol, decimals, totalSupply); (6) a static simulation (eth_call, 0 value, dummy sender) of the mint function, reporting success or the revert reason, including custom-error selectors.

Every check states what it proves and what it does NOT prove. A SAFE_TO_REVIEW verdict is not a safety guarantee: verified code can still hide a backdoor, a successful simulation does not promise a real mint will succeed, and a reverting simulation is often innocent (closed window, allowlist, payment needed). 'Not verified' means not verified on Sourcify — BscScan is not queried. MintGuard is a checker, not an executor: it never signs, never sends a transaction, and never executes arbitrary calldata — calls are built only from the verified ABI or an explicit user-supplied signature.
```

## Message to judges (554/1000 chars)

```
Built from the verification routine I run by hand before every free mint: code present, source public, function exists, simulation clean — automated into one call that takes seconds and costs nothing. The honest-limits design is deliberate: each check reports what it proves and what it does not, because a checker that over-promises is worse than no checker. Try it live on the demo page — Flaggies (verified, sold out) returns CAUTION with the revert shown; WBNB returns SAFE_TO_REVIEW. 100% original code; the only dependency is js-sha3 for keccak256.
```

## Test results (21 Nov 2026, ~01:00 WIB)

Local (`npm test`): 43 passed, 0 failed (13 unit + 30 live against real BSC contracts).
Live (https://mintguard-virid.vercel.app): health 200 {ok:true}; homepage 200; Flaggies+mint → CAUTION with revert 0x589ed34b; WBNB → SAFE_TO_REVIEW; Bagent Vault (unverified) → CAUTION. Warm response ~1s.
