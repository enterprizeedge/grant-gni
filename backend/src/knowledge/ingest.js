// Ingestion.
//   Global corpus (shared):   `npm run ingest`  -> data/global/vector-store.json
//   Tenant uploads (private):  ingestTenantText() -> data/tenants/<id>/vector-store.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { chunkDocument } from "./chunk.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { FileVectorStore } from "./vector-store.js";
import { GLOBAL_STORE_PATH, tenantStorePath, tenantUploadsDir, sanitizeTenantId } from "./tenancy.js";
import { invalidateStore } from "./retriever.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.resolve(__dirname, "../../knowledge");

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

export async function ingestGlobal({ knowledgeDir = KNOWLEDGE_DIR, storePath = GLOBAL_STORE_PATH } = {}) {
  const provider = createEmbeddingProvider();
  if (!provider.isConfigured()) {
    throw new Error(`Embedding provider "${provider.name}" is not configured (missing key?).`);
  }
  const files = walk(knowledgeDir);
  const allChunks = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const fileId = path.relative(knowledgeDir, file).replace(/\\/g, "/");
    for (const c of chunkDocument(raw, fileId)) allChunks.push(c);
  }
  const vectors = await provider.embed(allChunks.map((c) => c.text), { taskType: "RETRIEVAL_DOCUMENT" });
  const records = allChunks.map((c, i) => ({
    id: `${c.metadata.fileId}#${c.metadata.chunkIndex}`,
    vector: vectors[i],
    text: c.text,
    metadata: c.metadata,
  }));
  const store = new FileVectorStore(storePath);
  store.reset({ embedProvider: provider.name, embedModel: provider.model, dim: provider.dim });
  store.upsert(records);
  store.save();
  invalidateStore(storePath);
  return { provider: provider.name, files: files.length, chunks: records.length, storePath };
}

export async function ingestTenantText(tenantId, { filename, text, program, docType, section } = {}) {
  const id = sanitizeTenantId(tenantId);
  const provider = createEmbeddingProvider();
  if (!provider.isConfigured()) {
    throw new Error(`Embedding provider "${provider.name}" is not configured (missing key?).`);
  }
  if (!text || !text.trim()) throw new Error("No extractable text in the uploaded file.");

  const fileId = `upload/${filename || "document"}`;
  const chunks = chunkDocument(text, fileId).map((c) => ({
    ...c,
    metadata: {
      ...c.metadata,
      program: program || c.metadata.program || null,
      docType: docType || "winning-proposal",
      section: section || c.metadata.section || null,
      tenantId: id,
      source: filename || fileId,
    },
  }));
  const vectors = await provider.embed(chunks.map((c) => c.text), { taskType: "RETRIEVAL_DOCUMENT" });
  const records = chunks.map((c, i) => ({
    id: `${id}:${fileId}#${c.metadata.chunkIndex}`,
    vector: vectors[i],
    text: c.text,
    metadata: c.metadata,
  }));

  const storePath = tenantStorePath(id);
  const store = new FileVectorStore(storePath).load();
  // Invariant: every vector in a store must come from the same embedding model/dim.
  // If the embedding model changed since this tenant store was built, rebuild it
  // (old vectors are incompatible) rather than mixing dimensionalities.
  const modelChanged =
    store.meta.embedProvider &&
    (store.meta.embedModel !== provider.model || store.meta.dim !== provider.dim);
  if (!store.meta.embedProvider || modelChanged) {
    if (modelChanged) {
      console.warn(
        `[ingest] tenant "${id}" embedding model changed ` +
          `(${store.meta.embedModel}/${store.meta.dim} -> ${provider.model}/${provider.dim}); rebuilding store.`
      );
    }
    store.reset({ embedProvider: provider.name, embedModel: provider.model, dim: provider.dim });
  }
  store.upsert(records);
  store.save();
  invalidateStore(storePath);

  const upDir = tenantUploadsDir(id);
  fs.mkdirSync(upDir, { recursive: true });
  fs.writeFileSync(path.join(upDir, (filename || "document.txt").replace(/[^\w.-]/g, "_")), text);

  return { tenantId: id, filename, chunks: records.length, storeSize: store.size() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ingestGlobal()
    .then((r) => {
      console.log(`Ingested ${r.chunks} chunks from ${r.files} files using "${r.provider}" embeddings.`);
      console.log(`Global store written to ${r.storePath}`);
    })
    .catch((e) => {
      console.error("Ingestion failed:", e.message);
      process.exit(1);
    });
}
