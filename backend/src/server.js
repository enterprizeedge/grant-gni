// Grant Gni backend gateway
// ---------------------------------------------------------------------------
// The Word/Excel add-in calls THIS server instead of calling Google directly.
// The provider key lives here, server-side. This is the seam where the
// monetization phase (auth + Stripe metering) and the knowledge layer (Vertex
// AI, RAG retrieval) plug in.
//
// Endpoints:
//   GET  /health                          -> liveness + provider/knowledge status
//   POST /api/generate?model=<model>      -> proxy to the LLM, returns JSON verbatim
//   POST /api/retrieve                    -> raw vector retrieval (debug/future use)
//   POST /api/advise                      -> grounded, evaluator-style suggestions
//   POST   /api/tenant/:id/documents      -> upload + ingest a client's private file
//   GET    /api/tenant/:id/status         -> a client's private KB status
//   DELETE /api/tenant/:id/documents      -> clear a client's private KB (GDPR delete)
// ---------------------------------------------------------------------------

// Load .env BEFORE any local module is evaluated. ESM imports are hoisted and
// evaluated in declaration order, so this must stay the FIRST import: auth.js,
// the middleware, and config/knowledge.js all read process.env at module scope.
// (Previously dotenv.config() ran after imports, so AUTH_ENABLED / TENANT_KEYS /
// ADMIN_TOKEN from .env were silently ignored in local dev.)
import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import express from "express";
import cors from "cors";

import { createGeminiProvider } from "./providers/gemini.js";
import { createVertexProvider } from "./providers/vertex.js";
import { generateWithFallback } from "./providers/resilience.js";
import { retrieve, storeStatus, invalidateStore } from "./knowledge/retriever.js";
import { advise } from "./knowledge/advisor.js";
import { ingestTenantText } from "./knowledge/ingest.js";
import { extractText } from "./knowledge/extract.js";
import { sanitizeTenantId, tenantDir, tenantStorePath, tenantUploadsDir } from "./knowledge/tenancy.js";
import { USE_QDRANT, TIER } from "./config/knowledge.js";
import * as kb from "./knowledge/kb.js";
import { seedSynthetic } from "./knowledge/seed.js";
import { requireTenant, requireAdmin, AUTH_ENABLED } from "./auth/auth.js";
import { rateLimit } from "./middleware/rate-limit.js";
import { requireAppToken } from "./middleware/app-token.js";
import { requestLog, extractUsage } from "./middleware/request-log.js";
import { enforceQuota, recordUsage, resolveBilling } from "./billing/quota.js";
import { describeUsage, monthKey } from "./billing/plans.js";
import { getUsage } from "./billing/store.js";
import { paddleWebhook, licenseKeyPage } from "./billing/paddle.js";
import {
  createLicenseHandler,
  listLicensesHandler,
  updateLicenseHandler,
  boostLicenseHandler,
} from "./billing/admin.js";

const PORT = Number(process.env.PORT) || 3001;
const USE_HTTPS = String(process.env.USE_HTTPS || "true").toLowerCase() === "true";
// CORS origins. Defaults to the known task-pane origins (production Pages site +
// local dev server). Override with a comma-separated ALLOWED_ORIGINS, or set "*"
// explicitly to reflect any origin (NOT recommended in production — it lets any
// website drive this backend from a browser).
const DEFAULT_ORIGINS = "https://grant-gni.pages.dev,https://localhost:3000";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOW_ALL_ORIGINS = ALLOWED_ORIGINS.includes("*");

// ── Provider selection (LLM_PROVIDER = gemini | vertex) ──────────────────────
function buildProvider() {
  const which = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  switch (which) {
    case "vertex":
      return createVertexProvider();
    case "gemini":
    default:
      return createGeminiProvider({
        apiKey: process.env.GEMINI_API_KEY,
        apiBase: process.env.GEMINI_API_BASE,
      });
  }
}
const provider = buildProvider();

const app = express();
// Keep the raw body around: Paddle webhook signatures are computed over the
// exact bytes received, so they must be verified against the unparsed payload.
app.use(
  express.json({
    limit: "25mb", // documents (base64) can be large
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
// IMPORTANT: never throw from the origin callback. Throwing makes the CORS
// preflight (OPTIONS) fail with a 500 and no CORS headers, which the browser
// reports to the add-in as the opaque "Failed to fetch". Instead we reflect the
// allowed origin (or all origins) and simply omit the header for disallowed ones.
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // same-origin / non-browser tools
    if (ALLOW_ALL_ORIGINS) return cb(null, true); // reflect any origin
    return cb(null, ALLOWED_ORIGINS.includes(origin)); // never throw
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-App-Token"],
  maxAge: 86400,
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions)); // answer all preflights explicitly
app.use(requestLog); // structured JSON logs (spend/abuse visibility in Cloud Logging)

app.get("/health", (_req, res) => {
  let knowledge = null;
  try {
    knowledge = storeStatus();
  } catch {
    knowledge = { size: 0 };
  }
  res.json({
    ok: true,
    service: "grant-gni-backend",
    version: "0.5.0",
    provider: provider.name,
    providerConfigured: provider.isConfigured(),
    kbBackend: USE_QDRANT ? "qdrant" : "file",
    authEnabled: AUTH_ENABLED,
    knowledge,
  });
});

// Mirror of Gemini's generateContent. Body passed through; response verbatim.
// Protected by: app token (proves the caller is our add-in build) + per-caller
// rate limit / daily quota. Per-tenant billing/metering plugs in at the same seam.
app.post("/api/generate", requireAppToken, rateLimit, enforceQuota, async (req, res) => {
  const model = req.query.model || (req.body && req.body.model) || "gemini-flash-latest";
  if (!provider.isConfigured()) {
    return res.status(502).json({
      error: { message: "LLM provider not configured. Set GEMINI_API_KEY in backend/.env and restart." },
    });
  }
  try {
    // Retry + automatic model fallback on 503/"high demand" and transient errors.
    const { status, body, modelUsed } = await generateWithFallback({
      provider,
      model: String(model),
      payload: req.body,
    });
    if (modelUsed && modelUsed !== String(model)) {
      res.setHeader("X-Model-Used", modelUsed); // visibility into fallbacks
    }
    res.locals.usage = extractUsage(body); // token counts -> structured request log
    if (res.locals.usage && res.locals.usage.totalTokens) {
      recordUsage(req, res.locals.usage.totalTokens); // monthly quota metering
    }
    res.status(status).type("application/json").send(body);
  } catch (err) {
    console.error("[/api/generate] proxy error:", err);
    res.status(502).json({ error: { message: `Upstream provider error: ${err.message}` } });
  }
});

// Raw retrieval. body: { query, topK?, filter? }
// requireTenant binds the tenant server-side (same rule as /api/advise), so a
// caller can no longer read another tenant's private store by naming it in the
// body. Rate-limited like every LLM/vector endpoint.
app.post("/api/retrieve", requireAppToken, rateLimit, requireTenant, async (req, res) => {
  try {
    const { query, topK, filter } = req.body || {};
    if (!query) return res.status(400).json({ error: { message: "query is required" } });
    const hits = await retrieve(String(query), { topK, filter, tenantId: req.tenantId || null });
    res.json({ hits });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Grounded review. body: { sectionText, program, section?, callId? }
// tenantId comes from auth (req.tenantId), NOT the body, so it can't be spoofed.
app.post("/api/advise", requireAppToken, rateLimit, requireTenant, enforceQuota, async (req, res) => {
  const { sectionText, program, section, callId, filters } = req.body || {};
  if (!sectionText || !sectionText.trim()) {
    return res.status(400).json({ error: { message: "sectionText is required" } });
  }
  if (!provider.isConfigured()) {
    return res.status(502).json({ error: { message: "LLM provider not configured." } });
  }
  try {
    const result = await advise({
      provider,
      sectionText,
      program,
      section,
      callId,
      tenantId: req.tenantId || null,
      filters: filters || {}, // { cluster?, topic?, trl?, country? }
    });
    if (result && result.usageTokens) {
      res.locals.usage = { totalTokens: result.usageTokens };
      recordUsage(req, result.usageTokens); // monthly quota metering
    }
    res.json(result);
  } catch (err) {
    console.error("[/api/advise] error:", err);
    res.status(502).json({ error: { message: err.message } });
  }
});

// ── Billing: usage + Paddle integration ──────────────────────────────────────
// The add-in shows "X of Y used this month" from here (works for licensed
// callers AND anonymous trial users).
app.get("/api/usage", async (req, res) => {
  try {
    const billing = await resolveBilling(req);
    const usage = await getUsage(billing.caller, monthKey());
    res.json({
      licensed: billing.licensed,
      ...describeUsage(billing.plan, usage.tokens, usage.extraTokens),
    });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Paddle webhook (signature-verified against the raw body; 503 until
// PADDLE_WEBHOOK_SECRET is configured, so this is inert pre-launch).
app.post("/api/billing/webhook/paddle", paddleWebhook);

// Paddle checkout success page -> shows the buyer their license key.
app.get("/api/billing/key", licenseKeyPage);

// ── Admin license management (INVOICE-FIRST billing) ─────────────────────────
// Mint/upgrade/boost/revoke license keys by hand when invoices are paid.
// See backend/src/billing/admin.js header for curl examples.
app.post("/api/admin/licenses", requireAdmin, createLicenseHandler);
app.get("/api/admin/licenses", requireAdmin, listLicensesHandler);
app.post("/api/admin/licenses/:key", requireAdmin, updateLicenseHandler);
app.post("/api/admin/licenses/:key/boost", requireAdmin, boostLicenseHandler);

// ── Per-client private knowledge base (tier 3, isolated) ─────────────────────
// The effective tenant always comes from auth (req.tenantId); the URL :id is
// ignored when auth is on, so a client can never reach another client's tier-3.
function tenantOf(req) {
  return sanitizeTenantId(req.tenantId || req.params.id);
}

// Upload one document into the caller's private KB.
// body: { filename, contentBase64? | text?, program?, docType?, section? }
app.post("/api/tenant/:id/documents", requireAppToken, rateLimit, requireTenant, async (req, res) => {
  let id;
  try {
    id = tenantOf(req);
  } catch (e) {
    return res.status(400).json({ error: { message: e.message } });
  }
  try {
    const { filename, contentBase64, text, program, docType, section } = req.body || {};
    if (!filename) return res.status(400).json({ error: { message: "filename is required" } });
    let extracted = text;
    if (!extracted) {
      if (!contentBase64) return res.status(400).json({ error: { message: "contentBase64 or text is required" } });
      const buffer = Buffer.from(String(contentBase64).replace(/^data:[^;]+;base64,/, ""), "base64");
      extracted = await extractText(filename, buffer);
    }

    let result;
    if (USE_QDRANT) {
      result = await kb.ingestText({
        tier: TIER.CLIENT,
        tenantId: id,
        filename,
        text: extracted,
        meta: { program, docType, section },
      });
      // Keep a lightweight filename record so the UI's file list + GDPR delete work.
      try {
        const dir = tenantUploadsDir(id);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, String(filename).replace(/[^\w.-]/g, "_")), "");
      } catch (e) {
        console.warn("[tenant upload] could not record filename:", e.message);
      }
    } else {
      result = await ingestTenantText(id, { filename, text: extracted, program, docType, section });
    }
    res.json(result);
  } catch (err) {
    console.error("[/api/tenant upload] error:", err);
    res.status(400).json({ error: { message: err.message } });
  }
});

// The caller's private KB status + uploaded file list.
app.get("/api/tenant/:id/status", requireTenant, async (req, res) => {
  let id;
  try {
    id = tenantOf(req);
  } catch (e) {
    return res.status(400).json({ error: { message: e.message } });
  }
  let uploads = [];
  try {
    const dir = tenantUploadsDir(id);
    if (fs.existsSync(dir)) uploads = fs.readdirSync(dir);
  } catch {
    uploads = [];
  }
  try {
    if (USE_QDRANT) {
      const s = await kb.status(id);
      return res.json({ tenant: { tenantId: id, size: (s.tenant && s.tenant.size) || 0 }, uploads, backend: "qdrant" });
    }
    return res.json({ ...storeStatus(id), uploads });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
});

// GDPR deletion: wipe the caller's private KB entirely (vectors + records).
app.delete("/api/tenant/:id/documents", requireTenant, async (req, res) => {
  let id;
  try {
    id = tenantOf(req);
  } catch (e) {
    return res.status(400).json({ error: { message: e.message } });
  }
  try {
    if (USE_QDRANT) await kb.deleteTenant(id);
    const dir = tenantDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    invalidateStore(tenantStorePath(id));
    res.json({ ok: true, tenantId: id, deleted: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── Admin: bootstrap collections + ingest shared knowledge (tiers 1 & 2) ─────
// Protected by ADMIN_TOKEN when auth is enabled.
// List all clients that have uploaded tier-3 data (+ passage counts). Add-in
// uploads are ingested immediately, so this reflects reality with no manual step.
app.get("/api/admin/tenants", requireAdmin, async (_req, res) => {
  if (!USE_QDRANT) return res.json({ tenants: [] });
  try {
    const tenants = await kb.listTenants();
    res.json({ tenants });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

app.post("/api/admin/bootstrap", requireAdmin, async (req, res) => {
  try {
    const recreate = String(req.query.recreate || (req.body && req.body.recreate) || "") === "true";
    const r = await kb.ensureCollections({ recreate });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Seed the synthetic corpus across the 3 tiers using the SERVER's configured
// Vertex/Qdrant providers (no local GCP creds needed). ?recreate=true rebuilds
// collections first (use when dims changed).
app.post("/api/admin/seed", requireAdmin, async (req, res) => {
  if (!USE_QDRANT) {
    return res.status(400).json({ error: { message: "KB_BACKEND must be 'qdrant' to seed." } });
  }
  try {
    const recreate = String(req.query.recreate || (req.body && req.body.recreate) || "") === "true";
    const logs = [];
    const r = await seedSynthetic({ recreate, log: (m) => logs.push(m) });
    res.json({ ok: true, ...r, logs });
  } catch (err) {
    console.error("[/api/admin/seed] error:", err);
    res.status(500).json({ error: { message: err.message } });
  }
});

// body: { tier: 1|2|3, tenantId?, filename, contentBase64? | text?, programme?, docType?, section?, callId?, cluster?, topic?, trl?, country? }
app.post("/api/admin/ingest", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const tier = Number(b.tier);
    if (![TIER.PUBLIC, TIER.IP, TIER.CLIENT].includes(tier)) {
      return res.status(400).json({ error: { message: "tier must be 1 (public), 2 (IP) or 3 (client)" } });
    }
    let extracted = b.text;
    if (!extracted) {
      if (!b.contentBase64) return res.status(400).json({ error: { message: "contentBase64 or text is required" } });
      const buffer = Buffer.from(String(b.contentBase64).replace(/^data:[^;]+;base64,/, ""), "base64");
      extracted = await extractText(b.filename, buffer);
    }
    const meta = {
      programme: b.programme || b.program || null,
      docType: b.docType || null,
      section: b.section || null,
      callId: b.callId || null,
      cluster: b.cluster ?? null,
      topic: b.topic ?? null,
      trl: b.trl ?? null,
      country: b.country ?? null,
      source: b.filename || null,
    };
    const r = await kb.ingestText({
      tier,
      tenantId: tier === TIER.CLIENT ? b.tenantId : null,
      filename: b.filename,
      text: extracted,
      meta,
    });
    res.json({ ok: true, ...r });
  } catch (err) {
    console.error("[/api/admin/ingest] error:", err);
    res.status(400).json({ error: { message: err.message } });
  }
});

// ── Boot (HTTPS in dev so the HTTPS task pane can reach us) ──────────────────
function start() {
  if (USE_HTTPS) {
    const certPath = process.env.SSL_CERT_PATH;
    const keyPath = process.env.SSL_KEY_PATH;
    if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const creds = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
      https.createServer(creds, app).listen(PORT, () => {
        console.log(`Grant Gni backend (HTTPS) on https://localhost:${PORT}`);
        console.log(`  provider=${provider.name} configured=${provider.isConfigured()}`);
        console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
      });
      return;
    }
    console.warn(
      "[boot] USE_HTTPS=true but SSL_CERT_PATH/SSL_KEY_PATH are missing or invalid; falling back to HTTP."
    );
  }
  http.createServer(app).listen(PORT, () => {
    console.log(`Grant Gni backend (HTTP) on http://localhost:${PORT}`);
    console.log(`  provider=${provider.name} configured=${provider.isConfigured()}`);
    console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  });
}

start();
