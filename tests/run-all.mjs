// Add-in test runner — executes the Node-runnable test files under tests/ and
// tests/addin/ as child processes; exits 1 if any fail. Run with `npm test`.
//
// Excluded on purpose:
//   - setup-xml-provider.mjs        (helper, not a test)
//   - docx-harness/, word-desktop/  (need Word / PowerShell)
//   - phase4/                       (golden guardrail + perf harness; run explicitly)
//   - fixtures/, sample_doc/        (data)

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const EXCLUDE = new Set(["setup-xml-provider.mjs", "run-all.mjs"]);

function testFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".mjs") && !EXCLUDE.has(f))
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

const files = [...testFiles(__dirname), ...testFiles(path.join(__dirname, "addin"))].sort();

if (files.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const rel = path.relative(__dirname, f);
  const r = spawnSync(process.execPath, [f], { stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED: ${rel}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} test files passed.`);
process.exit(failed === 0 ? 0 : 1);
