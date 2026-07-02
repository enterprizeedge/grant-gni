/* global localStorage */

// Shared app token sent with every backend call as `X-App-Token`.
// ---------------------------------------------------------------------------
// This value is public by nature (it ships in the bundle) — it is an abuse
// brake for the open Cloud Run endpoint, NOT authentication. The backend only
// enforces it once its APP_TOKEN env var is set, so rollout order is:
//   1) deploy this frontend, 2) set APP_TOKEN=<same value> on the backend.
// Rotate by changing both values and redeploying frontend first.
// ---------------------------------------------------------------------------

export const APP_TOKEN = "gg-addin-2026-07-r1";

// Optional override for staging/testing (mirrors the grantGniBackendUrl pattern).
function currentToken() {
  try {
    const o = localStorage.getItem("grantGniAppToken");
    if (o && o.trim()) return o.trim();
  } catch {
    /* localStorage unavailable — fall through */
  }
  return APP_TOKEN;
}

// The user's license key (issued at purchase via Paddle, pasted in Settings).
// Shared storage key with the Review panel's client key — one key, all features.
export function loadLicenseKey() {
  try {
    return (localStorage.getItem("grantGniClientKey") || "").trim();
  } catch {
    return "";
  }
}

export function saveLicenseKey(key) {
  try {
    localStorage.setItem("grantGniClientKey", String(key || "").trim());
  } catch {
    /* localStorage unavailable */
  }
}

// Merge the app token (+ license key when present) into a headers object:
// appHeaders({ "Content-Type": ... }). Used by EVERY backend call, so pasting
// a license key in Settings upgrades all features at once.
export function appHeaders(base = {}) {
  const headers = { ...base, "X-App-Token": currentToken() };
  const license = loadLicenseKey();
  if (license && !headers.Authorization) headers.Authorization = `Bearer ${license}`;
  return headers;
}
