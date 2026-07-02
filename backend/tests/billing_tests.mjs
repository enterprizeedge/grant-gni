// Unit tests: plan catalog, quota enforcement, boost credit, Paddle signature.
// Memory store backend — no network, no Firestore.

import assert from "node:assert";
import crypto from "node:crypto";

process.env.BILLING_STORE = "memory";
process.env.AUTH_ENABLED = "false";
delete process.env.TENANT_KEYS;
process.env.PADDLE_WEBHOOK_SECRET = "whsec_test";

const { PLANS, getPlan, monthKey, describeUsage, BOOST_TOKENS } = await import("../src/billing/plans.js");
const store = await import("../src/billing/store.js");
const { enforceQuota, resolveBilling, recordUsage, requireTenantOrLicense } = await import("../src/billing/quota.js");
const { verifyPaddleSignature } = await import("../src/billing/paddle.js");

function fakeReq(headers = {}) {
  return { headers, ip: "203.0.113.7", socket: {} };
}
function fakeRes() {
  return {
    statusCode: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const run = (req) => new Promise((resolve) => {
  const res = fakeRes();
  enforceQuota(req, res, () => resolve({ next: true, req, res }));
  // enforceQuota is async; give the 402 path a tick to resolve
  setTimeout(() => resolve({ next: false, req, res }), 50);
});

// ── plan catalog sanity ───────────────────────────────────────────────────────
assert.strictEqual(PLANS.reviewer.monthlyTokens, 2_000_000);
assert.strictEqual(PLANS.writer.monthlyTokens, 12_000_000);
assert.strictEqual(PLANS.studio.hardLimit, false, "studio must never hard-block");
assert.strictEqual(getPlan("nonsense").id, "trial", "unknown plan falls back to trial");
assert.match(monthKey(new Date("2026-07-02T10:00:00Z")), /^2026-07$/);
assert.strictEqual(describeUsage(PLANS.reviewer, 1_000_000, 0).percentUsed, 50);

// ── anonymous trial: allowed under cap, 402 over cap ─────────────────────────
store._resetForTests();
{
  const r1 = await run(fakeReq());
  assert.strictEqual(r1.next, true, "fresh trial caller passes");
  assert.strictEqual(r1.req.billing.plan.id, "trial");

  // burn the whole trial allowance
  recordUsage(r1.req, PLANS.trial.monthlyTokens);
  await new Promise((r) => setTimeout(r, 20)); // fire-and-forget write

  const r2 = await run(fakeReq());
  assert.strictEqual(r2.next, false, "over-cap trial caller is blocked");
  assert.strictEqual(r2.res.statusCode, 402);
  assert.strictEqual(r2.res.body.error.code, "QUOTA_EXCEEDED");
  assert.ok(r2.res.body.error.upgradeUrl, "402 carries an upgrade URL");
}

// ── licensed caller: store-backed license and plan quota ─────────────────────
store._resetForTests();
{
  await store.putLicense("gg_live_test1", { tenantId: "acme", plan: "reviewer", status: "active" });
  const { invalidateLicenseCache } = await import("../src/billing/quota.js");
  invalidateLicenseCache();

  const req = fakeReq({ authorization: "Bearer gg_live_test1" });
  const b = await resolveBilling(req);
  assert.strictEqual(b.licensed, true);
  assert.strictEqual(b.plan.id, "reviewer");
  assert.strictEqual(b.tenantId, "acme");

  // canceled licenses fall back to trial
  await store.putLicense("gg_live_dead", { tenantId: "x", plan: "writer", status: "canceled" });
  const b2 = await resolveBilling(fakeReq({ authorization: "Bearer gg_live_dead" }));
  assert.strictEqual(b2.licensed, false, "canceled license -> trial");
}

// ── boost credit extends the month's allowance ───────────────────────────────
store._resetForTests();
{
  const caller = "gg_live_boosty";
  await store.putLicense(caller, { tenantId: "t", plan: "reviewer", status: "active" });
  const { invalidateLicenseCache } = await import("../src/billing/quota.js");
  invalidateLicenseCache();

  await store.addUsage(caller, monthKey(), PLANS.reviewer.monthlyTokens); // cap reached
  const blocked = await run(fakeReq({ authorization: `Bearer ${caller}` }));
  assert.strictEqual(blocked.res.statusCode, 402, "at cap -> blocked");

  await store.addBoost(caller, monthKey(), BOOST_TOKENS); // deadline boost
  const allowed = await run(fakeReq({ authorization: `Bearer ${caller}` }));
  assert.strictEqual(allowed.next, true, "boost unblocks the same month");
}

// ── studio soft cap never blocks ─────────────────────────────────────────────
store._resetForTests();
{
  const caller = "gg_live_studio";
  await store.putLicense(caller, { tenantId: "agency", plan: "studio", status: "active" });
  const { invalidateLicenseCache } = await import("../src/billing/quota.js");
  invalidateLicenseCache();
  await store.addUsage(caller, monthKey(), PLANS.studio.monthlyTokens * 2); // way over
  const r = await run(fakeReq({ authorization: `Bearer ${caller}` }));
  assert.strictEqual(r.next, true, "studio is never hard-blocked");
}

// ── Paddle signature verification ────────────────────────────────────────────
{
  const raw = '{"event_type":"subscription.created"}';
  const ts = "1719999999";
  const h1 = crypto.createHmac("sha256", "whsec_test").update(`${ts}:${raw}`).digest("hex");
  assert.strictEqual(verifyPaddleSignature(raw, `ts=${ts};h1=${h1}`), true, "valid signature accepted");
  assert.strictEqual(verifyPaddleSignature(raw, `ts=${ts};h1=${"0".repeat(64)}`), false, "bad signature rejected");
  assert.strictEqual(verifyPaddleSignature(raw, null), false, "missing header rejected");
  assert.strictEqual(verifyPaddleSignature("tampered" + raw, `ts=${ts};h1=${h1}`), false, "tampered body rejected");
}

// ── requireTenantOrLicense: license key is a complete identity ────────────────
store._resetForTests();
{
  const { invalidateLicenseCache } = await import("../src/billing/quota.js");
  await store.putLicense("gg_live_ident", { tenantId: "acme", plan: "writer", status: "active" });
  invalidateLicenseCache();

  const runMw = (headers, body = {}, params = {}) =>
    new Promise((resolve) => {
      const req = { headers, body, params, ip: "203.0.113.9", socket: {} };
      const res = {
        statusCode: null,
        status(c) { this.statusCode = c; return this; },
        json() { resolve({ req, passed: false, status: this.statusCode }); return this; },
      };
      requireTenantOrLicense(req, res, () => resolve({ req, passed: true }));
    });

  // Licensed: tenant comes from the license, body/URL spoofing ignored.
  const a = await runMw({ authorization: "Bearer gg_live_ident" }, { tenantId: "EVIL" }, { id: "EVIL" });
  assert.strictEqual(a.passed, true);
  assert.strictEqual(a.req.tenantId, "acme", "license tenant beats body/param");

  // Unlicensed + auth off: legacy body fallback still works (trial/dev).
  process.env.AUTH_ENABLED = "false";
  const b = await runMw({}, { tenantId: "demo" }, {});
  assert.strictEqual(b.passed, true);
  assert.strictEqual(b.req.tenantId, "demo");

  // Unlicensed + auth on: 401.
  process.env.AUTH_ENABLED = "true";
  const c = await runMw({}, { tenantId: "demo" }, {});
  assert.strictEqual(c.passed, false);
  assert.strictEqual(c.status, 401, "auth on + no license -> 401");
  process.env.AUTH_ENABLED = "false";
}

console.log("PASS: billing tests");
