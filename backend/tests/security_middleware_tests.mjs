// Unit tests: rate limiter, app-token gate, admin fail-closed, request-log
// usage extraction. Pure-logic tests — no network, no server boot.

import assert from "node:assert";

// Deterministic env BEFORE importing modules that read env at module scope.
process.env.RATE_LIMIT_ENABLED = "true";
process.env.RATE_LIMIT_PER_MIN = "60"; // 1 token/second refill
process.env.RATE_LIMIT_BURST = "3";
process.env.RATE_LIMIT_DAILY = "5";
delete process.env.APP_TOKEN;
delete process.env.ADMIN_TOKEN;
delete process.env.TENANT_KEYS;
process.env.AUTH_ENABLED = "false";

const { consume, callerKey, _resetForTests } = await import("../src/middleware/rate-limit.js");
const { requireAdmin } = await import("../src/auth/auth.js");
const { extractUsage } = await import("../src/middleware/request-log.js");

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

// ── token bucket ──────────────────────────────────────────────────────────────
_resetForTests();
const t0 = 1_000_000;
assert.strictEqual(consume("k1", t0).ok, true, "1st request passes");
assert.strictEqual(consume("k1", t0).ok, true, "2nd request passes");
assert.strictEqual(consume("k1", t0).ok, true, "3rd request passes (burst=3)");
const denied = consume("k1", t0);
assert.strictEqual(denied.ok, false, "4th request within burst window is denied");
assert.strictEqual(denied.reason, "rate");
assert.ok(denied.retryAfterSec >= 1, "Retry-After is populated");
// refill: 60/min = 1 token/second -> 2s later, 2 tokens available
assert.strictEqual(consume("k1", t0 + 2000).ok, true, "token refilled after 2s");
// independent buckets per caller
assert.strictEqual(consume("k2", t0).ok, true, "different caller unaffected");

// ── daily quota ───────────────────────────────────────────────────────────────
_resetForTests();
let lastDaily;
for (let i = 0; i < 6; i++) {
  // space requests 10s apart so the bucket refills; only the daily cap binds
  lastDaily = consume("d1", t0 + i * 10_000);
}
assert.strictEqual(lastDaily.ok, false, "6th request exceeds RATE_LIMIT_DAILY=5");
assert.strictEqual(lastDaily.reason, "daily");

// ── callerKey: tenant beats IP, XFF first hop wins ───────────────────────────
const reqIp = { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } };
assert.strictEqual(callerKey(reqIp), "ip:203.0.113.9", "first XFF hop is the caller");
const reqNoHeaders = { headers: {}, ip: "198.51.100.4" };
assert.strictEqual(callerKey(reqNoHeaders), "ip:198.51.100.4", "falls back to req.ip");

// ── requireAdmin fails closed without ADMIN_TOKEN ────────────────────────────
{
  const res = fakeRes();
  let nextCalled = false;
  requireAdmin({ headers: {} }, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, "admin must not pass without ADMIN_TOKEN configured");
  assert.strictEqual(res.statusCode, 503, "admin endpoints disabled -> 503");
}

// ── usage extraction ──────────────────────────────────────────────────────────
assert.deepStrictEqual(
  extractUsage(JSON.stringify({ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } })),
  { promptTokens: 10, candidatesTokens: 5, totalTokens: 15 }
);
assert.strictEqual(extractUsage("not json"), null, "malformed body -> null, never throws");
assert.strictEqual(extractUsage(JSON.stringify({ candidates: [] })), null, "no usageMetadata -> null");

console.log("PASS: security middleware tests");
