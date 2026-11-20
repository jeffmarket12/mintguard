'use strict';
/**
 * Minimal ABI helpers for MintGuard — written from scratch for this project.
 *
 * Only what a read-only checker needs:
 *   - function selectors (keccak256 of the canonical signature)
 *   - encoding of static argument types (uint/int, address, bool, bytes32)
 *   - decoding of eth_call return data (address, uint, bool, string)
 *   - decoding of Solidity Error(string) revert reasons
 *
 * Dynamic types (string, bytes, arrays) are NOT supported as call arguments:
 * the checker refuses them rather than guessing an encoding.
 */

const { keccak256 } = require('js-sha3');

const WORD_HEX = 64; // 32 bytes, as hex chars

function strip0x(s) {
  return String(s).startsWith('0x') ? String(s).slice(2) : String(s);
}

function isAddress(s) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(s || ''));
}

/** 4-byte selector of a canonical signature, e.g. "mint(uint256)" -> "0x40c10f19". */
function selector(signature) {
  return '0x' + keccak256(signature).slice(0, 8);
}

function padLeft(hex, len = WORD_HEX) {
  return String(hex).padStart(len, '0');
}

function padRight(hex, len = WORD_HEX) {
  return String(hex).padEnd(len, '0');
}

function encodeUint(value) {
  const n = BigInt(value); // throws on non-numeric input
  if (n < 0n) throw new Error('uint value must not be negative');
  return padLeft(n.toString(16));
}

function encodeInt(value) {
  const n = BigInt(value);
  if (n >= 0n) return padLeft(n.toString(16));
  // two's complement
  const mod = 1n << 256n;
  return padLeft((mod + n).toString(16));
}

function encodeAddress(value) {
  if (!isAddress(value)) throw new Error(`not an address: ${value}`);
  return padLeft(strip0x(value).toLowerCase());
}

function encodeBool(value) {
  if (value === true || value === 'true' || value === 1 || value === '1') return padLeft('1');
  if (value === false || value === 'false' || value === 0 || value === '0') return padLeft('0');
  throw new Error(`not a boolean: ${value}`);
}

function encodeBytes32(value) {
  const hex = strip0x(value);
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error(`not bytes32: ${value}`);
  return padRight(hex.toLowerCase());
}

/**
 * Encode one argument of a static ABI type. Returns 64 hex chars (no 0x).
 * Throws on dynamic types (string, bytes, arrays) and on bad values.
 */
function encodeArg(type, value) {
  const t = String(type).trim();
  if (/^uint(\d*)$/.test(t)) return encodeUint(value);
  if (/^int(\d*)$/.test(t)) return encodeInt(value);
  if (t === 'address') return encodeAddress(value);
  if (t === 'bool') return encodeBool(value);
  if (t === 'bytes32') return encodeBytes32(value);
  throw new Error(`unsupported argument type (dynamic types not supported): ${t}`);
}

/** Build calldata for a function signature + argument values. */
function encodeCall(signature, args) {
  const types = parseSignatureTypes(signature);
  if (types.length !== (args || []).length) {
    throw new Error(`argument count mismatch for ${signature}: expected ${types.length}, got ${(args || []).length}`);
  }
  const words = types.map((t, i) => encodeArg(t, args[i]));
  return selector(signature) + words.join('');
}

/** Extract parameter types from "name(type1,type2)". */
function parseSignatureTypes(signature) {
  const m = String(signature).trim().match(/^[A-Za-z_][A-Za-z0-9_]*\((.*)\)$/);
  if (!m) throw new Error(`not a function signature: ${signature}`);
  const inner = m[1].trim();
  if (inner === '') return [];
  // Simple split is safe here: we only support static types (no tuples).
  return inner.split(',').map((s) => s.trim());
}

/** Extract the function name from "name(...)" or a bare name. */
function parseSignatureName(signature) {
  const m = String(signature).trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  if (!m) throw new Error(`not a function name: ${signature}`);
  return m[1];
}

/** Canonical signature of an ABI function entry, e.g. "mint(uint256)". */
function abiSignature(fn) {
  const types = (fn.inputs || []).map((i) => i.type).join(',');
  return `${fn.name}(${types})`;
}

/** Decode a single 32-byte word as an address (last 20 bytes). */
function decodeAddressWord(hex) {
  const h = strip0x(hex);
  if (h.length < 64) throw new Error('short return data for address');
  return '0x' + h.slice(24, 64).toLowerCase();
}

/** Decode a single 32-byte word as an unsigned integer (decimal string). */
function decodeUintWord(hex) {
  const h = strip0x(hex);
  if (h.length < 64) throw new Error('short return data for uint');
  return BigInt('0x' + h.slice(0, 64)).toString(10);
}

/** Decode a single 32-byte word as a boolean. */
function decodeBoolWord(hex) {
  const h = strip0x(hex);
  if (h.length < 64) throw new Error('short return data for bool');
  return BigInt('0x' + h.slice(0, 64)) !== 0n;
}

/** Decode ABI-encoded string return data (offset + length + bytes). */
function decodeString(hex) {
  const h = strip0x(hex);
  if (h.length < 128) throw new Error('short return data for string');
  const offset = Number(BigInt('0x' + h.slice(0, 64)) * 2n);
  const len = Number(BigInt('0x' + h.slice(offset, offset + 64)));
  const dataHex = h.slice(offset + 64, offset + 64 + len * 2);
  return Buffer.from(dataHex, 'hex').toString('utf8');
}

/**
 * Decode a Solidity revert reason: 0x08c379a0 + ABI-encoded Error(string).
 * Returns the reason string, or null if the data is not an Error(string).
 */
function decodeRevertReason(hex) {
  try {
    const h = strip0x(hex);
    if (!h.startsWith('08c379a0')) return null;
    return decodeString('0x' + h.slice(8));
  } catch (_) {
    return null;
  }
}

module.exports = {
  isAddress,
  selector,
  encodeCall,
  encodeArg,
  parseSignatureTypes,
  parseSignatureName,
  abiSignature,
  decodeAddressWord,
  decodeUintWord,
  decodeBoolWord,
  decodeString,
  decodeRevertReason,
};
