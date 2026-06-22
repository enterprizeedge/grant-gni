// Retrieval helper shared by /api/retrieve and /api/advise.
// Loads the store once, embeds the query with the same provider, returns top-k.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEmbeddingProvider } from "./embeddings.js";
import { FileVectorStore } from "./vector-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.resolve(__dirname, "../../data/vector-store.json");

let storeSingleton = null;
let providerSingleton = null;

function getStore() {
  if (!storeSingleton) {
    storeSingleton = new FileVectorStore(STORE_PATH).load();
  }
  return storeSingleton;
}

function getProvider() {
  if (!providerSingleton) providerSingleton = createEmbeddingProvider();
  return providerSingleton;
}

export function storeStatus() {
  const store = getStore();
  return {
    size: store.size(),
    embedProvider: store.meta.embedProvider,
    dim: store.meta.dim,
    queryProvider: getProvider().name,
  };
}

// query: string; opts: { topK, filter }
export async function retrieve(query, opts = {}) {
  const store = getStore();
  if (store.size() === 0) {
    throw new Error("Vector store is empty. Run `npm run ingest` first.");
  }
  const provider = getProvider();
  const [vector] = await provider.embed([query]);
  const hits = store.query(vector, { topK: opts.topK || 5, filter: opts.filter || null });
  return hits.map((h) => ({
    score: Number(h.score.toFixed(4)),
    text: h.text,
    metadata: h.metadata,
  }));
}
