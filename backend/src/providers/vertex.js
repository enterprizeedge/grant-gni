// Vertex AI provider — generation, embeddings, and reranking, all on one
// service-account auth and in your EU region. Dependency-free (fetch + gcp-auth).
// ---------------------------------------------------------------------------
//   generateContent : Gemini on Vertex (same body shape as the Gemini API, so the
//                     add-in's payload passes through unchanged).
//   embed           : gemini-embedding-001 :predict (independent of the LLM).
//   rank            : Discovery Engine Ranking API (semantic-ranker-default-004).
// ---------------------------------------------------------------------------

import { GCP } from "../config/knowledge.js";
import { getAccessToken, isConfigured as authConfigured } from "./gcp-auth.js";

function vertexBase(location = GCP.location) {
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${GCP.project}/locations/${location}/publishers/google/models`;
}

async function authedFetch(url, body) {
  const token = await getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res;
}

// ── LLM (drop-in for the resilience layer / server provider interface) ────────
export function createVertexProvider() {
  return {
    name: "vertex",
    isConfigured() {
      return authConfigured();
    },
    // model: e.g. "gemini-2.5-flash"; payload: Gemini generateContent body (verbatim).
    async generateContent(model, payload /*, signal */) {
      const safeModel = encodeURIComponent(model || GCP.genModel);
      const url = `${vertexBase()}/${safeModel}:generateContent`;
      try {
        const res = await authedFetch(url, payload);
        const body = await res.text();
        return { status: res.status, body };
      } catch (err) {
        return { status: 502, body: JSON.stringify({ error: { message: err.message } }) };
      }
    },
  };
}

// ── Embeddings (gemini-embedding-001) ─────────────────────────────────────────
// taskType: "RETRIEVAL_DOCUMENT" (ingest) | "RETRIEVAL_QUERY" (search)
export async function vertexEmbed(texts, { taskType = null } = {}) {
  const model = GCP.embedModel;
  const url = `${vertexBase()}/${encodeURIComponent(model)}:predict`;
  const out = [];
  // Vertex :predict accepts a small batch of instances; keep batches modest.
  const BATCH = 5;
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const body = {
      instances: slice.map((content) => ({
        content,
        ...(taskType ? { task_type: taskType } : {}),
      })),
      parameters: {
        outputDimensionality: GCP.embedDim,
        autoTruncate: true,
      },
    };
    const res = await authedFetch(url, body);
    if (!res.ok) {
      throw new Error(`Vertex embeddings failed (${res.status}): ${await res.text()}`);
    }
    const json = await res.json();
    for (const p of json.predictions || []) {
      out.push((p.embeddings && p.embeddings.values) || p.embeddings || []);
    }
  }
  return out;
}

export function vertexEmbedProvider() {
  return {
    name: "vertex",
    model: GCP.embedModel,
    dim: GCP.embedDim,
    isConfigured: () => authConfigured(),
    embed: (texts, opts) => vertexEmbed(texts, opts),
  };
}

// ── Reranking (Discovery Engine Ranking API) ──────────────────────────────────
// records: [{ id, text }]; returns the same records re-ordered with .score, top N.
export async function vertexRank(query, records, { topN = 5 } = {}) {
  if (!records || records.length === 0) return [];
  const url =
    `https://discoveryengine.googleapis.com/v1/projects/${GCP.project}` +
    `/locations/${GCP.rankLocation}/rankingConfigs/default_ranking_config:rank`;
  const body = {
    model: GCP.rankModel,
    query,
    topN,
    ignoreRecordDetailsInResponse: true,
    records: records.map((r, i) => ({
      id: String(r.id ?? i),
      content: r.text || r.content || "",
    })),
  };
  const token = await getAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Reranking is a quality booster, not a hard dependency: on failure, fall back
    // to the pre-rank order so Review/drafting still work.
    console.warn(`[vertex] rank failed (${res.status}): ${await res.text()}`);
    return records.slice(0, topN).map((r, i) => ({ ...r, score: 1 - i * 0.01 }));
  }
  const json = await res.json();
  const byId = new Map(records.map((r, i) => [String(r.id ?? i), r]));
  return (json.records || [])
    .map((rr) => ({ ...(byId.get(String(rr.id)) || {}), score: rr.score }))
    .slice(0, topN);
}
