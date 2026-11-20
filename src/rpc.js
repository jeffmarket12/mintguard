'use strict';
/**
 * Minimal BSC JSON-RPC client with failover across public endpoints.
 * Read-only: only eth_getCode and eth_call are used. No API key needed.
 */

const RPC_URLS = [
  'https://bsc-dataseed.binance.org/',
  'https://bsc-dataseed1.defibit.io/',
  'https://bsc-dataseed1.ninicoin.io/',
  'https://bsc-rpc.publicnode.com',
];

const FETCH_TIMEOUT_MS = 8000;

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/**
 * Send one JSON-RPC request, trying each public endpoint in turn until one
 * answers. Throws the last error if every endpoint fails.
 */
async function rpc(method, params) {
  let lastError = null;
  for (const url of RPC_URLS) {
    try {
      const json = await postJson(url, {
        jsonrpc: '2.0',
        id: 1,
        method,
        params,
      });
      if (json.error) {
        // A JSON-RPC error is a real answer from the chain (e.g. a revert on
        // eth_call), not a transport failure — surface it to the caller.
        const err = new Error(json.error.message || 'JSON-RPC error');
        err.code = json.error.code;
        err.data = json.error.data;
        throw err;
      }
      return json.result;
    } catch (err) {
      // JSON-RPC errors (with .code) are answers, not transport failures.
      if (err && typeof err.code === 'number') throw err;
      lastError = err;
    }
  }
  throw lastError || new Error('all BSC RPC endpoints failed');
}

/** Bytecode at an address ("0x" means no code — an EOA or empty account). */
async function getCode(address) {
  return rpc('eth_getCode', [address, 'latest']);
}

/**
 * Static call. Returns the raw hex result on success. On revert, throws an
 * Error with .data set to the revert data (when the node returns it).
 */
async function ethCall({ from, to, data }) {
  return rpc('eth_call', [{ from, to, data, value: '0x0' }, 'latest']);
}

module.exports = { rpc, getCode, ethCall, RPC_URLS };
