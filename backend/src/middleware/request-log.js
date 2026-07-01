// Structured request logging — one JSON line per request (Cloud Logging picks
// these up as structured entries, so you can filter/alert on any field).
// ---------------------------------------------------------------------------
// Fields: ts, method, path, status, ms, caller (tenant:x or ip:x), model,
//         modelUsed (set by /api/generate on fallback), usage (token counts
//         when the provider response includes usageMetadata).
//
// Spend/abuse visibility with zero dependencies. For real billing, feed the
// same events into BigQuery or a metering service later.
// ---------------------------------------------------------------------------

export function requestLog(req, res, next) {
  const started = Date.now();
  res.on("finish", () => {
    // Health checks are noise; skip them.
    if (req.path === "/health") return;
    const entry = {
      severity: res.statusCode >= 500 ? "ERROR" : res.statusCode >= 400 ? "WARNING" : "INFO",
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
      caller: req.callerKey || null,
      model: (req.query && req.query.model) || null,
      modelUsed: res.getHeader("X-Model-Used") || null,
      usage: res.locals.usage || null, // { promptTokens, candidatesTokens, totalTokens }
    };
    try {
      console.log(JSON.stringify(entry));
    } catch {
      /* never let logging break a request */
    }
  });
  next();
}

// Extract token usage from a Gemini/Vertex generateContent response body (text).
// Returns null when unavailable — callers stash the result on res.locals.usage.
export function extractUsage(bodyText) {
  try {
    const parsed = JSON.parse(bodyText);
    const u = parsed && parsed.usageMetadata;
    if (!u) return null;
    return {
      promptTokens: u.promptTokenCount ?? null,
      candidatesTokens: u.candidatesTokenCount ?? null,
      totalTokens: u.totalTokenCount ?? null,
    };
  } catch {
    return null;
  }
}
