// Qdrant vector store — dependency-free REST adapter.
// ---------------------------------------------------------------------------
// Implements the operations the knowledge layer needs against Qdrant Cloud:
//   ensureCollection, upsert, search (with payload filter), deleteByFilter, count.
//
// Tenancy/tier isolation is enforced by the CALLER passing the right collection
// and filter (see retrieval orchestrator). For tier-3 (clients) we additionally
// index tenantId so per-tenant filtering and GDPR delete-by-filter are fast.
//
// Hybrid (dense + BM25 sparse / Phase 3) plugs in via the Query API later; this
// adapter ships dense + metadata filtering + the seam for sparse.
// ---------------------------------------------------------------------------

import { QDRANT, assertQdrantConfigured } from "../../config/knowledge.js";

async function qreq(path, { method = "POST", body = null } = {}) {
  assertQdrantConfigured();
  const res = await fetch(`${QDRANT.url}${path}`, {
    method,
    headers: {
      "api-key": QDRANT.apiKey,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg = json && json.status && json.status.error ? json.status.error : text;
    throw new Error(`Qdrant ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return json;
}

export async function collectionExists(name) {
  try {
    await qreq(`/collections/${encodeURIComponent(name)}`, { method: "GET" });
    return true;
  } catch (e) {
    if (/404/.test(e.message)) return false;
    throw e;
  }
}

// Returns the configured vector dimension of an existing collection, or null.
export async function getCollectionDim(name) {
  try {
    const json = await qreq(`/collections/${encodeURIComponent(name)}`, { method: "GET" });
    const vectors = json?.result?.config?.params?.vectors;
    // vectors may be { size, distance } (single) or a named-vectors map.
    if (vectors && typeof vectors.size === "number") return vectors.size;
    return null;
  } catch {
    return null;
  }
}

export async function deleteCollection(name) {
  await qreq(`/collections/${encodeURIComponent(name)}`, { method: "DELETE" }).catch(() => {});
  return { ok: true };
}

// Create the collection if missing. Adds payload indexes used for filtering.
// recreate=true drops an existing collection whose dim differs from `dim`.
export async function ensureCollection(
  name,
  dim,
  { distance = QDRANT.distance, tenantIndex = false, recreate = false } = {}
) {
  if (await collectionExists(name)) {
    const existing = await getCollectionDim(name);
    if (existing != null && existing !== dim) {
      if (recreate) {
        console.warn(`[qdrant] ${name} dim ${existing} != ${dim}; recreating.`);
        await deleteCollection(name);
      } else {
        throw new Error(
          `Collection "${name}" exists with dim ${existing} but the embedder produces ${dim}. ` +
            `Run the seed with EMBED_PROVIDER=vertex, or bootstrap with recreate=true to rebuild.`
        );
      }
    } else {
      return false; // already correct
    }
  }
  await qreq(`/collections/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: {
      vectors: { size: dim, distance },
      // on_disk keeps RAM low on the small starter cluster.
      on_disk_payload: true,
    },
  });
  // Payload indexes make tier/programme/docType/section filters fast.
  const indexes = [
    { field_name: "tier", field_schema: "integer" },
    { field_name: "programme", field_schema: "keyword" },
    { field_name: "docType", field_schema: "keyword" },
    { field_name: "section", field_schema: "keyword" },
    { field_name: "callId", field_schema: "keyword" },
    { field_name: "cluster", field_schema: "keyword" },
    { field_name: "topic", field_schema: "keyword" },
    { field_name: "trl", field_schema: "integer" },
    { field_name: "country", field_schema: "keyword" },
  ];
  if (tenantIndex) indexes.push({ field_name: "tenantId", field_schema: "keyword" });
  for (const idx of indexes) {
    await qreq(`/collections/${encodeURIComponent(name)}/index?wait=true`, {
      method: "PUT",
      body: idx,
    }).catch((e) => console.warn(`[qdrant] index ${idx.field_name} on ${name}: ${e.message}`));
  }
  return true;
}

// points: [{ id, vector, payload }]
export async function upsert(name, points) {
  if (!points.length) return { upserted: 0 };
  await qreq(`/collections/${encodeURIComponent(name)}/points?wait=true`, {
    method: "PUT",
    body: { points },
  });
  return { upserted: points.length };
}

// Build a Qdrant filter from a flat {key: value} object (null/undefined skipped).
// Strict equality on every key.
export function toFilter(eqMap = {}) {
  const must = Object.entries(eqMap)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([key, value]) => ({ key, match: { value } }));
  return must.length ? { must } : undefined;
}

// Build a filter with HARD matches (must equal) and SOFT matches (equal OR the
// field is absent). Soft matching means tagging a document with e.g. cluster=4
// makes it eligible for a cluster=4 query, WITHOUT excluding documents (templates,
// exemplars) that simply have no cluster tag.
export function buildFilter({ hard = {}, soft = {} } = {}) {
  const must = [];
  for (const [key, value] of Object.entries(hard)) {
    if (value !== null && value !== undefined) must.push({ key, match: { value } });
  }
  for (const [key, value] of Object.entries(soft)) {
    if (value !== null && value !== undefined) {
      must.push({ should: [{ key, match: { value } }, { is_empty: { key } }] });
    }
  }
  return must.length ? { must } : undefined;
}

// vector: number[]; returns [{ id, score, payload }]
export async function search(name, vector, { topK = 10, filter = null } = {}) {
  if (!(await collectionExists(name))) return [];
  const json = await qreq(`/collections/${encodeURIComponent(name)}/points/search`, {
    method: "POST",
    body: {
      vector,
      limit: topK,
      with_payload: true,
      filter: filter || undefined,
    },
  });
  return (json.result || []).map((r) => ({ id: r.id, score: r.score, payload: r.payload || {} }));
}

export async function deleteByFilter(name, filter) {
  if (!(await collectionExists(name))) return { deleted: 0 };
  await qreq(`/collections/${encodeURIComponent(name)}/points/delete?wait=true`, {
    method: "POST",
    body: { filter },
  });
  return { ok: true };
}

// Distinct values of a payload key with counts (Qdrant facet API).
// Returns [{ value, count }]. Used to list which clients have uploaded data.
export async function facet(name, key, { limit = 200 } = {}) {
  if (!(await collectionExists(name))) return [];
  const json = await qreq(`/collections/${encodeURIComponent(name)}/facet`, {
    method: "POST",
    body: { key, limit, exact: true },
  });
  return (json.result && json.result.hits) || [];
}

export async function count(name, filter = null) {
  if (!(await collectionExists(name))) return 0;
  const json = await qreq(`/collections/${encodeURIComponent(name)}/points/count`, {
    method: "POST",
    body: { filter: filter || undefined, exact: true },
  });
  return (json.result && json.result.count) || 0;
}
