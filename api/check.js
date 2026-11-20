'use strict';
/**
 * Vercel serverless entry point: POST /api/check
 *
 * Body: { "contract": "0x...", "function": "mint" | "mint(uint256)", "args": [...] }
 *   - contract: required, a BSC address
 *   - function: optional, a mint function name or full signature
 *   - args: optional, values for the function arguments (static types only:
 *     uint/int, address, bool, bytes32)
 *
 * Read-only: the handler only issues eth_getCode / eth_call and public
 * registry lookups. It never signs, never sends a transaction, and never
 * executes arbitrary calldata — calls are built only from ABI entries or
 * from an explicit user-supplied signature.
 */

const { checkContract } = require('../src/checker');

const MAX_BODY_BYTES = 8192;

function send(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, {});
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method_not_allowed', hint: 'POST a JSON body: {"contract":"0x...","function":"mint"}' });
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        send(res, 413, { error: 'body_too_large' });
        return;
      }
      chunks.push(chunk);
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch (_) {
      send(res, 400, { error: 'invalid_json' });
      return;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      send(res, 400, { error: 'invalid_body', hint: 'Expected a JSON object.' });
      return;
    }
    if (body.args !== undefined && (!Array.isArray(body.args) || body.args.length > 5)) {
      send(res, 400, { error: 'invalid_args', hint: 'args must be an array of at most 5 values.' });
      return;
    }
    const report = await checkContract(body);
    send(res, 200, report);
  } catch (err) {
    console.error('[check] error:', err);
    send(res, 502, {
      error: 'upstream_unavailable',
      detail: 'A required upstream service (BSC RPC or registry) could not be reached. Try again in a moment.',
    });
  }
};
