// Production knowledge layer (Qdrant + Vertex). Tier-aware ingestion and the
// retrieval orchestrator used by BOTH drafting and review.
// ---------------------------------------------------------------------------
// Retrieval per request:
//   tier 1 (public)  : kb_public, no filter beyond metadata
//   tier 2 (IP)      : kb_ip, SERVER-ONLY — included in the prompt, never returned
//   tier 3 (client)  : kb_clients, FORCED filter tenantId === caller's tenant
//   -> merge -> Vertex rerank -> top-k
//   -> { promptContext (all tiers), citations (client-visible tiers only) }
// ---------------------------------------------------------------------------

import crypto from "node:crypto";

import { TIER, COLLECTIONS, CLIENT_VISIBLE_TIERS, GCP, buildPayload } from "../config/knowledge.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { chunkDocument } from "./chunk.js";
import { vertexRank } from "../providers/vertex.js";
import * as qdrant from "./stores/qdrant-store.js";

let embedderSingleton = null;
function embedder() {
  if (!embedderSingleton) embedderSingleton = createEmbeddingProvider();
  return embedderSingleton;
}

// Qdrant point IDs must be UUIDs or unsigned ints. Derive a stable UUID from the
// logical id so re-ingesting the same chunk overwrites rather than duplicates.
function uuidFrom(logicalId) {
  const h = crypto.createHash("sha1").update(String(logicalId)).digest("hex");
  return (
    `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-` +
    `${h.slice(16, 20)}-${h.slice(20, 32)}`
  );
}

export async function ensureCollections({ recreate = false } = {}) {
  const dim = embedder().dim || GCP.embedDim;
  await qdrant.ensureCollection(COLLECTIONS[TIER.PUBLIC], dim, { recreate });
  await qdrant.ensureCollection(COLLECTIONS[TIER.IP], dim, { recreate });
  await qdrant.ensureCollection(COLLECTIONS[TIER.CLIENT], dim, { tenantIndex: true, recreate });
  return { dim, collections: COLLECTIONS };
}

// Ingest raw text into a tier. For tier 3, tenantId is REQUIRED.
//   meta: { programme, docType, section, callId, cluster, topic, trl, country, source }
export async function ingestText({ tier, tenantId = null, filename, text, meta = {} }) {
  if (!text || !text.trim()) throw new Error("No extractable text to ingest.");
  if (tier === TIER.CLIENT && !tenantId) throw new Error("tenantId is required for tier-3 ingestion.");

  const collection = COLLECTIONS[tier];
  if (!collection) throw new Error(`Unknown tier: ${tier}`);

  const emb = embedder();
  const fileId = `${tier === TIER.CLIENT ? tenantId + ":" : ""}${filename || "document"}`;
  const chunks = chunkDocument(text, fileId);
  const vectors = await emb.embed(
    chunks.map((c) => c.text),
    { taskType: "RETRIEVAL_DOCUMENT" }
  );

  const points = chunks.map((c, i) => {
    const logicalId = `${tier}:${fileId}#${c.metadata.chunkIndex}`;
    return {
      id: uuidFrom(logicalId),
      vector: vectors[i],
      payload: buildPayload({
        tier,
        tenantId: tier === TIER.CLIENT ? tenantId : null,
        programme: meta.programme || meta.program || c.metadata.program || null,
        cluster: meta.cluster ?? null,
        topic: meta.topic ?? null,
        trl: meta.trl ?? null,
        country: meta.country ?? null,
        callId: meta.callId || c.metadata.callId || null,
        docType: meta.docType || c.metadata.docType || null,
        section: meta.section || c.metadata.section || null,
        source: meta.source || filename || fileId,
        fileId,
        chunkIndex: c.metadata.chunkIndex,
        text: c.text,
        embedModel: emb.model,
        embedDim: emb.dim,
      }),
    };
  });

  await qdrant.ensureCollection(collection, emb.dim, { tenantIndex: tier === TIER.CLIENT });
  await qdrant.upsert(collection, points);
  return { tier, tenantId, filename, chunks: points.length, collection };
}

// One grounded retrieval across all tiers for a tenant.
export async function retrieveGrounded({
  query,
  tenantId = null,
  filters = {},
  topKPerTier = 10,
  finalTopK = 6,
}) {
  const emb = embedder();
  const [vector] = await emb.embed([query], { taskType: "RETRIEVAL_QUERY" });

  const tag = (hits, tier) =>
    hits.map((h) => ({
      id: h.id,
      tier,
      score: h.score,
      text: (h.payload && h.payload.text) || "",
      source: (h.payload && h.payload.source) || null,
      docType: (h.payload && h.payload.docType) || null,
      section: (h.payload && h.payload.section) || null,
    }));

  // programme is a HARD filter (+ tenantId for tier 3). The rest are SOFT filters
  // (match the value OR the field is absent), so setting e.g. cluster=4 prefers
  // cluster-4 docs without dropping untagged templates/exemplars.
  const { programme = null, ...softAll } = filters || {};

  // Run one search pass across all tiers. `soft` lets us drop optional filters on retry.
  async function gather(soft) {
    const filterFor = (tenant) =>
      qdrant.buildFilter({
        hard: { programme, ...(tenant ? { tenantId: tenant } : {}) },
        soft,
      });
    const [pub, ip, client] = await Promise.all([
      qdrant.search(COLLECTIONS[TIER.PUBLIC], vector, { topK: topKPerTier, filter: filterFor(null) }).catch(() => []),
      qdrant.search(COLLECTIONS[TIER.IP], vector, { topK: topKPerTier, filter: filterFor(null) }).catch(() => []),
      tenantId
        ? qdrant
            .search(COLLECTIONS[TIER.CLIENT], vector, { topK: topKPerTier, filter: filterFor(tenantId) })
            .catch(() => [])
        : Promise.resolve([]),
    ]);
    return [...tag(pub, TIER.PUBLIC), ...tag(ip, TIER.IP), ...tag(client, TIER.CLIENT)].filter((c) => c.text);
  }

  // SAFETY FALLBACK: if the optional filters were so specific that nothing matched
  // (e.g. cluster=4 when every doc is cluster=5), retry with programme only.
  let candidates = await gather(softAll);
  const softKeys = Object.keys(softAll).filter((k) => softAll[k] != null);
  if (candidates.length === 0 && softKeys.length > 0) {
    candidates = await gather({});
  }

  if (candidates.length === 0) {
    return { promptContext: [], citations: [] };
  }

  // Rerank the merged candidate set, then keep the best few.
  const reranked = await vertexRank(query, candidates, { topN: finalTopK });

  // promptContext = ALL tiers (tier-2 IP included, used only server-side).
  // citations = client-visible tiers only (tier-2 IP is stripped out).
  const citations = reranked
    .filter((r) => CLIENT_VISIBLE_TIERS.includes(r.tier))
    .map((r) => ({ tier: r.tier, source: r.source, section: r.section, score: r.score }));

  return { promptContext: reranked, citations };
}

export async function deleteTenant(tenantId) {
  if (!tenantId) throw new Error("tenantId required");
  await qdrant.deleteByFilter(COLLECTIONS[TIER.CLIENT], qdrant.toFilter({ tenantId }));
  return { ok: true, tenantId, deleted: true };
}

// List every client that has uploaded tier-3 data, with indexed-passage counts.
// Lets the operator see who has content (add-in uploads are ingested immediately,
// so this reflects reality without any manual ingest step).
export async function listTenants() {
  try {
    const hits = await qdrant.facet(COLLECTIONS[TIER.CLIENT], "tenantId");
    return hits
      .map((h) => ({ tenantId: h.value, passages: h.count }))
      .sort((a, b) => b.passages - a.passages);
  } catch (e) {
    // Older Qdrant without the facet API — surface a clear hint.
    return { error: `Could not list tenants: ${e.message}` };
  }
}

export async function status(tenantId = null) {
  const out = {
    backend: "qdrant",
    embedModel: embedder().model,
    embedDim: embedder().dim,
    public: await qdrant.count(COLLECTIONS[TIER.PUBLIC]).catch(() => 0),
    ip: await qdrant.count(COLLECTIONS[TIER.IP]).catch(() => 0),
  };
  if (tenantId) {
    out.tenant = {
      tenantId,
      size: await qdrant.count(COLLECTIONS[TIER.CLIENT], qdrant.toFilter({ tenantId })).catch(() => 0),
    };
  }
  return out;
}
