// Unit tests: invoice-mode admin license lifecycle
// create -> use quota -> deadline upgrade -> boost -> revoke.

import assert from "node:assert";

process.env.BILLING_STORE = "memory";
process.env.AUTH_ENABLED = "false";
delete process.env.TENANT_KEYS;

const { PLANS, monthKey } = await import("../src/billing/plans.js");
const store = await import("../src/billing/store.js");
const { resolveBilling, invalidateLicenseCache } = await import("../src/billing/quota.js");
const admin = await import("../src/billing/admin.js");

function fakeReq(body = {}, params = {}, headers = {}) {
  return { body, params, headers, ip: "198.51.100.1", socket: {} };
}
function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

store._resetForTests();

// ── create ────────────────────────────────────────────────────────────────────
let key;
{
  const res = fakeRes();
  await admin.createLicenseHandler(fakeReq({ plan: "reviewer", tenantId: "Acme Consulting!", note: "INV-1" }), res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(res.body.key.startsWith("gg_live_"), "mints a gg_live_ key");
  assert.strictEqual(res.body.license.plan, "reviewer");
  assert.strictEqual(res.body.license.tenantId, "Acme_Consulting_", "tenantId sanitized");
  key = res.body.key;
}
{
  const res = fakeRes();
  await admin.createLicenseHandler(fakeReq({ plan: "trial" }), res);
  assert.strictEqual(res.statusCode, 400, "cannot mint trial licenses");
  const res2 = fakeRes();
  await admin.createLicenseHandler(fakeReq({ plan: "platinum" }), res2);
  assert.strictEqual(res2.statusCode, 400, "unknown plan rejected");
}

// ── the minted key resolves to its plan ──────────────────────────────────────
{
  invalidateLicenseCache();
  const b = await resolveBilling(fakeReq({}, {}, { authorization: `Bearer ${key}` }));
  assert.strictEqual(b.licensed, true);
  assert.strictEqual(b.plan.id, "reviewer");
}

// ── deadline upgrade: reviewer -> studio, effective immediately ──────────────
{
  const res = fakeRes();
  await admin.updateLicenseHandler(fakeReq({ plan: "studio" }, { key }), res);
  assert.strictEqual(res.body.license.plan, "studio");
  const b = await resolveBilling(fakeReq({}, {}, { authorization: `Bearer ${key}` }));
  assert.strictEqual(b.plan.id, "studio", "cache invalidated -> new plan live");
}

// ── boost credits the current month ──────────────────────────────────────────
{
  const res = fakeRes();
  await admin.boostLicenseHandler(fakeReq({}, { key }), res);
  assert.strictEqual(res.body.credited, 5_000_000);
  const usage = await store.getUsage(key, monthKey());
  assert.strictEqual(usage.extraTokens, 5_000_000);
}

// ── list shows the license with usage ────────────────────────────────────────
{
  const res = fakeRes();
  await admin.listLicensesHandler(fakeReq(), res);
  assert.strictEqual(res.body.count, 1);
  assert.strictEqual(res.body.licenses[0].key, key);
  assert.strictEqual(res.body.licenses[0].usage.plan, "studio");
  assert.strictEqual(res.body.licenses[0].usage.boostTokens, 5_000_000);
}

// ── revoke: canceled key falls back to trial ─────────────────────────────────
{
  const res = fakeRes();
  await admin.updateLicenseHandler(fakeReq({ status: "canceled" }, { key }), res);
  assert.strictEqual(res.body.license.status, "canceled");
  const b = await resolveBilling(fakeReq({}, {}, { authorization: `Bearer ${key}` }));
  assert.strictEqual(b.licensed, false, "revoked key no longer licensed");
  assert.strictEqual(b.plan.id, "trial");
}

// ── 404s ─────────────────────────────────────────────────────────────────────
{
  const res = fakeRes();
  await admin.updateLicenseHandler(fakeReq({ plan: "writer" }, { key: "gg_live_nope" }), res);
  assert.strictEqual(res.statusCode, 404);
}

console.log("PASS: admin license (invoice-mode) tests");
