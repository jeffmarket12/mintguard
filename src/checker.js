'use strict';
/**
 * MintGuard checker — the core logic. Pure Node.js, no framework, so the
 * same code runs on Vercel and in local tests.
 *
 * A check is a read-only investigation of a BSC contract BEFORE someone
 * mints from it. Every check reports:
 *   status  pass | warn | fail | info | skip | error
 *   detail  what was observed, in plain words
 *   proves  what this observation actually establishes
 *   doesNotProve  what it does NOT establish (honesty is the point)
 *
 * Verdicts (labels, not guarantees):
 *   SAFE_TO_REVIEW  verified source + mint path understood; still review it
 *   CAUTION         something could not be verified or the mint path failed
 *   HIGH_RISK       no contract at the address, or the mint function is
 *                   missing / the unverified mint path reverts
 *
 * A SAFE_TO_REVIEW verdict is NOT a promise that minting is safe. It means
 * the checks we could run did not find a problem. Read the README.
 */

const abi = require('./abi');
const rpc = require('./rpc');
const sourcify = require('./sourcify');
const fourbyte = require('./fourbyte');

const DUMMY_SENDER = '0x000000000000000000000000000000000000dEaD';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const DISCLAIMER =
  'MintGuard is a read-only pre-mint checker. It inspects public on-chain ' +
  'data and public source registries; it cannot guarantee that minting is ' +
  'safe, that a contract is honest, or that a mint will succeed. Always ' +
  'review the verified source yourself before signing anything.';

/** Wrap a promise so failures become data instead of exceptions. */
async function settled(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function check(id, label, status, detail, proves, doesNotProve) {
  return { id, label, status, detail, proves, doesNotProve };
}

/** Try to decode a token name/symbol: ABI string first, bytes32 fallback. */
function decodeNameLike(hex) {
  try {
    const s = abi.decodeString(hex);
    if (s) return s;
  } catch (_) { /* fall through to bytes32 */ }
  try {
    const h = String(hex).replace(/^0x/, '');
    const raw = Buffer.from(h.slice(0, 64), 'hex');
    const s = raw.toString('utf8').replace(/\0+$/, '');
    if (s && /^[\x20-\x7e]+$/.test(s)) return s;
  } catch (_) { /* no usable decoding */ }
  return null;
}

function isMintLike(fn) {
  if (!fn || fn.type !== 'function') return false;
  if (fn.stateMutability === 'view' || fn.stateMutability === 'pure') return false;
  return /mint|claim/i.test(fn.name || '');
}

/**
 * Resolve a user-supplied function reference against an ABI.
 * fnInput: "mint" (name) or "mint(uint256)" (full signature).
 * Returns { signature, fromAbi } or { error }.
 */
function resolveFunction(fnInput, abiArray) {
  const input = String(fnInput).trim();
  const isFull = input.includes('(');
  if (isFull) {
    try {
      abi.parseSignatureTypes(input);
    } catch (err) {
      return { error: `invalid function signature: ${input}` };
    }
    const fromAbi = (abiArray || []).some(
      (fn) => fn.type === 'function' && abi.abiSignature(fn) === input,
    );
    return { signature: input, fromAbi };
  }
  // Bare name: look it up in the ABI.
  const matches = (abiArray || []).filter(
    (fn) => fn.type === 'function' && fn.name === input,
  );
  if (matches.length === 0) return { error: `function "${input}" not found in the contract ABI` };
  // Prefer the overload with the fewest inputs (simplest mint path).
  matches.sort((a, b) => (a.inputs || []).length - (b.inputs || []).length);
  return { signature: abi.abiSignature(matches[0]), fromAbi: true };
}

/**
 * Run the full check. Input: { contract, function?, args? }.
 * Returns the report object (never throws for bad input — returns a report
 * with verdict HIGH_RISK and an error check instead, except when the BSC
 * RPC itself is unreachable, which throws).
 */
async function checkContract(input) {
  const contract = String((input && input.contract) || '').trim();
  const fnInput = input && input.function ? String(input.function).trim() : null;
  const args = (input && Array.isArray(input.args)) ? input.args : [];
  const checks = [];
  const startedAt = new Date().toISOString();

  if (!abi.isAddress(contract)) {
    return {
      contract, chainId: 56, chain: 'BSC', function: fnInput,
      verdict: 'HIGH_RISK',
      verdictExplanation: 'The supplied address is not a valid BSC address, so nothing could be checked.',
      checks: [check('input', 'Address format', 'fail',
        `"${contract}" is not a valid 0x address (40 hex characters).`,
        'Nothing — the input itself was invalid.',
        'Anything about any contract.')],
      disclaimer: DISCLAIMER, checkedAt: startedAt,
    };
  }

  // ---- Batch 1: independent reads, all in parallel. ----
  // Sourcify is a single call returning both match status and ABI.
  const [
    codeR, sourR,
    ownerR, nameR, symbolR, decimalsR, supplyR,
  ] = await Promise.all([
    settled(rpc.getCode(contract)),
    settled(sourcify.fetchContract(contract)),
    settled(rpc.ethCall({ from: DUMMY_SENDER, to: contract, data: abi.selector('owner()') })),
    settled(rpc.ethCall({ from: DUMMY_SENDER, to: contract, data: abi.selector('name()') })),
    settled(rpc.ethCall({ from: DUMMY_SENDER, to: contract, data: abi.selector('symbol()') })),
    settled(rpc.ethCall({ from: DUMMY_SENDER, to: contract, data: abi.selector('decimals()') })),
    settled(rpc.ethCall({ from: DUMMY_SENDER, to: contract, data: abi.selector('totalSupply()') })),
  ]);

  if (!codeR.ok) {
    // Without the chain we cannot say anything at all.
    throw new Error(`BSC RPC unreachable: ${codeR.error.message}`);
  }
  const hasCode = codeR.value !== '0x' && codeR.value !== '0x0' && codeR.value.length > 2;
  const codeSize = hasCode ? (codeR.value.length - 2) / 2 : 0;

  checks.push(check('has_code', 'Contract code on BSC',
    hasCode ? 'pass' : 'fail',
    hasCode
      ? `Bytecode present (${codeSize} bytes).`
      : 'No bytecode at this address — it is an externally owned account (EOA) or an empty address, not a contract.',
    hasCode ? 'Something is deployed at this address.' : 'There is no contract here to mint from.',
    'Whether the code is honest, safe, or what it claims to be.'));

  // Sourcify status + ABI (one call; on transport failure both are unknown).
  const sourcifyStatus = sourR.ok ? sourR.value.status : 'unknown';
  const abiArray = sourR.ok ? sourR.value.abi : null;
  const verified = sourcifyStatus === 'exact' || sourcifyStatus === 'partial';
  checks.push(check('sourcify', 'Source verification (Sourcify)',
    sourcifyStatus === 'exact' ? 'pass'
    : sourcifyStatus === 'partial' ? 'pass'
    : sourcifyStatus === 'unknown' ? 'error' : 'warn',
    sourcifyStatus === 'exact' ? 'Exact match: the published source compiles to exactly the deployed bytecode.'
    : sourcifyStatus === 'partial' ? 'Partial match: the published source matches except for metadata (usually harmless, but not byte-identical).'
    : sourcifyStatus === 'unknown' ? `Sourcify could not be reached (${sourR.error.message}). Verification status is unknown, not "unverified".`
    : 'Not verified on Sourcify: no published source matches this bytecode. (BscScan is not queried — a contract can be verified there but not on Sourcify.)',
    sourcifyStatus === 'exact' ? 'You can read the exact source that is running on-chain.'
    : sourcifyStatus === 'partial' ? 'You can read source that matches the deployed code except for metadata.'
    : 'Nothing — the status could not be established.',
    'That the source is honest. Verified code can still contain a rug pull, a backdoor, or a honeypot. Verification proves the source matches the bytecode, not that it is safe.'));

  // ABI availability.
  checks.push(check('abi', 'ABI available',
    abiArray ? 'pass' : (sourcifyStatus === 'unknown' ? 'error' : verified ? 'error' : 'warn'),
    abiArray
      ? `ABI retrieved from Sourcify (${abiArray.filter((f) => f.type === 'function').length} functions).`
      : sourcifyStatus === 'unknown'
        ? 'No ABI: Sourcify could not be reached, so the function list is unknown (not "absent").'
        : verified
          ? 'Contract is verified but its ABI could not be retrieved from Sourcify right now.'
          : 'No ABI: without verified source there is no public function list to inspect.',
    abiArray ? 'The contract\'s public functions can be listed and inspected.' : 'Nothing — no function list is available.',
    'What the functions do internally. An ABI lists names and types, not behaviour.'));

  // Mint-like functions found in the ABI (informational).
  if (abiArray) {
    const candidates = abiArray.filter(isMintLike).map((fn) => abi.abiSignature(fn));
    checks.push(check('mint_candidates', 'Mint-like functions in ABI',
      candidates.length > 0 ? 'info' : 'info',
      candidates.length > 0
        ? `Found: ${candidates.join(', ')}.`
        : 'No function with "mint" or "claim" in its name. The mint entry point may have a different name, or this contract may not be a mint.',
      candidates.length > 0 ? 'Which functions look like mint entry points.' : 'That no mint exists — the name filter is only a heuristic.',
      'Whether any of these functions is safe to call, or what they charge.'));
  }

  // Owner.
  let owner = null;
  let ownerKnown = false;
  if (ownerR.ok) {
    try {
      owner = abi.decodeAddressWord(ownerR.value);
      ownerKnown = true;
    } catch (_) { /* undecodable owner() response */ }
  }
  checks.push(check('owner', 'Contract owner',
    !ownerKnown ? 'info'
    : owner === ZERO_ADDRESS ? 'pass' : 'info',
    !ownerKnown ? 'No owner() response — the contract has no owner() function, or the call failed.'
    : owner === ZERO_ADDRESS ? 'owner() returns the zero address — ownership is renounced.'
    : `owner() returns ${owner}.`,
    ownerKnown && owner !== ZERO_ADDRESS
      ? 'One address controls the owner-only functions (if any).'
      : ownerKnown ? 'Nobody holds the owner role.' : 'Nothing about ownership.',
    'What the owner can do. Only the source (if verified) shows which functions are owner-only.'));

  // Token metadata.
  const meta = {};
  if (nameR.ok) { const v = decodeNameLike(nameR.value); if (v) meta.name = v; }
  if (symbolR.ok) { const v = decodeNameLike(symbolR.value); if (v) meta.symbol = v; }
  if (decimalsR.ok) { try { meta.decimals = Number(abi.decodeUintWord(decimalsR.value)); } catch (_) {} }
  if (supplyR.ok) { try { meta.totalSupply = abi.decodeUintWord(supplyR.value); } catch (_) {} }
  const metaKeys = Object.keys(meta);
  checks.push(check('token_metadata', 'Token metadata (name / symbol / decimals / supply)',
    metaKeys.length > 0 ? 'info' : 'info',
    metaKeys.length > 0
      ? metaKeys.map((k) => `${k}: ${meta[k]}`).join('; ')
      : 'No ERC-20/ERC-721 metadata functions responded. This may be a non-token contract, or metadata may be implemented differently.',
    metaKeys.length > 0 ? 'The token identifies itself this way on-chain.' : 'Nothing — metadata is absent or unreadable.',
    'That the token is legitimate. Name and symbol are free text anyone can set.'));

  // ---- Function resolution + simulation (only when a function is asked for). ----
  let resolved = null;
  let simulation = null;
  if (fnInput) {
    const res = resolveFunction(fnInput, abiArray);
    if (res.error) {
      const whyNoAbi = abiArray ? ''
        : sourcifyStatus === 'unknown'
          ? ' (No ABI is available because Sourcify could not be reached right now — retry the check, or try a full signature like "mint(uint256)".)'
          : sourcifyStatus === 'none'
            ? ' (No ABI is available because the contract is not verified on Sourcify — try a full signature like "mint(uint256)".)'
            : ' (The ABI could not be retrieved — retry the check.)';
      checks.push(check('mint_function', 'Requested mint function',
        'fail', res.error + whyNoAbi,
        'That the requested function could not be confirmed to exist.',
        'That no mint function exists under a different name or signature.'));
    } else {
      resolved = res;
      let detail = `Resolved to ${res.signature}${res.fromAbi ? ' (found in the verified ABI).' : ' (NOT in the verified ABI — the signature was supplied by you, so the call below is a blind probe).'}`;
      // 4byte hint when the signature is not from the ABI.
      if (!res.fromAbi) {
        const sel = abi.selector(res.signature);
        const known = await settled(fourbyte.lookupSelector(sel));
        if (known.ok && known.value.length > 0) {
          detail += ` 4byte.directory knows this selector as: ${known.value.slice(0, 3).join(', ')}.`;
        } else {
          detail += ' 4byte.directory has no record of this selector.';
        }
      }
      checks.push(check('mint_function', 'Requested mint function',
        res.fromAbi ? 'pass' : 'warn', detail,
        res.fromAbi ? 'The function exists in the verified source.' : 'Only that these 4 bytes are (or are not) a known signature elsewhere.',
        'What the function does when called, or what it costs.'));

      // Simulate the call from a dummy sender, 0 value.
      try {
        const data = abi.encodeCall(res.signature, args);
        const sim = await settled(rpc.ethCall({ from: DUMMY_SENDER, to: contract, data }));
        if (sim.ok) {
          simulation = { success: true, returnData: sim.value };
          checks.push(check('mint_simulation', 'Mint simulation (eth_call, 0 value, dummy sender)',
            'pass',
            `Static call succeeded (returned ${(sim.value.length - 2) / 2} bytes).`,
            'That this exact call, from a dummy sender with 0 value, does not revert right now.',
            'That a real mint will succeed. A real mint uses YOUR address (allowlist, per-wallet limits), may require payment, and runs against a later block. A successful static call is a weak signal, not a green light.'));
        } else {
          const rawData = sim.error && sim.error.data ? String(sim.error.data) : '';
          const reason = rawData ? abi.decodeRevertReason(rawData) : null;
          let detail;
          if (reason) {
            detail = `Static call reverted: "${reason}".`;
          } else if (/^0x[0-9a-fA-F]{8}$/.test(rawData)) {
            // 4-byte custom error selector — try to name it via 4byte.directory.
            const known = await settled(fourbyte.lookupSelector(rawData));
            const name = known.ok && known.value.length > 0 ? known.value[0] : null;
            detail = name
              ? `Static call reverted with custom error ${name} (${rawData}).`
              : `Static call reverted with custom error ${rawData} (no human-readable reason; the 4-byte selector identifies the error in the contract source).`;
          } else if (rawData) {
            detail = `Static call reverted (revert data: ${rawData.slice(0, 18)}…).`;
          } else {
            detail = 'Static call reverted (no revert data returned by the node).';
          }
          simulation = { success: false, reason: reason || rawData || 'revert' };
          checks.push(check('mint_simulation', 'Mint simulation (eth_call, 0 value, dummy sender)',
            'warn', detail,
            'That this exact call, from a dummy sender with 0 value, reverts right now.',
            'That minting is impossible. Common innocent causes: the mint window is closed, the dummy sender is not allowlisted, the call needs a payment value, or the arguments are wrong.'));
        }
      } catch (err) {
        checks.push(check('mint_simulation', 'Mint simulation (eth_call, 0 value, dummy sender)',
          'error', `Could not build the call: ${err.message}`,
          'Nothing — the simulation never ran.',
          'Anything about the mint.'));
      }
    }
  } else {
    checks.push(check('mint_simulation', 'Mint simulation',
      'skip', 'No function was supplied, so no call was simulated. Pass "function" (e.g. "mint" or "mint(uint256)") to simulate a mint.',
      'Nothing — no simulation ran.',
      'Anything about any mint path.'));
  }

  // ---- Verdict ----
  let verdict = 'SAFE_TO_REVIEW';
  let verdictExplanation = '';
  const functionRequested = Boolean(fnInput);
  const functionMissing = functionRequested && !resolved;
  const simulationReverted = simulation && simulation.success === false;

  if (!hasCode) {
    verdict = 'HIGH_RISK';
    verdictExplanation = 'There is no contract at this address — there is nothing to mint from.';
  } else if (functionMissing && abiArray) {
    verdict = 'HIGH_RISK';
    verdictExplanation = 'The requested mint function is not in the verified ABI — the mint you plan to call does not exist on this contract.';
  } else if (functionMissing && sourcifyStatus === 'none') {
    verdict = 'HIGH_RISK';
    verdictExplanation = 'The contract source is not public and the requested mint function could not be confirmed to exist.';
  } else if (sourcifyStatus === 'unknown') {
    verdict = 'CAUTION';
    verdictExplanation = 'Sourcify could not be reached, so the verification status and mint path could not be confirmed. Retry the check before deciding.';
  } else if (!verified && simulationReverted) {
    verdict = 'HIGH_RISK';
    verdictExplanation = 'The contract source is not public AND the mint simulation reverts — there is no way to inspect what the mint would do.';
  } else if (!verified) {
    verdict = 'CAUTION';
    verdictExplanation = 'The contract source is not verified on Sourcify, so its behaviour cannot be inspected. Proceed only after independent review.';
  } else if (simulationReverted) {
    verdict = 'CAUTION';
    verdictExplanation = 'The mint simulation reverts. This is often innocent (closed window, allowlist, payment needed), but the mint path is not confirmed working.';
  } else if (!abiArray) {
    verdict = 'CAUTION';
    verdictExplanation = 'No ABI could be retrieved, so the mint path could not be fully inspected.';
  } else {
    verdict = 'SAFE_TO_REVIEW';
    verdictExplanation = functionRequested
      ? 'Verified source, mint function found, and the simulation succeeds. Review the source yourself before signing — this is a starting point, not a safety guarantee.'
      : 'Verified source with bytecode present. No mint function was simulated — supply "function" to check a specific mint path.';
  }

  return {
    contract: contract.toLowerCase(),
    chainId: 56,
    chain: 'BSC',
    function: resolved ? resolved.signature : fnInput,
    verdict,
    verdictExplanation,
    checks,
    disclaimer: DISCLAIMER,
    checkedAt: startedAt,
  };
}

module.exports = { checkContract, DUMMY_SENDER, DISCLAIMER };
