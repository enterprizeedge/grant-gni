// File-based vector store behind a small interface.
// Swap target later: pgvector (Cloud SQL) or Vertex AI Vector Search — implement
// the same load/upsert/query/save surface and the rest of the app is unchanged.

import fs from "node:fs";
import path from "node:path";
import { cosineSimilarity } from "./embeddings.js";

export class FileVectorStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.records = []; // { id, vector, text, metadata }
    this.meta = { embedProvider: null, dim: null };
  }

  load() {
    if (fs.existsSync(this.filePath)) {
      const data = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      this.records = data.records || [];
      this.meta = data.meta || this.meta;
    }
    return this;
  }

  reset(meta = {}) {
    this.records = [];
    this.meta = { ...this.meta, ...meta };
  }

  upsert(records) {
    const byId = new Map(this.records.map((r) => [r.id, r]));
    for (const r of records) byId.set(r.id, r);
    this.records = [...byId.values()];
  }

  size() {
    return this.records.length;
  }

  // filter: optional object; record matches if every key equals metadata[key]
  query(vector, { topK = 5, filter = null } = {}) {
    const matches = filter
      ? this.records.filter((r) =>
          Object.entries(filter).every(([k, v]) => v == null || r.metadata?.[k] === v)
        )
      : this.records;
    return matches
      .map((r) => ({ ...r, score: cosineSimilarity(vector, r.vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ meta: this.meta, records: this.records }, null, 0)
    );
    return this;
  }
}
