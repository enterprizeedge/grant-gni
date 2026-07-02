// Quota middleware — resolves the caller's plan, enforces the monthly token
// budget, and records usage after each LLM response.
// ---------------------------------------------------------------------------
// Caller resolution (in order):
//   1. Authorization bearer key found in TENANT_KEYS env  -> legacy client;
//      plan from TENANT_KEYS_PLAN (default "writer").
//   2. Bearer key found in the billing store (Paddle)     -> that license's
//      plan, if status is active/trialing/past_due-grace.
//   3. No/unknown key                                     -> "trial" plan,
//      metered per client IP.
//
// Enforcement:
//   - hard-limit plans (trial/reviewer/writer): 402 QUOTA_EXCEEDED once the
//     month's tokens + boost are spent, with a friendly upgrade message.
//   - studio (soft limit): NEVER blocked — over-cap requests are logged with
//     severity WARNING for fair-use follow-up. Agencies at a deadline must
//     not be cut off by their own success.
// ---------------------------------------------------------------------------

import { resolveTenant } from "../auth/auth.js";
import { getPlan, monthKey, describeUsage, PRICING_URL } from "./plans.js";
import { getLicense, getUsage, addUsage } from "./store.js";

const TENANT_KEYS_PLAN = process.env.TENANT_KEYS_PLAN || "writer";
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

// Small TTL cache so we don't hit the store on every request.
const licenseCache = new Map(); // key -> { license, exp }
const LICENSE_TTL_MS = 5 * 60 * 1000;

function bearerKey(req) {
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function clientIp(req) {
  const xff = String(req.headers["x-forwarded-for"] || "");
  return xff.split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "unknown";
}

export async function resolveBilling(req) {
  const key = bearerKey(req);

  // 1. Legacy env-issued tenant keys keep working, mapped to a plan.
  const legacyTenant = resolveTenant(req);
  if (legacyTenant) {
    return { caller: key, tenantId: legacyTenant, plan: getPlan(TENANT_KEYS_PLAN), licensed: true };
  }

  // 2. Store-backed license (Paddle-provisioned).
  if (key) {
    const cached = licenseCache.get(key);
    let license = cached && cached.exp > Date.now() ? cached.license : undefined;
    if (license === undefined) {
      license = await getLicense(key).catch(() => null);
      licenseCache.set(key, { license, exp: Date.now() + LICENSE_TTL_MS });
    }
    if (license && ACTIVE_STATUSES.has(license.status)) {
      return { caller: key, tenantId: license.tenantId || null, plan: getPlan(license.plan), licensed: true };
    }
  }

  // 3. Anonymous -> free trial, metered per IP.
  return { caller: `ip:${clientIp(req)}`, tenantId: null, plan: getPlan("trial"), licensed: false };
}

export function invalidateLicenseCache(key) {
  if (key) licenseCache.delete(key);
  else licenseCache.clear();
}

// Express middleware: attach billing info + enforce the quota.
export async function enforceQuota(req, res, next) {
  try {
    const billing = await resolveBilling(req);
    const month = monthKey();
    const usage = await getUsage(billing.caller, month).catch(() => ({ tokens: 0, extraTokens: 0 }));
    const allowance = billing.plan.monthlyTokens + usage.extraTokens;

    req.billing = { ...billing, month, usage, allowance };

    if (usage.tokens >= allowance) {
      if (billing.plan.hardLimit) {
        const msg = billing.licensed
          ? `You've used your ${billing.plan.name} plan's monthly AI allowance. ` +
            `Upgrade your plan or add a Deadline Boost at ${PRICING_URL} — upgrades take effect immediately.`
          : `You've used this month's free allowance. Subscribe at ${PRICING_URL} to keep going ` +
            `(plans from €99/month), then paste your license key in Settings.`;
        return res.status(402).json({
          error: { message: msg, code: "QUOTA_EXCEEDED", upgradeUrl: PRICING_URL },
          usage: describeUsage(billing.plan, usage.tokens, usage.extraTokens),
        });
      }
      // Soft-limit plan (studio): log for fair-use review, never block.
      console.log(
        JSON.stringify({
          severity: "WARNING",
          msg: "soft-cap exceeded (studio fair-use)",
          caller: billing.caller,
          usedTokens: usage.tokens,
          allowanceTokens: allowance,
        })
      );
    }
    return next();
  } catch (err) {
    // Billing must never take the product down: on store errors, allow the
    // request and log loudly. (Fail-open for paying users; the rate limiter
    // still bounds worst-case abuse.)
    console.error("[billing] enforceQuota failed open:", err.message);
    req.billing = null;
    return next();
  }
}

// Record spent tokens after a response. Fire-and-forget.
export function recordUsage(req, totalTokens) {
  if (!req.billing || !totalTokens || totalTokens <= 0) return;
  addUsage(req.billing.caller, req.billing.month, totalTokens).catch((e) =>
    console.error("[billing] recordUsage failed:", e.message)
  );
}
