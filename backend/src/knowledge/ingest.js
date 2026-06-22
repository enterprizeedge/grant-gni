// Ingestion CLI: read knowledge/**/*.md, chunk, embed, persist the vector store.
//   node src/knowledge/ingest.js
// Honours EMBED_PROVIDER (local|gemini) from .env.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { chunkDocument } from "./chunk.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { FileVectorStore } from "./vector-store.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.resolve(__dirname, "../../knowledge");
const STORE_PATH = path.resolve(__dirname, "../../data/vector-store.json");

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

export async function ingest({ knowledgeDir = KNOWLEDGE_DIR, storePath = STORE_PATH } = {}) {
  const provider = createEmbeddingProvider();
  if (!provider.isConfigured()) {
    throw new Error(
      `Embedding provider "${provider.name}" is not configured (missing key?).`
    );
  }
  const files = walk(knowledgeDir);
  const allChunks = [];
  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const fileId = path.relative(knowledgeDir, file).replace(/\\/g, "/");
    for (const c of chunkDocument(raw, fileId)) allChunks.push(c);
  }

  const vectors = await provider.embed(allChunks.map((c) => c.text));
  const records = allChunks.map((c, i) => ({
    id: `${c.metadata.fileId}#${c.metadata.chunkIndex}`,
    vector: vectors[i],
    text: c.text,
    metadata: c.metadata,
  }));

  const store = new FileVectorStore(storePath);
  store.reset({ embedProvider: provider.name, dim: provider.dim });
  store.upsert(records);
  store.save();

  return {
    provider: provider.name,
    files: files.length,
    chunks: records.length,
    storePath,
  };
}

// Run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest()
    .then((r) => {
      console.log(
        `Ingested ${r.chunks} chunks from ${r.files} files using "${r.provider}" embeddings.`
      );
      console.log(`Store written to ${r.storePath}`);
    })
    .catch((e) => {
      console.error("Ingestion failed:", e.message);
      process.exit(1);
    });
}
