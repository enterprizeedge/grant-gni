// Admin license management — the operational backbone of INVOICE-FIRST billing.
// ---------------------------------------------------------------------------
// No payment gateway required: you invoice the customer yourself; when they
// pay, you mint a license key here and email it to them. Same key, same plans,
// same quotas as the (dormant) Paddle flow — switching Paddle on later changes
// nothing for existing invoice customers.
//
// All routes are mounted under /api/admin/licenses and protected by
// requireAdmin (Bearer ADMIN_TOKEN). Typical operations:
//
//   Create (invoice paid):
//     curl -X POST $B/api/admin/licenses -H "Authorization: Bearer $ADMIN_TOKEN" \
//       -H "Content-Type: application/json" \
//       -d '{"plan":"writer","tenantId":"acme-consulting","note":"INV-2026-014"}'
//
//   Deadline tier change (up or down, effective immediately):
//     curl -X POST $B/api/admin/licenses/gg_live_xxx -H "Authorization: Bearer $ADMIN_TOKEN" \
//       -H "Content-Type: application/json" -d '{"plan":"studio"}'
//
//   Sell a €49 Deadline Boost by invoice:
//     curl -X POST $B/api/admin/licenses/gg_live_xxx/boost -H "Authorization: Bearer $ADMIN_TOKEN"
//
//   Revoke (non-payment / churn):
//     curl -X POST $B/api/admin/licenses/gg_live_xxx -H "Authorization: Bearer $ADMIN_TOKEN" \
//       -H "Content-Type: application/json" -d '{"status":"canceled"}'
//
//   Overview (all licenses + this month's usage):
//     curl $B/api/admin/licenses -H "Authorization: Bearer $ADMIN_TOKEN"
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { PLANS, getPlan, monthKey, describeUsage, BOOST_TOKENS } from "./plans.js";
import { getLicense, putLicense, listLicenses, getUsage, addBoost } from "./store.js";
import { invalidateLicenseCache } from "./quota.js";

const VALID_STATUSES = new Set(["active", "past_due", "canceled"]);

function newLicenseKey() {
  return "gg_live_" + crypto.randomBytes(18).toString("base64url");
}

// POST /api/admin/licenses  body: { plan, tenantId?, note? }
export async function createLicenseHandler(req, res) {
  try {
    const b = req.body || {};
    const plan = String(b.plan || "").toLowerCase();
    if (!PLANS[plan] || plan === "trial") {
      return res.status(400).json({
        error: { message: `plan must be one of: ${Object.keys(PLANS).filter((p) => p !== "trial").join(", ")}` },
      });
    }
    const key = newLicenseKey();
    const license = await putLicense(key, {
      tenantId: b.tenantId ? String(b.tenantId).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) : null,
      plan,
      status: "active",
      note: b.note || null, // e.g. invoice number / customer name
      source: "invoice",
    });
    return res.json({ ok: true, key, license });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}

// GET /api/admin/licenses — all licenses with this month's usage.
export async function listLicensesHandler(_req, res) {
  try {
    const month = monthKey();
    const licenses = await listLicenses();
    const enriched = await Promise.all(
      licenses.map(async (l) => {
        const usage = await getUsage(l.key, month).catch(() => ({ tokens: 0, extraTokens: 0 }));
        return { ...l, usage: describeUsage(getPlan(l.plan), usage.tokens, usage.extraTokens) };
      })
    );
    // Most recently updated first — the ones you're actively managing.
    enriched.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    return res.json({ month, count: enriched.length, licenses: enriched });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}

// POST /api/admin/licenses/:key  body: { plan? , status?, note? }
export async function updateLicenseHandler(req, res) {
  try {
    const key = String(req.params.key || "");
    const existing = await getLicense(key);
    if (!existing) return res.status(404).json({ error: { message: "License not found." } });

    const b = req.body || {};
    const next = { ...existing };
    if (b.plan !== undefined) {
      const plan = String(b.plan).toLowerCase();
      if (!PLANS[plan] || plan === "trial") {
        return res.status(400).json({ error: { message: `Invalid plan "${b.plan}".` } });
      }
      next.plan = plan;
    }
    if (b.status !== undefined) {
      const status = String(b.status).toLowerCase();
      if (!VALID_STATUSES.has(status)) {
        return res.status(400).json({ error: { message: `status must be one of: ${[...VALID_STATUSES].join(", ")}` } });
      }
      next.status = status;
    }
    if (b.note !== undefined) next.note = b.note;

    const license = await putLicense(key, next);
    invalidateLicenseCache(key); // change takes effect on the next request
    return res.json({ ok: true, key, license });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}

// POST /api/admin/licenses/:key/boost  body: { tokens? } (default +5M)
export async function boostLicenseHandler(req, res) {
  try {
    const key = String(req.params.key || "");
    const existing = await getLicense(key);
    if (!existing) return res.status(404).json({ error: { message: "License not found." } });
    const tokens = Number(req.body?.tokens) > 0 ? Number(req.body.tokens) : BOOST_TOKENS;
    const usage = await addBoost(key, monthKey(), tokens);
    return res.json({
      ok: true,
      key,
      credited: tokens,
      usage: describeUsage(getPlan(existing.plan), usage.tokens, usage.extraTokens),
    });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
