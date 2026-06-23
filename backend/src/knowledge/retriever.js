// Retrieval across two isolated layers:
//   - GLOBAL store: shared program/template/call knowledge (data/global/...)
//   - TENANT store: a single client's private uploads (data/tenants/<id>/...)
// A tenant query searches BOTH and merges; a tenant NEVER sees another tenant's store.

import { createEmbeddingProvider } from "./embeddings.js";
import { FileVectorStore } from "./vector-store.js";
import { GLOBAL_STORE_PATH, tenantStorePath, sanitizeTenantId } from "./tenancy.js";

const storeCache = new Map(); // path -> FileVectorStore
let providerSingleton = null;

function getStore(path) {
  if (!storeCache.has(path)) storeCache.set(path, new FileVectorStore(path).load());
  return storeCache.get(path);
}
function getProvider() {
  if (!providerSingleton) providerSingleton = createEmbeddingProvider();
  return providerSingleton;
}

// Force a reload (after ingestion writes new data for a tenant/global).
export function invalidateStore(path) {
  storeCache.delete(path);
}

export function storeStatus(tenantId) {
  const global = getStore(GLOBAL_STORE_PATH);
  const status = {
    queryProvider: getProvider().name,
    global: { size: global.size(), embedProvider: global.meta.embedProvider, dim: global.meta.dim },
  };
  if (tenantId) {
    const t = getStore(tenantStorePath(sanitizeTenantId(tenantId)));
    status.tenant = { tenantId: sanitizeTenantId(tenantId), size: t.size() };
  }
  status.size = global.size() + (status.tenant ? status.tenant.size : 0);
  return status;
}

// retrieve(query, { topK, filter, tenantId })
export async function retrieve(query, opts = {}) {
  const { topK = 5, filter = null, tenantId = null } = opts;
  const provider = getProvider();
  const [vector] = await provider.embed([query]);

  const collected = [];
  const global = getStore(GLOBAL_STORE_PATH);
  for (const h of global.query(vector, { topK, filter })) collected.push({ ...h, origin: "global" });

  if (tenantId) {
    const tenant = getStore(tenantStorePath(sanitizeTenantId(tenantId)));
    for (const h of tenant.query(vector, { topK, filter })) collected.push({ ...h, origin: "private" });
  }

  if (collected.length === 0 && global.size() === 0) {
    throw new Error("Knowledge base is empty. Run `npm run ingest` (global) and/or upload client documents.");
  }

  return collected
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((h) => ({
      score: Number(h.score.toFixed(4)),
      text: h.text,
      origin: h.origin,
      metadata: h.metadata,
    }));
}
