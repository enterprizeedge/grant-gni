// Add ONE knowledge file to a tier on the DEPLOYED backend.
// The backend extracts text (PDF/Word/MD/TXT), embeds on Vertex, and stores in
// Qdrant — so you need no GCP/Qdrant creds locally, just Node 18+.
//
// Usage:
//   node scripts/add-knowledge.mjs --tier 1 --file "C:\path\call.pdf" --docType call --programme horizon-europe --callId HORIZON-CL5-2026-D3-01
//   node scripts/add-knowledge.mjs --tier 2 --file "C:\path\my-template.docx" --docType template
//   node scripts/add-knowledge.mjs --tier 2 --file "C:\path\review-skill.md" --docType skill
//   node scripts/add-knowledge.mjs --tier 3 --tenant acme --file "C:\path\acme-winning.pdf" --docType winning-proposal --section impact
//
// Flags:
//   --tier 1|2|3        (required)  1=public, 2=your IP, 3=client-private
//   --tenant <id>       (required for tier 3)
//   --file <path>       (required)
//   --docType <type>    call | programme | template | skill | winning-proposal | guideline
//   --section <s>       excellence | impact | implementation (optional)
//   --programme <p>     e.g. horizon-europe (optional)
//   --callId <id>       (optional)
//   --backend <url>     defaults to the Cloud Run URL
//   --token <admin>     only if AUTH_ENABLED=true (ADMIN_TOKEN)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const BACKEND = (arg("backend", "https://grant-gni-backend-418969920062.europe-west1.run.app")).replace(/\/+$/, "");
const tier = Number(arg("tier"));
const file = arg("file");
const tenant = arg("tenant");
const token = arg("token");

if (![1, 2, 3].includes(tier) || !file) {
  console.error("Required: --tier 1|2|3 and --file <path>. See header for usage.");
  process.exit(1);
}
if (tier === 3 && !tenant) {
  console.error("Tier 3 requires --tenant <clientId>.");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(1);
}

const filename = path.basename(file);
const contentBase64 = fs.readFileSync(file).toString("base64");

const body = {
  tier,
  tenantId: tier === 3 ? tenant : null,
  filename,
  contentBase64,
  docType: arg("docType") || (tier === 3 ? "winning-proposal" : tier === 2 ? "template" : "call"),
  section: arg("section") || null,
  programme: arg("programme") || "horizon-europe", // default so Review's programme filter matches
  callId: arg("callId") || null,
  // Stored on every chunk (used by rerank context + future metadata/hybrid filtering).
  cluster: arg("cluster") || null,
  topic: arg("topic") || null,
  trl: arg("trl") ? Number(arg("trl")) : null,
  country: arg("country") || null,
};

const headers = { "Content-Type": "application/json" };
if (token) headers.Authorization = `Bearer ${token}`;

const res = await fetch(`${BACKEND}/api/admin/ingest`, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
const text = await res.text();
if (!res.ok) {
  console.error(`FAILED (${res.status}): ${text}`);
  process.exit(1);
}
console.log(`OK: ${filename} -> tier ${tier}${tenant ? " (" + tenant + ")" : ""}`);
console.log(text);
