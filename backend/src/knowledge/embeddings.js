// Embeddings — a standalone layer, deliberately decoupled from the LLM.
// ---------------------------------------------------------------------------
// WHY THIS IS SEPARATE FROM THE LLM:
//   The chat/Review LLM (LLM_PROVIDER / model query-param) and the embedding
//   model (EMBED_PROVIDER / EMBED_MODEL) are configured independently. Changing
//   or swapping the LLM has ZERO effect on the vectors stored in the vector DB.
//   The only thing that must stay consistent is the *embedding* model: the query
//   embedding and the stored document embeddings must come from the same model
//   and dimensionality. The vector store records which model/dim produced it
//   (see vector-store meta + the dim guard in retriever.js), so a mismatch is
//   detected instead of silently degrading retrieval.
//
// PROVIDERS:
//   'local'  : deterministic, offline, no key. Feature-hashed bag-of-words.
//              For dev/tests only — low quality, but lets retrieval run with no key.
//   'gemini' : Google's text embeddings. Default model `gemini-embedding-001`
//              (state-of-the-art on the MTEB multilingual leaderboard), with
//              Matryoshka output dims (768 / 1536 / 3072) selectable via EMBED_DIM.
//
// To switch the vector DB backend later (pgvector / Vertex AI Vector Search),
// only vector-store.js changes — this file's interface stays the same.
// ---------------------------------------------------------------------------

import { vertexEmbedProvider } from "../providers/vertex.js";

const LOCAL_DIM = 256;

// Known native output dimensionality per Gemini embedding model. gemini-embedding-001
// defaults to 3072 but supports Matryoshka truncation to smaller sizes.
const GEMINI_DEFAULT_DIMS = {
  "gemini-embedding-001": 3072,
  "text-embedding-004": 768,
};

function l2normalize(vec) {
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

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
  return l2normalize(vec);
}

function createLocalProvider() {
  return {
    name: "local",
    model: "local-hash",
    dim: LOCAL_DIM,
    isConfigured: () => true,
    async embed(texts) {
      return texts.map(localEmbed);
    },
  };
}

function createGeminiProvider({ apiKey, apiBase, model, dim }) {
  const base = (apiBase || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
  const m = model || "gemini-embedding-001";
  const nativeDim = GEMINI_DEFAULT_DIMS[m] || 3072;
  // Optional Matryoshka truncation. Only sent when smaller than the native dim.
  const outputDim = dim && dim > 0 && dim < nativeDim ? dim : nativeDim;

  return {
    name: "gemini",
    model: m,
    dim: outputDim,
    isConfigured: () => Boolean(apiKey),
    // texts: string[]; opts.taskType: "RETRIEVAL_DOCUMENT" (ingest) | "RETRIEVAL_QUERY" (search)
    async embed(texts, opts = {}) {
      const taskType = opts.taskType || null;
      const out = [];
      // Sequential keeps us well under rate limits for a dev-sized corpus.
      for (const text of texts) {
        const url = `${base}/models/${m}:embedContent?key=${apiKey}`;
        const reqBody = {
          model: `models/${m}`,
          content: { parts: [{ text }] },
        };
        if (taskType) reqBody.taskType = taskType;
        if (outputDim < nativeDim) reqBody.outputDimensionality = outputDim;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
        });
        if (!res.ok) {
          throw new Error(`Gemini embeddings failed (${res.status}): ${await res.text()}`);
        }
        const json = await res.json();
        let values = json.embedding.values;
        // Google recommends re-normalising when a non-native dimensionality is used.
        if (outputDim < nativeDim) values = l2normalize(values);
        out.push(values);
      }
      return out;
    },
  };
}

export function createEmbeddingProvider(env = process.env) {
  const which = (env.EMBED_PROVIDER || "local").toLowerCase();
  if (which === "vertex") {
    // Vertex AI gemini-embedding-001. Same { name, model, dim, isConfigured, embed }
    // interface; independent of the chat/Review LLM.
    return vertexEmbedProvider();
  }
  if (which === "gemini") {
    return createGeminiProvider({
      apiKey: env.GEMINI_API_KEY,
      apiBase: env.GEMINI_API_BASE,
      model: env.EMBED_MODEL || "gemini-embedding-001",
      dim: Number(env.EMBED_DIM) || 0,
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
