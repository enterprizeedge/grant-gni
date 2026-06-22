// Embeddings — swappable providers.
// 'local'  : deterministic, offline, no key. Bag-of-words feature-hashing into a
//            fixed-dim L2-normalised vector. Good enough to prove retrieval in dev.
// 'gemini' : real semantic embeddings via Google (uses the backend's key).
//
// Vertex AI embeddings slot in later as a third provider with the same interface.

const LOCAL_DIM = 256;

function hashToken(token) {
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function localEmbed(text) {
  const vec = new Array(LOCAL_DIM).fill(0);
  const tokens = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
  for (const tok of tokens) {
    const idx = hashToken(tok) % LOCAL_DIM;
    const sign = (hashToken(tok + "#") & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  // L2 normalise
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function createLocalProvider() {
  return {
    name: "local",
    dim: LOCAL_DIM,
    isConfigured: () => true,
    async embed(texts) {
      return texts.map(localEmbed);
    },
  };
}

function createGeminiProvider({ apiKey, apiBase, model }) {
  const base = (apiBase || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const m = model || "text-embedding-004";
  return {
    name: "gemini",
    dim: 768, // text-embedding-004
    isConfigured: () => Boolean(apiKey),
    async embed(texts) {
      // Sequential to stay well under rate limits for a dev-sized corpus.
      const out = [];
      for (const text of texts) {
        const url = `${base}/models/${m}:embedContent?key=${apiKey}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: `models/${m}`,
            content: { parts: [{ text }] },
          }),
        });
        if (!res.ok) {
          throw new Error(`Gemini embeddings failed (${res.status}): ${await res.text()}`);
        }
        const json = await res.json();
        out.push(json.embedding.values);
      }
      return out;
    },
  };
}

export function createEmbeddingProvider(env = process.env) {
  const which = (env.EMBED_PROVIDER || "local").toLowerCase();
  if (which === "gemini") {
    return createGeminiProvider({
      apiKey: env.GEMINI_API_KEY,
      apiBase: env.GEMINI_API_BASE,
      model: env.EMBED_MODEL,
    });
  }
  return createLocalProvider();
}

export function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
