'use strict';

// Crypto wallet address lookup — Bitcoin via blockstream.info (keyless),
// Ethereum via Etherscan's V2 API (free-tier keyed). Unlike sanctions.js,
// this IS a live per-query call, the same shape osint.js already uses: a
// wallet's balance and activity change with every block, so there is
// nothing useful to cache.
//
// No `kind` input, unlike osint_lookup's ip/domain split — the address
// format itself says which chain it belongs to, so this auto-detects
// rather than asking the caller to specify.
//
// Etherscan verified directly against the live V2 API before writing this:
// their own docs page still describes the deprecated V1 shape, and a V1
// call now returns "You are using a deprecated V1 endpoint" — the real
// current endpoint is https://api.etherscan.io/v2/api with a required
// chainid parameter (1 = Ethereum mainnet), confirmed via its actual error
// responses.

const BTC_TIMEOUT_MS = 12_000;
const ETH_TIMEOUT_MS = 12_000;
const USER_AGENT = 'Sentinel-Crypto/1.0 (Karnataka State Police crime platform)';

const ETH_RE = /^0x[a-fA-F0-9]{40}$/;
const BTC_LEGACY_RE = /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/;
const BTC_BECH32_RE = /^bc1[a-z0-9]{25,90}$/i;

function isEthAddress(v) {
  return ETH_RE.test(String(v || '').trim());
}

function isBtcAddress(v) {
  const s = String(v || '').trim();
  return BTC_LEGACY_RE.test(s) || BTC_BECH32_RE.test(s);
}

async function fetchJson(url, opts, timeoutMs) {
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': USER_AGENT, ...(opts && opts.headers) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function btcLookup(address) {
  const data = await fetchJson(`https://blockstream.info/api/address/${encodeURIComponent(address)}`, {}, BTC_TIMEOUT_MS);
  if (!data || !data.chain_stats) return { available: false };
  const cs = data.chain_stats;
  const balanceSats = (cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0);
  return {
    available: true,
    balanceBtc: balanceSats / 1e8,
    txCount: cs.tx_count || 0,
    fundedCount: cs.funded_txo_count || 0,
    spentCount: cs.spent_txo_count || 0,
  };
}

async function ethLookup(address) {
  const key = process.env.ETHERSCAN_API_KEY;
  if (!key) return { available: false };
  const url = `https://api.etherscan.io/v2/api?chainid=1&module=account&action=balance`
    + `&address=${encodeURIComponent(address)}&tag=latest&apikey=${encodeURIComponent(key)}`;
  const data = await fetchJson(url, {}, ETH_TIMEOUT_MS);
  if (!data || data.status !== '1' || typeof data.result !== 'string') return { available: false };
  return {
    available: true,
    balanceEth: Number(data.result) / 1e18,
  };
}

/**
 * Look up a crypto wallet address. Chain is auto-detected from the address
 * format. Returns { error } for a value that matches neither format, with
 * no network call. Otherwise always returns
 * { chain, address, bitcoin | ethereum, sovereignty } — the chain-specific
 * section is { available: false } on failure or absence, never a thrown
 * error.
 */
async function lookup({ address }) {
  const v = String(address || '').trim();
  if (isBtcAddress(v)) {
    const bitcoin = await btcLookup(v);
    return {
      chain: 'bitcoin',
      address: v,
      bitcoin,
      sovereignty: 'Looking up a Bitcoin address sends it to blockstream.info, outside Sentinel and outside India. Nothing else about this case travels with it.',
    };
  }
  if (isEthAddress(v)) {
    const ethereum = await ethLookup(v);
    return {
      chain: 'ethereum',
      address: v,
      ethereum,
      sovereignty: 'Looking up an Ethereum address sends it to api.etherscan.io, outside Sentinel and outside India. Nothing else about this case travels with it.',
    };
  }
  return { error: `"${address}" is not a recognisable Bitcoin or Ethereum address.` };
}

module.exports = { lookup, isEthAddress, isBtcAddress };
