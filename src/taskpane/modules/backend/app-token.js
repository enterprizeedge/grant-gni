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

// Merge the app token into a headers object: appHeaders({ "Content-Type": ... })
export function appHeaders(base = {}) {
  return { ...base, "X-App-Token": currentToken() };
}
