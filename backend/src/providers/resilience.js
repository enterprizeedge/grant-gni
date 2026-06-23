// LLM resilience layer.
// ---------------------------------------------------------------------------
// Wraps provider.generateContent with two protections against transient upstream
// failures (the Gemini "503 UNAVAILABLE / model is currently experiencing high
// demand" being the main one clients were seeing):
//
//   1. Retry the SAME model a few times with exponential backoff + jitter.
//   2. If it still fails, FALL BACK to the next model in a configured chain.
//
// Used by BOTH /api/generate (chat) and the Advisor (Review), so a spike in
// demand degrades gracefully instead of surfacing a raw 503 to the end user.
// ---------------------------------------------------------------------------

// HTTP statuses worth retrying / falling back on (overloaded or transient).
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Build the model attempt order: the requested model first, then any configured
// fallbacks that aren't already the requested one.
export function buildModelChain(requestedModel, env = process.env) {
  const primary = requestedModel || env.DEFAULT_MODEL || "gemini-flash-latest";
  const fallbacks = parseList(
    env.LLM_FALLBACK_MODELS || "gemini-2.5-flash,gemini-flash-latest,gemini-2.5-flash-lite"
  );
  const chain = [primary, ...fallbacks];
  // De-dupe while preserving order.
  return [...new Set(chain)];
}

function isRetryableBody(status, body) {
  if (RETRYABLE_STATUS.has(status)) return true;
  // Some upstream errors arrive as 200/4xx wrappers containing an UNAVAILABLE code.
  if (typeof body === "string" && /UNAVAILABLE|high demand|overloaded|RESOURCE_EXHAUSTED/i.test(body)) {
    return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// generateWithFallback({ provider, model, payload, signal, env })
//   -> { status, body, modelUsed, attempts }
// Always resolves with the last response (never throws on upstream errors), so
// callers keep their existing status-code handling.
export async function generateWithFallback({
  provider,
  model,
  payload,
  signal,
  env = process.env,
  retriesPerModel = Number(env.LLM_RETRIES_PER_MODEL) || 2,
  baseDelayMs = Number(env.LLM_RETRY_BASE_MS) || 600,
}) {
  const chain = buildModelChain(model, env);
  let last = { status: 503, body: '{"error":{"message":"No model attempted"}}', modelUsed: chain[0] };
  let attempts = 0;

  for (const m of chain) {
    for (let i = 0; i <= retriesPerModel; i++) {
      attempts += 1;
      try {
        const { status, body } = await provider.generateContent(m, payload, signal);
        if (status >= 200 && status < 300) {
          return { status, body, modelUsed: m, attempts };
        }
        last = { status, body, modelUsed: m };
        if (!isRetryableBody(status, body)) {
          // Non-transient (e.g. 400 bad request) — don't waste fallbacks on it.
          return { ...last, attempts };
        }
      } catch (err) {
        // Network-level failure — treat as retryable/transient.
        last = { status: 503, body: JSON.stringify({ error: { message: err.message } }), modelUsed: m };
      }
      // Backoff before the next attempt on this model (skip after the last try).
      if (i < retriesPerModel) {
        const delay = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 250);
        await sleep(delay);
      }
    }
    // Exhausted this model — log and move to the next in the chain.
    console.warn(`[resilience] model "${m}" exhausted (last status ${last.status}); trying fallback.`);
  }

  return { ...last, attempts };
}
