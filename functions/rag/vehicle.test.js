// Vehicle RC (registration certificate) lookup: format validation, HMAC
// signing, and mapping Eko's real response/error shapes — both captured
// from an actual live call before this was written, not assumed.
// Run: node functions/rag/vehicle.test.js

const crypto = require('crypto');
const vehicle = require('./vehicle');

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('ok  ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ` — ${detail}` : '')); }
};

// ── Format validation ────────────────────────────────────────────────────
check('a standard registration number is valid', vehicle.isValidVehicleNumber('HJ01ME5678'));
check('lowercase and internal spacing are tolerated', vehicle.isValidVehicleNumber('mh 01 ab 1234'));
check('a two-letter series is valid', vehicle.isValidVehicleNumber('KA03MX4521'));
check('garbage is not a valid registration number', !vehicle.isValidVehicleNumber('not a plate'));
check('a bare word is not a valid registration number', !vehicle.isValidVehicleNumber('vehicle'));

// ── HMAC secret-key computation ──────────────────────────────────────────
// Eko's own documented formula: secret-key = base64(HMAC-SHA256(timestamp,
// key = base64(access_key))). Confirmed directly against
// https://eps.eko.in/docs/how-auth-works, and checked here against a
// hand-computed reference so a change to the formula fails loudly.
const expected = crypto
  .createHmac('sha256', Buffer.from('test-access-key').toString('base64'))
  .update('1700000000000')
  .digest('base64');
check('computeSecretKey matches Eko\'s documented HMAC formula exactly',
  vehicle.computeSecretKey('test-access-key', '1700000000000') === expected);
check('a different timestamp produces a different signature',
  vehicle.computeSecretKey('test-access-key', '1700000000001') !== expected);

// ── Mocked network ────────────────────────────────────────────────────────
const originalFetch = global.fetch;
const ENV_KEYS = ['EKO_DEVELOPER_KEY', 'EKO_ACCESS_KEY', 'EKO_INITIATOR_ID', 'EKO_VEHICLE_RC_URL'];
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
function setEnv(vals) {
  for (const k of ENV_KEYS) {
    if (vals[k] === undefined) delete process.env[k];
    else process.env[k] = vals[k];
  }
}
function restoreEnv() {
  global.fetch = originalFetch;
  setEnv(originalEnv);
}

// The exact shape captured from a real, live call during design.
const REAL_SUCCESS_RESPONSE = {
  response_status_id: 0,
  data: {
    reg_no: 'HJ01ME5678', rc_status: 'ACTIVE', type: 'PETROL', owner: 'JOHN DOE',
    class: 'Motor Car', vehicle_manufacturer_name: 'HYUNDAI MOTOR INDIA LTD',
    model: 'P20 1.0TURBO GDI DCT', vehicle_colour: 'TEAL GREY',
    reg_date: '2021-12-24', reg_authority: 'BENGALURU CENTRAL  RTO, Karnataka',
    rc_expiry_date: '2089-12-23', chassis: 'PFGHV511VMM23768', engine: 'K8KJHH7766890',
    vehicle_insurance_company_name: 'BAJAJ INSURANCE CO. LTD.',
    vehicle_insurance_upto: '2029-12-14', pucc_upto: '2022-12-23',
    rc_financer: 'BAJAJ FINANCE', blacklist_status: 'NA',
  },
  response_type_id: 0, status: 0,
};
// The exact shape captured from a real, live call with a made-up test
// vehicle number the provider's sandbox does not recognise.
const REAL_FAILURE_RESPONSE = {
  response_status_id: 1, code: 'verification_failed', response_type_id: 1,
  type: 'internal_error',
  message: 'Please use test data in the test environment. Refer to: https://www.cashfree.com/docs/api-reference/vrs/data-to-test-integration',
  status: 1,
};

(async () => {
  // A malformed vehicle number never reaches the network at all.
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error('should not be called'); };
  const bad = await vehicle.lookup({ vehicleNumber: 'not a plate' });
  check('a malformed vehicle number is refused before any network call',
    /not a recognisable Indian vehicle registration number/.test(bad.error || ''));
  check('the rejection touched no network', fetchCalls === 0);

  // Missing configuration is refused before any network call too.
  setEnv({});
  const unconfigured = await vehicle.lookup({ vehicleNumber: 'HJ01ME5678' });
  check('with no Eko credentials configured, the lookup is refused up front',
    /not configured/.test(unconfigured.error || ''));

  // A successful lookup against the default (staging) endpoint, mocked with
  // the real captured response shape. The body is read via .text() now, not
  // .json() — the mock reflects that.
  setEnv({ EKO_DEVELOPER_KEY: 'dk', EKO_ACCESS_KEY: 'ak', EKO_INITIATOR_ID: '9999999999' });
  global.fetch = async (url, opts) => {
    check('the request hits the default staging endpoint when EKO_VEHICLE_RC_URL is unset',
      url === 'https://staging.eko.in/ekoapi/v3/tools/kyc/vehicle-rc');
    check('the request carries the three Eko auth headers',
      !!(opts.headers.developer_key && opts.headers['secret-key'] && opts.headers['secret-key-timestamp']));
    const body = JSON.parse(opts.body);
    check('the request body carries initiator_id, client_ref_id and vehicle_number',
      body.initiator_id === '9999999999' && !!body.client_ref_id && body.vehicle_number === 'HJ01ME5678');
    return { status: 200, text: async () => JSON.stringify(REAL_SUCCESS_RESPONSE) };
  };
  const found = await vehicle.lookup({ vehicleNumber: 'hj01me5678' });
  check('a found vehicle reports found:true', found.found === true);
  check('the owner is carried through', found.owner === 'JOHN DOE');
  check('manufacturer and model are carried through',
    found.manufacturer === 'HYUNDAI MOTOR INDIA LTD' && found.model === 'P20 1.0TURBO GDI DCT');
  check('RC status and expiry are carried through',
    found.rcStatus === 'ACTIVE' && found.rcExpiryDate === '2089-12-23');
  check('insurance validity is carried through', found.insuranceValidUpto === '2029-12-14');
  check('the British-spelling colour field (sandbox shape) is carried through', found.color === 'TEAL GREY');
  check('the vehicle number is normalised to uppercase, no spaces', found.vehicleNumber === 'HJ01ME5678');
  check('the default staging endpoint is flagged as sandbox data', found.isSandboxData === true);

  // A verification the provider itself rejects — the real captured shape.
  global.fetch = async () => ({ status: 200, text: async () => JSON.stringify(REAL_FAILURE_RESPONSE) });
  const notFound = await vehicle.lookup({ vehicleNumber: 'ZZ99ZZ9999' });
  check('a rejected verification reports found:false, not an error', notFound.found === false);
  check('the provider\'s own message is carried through', /test data/.test(notFound.message || ''));
  check('a rejection is flagged as sandbox data too, not just a match',
    notFound.isSandboxData === true);

  // A non-JSON body (e.g. an HTML error page from a wrong port/path, or a
  // plain-text rejection) must surface the real HTTP status and a snippet
  // of what actually came back, not a generic parse-error message.
  global.fetch = async () => ({ status: 403, text: async () => 'Kindly use registered credentials to access this API' });
  const nonJson = await vehicle.lookup({ vehicleNumber: 'HJ01ME5678' });
  check('a non-JSON body is reported as an error carrying the real HTTP status',
    /HTTP 403/.test(nonJson.error || ''));
  check('  and the actual response body, not a generic parse error',
    /Kindly use registered credentials/.test(nonJson.error || ''));

  // A network outage is reported as an error, never thrown.
  global.fetch = async () => { throw new Error('network down'); };
  const down = await vehicle.lookup({ vehicleNumber: 'HJ01ME5678' });
  check('a network outage is reported, not thrown', /lookup failed/.test(down.error || ''));

  // This account's actual confirmed production endpoint — a different path,
  // not just a different host, so this locks in that the URL is used
  // verbatim rather than composed from a host + fixed path.
  const PROD_URL = 'https://api.eko.in:25002/ekoicici/v3/tools/kyc/vehicle-rc';
  setEnv({ EKO_DEVELOPER_KEY: 'dk', EKO_ACCESS_KEY: 'ak', EKO_INITIATOR_ID: '9999999999', EKO_VEHICLE_RC_URL: PROD_URL });
  global.fetch = async (url) => {
    check('a configured EKO_VEHICLE_RC_URL is used verbatim, port and all', url === PROD_URL);
    return { status: 200, text: async () => JSON.stringify(REAL_SUCCESS_RESPONSE) };
  };
  const prod = await vehicle.lookup({ vehicleNumber: 'HJ01ME5678' });
  check('the configured production endpoint is not flagged as sandbox data', prod.isSandboxData === false);

  global.fetch = async () => {
    const american = { ...REAL_SUCCESS_RESPONSE, data: { ...REAL_SUCCESS_RESPONSE.data } };
    delete american.data.vehicle_colour;
    american.data.vehicle_color = 'SLATE BLUE';
    return { status: 200, text: async () => JSON.stringify(american) };
  };
  const americanSpelling = await vehicle.lookup({ vehicleNumber: 'HJ01ME5678' });
  check('vehicle_color (American spelling, production) is read when vehicle_colour is absent',
    americanSpelling.color === 'SLATE BLUE');

  restoreEnv();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
