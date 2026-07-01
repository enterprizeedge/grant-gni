// Per-caller rate limiting + daily quota — dependency-free, in-memory.
// ---------------------------------------------------------------------------
// Protects the public LLM proxy from drive-by abuse and runaway spend.
//
//   - Token bucket per caller: RATE_LIMIT_PER_MIN requests/min sustained,
//     bursts up to RATE_LIMIT_BURST.
//   - Daily quota per caller: RATE_LIMIT_DAILY requests/UTC-day.
//   - Caller identity: the resolved tenant (Authorization bearer key) when
//     available, otherwise the client IP (first X-Forwarded-For hop — Cloud Run
//     sets this header from the real connection).
//
// KNOWN LIMITATION: counters are per Cloud Run instance. With N instances the
// effective limit is up to N× the configured value. That is acceptable as an
// abuse brake (instances are few and scale with legitimate load); move to a
// shared store (Redis / Firestore) when limits must be exact for billing.
//
// Config (env):
//   RATE_LIMIT_ENABLED  = "true" (default) | "false"
//   RATE_LIMIT_PER_MIN  = sustained requests/minute per caller   (default 10)
//   RATE_LIMIT_BURST    = bucket capacity (burst size)           (default 20)
//   RATE_LIMIT_DAILY    = requests per caller per UTC day        (default 500)
// ---------------------------------------------------------------------------

import { resolveTenant } from "../auth/auth.js";

const ENABLED = String(process.env.RATE_LIMIT_ENABLED || "true").toLowerCase() === "true";
const PER_MIN = Math.max(1, Number(process.env.RATE_LIMIT_PER_MIN) || 10);
const BURST = Math.max(1, Number(process.env.RATE_LIMIT_BURST) || 20);
const DAILY = Math.max(1, Number(process.env.RATE_LIMIT_DAILY) || 500);

// callerKey -> { tokens, lastRefillMs, day, dayCount }
const buckets = new Map();

// Periodically drop idle entries so the map can't grow unbounded.
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const IDLE_EVICT_MS = 60 * 60 * 1000;
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now - b.lastRefillMs > IDLE_EVICT_MS) buckets.delete(key);
  }
}, SWEEP_EVERY_MS);
sweeper.unref(); // never keep the process alive just for the sweeper

export function callerKey(req) {
  const tenant = resolveTenant(req);
  if (tenant) return `tenant:${tenant}`;
  const xff = String(req.headers["x-forwarded-for"] || "");
  const ip = xff.split(",")[0].trim() || req.ip || req.socket?.remoteAddress || "unknown";
  return `ip:${ip}`;
}

function utcDay() {
  return new Date().toISOString().slice(0, 10);
}

// Returns { ok, retryAfterSec?, reason? } and mutates the caller's bucket.
export function consume(key, now = Date.now()) {
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: BURST, lastRefillMs: now, day: utcDay(), dayCount: 0 };
    buckets.set(key, b);
  }

  // Reset the daily counter on UTC day rollover.
  const day = utcDay();
  if (b.day !== day) {
    b.day = day;
    b.dayCount = 0;
  }
  if (b.dayCount >= DAILY) {
    return { ok: false, reason: "daily", retryAfterSec: 3600 };
  }

  // Refill the token bucket.
  const elapsedMin = (now - b.lastRefillMs) / 60000;
  b.tokens = Math.min(BURST, b.tokens + elapsedMin * PER_MIN);
  b.lastRefillMs = now;

  if (b.tokens < 1) {
    const retryAfterSec = Math.ceil(((1 - b.tokens) / PER_MIN) * 60);
    return { ok: false, reason: "rate", retryAfterSec };
  }

  b.tokens -= 1;
  b.dayCount += 1;
  return { ok: true };
}

// Express middleware.
export function rateLimit(req, res, next) {
  if (!ENABLED) return next();
  const key = callerKey(req);
  const result = consume(key);
  if (result.ok) {
    req.callerKey = key; // reused by request logging
    return next();
  }
  res.setHeader("Retry-After", String(result.retryAfterSec));
  const message =
    result.reason === "daily"
      ? "Daily request quota reached. Please try again tomorrow or contact support for a higher limit."
      : "Too many requests. Please slow down and try again shortly.";
  return res.status(429).json({ error: { message, code: "RATE_LIMITED" } });
}

// Test/inspection hook.
export function _resetForTests() {
  buckets.clear();
}
