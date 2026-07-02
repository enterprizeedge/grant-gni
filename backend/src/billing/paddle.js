// Paddle Billing integration — webhook + license-key retrieval.
// ---------------------------------------------------------------------------
// Paddle is the Merchant of Record (handles EU VAT/invoices). Flow:
//
//   1. User buys a plan on the pricing page (Paddle checkout).
//   2. Paddle calls POST /api/billing/webhook/paddle:
//        subscription.created/activated -> we generate a license key
//          (gg_live_...), map the Paddle price to a plan, store the license.
//        subscription.updated  -> plan/tier change (deadline upgrades — Paddle
//          prorates automatically) or status change.
//        subscription.canceled -> license deactivated.
//        transaction.completed with a "boost" price -> +5M tokens credited to
//          the license's current month (custom_data.license_key).
//   3. Paddle checkout success redirects to
//        GET /api/billing/key?txn={transaction_id}
//      which verifies the transaction with the Paddle API and shows the user
//      their license key to paste into the add-in's Settings.
//
// Signature verification: Paddle-Signature header "ts=...;h1=...", where
// h1 = HMAC-SHA256(`${ts}:${rawBody}`, PADDLE_WEBHOOK_SECRET).
//
// Config (env / Secret Manager):
//   PADDLE_WEBHOOK_SECRET  required to enable the webhook (else 503)
//   PADDLE_API_KEY         required for /api/billing/key verification
//   PADDLE_API_BASE        default https://api.paddle.com
//                          (sandbox: https://sandbox-api.paddle.com)
//   PADDLE_PRICE_MAP       JSON: { "pri_xxx": "reviewer" | "writer" |
//                          "studio" | "boost", ... }
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import { putLicense, findLicenseBySubscription, addBoost } from "./store.js";
import { getPlan, monthKey, BOOST_TOKENS, PRICING_URL } from "./plans.js";
import { invalidateLicenseCache } from "./quota.js";

const WEBHOOK_SECRET = process.env.PADDLE_WEBHOOK_SECRET || "";
const API_KEY = process.env.PADDLE_API_KEY || "";
const API_BASE = (process.env.PADDLE_API_BASE || "https://api.paddle.com").replace(/\/+$/, "");

let priceMap = {};
try {
  priceMap = process.env.PADDLE_PRICE_MAP ? JSON.parse(process.env.PADDLE_PRICE_MAP) : {};
} catch {
  console.warn("[paddle] PADDLE_PRICE_MAP is not valid JSON; treating as empty.");
}

export function verifyPaddleSignature(rawBody, signatureHeader, secret = WEBHOOK_SECRET) {
  if (!secret || !signatureHeader) return false;
  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(";")
      .map((p) => p.split("=").map((s) => s.trim()))
      .filter((kv) => kv.length === 2)
  );
  if (!parts.ts || !parts.h1) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${parts.ts}:${rawBody}`)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.h1));
  } catch {
    return false;
  }
}

function planFromItems(items) {
  for (const item of items || []) {
    const priceId = item?.price?.id || item?.price_id;
    const mapped = priceMap[priceId];
    if (mapped && mapped !== "boost") return mapped;
  }
  return null;
}

function isBoostTransaction(items) {
  return (items || []).some((item) => priceMap[item?.price?.id || item?.price_id] === "boost");
}

function newLicenseKey() {
  return "gg_live_" + crypto.randomBytes(18).toString("base64url");
}

// Paddle statuses -> our license statuses.
function mapStatus(s) {
  if (s === "active" || s === "trialing" || s === "past_due") return s;
  return "canceled"; // paused / canceled / anything else -> not usable
}

async function handleSubscriptionEvent(eventType, data) {
  const subId = data.id;
  const existing = await findLicenseBySubscription(subId);

  if (eventType === "subscription.canceled") {
    if (existing) {
      await putLicense(existing.key, { ...existing.license, status: "canceled" });
      invalidateLicenseCache(existing.key);
    }
    return { ok: true, action: "canceled" };
  }

  const plan = planFromItems(data.items) || existing?.license?.plan || "reviewer";
  const status = mapStatus(data.status);

  if (existing) {
    // Plan/tier change (Paddle prorates) or status update.
    await putLicense(existing.key, { ...existing.license, plan, status });
    invalidateLicenseCache(existing.key);
    return { ok: true, action: "updated", plan };
  }

  // New subscription -> provision a license. tenantId derives from the Paddle
  // customer id so all of a customer's seats share one private KB tenant.
  const key = newLicenseKey();
  await putLicense(key, {
    tenantId: String(data.customer_id || key).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64),
    plan,
    status,
    paddleSubscriptionId: subId,
    paddleCustomerId: data.customer_id || null,
    paddleTransactionId: data.transaction_id || null,
  });
  return { ok: true, action: "created", plan };
}

async function handleTransactionCompleted(data) {
  if (!isBoostTransaction(data.items)) return { ok: true, action: "ignored" };
  const licenseKey = data.custom_data?.license_key || data.custom_data?.licenseKey;
  if (!licenseKey) {
    console.warn(
      `[paddle] boost transaction ${data.id} has no custom_data.license_key — credit manually.`
    );
    return { ok: true, action: "boost-unmatched" };
  }
  await addBoost(licenseKey, monthKey(), BOOST_TOKENS);
  return { ok: true, action: "boost-credited", tokens: BOOST_TOKENS };
}

// Express handler for POST /api/billing/webhook/paddle (needs req.rawBody).
export async function paddleWebhook(req, res) {
  if (!WEBHOOK_SECRET) {
    return res.status(503).json({ error: { message: "Billing webhook not configured." } });
  }
  const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body || {});
  if (!verifyPaddleSignature(raw, req.headers["paddle-signature"])) {
    return res.status(401).json({ error: { message: "Invalid Paddle signature." } });
  }
  try {
    const event = req.body || {};
    const type = event.event_type || "";
    const data = event.data || {};
    let result = { ok: true, action: "ignored" };
    if (type.startsWith("subscription.")) result = await handleSubscriptionEvent(type, data);
    else if (type === "transaction.completed") result = await handleTransactionCompleted(data);
    console.log(JSON.stringify({ severity: "INFO", msg: "paddle webhook", type, ...result }));
    return res.json(result);
  } catch (err) {
    console.error("[paddle] webhook error:", err);
    // 500 -> Paddle retries with backoff, which is what we want.
    return res.status(500).json({ error: { message: err.message } });
  }
}

// GET /api/billing/key?txn=<paddle transaction id>
// The Paddle checkout success URL points here; verifies the purchase with the
// Paddle API and shows the license key (webhooks normally land first; if not,
// the page tells the user to refresh).
export async function licenseKeyPage(req, res) {
  const txn = String(req.query.txn || req.query._ptxn || "").trim();
  const page = (title, body) =>
    res
      .status(200)
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
          `<body style="font-family:system-ui;max-width:560px;margin:60px auto;padding:0 16px">` +
          `<h2>${title}</h2>${body}` +
          `<p style="color:#666;margin-top:32px">Grant Gni — <a href="${PRICING_URL}">pricing & help</a></p></body>`
      );

  if (!API_KEY) return page("Billing not configured", "<p>PADDLE_API_KEY is not set on the server.</p>");
  if (!txn) return page("Missing transaction", "<p>No transaction id in the URL.</p>");

  try {
    const r = await fetch(`${API_BASE}/transactions/${encodeURIComponent(txn)}`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(json?.error?.detail || `Paddle API ${r.status}`);
    const t = json.data || {};
    if (!["completed", "paid"].includes(t.status)) {
      return page("Payment not completed yet", "<p>Refresh this page in a few seconds.</p>");
    }
    if (isBoostTransaction(t.items)) {
      return page(
        "Deadline Boost added 🎉",
        `<p>${(BOOST_TOKENS / 1e6).toFixed(0)}M extra tokens have been credited to your license for this month. You can close this page.</p>`
      );
    }
    const subId = t.subscription_id;
    const found = subId ? await findLicenseBySubscription(subId) : null;
    if (!found) {
      return page(
        "Almost there…",
        "<p>Your payment is confirmed but the license is still being provisioned. Refresh this page in ~30 seconds.</p>"
      );
    }
    const plan = getPlan(found.license.plan);
    return page(
      "Your Grant Gni license key",
      `<p>Plan: <b>${plan.name}</b> (€${plan.pricePerMonthEur}/month)</p>` +
        `<p>Copy this key, then in Word open Grant Gni → ⚙ Settings → <b>License key</b> and paste it:</p>` +
        `<pre style="background:#f4f4f4;padding:14px;border-radius:8px;font-size:15px;user-select:all">${found.key}</pre>` +
        `<p>Keep it safe — it is your access to the service.</p>`
    );
  } catch (err) {
    console.error("[paddle] key page error:", err);
    return page("Something went wrong", `<p>${String(err.message)}</p><p>Contact support with your Paddle receipt.</p>`);
  }
}
