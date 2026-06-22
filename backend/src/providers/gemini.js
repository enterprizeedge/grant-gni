// Gemini provider — v1.
// Forwards a Gemini-shaped generateContent payload to Google and returns the
// raw JSON response unchanged, so the add-in's existing response parsing keeps
// working untouched. The server-side API key is injected here and never leaves
// the backend.

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export function createGeminiProvider({ apiKey, apiBase }) {
  if (!apiKey) {
    console.warn(
      "[gemini] GEMINI_API_KEY is empty — /api/generate will return 502 until it is set in backend/.env"
    );
  }
  const base = (apiBase || DEFAULT_BASE).replace(/\/+$/, "");

  return {
    name: "gemini",
    isConfigured() {
      return Boolean(apiKey);
    },
    // model: string (e.g. "gemini-flash-latest")
    // payload: the Gemini generateContent request body, passed through verbatim
    async generateContent(model, payload, signal) {
      const safeModel = encodeURIComponent(model || "gemini-flash-latest");
      const url = `${base}/models/${safeModel}:generateContent?key=${apiKey}`;
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const text = await upstream.text();
      return { status: upstream.status, body: text };
    },
  };
}
