// Bulk-ingest a folder tree into the tiers. Drop files in the tier folders, run once.
//
//   backend/knowledge/tier1/<files>            -> tier 1 (public)
//   backend/knowledge/tier2/<files>            -> tier 2 (your IP)
//   backend/knowledge/tier3/<clientId>/<files> -> tier 3 (that client's private KB)
//
// Metadata per file (optional): put a sidecar next to it named "<filename>.meta.json", e.g.
//   call-2026.pdf              +  call-2026.pdf.meta.json
//   { "docType":"call", "callId":"HORIZON-CL5-2026-D3-01", "programme":"horizon-europe",
//     "section":null, "cluster":"4", "topic":"AI", "trl":6, "country":"Norway" }
// For .md files you can instead use YAML frontmatter (program/docType/section/callId).
// Anything not specified defaults to programme=horizon-europe.
//
// Run:  cd backend && node scripts/ingest-folder.mjs      (or: npm run ingest:folder)
// Files supported: .pdf .docx .md .txt   (README.md and *.meta.json are ignored)
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../knowledge");
const BACKEND = (process.env.BACKEND || "https://grant-gni-backend-418969920062.europe-west1.run.app").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DEFAULT_PROGRAMME = process.env.DEFAULT_PROGRAMME || "horizon-europe";

const SUPPORTED = new Set([".pdf", ".docx", ".md", ".txt"]);

function listFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function metaFor(file) {
  const sidecar = `${file}.meta.json`;
  if (fs.existsSync(sidecar)) {
    try {
      return JSON.parse(fs.readFileSync(sidecar, "utf8"));
    } catch (e) {
      console.warn(`  ! bad sidecar ${path.basename(sidecar)}: ${e.message}`);
    }
  }
  return {};
}

function ingestible(file) {
  const base = path.basename(file).toLowerCase();
  if (base === "readme.md" || base.endsWith(".meta.json")) return false;
  return SUPPORTED.has(path.extname(base));
}

async function post(body) {
  const headers = { "Content-Type": "application/json" };
  if (ADMIN_TOKEN) headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
  const res = await fetch(`${BACKEND}/api/admin/ingest`, { method: "POST", headers, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

async function ingestTier(tierDir, tier, tenantOf) {
  const files = listFiles(tierDir).filter(ingestible);
  for (const file of files) {
    const meta = metaFor(file);
    const tenant = tier === 3 ? tenantOf(file) : null;
    if (tier === 3 && !tenant) {
      console.warn(`  ! tier3 file not inside a client folder, skipped: ${file}`);
      continue;
    }
    const body = {
      tier,
      tenantId: tenant,
      filename: path.basename(file),
      contentBase64: fs.readFileSync(file).toString("base64"),
      docType: meta.docType || (tier === 3 ? "winning-proposal" : tier === 2 ? "template" : "call"),
      section: meta.section || null,
      programme: meta.programme || meta.program || DEFAULT_PROGRAMME,
      callId: meta.callId || null,
      cluster: meta.cluster ?? null,
      topic: meta.topic ?? null,
      trl: meta.trl ?? null,
      country: meta.country ?? null,
    };
    const r = await post(body);
    if (!r.ok) console.error(`  FAIL tier${tier} ${body.filename} (${r.status}): ${r.text.slice(0, 200)}`);
    else {
      let chunks = "?";
      try {
        chunks = JSON.parse(r.text).chunks;
      } catch {
        /* ignore */
      }
      console.log(`  OK  tier${tier}${tenant ? " [" + tenant + "]" : ""}  ${body.filename} -> ${chunks} chunks`);
    }
  }
  return files.length;
}

async function main() {
  console.log(`Ingesting ${ROOT} -> ${BACKEND}`);
  const n1 = await ingestTier(path.join(ROOT, "tier1"), 1, () => null);
  const n2 = await ingestTier(path.join(ROOT, "tier2"), 2, () => null);
  // tier3: client id = the first folder under tier3/
  const tier3Root = path.join(ROOT, "tier3");
  const n3 = await ingestTier(tier3Root, 3, (file) => {
    const rel = path.relative(tier3Root, file).split(path.sep);
    return rel.length > 1 ? rel[0] : null; // tier3/<clientId>/...
  });
  console.log(`\nDone. Scanned tier1:${n1} tier2:${n2} tier3:${n3} files.`);
}

main().catch((e) => {
  console.error("Bulk ingest failed:", e.message);
  process.exitCode = 1;
});
