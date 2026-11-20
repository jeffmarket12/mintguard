'use strict';
/**
 * MintGuard tests — run with `npm test`.
 *
 * Two parts:
 *   1. Unit tests for the ABI helpers (no network).
 *   2. Live checks against real BSC contracts (needs internet + public RPC).
 *      Fixtures are real contracts, chosen because their state is stable:
 *        - Flaggies NFT (verified, sold out) — mint simulation reverts.
 *        - WBNB (verified ERC-20) — metadata + a succeeding simulation.
 *        - Bagent Vault (NOT verified on Sourcify) — the unverified case.
 *        - An EOA (the Agent Games prize wallet) — the no-code case.
 *
 * A test failure here means the checker misread live chain data — investigate
 * before deploying.
 */

const abi = require('../src/abi');
const { checkContract } = require('../src/checker');

const FLAGGIES = '0xdEAa9aaec224c7429dA2501b159aaf8D79019Ba3';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const BAGENT_VAULT = '0x80CABb78d05205Bb0f7C395ec6326Bf1890E7a00';
const EOA = '0xe1471e72ABf750846FD4828fc0Ddd1Be0C30336F';
const DUMMY = '0x000000000000000000000000000000000000dEaD';

let passed = 0;
let failed = 0;
const failures = [];

function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function getCheck(report, id) {
  return (report.checks || []).find((c) => c.id === id);
}

async function unitTests() {
  console.log('== unit: abi helpers ==');
  ok(abi.selector('mint(uint256)') === '0xa0712d68', 'selector mint(uint256) = 0xa0712d68');
  ok(abi.selector('mint(address,uint256)') === '0x40c10f19', 'selector mint(address,uint256) = 0x40c10f19');
  ok(abi.selector('owner()') === '0x8da5cb5b', 'selector owner() = 0x8da5cb5b');
  ok(abi.selector('transfer(address,uint256)') === '0xa9059cbb', 'selector transfer(address,uint256)');
  ok(abi.isAddress(WBNB) && !abi.isAddress('0x1234') && !abi.isAddress('not an address'),
    'isAddress validation');
  const call = abi.encodeCall('mint(uint256)', [1]);
  ok(call === '0xa0712d68' + '0'.repeat(63) + '1', 'encodeCall mint(uint256) [1]');
  ok(abi.decodeUintWord('0x' + '0'.repeat(62) + 'ff') === '255', 'decodeUintWord');
  ok(abi.decodeAddressWord('0x' + '0'.repeat(24) + 'bb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'.toLowerCase())
    === WBNB.toLowerCase(), 'decodeAddressWord');
  ok(abi.decodeString('0x' + '0'.repeat(62) + '20' + '0'.repeat(62) + '05' + Buffer.from('Flaggies').toString('hex').slice(0, 10)) === 'Flagg',
    'decodeString (short string)');
  // Error(string) revert reason: 0x08c379a0 + offset + length + "SoldOut"
  const reasonHex = '0x08c379a0'
    + '0'.repeat(62) + '20'
    + '0'.repeat(62) + '07'
    + Buffer.from('SoldOut').toString('hex').padEnd(64, '0');
  ok(abi.decodeRevertReason(reasonHex) === 'SoldOut', 'decodeRevertReason Error(string)');
  ok(abi.decodeRevertReason('0x589ed34b') === null, 'decodeRevertReason ignores custom errors');
  ok(abi.abiSignature({ name: 'mint', inputs: [{ type: 'uint256' }] }) === 'mint(uint256)',
    'abiSignature');
  let threw = false;
  try { abi.encodeCall('mint(string)', ['x']); } catch (_) { threw = true; }
  ok(threw, 'encodeCall refuses dynamic types');
}

async function liveTests() {
  console.log('== live: Flaggies (verified) + mint(1) — reverting mint ==');
  let r = await checkContract({ contract: FLAGGIES, function: 'mint', args: [1] });
  ok(r.verdict === 'CAUTION', 'Flaggies mint verdict is CAUTION', `got ${r.verdict}`);
  ok(getCheck(r, 'has_code').status === 'pass', 'Flaggies has_code pass');
  ok(getCheck(r, 'sourcify').status === 'pass', 'Flaggies sourcify pass (exact)');
  ok(getCheck(r, 'abi').status === 'pass', 'Flaggies abi pass');
  ok(getCheck(r, 'mint_function').status === 'pass', 'Flaggies mint(uint256) found in ABI');
  ok(getCheck(r, 'mint_simulation').status === 'warn', 'Flaggies mint simulation reverts (sold out)');
  ok(/589ed34b/.test(getCheck(r, 'mint_simulation').detail), 'Flaggies revert data shown');
  ok(/Flaggies/.test(getCheck(r, 'token_metadata').detail), 'Flaggies name decoded');
  ok(/5555/.test(getCheck(r, 'token_metadata').detail), 'Flaggies totalSupply 5555');
  ok(/renounced/.test(getCheck(r, 'owner').detail), 'Flaggies owner renounced');

  console.log('== live: WBNB (verified ERC-20), no function ==');
  r = await checkContract({ contract: WBNB });
  ok(r.verdict === 'SAFE_TO_REVIEW', 'WBNB verdict is SAFE_TO_REVIEW', `got ${r.verdict}`);
  ok(/Wrapped BNB/.test(getCheck(r, 'token_metadata').detail), 'WBNB name decoded');
  ok(/WBNB/.test(getCheck(r, 'token_metadata').detail), 'WBNB symbol decoded');
  ok(/decimals: 18/.test(getCheck(r, 'token_metadata').detail), 'WBNB decimals 18');
  ok(getCheck(r, 'mint_simulation').status === 'skip', 'WBNB simulation skipped without function');

  console.log('== live: WBNB + balanceOf(dummy) — succeeding simulation ==');
  r = await checkContract({ contract: WBNB, function: 'balanceOf', args: [DUMMY] });
  ok(getCheck(r, 'mint_function').status === 'pass', 'WBNB balanceOf found in ABI');
  ok(getCheck(r, 'mint_simulation').status === 'pass', 'WBNB balanceOf simulation succeeds');
  ok(r.verdict === 'SAFE_TO_REVIEW', 'WBNB balanceOf verdict SAFE_TO_REVIEW', `got ${r.verdict}`);

  console.log('== live: Bagent Vault (unverified), no function ==');
  r = await checkContract({ contract: BAGENT_VAULT });
  ok(getCheck(r, 'has_code').status === 'pass', 'Vault has_code pass');
  ok(getCheck(r, 'sourcify').status === 'warn', 'Vault sourcify warn (not verified)');
  ok(r.verdict === 'CAUTION', 'Vault verdict is CAUTION', `got ${r.verdict}`);

  console.log('== live: Bagent Vault + claimAirdrop(uint256) — blind probe on unverified ==');
  r = await checkContract({ contract: BAGENT_VAULT, function: 'claimAirdrop(uint256)', args: [0] });
  ok(getCheck(r, 'mint_function').status === 'warn', 'Vault claimAirdrop resolved as blind probe (not in ABI)');
  ok(['warn', 'pass'].includes(getCheck(r, 'mint_simulation').status), 'Vault simulation ran');
  ok(['HIGH_RISK', 'CAUTION'].includes(r.verdict), 'Vault blind-probe verdict is HIGH_RISK or CAUTION', `got ${r.verdict}`);

  console.log('== live: EOA (no code) ==');
  r = await checkContract({ contract: EOA });
  ok(getCheck(r, 'has_code').status === 'fail', 'EOA has_code fail');
  ok(r.verdict === 'HIGH_RISK', 'EOA verdict is HIGH_RISK', `got ${r.verdict}`);

  console.log('== live: invalid address ==');
  r = await checkContract({ contract: '0x1234' });
  ok(getCheck(r, 'input').status === 'fail', 'invalid address rejected');
  ok(r.verdict === 'HIGH_RISK', 'invalid address verdict is HIGH_RISK', `got ${r.verdict}`);

  console.log('== live: Flaggies + nonexistent function ==');
  r = await checkContract({ contract: FLAGGIES, function: 'doesNotExist' });
  ok(getCheck(r, 'mint_function').status === 'fail', 'nonexistent function fails');
  ok(r.verdict === 'HIGH_RISK', 'nonexistent function verdict is HIGH_RISK', `got ${r.verdict}`);
}

(async () => {
  const t0 = Date.now();
  await unitTests();
  await liveTests();
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s) ===`);
  if (failed > 0) {
    console.log('Failures:', failures.join('; '));
    process.exit(1);
  }
})().catch((err) => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
