// Unit tests: model fallback chain + retry behaviour of the resilience layer.

import assert from "node:assert";
import { buildModelChain, generateWithFallback } from "../src/providers/resilience.js";

// ── buildModelChain ───────────────────────────────────────────────────────────
{
  const env = { LLM_FALLBACK_MODELS: "b,c", DEFAULT_MODEL: "a" };
  assert.deepStrictEqual(buildModelChain("x", env), ["x", "b", "c"], "requested model first");
  assert.deepStrictEqual(buildModelChain("b", env), ["b", "c"], "de-dupes requested model");
  assert.deepStrictEqual(buildModelChain(null, env), ["a", "b", "c"], "falls back to DEFAULT_MODEL");
}

// ── generateWithFallback: success on first try ───────────────────────────────
{
  const provider = {
    async generateContent(model) {
      return { status: 200, body: JSON.stringify({ ok: true, model }) };
    },
  };
  const r = await generateWithFallback({
    provider, model: "m1", payload: {},
    env: { LLM_FALLBACK_MODELS: "m2" }, retriesPerModel: 0, baseDelayMs: 1,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.modelUsed, "m1");
  assert.strictEqual(r.attempts, 1);
}

// ── falls back to next model on 503 ──────────────────────────────────────────
{
  const calls = [];
  const provider = {
    async generateContent(model) {
      calls.push(model);
      if (model === "m1") return { status: 503, body: '{"error":{"message":"UNAVAILABLE"}}' };
      return { status: 200, body: "{}" };
    },
  };
  const r = await generateWithFallback({
    provider, model: "m1", payload: {},
    env: { LLM_FALLBACK_MODELS: "m2" }, retriesPerModel: 1, baseDelayMs: 1,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.modelUsed, "m2");
  assert.deepStrictEqual(calls, ["m1", "m1", "m2"], "retries m1 then falls back to m2");
}

// ── non-retryable 400 returns immediately, no fallback burn ──────────────────
{
  const calls = [];
  const provider = {
    async generateContent(model) {
      calls.push(model);
      return { status: 400, body: '{"error":{"message":"bad request"}}' };
    },
  };
  const r = await generateWithFallback({
    provider, model: "m1", payload: {},
    env: { LLM_FALLBACK_MODELS: "m2" }, retriesPerModel: 2, baseDelayMs: 1,
  });
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(calls, ["m1"], "400 is not retried and does not fall back");
}

// ── network throw is treated as transient ────────────────────────────────────
{
  let n = 0;
  const provider = {
    async generateContent() {
      n++;
      if (n < 2) throw new Error("ECONNRESET");
      return { status: 200, body: "{}" };
    },
  };
  const r = await generateWithFallback({
    provider, model: "m1", payload: {},
    env: { LLM_FALLBACK_MODELS: "" }, retriesPerModel: 2, baseDelayMs: 1,
  });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.attempts, 2, "network error retried");
}

console.log("PASS: resilience tests");
