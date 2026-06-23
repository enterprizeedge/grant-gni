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

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { createGeminiProvider } from "./providers/gemini.js";
import { retrieve, storeStatus, invalidateStore } from "./knowledge/retriever.js";
import { advise } from "./knowledge/advisor.js";
import { ingestTenantText } from "./knowledge/ingest.js";
import { extractText } from "./knowledge/extract.js";
import { sanitizeTenantId, tenantDir, tenantStorePath, tenantUploadsDir } from "./knowledge/tenancy.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const USE_HTTPS = String(process.env.USE_HTTPS || "true").toLowerCase() === "true";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Provider selection (gemini now; vertex slots in here later) ──────────────
function buildProvider() {
  const which = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  switch (which) {
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
app.use(express.json({ limit: "25mb" })); // documents (base64) can be large
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin / non-browser tools
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);

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
    version: "0.3.0",
    provider: provider.name,
    providerConfigured: provider.isConfigured(),
    knowledge,
  });
});

// Mirror of Gemini's generateContent. Body passed through; response verbatim.
app.post("/api/generate", async (req, res) => {
  // NOTE (monetization phase): authenticate + check quota + log usage here.
  const model = req.query.model || (req.body && req.body.model) || "gemini-flash-latest";
  if (!provider.isConfigured()) {
    return res.status(502).json({
      error: { message: "LLM provider not configured. Set GEMINI_API_KEY in backend/.env and restart." },
    });
  }
  try {
    const { status, body } = await provider.generateContent(String(model), req.body);
    res.status(status).type("application/json").send(body);
  } catch (err) {
    console.error("[/api/generate] proxy error:", err);
    res.status(502).json({ error: { message: `Upstream provider error: ${err.message}` } });
  }
});

// Raw retrieval. body: { query, topK?, filter?, tenantId? }
app.post("/api/retrieve", async (req, res) => {
  try {
    const { query, topK, filter, tenantId } = req.body || {};
    if (!query) return res.status(400).json({ error: { message: "query is required" } });
    const hits = await retrieve(String(query), { topK, filter, tenantId: tenantId || null });
    res.json({ hits });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// Grounded review. body: { sectionText, program, section?, callId?, tenantId? }
app.post("/api/advise", async (req, res) => {
  // NOTE (monetization phase): auth + quota check + usage logging go here too.
  const { sectionText, program, section, callId, tenantId } = req.body || {};
  if (!sectionText || !sectionText.trim()) {
    return res.status(400).json({ error: { message: "sectionText is required" } });
  }
  if (!provider.isConfigured()) {
    return res.status(502).json({
      error: { message: "LLM provider not configured. Set GEMINI_API_KEY in backend/.env." },
    });
  }
  try {
    const result = await advise({ provider, sectionText, program, section, callId, tenantId: tenantId || null });
    res.json(result);
  } catch (err) {
    console.error("[/api/advise] error:", err);
    res.status(502).json({ error: { message: err.message } });
  }
});

// ── Per-client private knowledge base (upload-only, isolated) ────────────────

// Upload one document into a client's private KB.
// body: { filename, contentBase64? | text?, program?, docType?, section? }
app.post("/api/tenant/:id/documents", async (req, res) => {
  let id;
  try {
    id = sanitizeTenantId(req.params.id);
  } catch (e) {
    return res.status(400).json({ error: { message: e.message } });
  }
  if (!provider.isConfigured()) {
    return res.status(502).json({ error: { message: "Set GEMINI_API_KEY (used for embeddings) in backend/.env." } });
  }
  try {
    const { filename, contentBase64, text, program, docType, section } = req.body || {};
    if (!filename) return res.status(400).json({ error: { message: "filename is required" } });
    let extracted = text;
    if (!extracted) {
      if (!contentBase64) return res.status(400).json({ error: { message: "contentBase64 or text is required" } });
      const buffer = Buffer.from(String(contentBase64).replace(/^data:[^;]+;base64,/, ""), "base64");
      extracted = extractText(filename, buffer);
    }
    const result = await ingestTenantText(id, { filename, text: extracted, program, docType, section });
    res.json(result);
  } catch (err) {
    console.error("[/api/tenant upload] error:", err);
    res.status(400).json({ error: { message: err.message } });
  }
});

// A client's private KB status + uploaded file list.
app.get("/api/tenant/:id/status", (req, res) => {
  let id;
  try {
    id = sanitizeTenantId(req.params.id);
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
  res.json({ ...storeStatus(id), uploads });
});

// GDPR deletion: wipe a client's private KB entirely.
app.delete("/api/tenant/:id/documents", (req, res) => {
  let id;
  try {
    id = sanitizeTenantId(req.params.id);
  } catch (e) {
    return res.status(400).json({ error: { message: e.message } });
  }
  try {
    const dir = tenantDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    invalidateStore(tenantStorePath(id));
    res.json({ ok: true, tenantId: id, deleted: true });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
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
