// Backend test runner — executes every *_tests.mjs in this directory as a
// child process and fails (exit 1) if any test file fails. Run with `npm test`.

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(__dirname)
  .filter((f) => f.endsWith("_tests.mjs"))
  .sort();

if (files.length === 0) {
  console.error("No *_tests.mjs files found in backend/tests/");
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.status !== 0) {
    failed++;
    console.error(`FAILED: ${f}`);
  }
}

console.log(`\n${files.length - failed}/${files.length} backend test files passed.`);
process.exit(failed === 0 ? 0 : 1);
