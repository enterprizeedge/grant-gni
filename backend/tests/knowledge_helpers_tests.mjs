// Unit tests: tenancy sanitizer + Qdrant filter builders (tenant isolation
// depends on these being right).

import assert from "node:assert";
import { sanitizeTenantId } from "../src/knowledge/tenancy.js";
import { toFilter, buildFilter } from "../src/knowledge/stores/qdrant-store.js";

// ── sanitizeTenantId: allow-list, path traversal blocked ─────────────────────
assert.strictEqual(sanitizeTenantId("client-A_1"), "client-A_1");
assert.strictEqual(sanitizeTenantId("  demo  "), "demo", "trims whitespace");
for (const bad of ["../etc", "a/b", "a\\b", "", "x".repeat(65), "sp ace", "dot.dot"]) {
  assert.throws(() => sanitizeTenantId(bad), /Invalid tenantId/, `rejects ${JSON.stringify(bad)}`);
}

// ── toFilter: strict equality, null/undefined skipped ────────────────────────
assert.deepStrictEqual(toFilter({ tenantId: "t1", x: null, y: undefined }), {
  must: [{ key: "tenantId", match: { value: "t1" } }],
});
assert.strictEqual(toFilter({}), undefined, "empty map -> no filter");

// ── buildFilter: hard must-match, soft match-or-absent ───────────────────────
{
  const f = buildFilter({ hard: { programme: "horizon-europe" }, soft: { cluster: "4" } });
  assert.deepStrictEqual(f, {
    must: [
      { key: "programme", match: { value: "horizon-europe" } },
      { should: [{ key: "cluster", match: { value: "4" } }, { is_empty: { key: "cluster" } }] },
    ],
  });
}
assert.strictEqual(buildFilter({ hard: { a: null }, soft: { b: undefined } }), undefined, "all-null -> no filter");

console.log("PASS: knowledge helper tests");
