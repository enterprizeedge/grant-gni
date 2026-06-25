// Seed the Qdrant knowledge base with the synthetic corpus, split across the
// three tiers. Run AFTER setting QDRANT_URL, QDRANT_API_KEY, SA_KEY and
// EMBED_PROVIDER=vertex (so embeddings come from Vertex gemini-embedding-001).
//
//   cd backend && npm run ingest:qdrant
//
// Idempotent: re-running overwrites the same chunks (stable UUIDs).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { TIER } from "../src/config/knowledge.js";
import { ensureCollections, ingestText, status } from "../src/knowledge/kb.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KN = path.resolve(__dirname, "../knowledge");
const SK = path.resolve(__dirname, "../skills");

// What goes where. tier 1 = public, tier 2 = your IP, tier 3 = a demo client.
const MANIFEST = [
  // ── Tier 1: PUBLIC (call text, programme overview) ──
  { file: path.join(KN, "dummy/tier1-horizon-programme-overview.md"), tier: TIER.PUBLIC, docType: "programme" },
  { file: path.join(KN, "horizon-europe/call-HORIZON-CL5-2026-D3-synthetic.md"), tier: TIER.PUBLIC, docType: "call", callId: "HORIZON-CL5-2026-D3-01-SYNTH" },

  // ── Tier 2: YOUR IP (templates + drafting/review skills) — server-only ──
  { file: path.join(KN, "horizon-europe/template.md"), tier: TIER.IP, docType: "template" },
  { file: path.join(SK, "expert_review_skill.md"), tier: TIER.IP, docType: "skill" },
  { file: path.join(SK, "drafting_skill.md"), tier: TIER.IP, docType: "skill" },
  { file: path.join(SK, "finance_skill.md"), tier: TIER.IP, docType: "skill" },
  { file: path.join(SK, "project_reporting_skill.md"), tier: TIER.IP, docType: "skill" },

  // ── Tier 3: a demo CLIENT's private docs (tenantId "demo") ──
  { file: path.join(KN, "dummy/tier3-demo-client-winning-proposal.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "impact" },
  { file: path.join(KN, "horizon-europe/winning-excerpts-excellence.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "excellence" },
  { file: path.join(KN, "horizon-europe/winning-excerpts-impact.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "impact" },
  { file: path.join(KN, "horizon-europe/winning-excerpts-implementation.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "implementation" },
];

async function main() {
  console.log("Ensuring Qdrant collections…");
  const { dim } = await ensureCollections();
  console.log(`  collections ready (embedding dim = ${dim})`);

  let total = 0;
  for (const item of MANIFEST) {
    if (!fs.existsSync(item.file)) {
      console.warn(`  ! missing, skipped: ${item.file}`);
      continue;
    }
    const text = fs.readFileSync(item.file, "utf8");
    const filename = path.basename(item.file);
    const r = await ingestText({
      tier: item.tier,
      tenantId: item.tenantId || null,
      filename,
      text,
      meta: {
        programme: "horizon-europe",
        docType: item.docType,
        section: item.section || null,
        callId: item.callId || null,
      },
    });
    total += r.chunks;
    console.log(`  tier ${item.tier}  ${filename}  -> ${r.chunks} chunks (${r.collection})`);
  }

  console.log(`\nDone. ${total} chunks ingested.`);
  console.log("Status:", JSON.stringify(await status("demo"), null, 2));
}

main().catch((e) => {
  console.error("Ingestion failed:", e.message);
  process.exit(1);
});
