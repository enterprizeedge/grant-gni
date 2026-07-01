// Seed the Qdrant knowledge base with the synthetic corpus (3 tiers).
// Prefer the server-side route (POST /api/admin/seed) so you don't need GCP creds
// locally. Use this CLI only if you have QDRANT_URL, QDRANT_API_KEY, SA_KEY (or
// GOOGLE_APPLICATION_CREDENTIALS) and EMBED_PROVIDER=vertex set locally.
//
//   cd backend && npm run ingest:qdrant            # seed
//   cd backend && npm run ingest:qdrant -- --recreate   # drop + rebuild collections
// ---------------------------------------------------------------------------

import dotenv from "dotenv";
import { seedSynthetic } from "../src/knowledge/seed.js";

dotenv.config();

const recreate = process.argv.includes("--recreate");

seedSynthetic({ recreate, log: (m) => console.log("  " + m) })
  .then((r) => {
    console.log(`\nDone. ${r.chunks} chunks from ${r.files} files (dim ${r.dim}).`);
    console.log("Status:", JSON.stringify(r.status, null, 2));
    process.exitCode = 0; // let Node drain handles cleanly (avoids Windows libuv crash)
  })
  .catch((e) => {
    console.error("Ingestion failed:", e.message);
    process.exitCode = 1; // NOT process.exit(1) — that aborts mid-flush on Windows
  });
