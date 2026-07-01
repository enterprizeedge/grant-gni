// Seed the Qdrant knowledge base with the synthetic corpus across the 3 tiers.
// Shared by the CLI (scripts/ingest-knowledge.js) and the /api/admin/seed endpoint
// so it always runs with the SAME provider/embedding config as the server.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TIER } from "../config/knowledge.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { ensureCollections, ingestText, status } from "./kb.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KN = path.resolve(__dirname, "../../knowledge");
const SK = path.resolve(__dirname, "../../skills");

// What goes where. tier 1 = public, tier 2 = your IP, tier 3 = a demo client.
export const MANIFEST = [
  { file: path.join(KN, "dummy/tier1-horizon-programme-overview.md"), tier: TIER.PUBLIC, docType: "programme" },
  { file: path.join(KN, "horizon-europe/call-HORIZON-CL5-2026-D3-synthetic.md"), tier: TIER.PUBLIC, docType: "call", callId: "HORIZON-CL5-2026-D3-01-SYNTH" },

  { file: path.join(KN, "horizon-europe/template.md"), tier: TIER.IP, docType: "template" },
  { file: path.join(SK, "expert_review_skill.md"), tier: TIER.IP, docType: "skill" },
  { file: path.join(SK, "drafting_skill.md"), tier: TIER.IP, docType: "skill" },
  { file: path.join(SK, "finance_skill.md"), tier: TIER.IP, docType: "skill" },
  { file: path.join(SK, "project_reporting_skill.md"), tier: TIER.IP, docType: "skill" },

  { file: path.join(KN, "dummy/tier3-demo-client-winning-proposal.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "impact" },
  { file: path.join(KN, "horizon-europe/winning-excerpts-excellence.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "excellence" },
  { file: path.join(KN, "horizon-europe/winning-excerpts-impact.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "impact" },
  { file: path.join(KN, "horizon-europe/winning-excerpts-implementation.md"), tier: TIER.CLIENT, tenantId: "demo", docType: "winning-proposal", section: "implementation" },
];

// seedSynthetic({ recreate, log }) -> { dim, files, chunks, status }
export async function seedSynthetic({ recreate = false, log = () => {} } = {}) {
  const emb = createEmbeddingProvider();
  if (emb.name === "local") {
    // 256-dim local hashing is for dev only and will not match production (1536-dim)
    // collections. This is the usual cause of a "Vector dimension error" on upsert.
    log(
      "WARNING: EMBED_PROVIDER is not set to 'vertex' — using the 256-dim local embedder. " +
        "Set EMBED_PROVIDER=vertex (and GCP creds) before seeding production."
    );
  }

  const { dim } = await ensureCollections({ recreate });
  log(`collections ready (embedding dim = ${dim}${recreate ? ", recreated" : ""})`);

  let files = 0;
  let chunks = 0;
  for (const item of MANIFEST) {
    if (!fs.existsSync(item.file)) {
      log(`! missing, skipped: ${item.file}`);
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
    files += 1;
    chunks += r.chunks;
    log(`tier ${item.tier}  ${filename}  -> ${r.chunks} chunks (${r.collection})`);
  }

  return { dim, files, chunks, status: await status("demo") };
}
