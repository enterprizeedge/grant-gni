// Minimal authentication — binds a request to a tenant SERVER-SIDE so a client
// cannot read or write another client's tier-3 data by changing a field.
// ---------------------------------------------------------------------------
// This is intentionally small (no external IdP yet). Each client is issued an
// opaque API key; the backend maps key -> tenantId. The add-in stores its key and
// sends it as `Authorization: Bearer <key>`. The tenantId is NEVER taken from the
// request body when auth is on.
//
// Config (from Secret Manager / env):
//   AUTH_ENABLED   = "true" to enforce (default false -> legacy body tenantId)
//   TENANT_KEYS    = JSON: { "<apiKey>": "<tenantId>", ... }
//   ADMIN_TOKEN    = bearer token required for ingestion/admin endpoints
//
// Upgrade path: replace key lookup with verification of a real IdP token
// (Google Identity / Auth0 / Entra) and map the verified org claim to tenantId.
// ---------------------------------------------------------------------------

export const AUTH_ENABLED = String(process.env.AUTH_ENABLED || "false").toLowerCase() === "true";

let tenantKeys = {};
try {
  tenantKeys = process.env.TENANT_KEYS ? JSON.parse(process.env.TENANT_KEYS) : {};
} catch {
  console.warn("[auth] TENANT_KEYS is not valid JSON; treating as empty.");
  tenantKeys = {};
}
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function bearer(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

export function resolveTenant(req) {
  const key = bearer(req);
  if (key && tenantKeys[key]) return tenantKeys[key];
  return null;
}

// Sets req.tenantId. When auth is OFF, falls back to the body/param value so the
// existing (pre-auth) flow keeps working in dev.
export function requireTenant(req, res, next) {
  if (AUTH_ENABLED) {
    const tenantId = resolveTenant(req);
    if (!tenantId) {
      return res.status(401).json({ error: { message: "Unauthorized: valid client key required." } });
    }
    req.tenantId = tenantId;
    return next();
  }
  // Legacy fallback (auth disabled): trust the supplied id. Spoofable — dev only.
  req.tenantId = (req.body && req.body.tenantId) || req.params.id || null;
  return next();
}

// FAIL CLOSED: admin endpoints (ingest/seed/bootstrap/tenant listing) always
// require ADMIN_TOKEN, regardless of AUTH_ENABLED. Previously these were open
// whenever auth was off — which meant anyone could ingest into (or rebuild)
// the shared knowledge base on a deployed instance. For local dev, set a
// throwaway ADMIN_TOKEN in backend/.env.
export function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({
      error: {
        message:
          "Admin endpoints are disabled: ADMIN_TOKEN is not configured. Set it in backend/.env (dev) or Secret Manager (prod).",
      },
    });
  }
  if (bearer(req) !== ADMIN_TOKEN) {
    return res.status(401).json({ error: { message: "Unauthorized: admin token required." } });
  }
  return next();
}
