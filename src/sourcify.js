'use strict';
/**
 * Sourcify helpers (https://sourcify.dev) — no API key needed.
 * Uses the Sourcify API v2 (v1 was removed):
 *   GET /server/v2/contract/{chainId}/{address}?fields=abi
 * returns both the match status and the ABI in one call. A 404 means the
 * contract is not verified on Sourcify.
 *
 *   fetchContract(address) -> { status: "exact"|"partial"|"none",
 *                               abi: [...]|null }
 *   (throws on transport failure — the caller reports status "unknown")
 *
 * Sourcify is the source of truth for "is this contract's source public and
 * does it match the deployed bytecode". An exact match means the published
 * source compiles to exactly the deployed bytecode; partial means the
 * metadata hash differs (usually only metadata, but the source is still the
 * best available evidence). "none" means the source was never published to
 * Sourcify — the contract could still be verified on BscScan, which this
 * checker does NOT query (BscScan needs an API key), and the report says so.
 */

const CHAIN_ID = 56;
const FETCH_TIMEOUT_MS = 6000;
const USER_AGENT = 'MintGuard/1.0 (https://github.com/jeffmarket12/mintguard)';

function mapMatch(match) {
  // The v2 API returns "match"/"exact_match" (and "partial"/"partial_match")
  // depending on when the contract was verified — accept both spellings.
  if (match === 'match' || match === 'exact_match') return 'exact';
  if (match === 'partial' || match === 'partial_match') return 'partial';
  return 'none';
}

async function fetchContract(address) {
  const url = `https://sourcify.dev/server/v2/contract/${CHAIN_ID}/${address}?fields=abi`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404) return { status: 'none', abi: null };
  if (!res.ok) throw new Error(`HTTP ${res.status} from Sourcify`);
  const json = await res.json();
  const abi = Array.isArray(json.abi) && json.abi.length > 0 ? json.abi : null;
  return { status: mapMatch(json.match), abi };
}

module.exports = { fetchContract, CHAIN_ID };
