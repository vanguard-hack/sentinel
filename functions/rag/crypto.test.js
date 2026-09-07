// Crypto wallet address lookup: format detection (auto-routes to the right
// chain) and fail-soft per-chain behaviour. Run: node functions/rag/crypto.test.js

const crypto = require('./crypto');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

const ETH_ADDR = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const BTC_ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

// ── Format detection ─────────────────────────────────────────────────────
check('a legacy BTC address is recognised', crypto.isBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'));
check('a P2SH BTC address is recognised', crypto.isBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'));
check('a bech32 BTC address is recognised', crypto.isBtcAddress(BTC_ADDR));
check('an ETH address is not mistaken for a BTC one', !crypto.isBtcAddress(ETH_ADDR));
check('a well-formed ETH address is recognised', crypto.isEthAddress(ETH_ADDR));
check('an ETH address needs the full 40 hex characters', !crypto.isEthAddress('0xd8dA6BF2'));
check('a BTC address is not mistaken for an ETH one', !crypto.isEthAddress(BTC_ADDR));
check('garbage matches neither chain', !crypto.isBtcAddress('not an address') && !crypto.isEthAddress('not an address'));

// ── Mocked network ────────────────────────────────────────────────────────
const originalFetch = global.fetch;
const originalKey = process.env.ETHERSCAN_API_KEY;
function mockFetch(handlers) {
  global.fetch = async (url) => {
    const hit = handlers.find(([match]) => String(url).includes(match));
    if (!hit) throw new Error(`unexpected fetch to ${url}`);
    return hit[1]();
  };
}
function restoreEnv() {
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.ETHERSCAN_API_KEY;
  else process.env.ETHERSCAN_API_KEY = originalKey;
}

(async () => {
  // A malformed address never reaches the network at all.
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('should not be called'); };
  const bad = await crypto.lookup({ address: 'not an address' });
  check('an unrecognisable address is refused before any network call',
    /not a recognisable Bitcoin or Ethereum address/.test(bad.error || ''));
  check('the rejection touched no network', fetchCalls === 0);

  // Bitcoin — real figures previously verified live against blockstream.info.
  mockFetch([
    ['blockstream.info', () => ({ ok: true, json: async () => ({
      address: BTC_ADDR,
      chain_stats: { funded_txo_count: 1174, funded_txo_sum: 1658224322, spent_txo_count: 434, spent_txo_sum: 1287005839, tx_count: 1131 },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 0 },
    }) })],
  ]);
  const btc = await crypto.lookup({ address: BTC_ADDR });
  check('a Bitcoin address routes to the Bitcoin chain', btc.chain === 'bitcoin');
  check('the Bitcoin balance is funded minus spent, in BTC not satoshis',
    Math.abs(btc.bitcoin.balanceBtc - (1658224322 - 1287005839) / 1e8) < 1e-9);
  check('the Bitcoin transaction count is carried through', btc.bitcoin.txCount === 1131);
  check('the sovereignty note names blockstream.info for a Bitcoin lookup',
    /blockstream\.info/.test(btc.sovereignty));

  // Ethereum, no key configured — never even calls Etherscan.
  delete process.env.ETHERSCAN_API_KEY;
  let etherscanCalled = false;
  mockFetch([
    ['etherscan.io', () => { etherscanCalled = true; return { ok: true, json: async () => ({ status: '1', result: '0' }) }; }],
  ]);
  const ethNoKey = await crypto.lookup({ address: ETH_ADDR });
  check('an Ethereum address routes to the Ethereum chain', ethNoKey.chain === 'ethereum');
  check('with no Etherscan key, that chain reports unavailable', ethNoKey.ethereum.available === false);
  check('and never even calls Etherscan', !etherscanCalled);

  // Ethereum, with a key — real response envelope verified live against the
  // V2 API (status/message/result), balance is Wei-as-a-string.
  process.env.ETHERSCAN_API_KEY = 'test-key';
  mockFetch([
    ['etherscan.io', () => ({ ok: true, json: async () => ({ status: '1', message: 'OK', result: '2500000000000000000' }) })],
  ]);
  const ethWithKey = await crypto.lookup({ address: ETH_ADDR });
  check('with a key, the Ethereum balance comes back converted to ETH, not Wei',
    ethWithKey.ethereum.available === true && ethWithKey.ethereum.balanceEth === 2.5);
  check('the sovereignty note names api.etherscan.io for an Ethereum lookup',
    /etherscan\.io/.test(ethWithKey.sovereignty));

  // A key that Etherscan itself rejects reports unavailable, not a crash.
  mockFetch([
    ['etherscan.io', () => ({ ok: true, json: async () => ({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }) })],
  ]);
  const ethBadKey = await crypto.lookup({ address: ETH_ADDR });
  check('an Etherscan-rejected key reports unavailable, not an error',
    ethBadKey.ethereum.available === false);

  // A chain's own outage is reported as unavailable, never thrown.
  mockFetch([
    ['blockstream.info', () => { throw new Error('network down'); }],
  ]);
  const btcDown = await crypto.lookup({ address: BTC_ADDR });
  check('a Bitcoin outage reports unavailable, not an error', btcDown.bitcoin.available === false);

  restoreEnv();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
