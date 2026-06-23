// Per-client (tenant) isolation. Each client's private knowledge lives in its own
// directory and vector store, never accessible to other clients. Until auth lands
// (final stage), the tenantId is supplied by the client; auth will later bind it to an
// authenticated organisation so it cannot be spoofed.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data");

export const GLOBAL_STORE_PATH = path.join(DATA_DIR, "global", "vector-store.json");

// Strict allow-list — prevents path traversal and keeps tenants isolated.
export function sanitizeTenantId(id) {
  const s = String(id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new Error("Invalid tenantId (allowed: letters, digits, _ and -, max 64).");
  }
  return s;
}

export function tenantDir(id) {
  return path.join(DATA_DIR, "tenants", sanitizeTenantId(id));
}
export function tenantStorePath(id) {
  return path.join(tenantDir(id), "vector-store.json");
}
export function tenantUploadsDir(id) {
  return path.join(tenantDir(id), "uploads");
}
