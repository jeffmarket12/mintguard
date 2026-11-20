'use strict';
/**
 * 4byte.directory lookup — maps a 4-byte function selector to known
 * signatures. No API key needed. Used only as a fallback hint when a
 * contract has no verified ABI: a known selector tells you the function
 * name other projects use for those bytes, nothing more.
 */

const FETCH_TIMEOUT_MS = 5000;

/** Returns an array of known text signatures for a selector, or []. */
async function lookupSelector(selectorHex) {
  const sel = String(selectorHex).toLowerCase().replace(/^0x/, '');
  const url = `https://www.4byte.directory/api/v1/signatures/?hex_signature=0x${sel}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const json = await res.json();
  return (json.results || []).map((r) => r.text_signature).filter(Boolean);
}

module.exports = { lookupSelector };
