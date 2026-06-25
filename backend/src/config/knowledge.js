// Central configuration for the knowledge layer (tiers, collections, GCP, Qdrant).
// ---------------------------------------------------------------------------
// THREE KNOWLEDGE TIERS (the security backbone of the product):
//
//   tier 1  PUBLIC   call/programme text, public guidelines.
//                    No protection. Citable to clients. Collection: kb_public.
//
//   tier 2  IP       YOUR templates + drafting/review skills. This is your IP.
//                    SERVER-ONLY: used to ground drafting AND review prompts, but
//                    the raw text is NEVER returned in any client-facing response.
//                    Collection: kb_ip.
//
//   tier 3  CLIENT   a client's own winning proposals / guidelines. Private to that
//                    client, visible + deletable only by them (GDPR). Every query is
//                    forced to filter tenant_id. Collection: kb_clients.
//
// All three tiers feed BOTH drafting and review. The stage only changes the skill
// injected into the prompt, not which tiers are retrieved.
// ---------------------------------------------------------------------------

export const TIER = Object.freeze({
  PUBLIC: 1, // tier 1
  IP: 2, // tier 2 (server-only)
  CLIENT: 3, // tier 3 (tenant-private)
});

export const COLLECTIONS = Object.freeze({
  [TIER.PUBLIC]: process.env.QDRANT_COLLECTION_PUBLIC || "kb_public",
  [TIER.IP]: process.env.QDRANT_COLLECTION_IP || "kb_ip",
  [TIER.CLIENT]: process.env.QDRANT_COLLECTION_CLIENTS || "kb_clients",
});

// Tiers whose raw text may be surfaced to the client (citations, snippets).
// tier 2 is deliberately excluded — it is used in prompts but never returned.
export const CLIENT_VISIBLE_TIERS = Object.freeze([TIER.PUBLIC, TIER.CLIENT]);

// Canonical metadata (payload) schema written on every chunk.
//   tier, tenantId, programme, cluster, topic, trl, country,
//   callId, docType, section, source, fileId, chunkIndex,
//   embedModel, embedDim, createdAt
export function buildPayload(base = {}) {
  return {
    tier: base.tier ?? null,
    tenantId: base.tenantId ?? null, // only set for tier 3
    programme: base.programme ?? base.program ?? null,
    cluster: base.cluster ?? null,
    topic: base.topic ?? null,
    trl: base.trl ?? null,
    country: base.country ?? null,
    callId: base.callId ?? null,
    docType: base.docType ?? null,
    section: base.section ?? null,
    source: base.source ?? null,
    fileId: base.fileId ?? null,
    chunkIndex: base.chunkIndex ?? null,
    text: base.text ?? "", // stored so retrieval + rerank have the passage
    embedModel: base.embedModel ?? null,
    embedDim: base.embedDim ?? null,
    createdAt: base.createdAt ?? new Date().toISOString(),
  };
}

// ── Backend selection ────────────────────────────────────────────────────────
// KB_BACKEND = "file" (default, legacy JSON store) | "qdrant" (production).
export const KB_BACKEND = (process.env.KB_BACKEND || "file").toLowerCase();
export const USE_QDRANT = KB_BACKEND === "qdrant";

// ── GCP / Vertex ─────────────────────────────────────────────────────────────
export const GCP = Object.freeze({
  project: process.env.GCP_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "grant-gni",
  // Region for Vertex generate/embeddings. If a model is not served in this region,
  // set VERTEX_LOCATION to one that has it (or "global").
  location: process.env.VERTEX_LOCATION || process.env.GCP_REGION || "europe-west1",
  // The Discovery Engine Ranking API is addressed at "global".
  rankLocation: process.env.VERTEX_RANK_LOCATION || "global",
  rankModel: process.env.VERTEX_RANK_MODEL || "semantic-ranker-default-004",
  genModel: process.env.VERTEX_GEN_MODEL || "gemini-2.5-flash",
  embedModel: process.env.EMBED_MODEL || "gemini-embedding-001",
  embedDim: Number(process.env.EMBED_DIM) || 1536,
});

// ── Qdrant ───────────────────────────────────────────────────────────────────
// Cluster lives in europe-west3 (Frankfurt); credentials come from Secret Manager.
export const QDRANT = Object.freeze({
  url: (process.env.QDRANT_URL || "").replace(/\/+$/, ""),
  apiKey: process.env.QDRANT_API_KEY || "",
  // distance metric for normalized embeddings
  distance: process.env.QDRANT_DISTANCE || "Cosine",
});

export function assertQdrantConfigured() {
  if (!QDRANT.url || !QDRANT.apiKey) {
    throw new Error(
      "Qdrant is not configured. Set QDRANT_URL and QDRANT_API_KEY (from Secret Manager)."
    );
  }
}
