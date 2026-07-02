// Billing store — licenses + monthly usage counters.
// ---------------------------------------------------------------------------
// Two backends behind one interface:
//   memory    : default. Dev/testing only — counters reset on restart.
//   firestore : production. Dependency-free REST calls to Firestore (native
//               mode, default database) authenticated with the SAME service
//               account as Vertex (gcp-auth.js). Enable with
//               BILLING_STORE=firestore. See MONETIZATION.md for setup.
//
// Documents:
//   licenses/{licenseKey} : { tenantId, plan, status, paddleSubscriptionId,
//                             paddleCustomerId, paddleTransactionId, updatedAt }
//   usage/{caller}_{YYYY-MM} : { tokens, extraTokens }
//     caller = license key (subscribed) or "ip:x.x.x.x" (trial)
//
// Usage increments are read-modify-write WITHOUT a transaction: under heavy
// concurrency a few tokens may go uncounted. Deliberate v1 trade-off (metering
// favours the customer, code stays dependency-free); revisit when usage-based
// billing must be exact to the token.
// ---------------------------------------------------------------------------

import { getAccessToken } from "../providers/gcp-auth.js";
import { GCP } from "../config/knowledge.js";

const BACKEND = (process.env.BILLING_STORE || "memory").toLowerCase();
export const USING_FIRESTORE = BACKEND === "firestore";

// ── memory backend ────────────────────────────────────────────────────────────
const memLicenses = new Map(); // key -> license object
const memUsage = new Map(); // usageId -> { tokens, extraTokens }

// ── firestore REST helpers ────────────────────────────────────────────────────
function fsBase() {
  return `https://firestore.googleapis.com/v1/projects/${GCP.project}/databases/(default)/documents`;
}

async function fsReq(path, { method = "GET", body = null, query = "" } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${fsBase()}${path}${query}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || res.status;
    throw new Error(`Firestore ${method} ${path} failed: ${msg}`);
  }
  return json;
}

// JS object <-> Firestore fields
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number") fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (typeof v === "boolean") fields[k] = { booleanValue: v };
    else fields[k] = { stringValue: String(v) };
  }
  return fields;
}

function fromFields(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(doc.fields)) {
    if ("integerValue" in v) out[k] = Number(v.integerValue);
    else if ("doubleValue" in v) out[k] = v.doubleValue;
    else if ("booleanValue" in v) out[k] = v.booleanValue;
    else if ("stringValue" in v) out[k] = v.stringValue;
  }
  return out;
}

// Sanitize a document id (usage ids embed IPs — ":" and "/" are not allowed).
function docId(s) {
  return String(s).replace(/[^\w.-]/g, "_").slice(0, 500);
}

// ── licenses ──────────────────────────────────────────────────────────────────
export async function getLicense(key) {
  if (!key) return null;
  if (!USING_FIRESTORE) return memLicenses.get(key) || null;
  const doc = await fsReq(`/licenses/${docId(key)}`);
  return fromFields(doc);
}

export async function putLicense(key, license) {
  const record = { ...license, updatedAt: new Date().toISOString() };
  if (!USING_FIRESTORE) {
    memLicenses.set(key, record);
    return record;
  }
  await fsReq(`/licenses/${docId(key)}`, { method: "PATCH", body: { fields: toFields(record) } });
  return record;
}

// List all licenses (admin/invoice-mode overview). Returns [{ key, ...license }].
export async function listLicenses() {
  if (!USING_FIRESTORE) {
    return [...memLicenses.entries()].map(([key, lic]) => ({ key, ...lic }));
  }
  const out = [];
  let pageToken = "";
  do {
    const q = `?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const json = await fsReq(`/licenses`, { query: q });
    for (const doc of json?.documents || []) {
      out.push({ key: doc.name.split("/").pop(), ...fromFields(doc) });
    }
    pageToken = json?.nextPageToken || "";
  } while (pageToken);
  return out;
}

// Find a license by its Paddle subscription id (webhook + key-retrieval flows).
export async function findLicenseBySubscription(subscriptionId) {
  if (!subscriptionId) return null;
  if (!USING_FIRESTORE) {
    for (const [key, lic] of memLicenses) {
      if (lic.paddleSubscriptionId === subscriptionId) return { key, license: lic };
    }
    return null;
  }
  const json = await fsReq(`:runQuery`, {
    method: "POST",
    body: {
      structuredQuery: {
        from: [{ collectionId: "licenses" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "paddleSubscriptionId" },
            op: "EQUAL",
            value: { stringValue: String(subscriptionId) },
          },
        },
        limit: 1,
      },
    },
  });
  const hit = Array.isArray(json) ? json.find((r) => r.document) : null;
  if (!hit) return null;
  const name = hit.document.name; // .../documents/licenses/<key>
  return { key: name.split("/").pop(), license: fromFields(hit.document) };
}

// ── usage counters ────────────────────────────────────────────────────────────
function usageId(caller, month) {
  return docId(`${caller}_${month}`);
}

export async function getUsage(caller, month) {
  const id = usageId(caller, month);
  if (!USING_FIRESTORE) return memUsage.get(id) || { tokens: 0, extraTokens: 0 };
  const doc = await fsReq(`/usage/${id}`);
  const u = fromFields(doc);
  return { tokens: u?.tokens || 0, extraTokens: u?.extraTokens || 0 };
}

export async function addUsage(caller, month, tokens) {
  if (!tokens || tokens <= 0) return;
  const id = usageId(caller, month);
  if (!USING_FIRESTORE) {
    const u = memUsage.get(id) || { tokens: 0, extraTokens: 0 };
    u.tokens += tokens;
    memUsage.set(id, u);
    return;
  }
  const current = await getUsage(caller, month);
  await fsReq(`/usage/${id}`, {
    method: "PATCH",
    body: { fields: toFields({ tokens: current.tokens + tokens, extraTokens: current.extraTokens }) },
  });
}

// Deadline Boost: credit extra tokens to the caller's CURRENT month.
export async function addBoost(caller, month, tokens) {
  const id = usageId(caller, month);
  if (!USING_FIRESTORE) {
    const u = memUsage.get(id) || { tokens: 0, extraTokens: 0 };
    u.extraTokens += tokens;
    memUsage.set(id, u);
    return u;
  }
  const current = await getUsage(caller, month);
  const next = { tokens: current.tokens, extraTokens: current.extraTokens + tokens };
  await fsReq(`/usage/${id}`, { method: "PATCH", body: { fields: toFields(next) } });
  return next;
}

// Test hook (memory backend only).
export function _resetForTests() {
  memLicenses.clear();
  memUsage.clear();
}
