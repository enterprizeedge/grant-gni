// Seed the DEPLOYED backend by POSTing each corpus file to /api/admin/ingest.
// The backend does the embedding (Vertex) and Qdrant upsert, so you need NO GCP
// or Qdrant credentials locally — just Node 18+.
//
//   cd backend
//   node scripts/seed-remote.mjs
//
// Options (env vars):
//   BACKEND     = backend base URL (defaults to the Cloud Run URL below)
//   ADMIN_TOKEN = bearer token, only if AUTH_ENABLED=true on the backend
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KN = path.resolve(__dirname, "../knowledge");
const SK = path.resolve(__dirname, "../skills");

const BACKEND = (process.env.BACKEND || "https://grant-gni-backend-418969920062.europe-west1.run.app").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const TIER = { PUBLIC: 1, IP: 2, CLIENT: 3 };

const MANIFEST = [
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

function headers() {
  const h = { "Content-Type": "application/json" };
  if (ADMIN_TOKEN) h.Authorization = `Bearer ${ADMIN_TOKEN}`;
  return h;
}

async function main() {
  console.log(`Seeding ${BACKEND} …`);
  let ok = 0;
  let chunks = 0;
  for (const item of MANIFEST) {
    if (!fs.existsSync(item.file)) {
      console.warn(`  ! missing, skipped: ${item.file}`);
      continue;
    }
    const filename = path.basename(item.file);
    const body = {
      tier: item.tier,
      tenantId: item.tenantId || null,
      filename,
      text: fs.readFileSync(item.file, "utf8"),
      programme: "horizon-europe",
      docType: item.docType,
      section: item.section || null,
      callId: item.callId || null,
    };
    const res = await fetch(`${BACKEND}/api/admin/ingest`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`  FAIL tier ${item.tier} ${filename} (${res.status}): ${text.slice(0, 300)}`);
      continue;
    }
    let json = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    ok += 1;
    chunks += json.chunks || 0;
    console.log(`  OK  tier ${item.tier}  ${filename}  -> ${json.chunks ?? "?"} chunks`);
  }
  console.log(`\nDone. ${ok}/${MANIFEST.length} files, ~${chunks} chunks.`);
}

main().catch((e) => {
  console.error("Seed failed:", e.message);
  process.exitCode = 1;
});
