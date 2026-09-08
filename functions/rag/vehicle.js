'use strict';

// Vehicle RC (registration certificate) lookup — Eko Platform Services'
// Vehicle RC Verification API, which (per its own test-data error message)
// appears to sit on top of Cashfree's underlying verification data. Live
// per-query, like osint.js and crypto.js: RC status, insurance validity
// and ownership can all change, so there is nothing useful to cache.
//
// Unlike every other external tool built this session, this one does NOT
// cross India's border — Eko is an Indian verification provider processing
// Indian government RTO data. The disclosure this tool carries reflects
// that: an external provider, not a foreign one.
//
// Verified directly against the live API — using real, working sandbox
// credentials — before writing this: the endpoint, the three auth headers,
// and both the success and failure response shapes were confirmed by an
// actual call, not assumed from documentation. Eko's interactive API
// reference is JS-rendered and did not expose its contract to inspection;
// probing the live endpoint (the same technique that found Etherscan's
// real V2 contract) is what actually confirmed all of this.

const crypto = require('crypto');

const DEFAULT_BASE_URL = 'https://staging.eko.in';
const RC_PATH = '/ekoapi/v3/tools/kyc/vehicle-rc';
const TIMEOUT_MS = 15_000;

// Indian vehicle registration format: two-letter state code, a one- or
// two-digit RTO code, a one-to-three-letter series, four digits. Validated
// before any network call — a malformed value costs nothing rather than
// becoming a request.
const VEHICLE_RE = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,3}[0-9]{4}$/i;

function isValidVehicleNumber(v) {
  return VEHICLE_RE.test(String(v || '').trim().replace(/\s+/g, ''));
}

// secret-key = base64(HMAC-SHA256(timestamp_ms, key = base64(access_key)))
// — Eko's own documented formula. This computation is what actually
// authenticated the live verification call made during design.
function computeSecretKey(accessKey, timestampMs) {
  return crypto
    .createHmac('sha256', Buffer.from(accessKey).toString('base64'))
    .update(String(timestampMs))
    .digest('base64');
}

function baseUrl() {
  return process.env.EKO_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Look up a vehicle's RC (registration certificate). Returns { error } for
 * a malformed vehicle number or missing configuration, with no network
 * call. Otherwise returns { vehicleNumber, found, ...fields } — a
 * verification the provider itself rejects comes back as
 * { vehicleNumber, found: false, message }, never a thrown error.
 */
async function lookup({ vehicleNumber }) {
  const v = String(vehicleNumber || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!isValidVehicleNumber(v)) {
    return { error: `"${vehicleNumber}" is not a recognisable Indian vehicle registration number.` };
  }

  const developerKey = process.env.EKO_DEVELOPER_KEY;
  const accessKey = process.env.EKO_ACCESS_KEY;
  const initiatorId = process.env.EKO_INITIATOR_ID;
  if (!developerKey || !accessKey || !initiatorId) {
    return { error: 'Vehicle RC lookup is not configured.' };
  }

  const ts = Date.now().toString();
  const secretKey = computeSecretKey(accessKey, ts);
  const clientRefId = `${ts}${Math.floor(Math.random() * 1000)}`;

  let data;
  try {
    const res = await fetch(`${baseUrl()}${RC_PATH}`, {
      method: 'POST',
      headers: {
        developer_key: developerKey,
        'secret-key': secretKey,
        'secret-key-timestamp': ts,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ initiator_id: initiatorId, client_ref_id: clientRefId, vehicle_number: v }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    data = await res.json();
  } catch (e) {
    return { error: `Vehicle RC lookup failed: ${(e && e.message) || e}` };
  }

  if (!data || data.response_status_id !== 0 || !data.data) {
    return { vehicleNumber: v, found: false, message: (data && data.message) || 'No RC record found.' };
  }

  const d = data.data;
  return {
    vehicleNumber: v,
    found: true,
    owner: d.owner || null,
    vehicleClass: d.class || null,
    manufacturer: d.vehicle_manufacturer_name || null,
    model: d.model || null,
    fuelType: d.type || null,
    color: d.vehicle_colour || null,
    registrationDate: d.reg_date || null,
    registrationAuthority: d.reg_authority || null,
    rcStatus: d.rc_status || null,
    rcExpiryDate: d.rc_expiry_date || null,
    chassisNumber: d.chassis || null,
    engineNumber: d.engine || null,
    insuranceCompany: d.vehicle_insurance_company_name || null,
    insuranceValidUpto: d.vehicle_insurance_upto || null,
    puccValidUpto: d.pucc_upto || null,
    financer: d.rc_financer || null,
    blacklistStatus: d.blacklist_status || null,
    // The sandbox always answers with fixed test data (a dummy owner, a
    // dummy address) for any test vehicle number — an officer must never
    // be shown that as if it were a real record. Derived from which host
    // is actually configured, not a separate toggle that could drift out
    // of sync with it.
    isSandboxData: baseUrl().includes('staging'),
  };
}

module.exports = { lookup, isValidVehicleNumber, computeSecretKey };
