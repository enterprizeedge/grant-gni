// Grant Gni backend gateway — v1
// ---------------------------------------------------------------------------
// Purpose: the Word/Excel add-in calls THIS server instead of calling Google
// directly. The provider key lives here, server-side. This is the seam where
// v2 (auth + Stripe metering) and v3 (Vertex AI, RAG retrieval) plug in.
//
// Endpoints:
//   GET  /health                      -> liveness + provider config status
//   POST /api/generate?model=<model>  -> proxy to the LLM, returns JSON verbatim
// ---------------------------------------------------------------------------

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { createGeminiProvider } from "./providers/gemini.js";

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const USE_HTTPS = String(process.env.USE_HTTPS || "true").toLowerCase() === "true";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ── Provider selection (v1 supports gemini; vertex slots in here later) ──────
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
app.use(express.json({ limit: "12mb" })); // documents can be large
app.use(
  cors({
    origin(origin, cb) {
      // allow same-origin / non-browser tools (no Origin header)
      if (!origin) return cb(null, true);
      if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    methods: ["GET", "POST", "OPTIONS"],
  })
);

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "grant-gni-backend",
    version: "0.1.0",
    provider: provider.name,
    providerConfigured: provider.isConfigured(),
  });
});

// Mirror of Gemini's generateContent. The add-in sends the same body it used to
// send to Google; we add the key and forward. Response is returned verbatim so
// the add-in's parsing logic is unchanged.
app.post("/api/generate", async (req, res) => {
  // NOTE (v2): authenticate the request (JWT) and check the user's subscription
  // + usage quota here before forwarding. Then log usage for billing/analytics.
  const model = req.query.model || (req.body && req.body.model) || "gemini-flash-latest";

  if (!provider.isConfigured()) {
    return res.status(502).json({
      error: {
        message:
          "LLM provider not configured. Set GEMINI_API_KEY in backend/.env and restart.",
      },
    });
  }

  try {
    const { status, body } = await provider.generateContent(String(model), req.body);
    res.status(status).type("application/json").send(body);
  } catch (err) {
    console.error("[/api/generate] proxy error:", err);
    res
      .status(502)
      .json({ error: { message: `Upstream provider error: ${err.message}` } });
  }
});

// ── Boot (HTTPS in dev so the HTTPS task pane can reach us) ──────────────────
function start() {
  if (USE_HTTPS) {
    const certPath = process.env.SSL_CERT_PATH;
    const keyPath = process.env.SSL_KEY_PATH;
    if (certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      const creds = {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      };
      https.createServer(creds, app).listen(PORT, () => {
        console.log(`Grant Gni backend (HTTPS) on https://localhost:${PORT}`);
        console.log(`  provider=${provider.name} configured=${provider.isConfigured()}`);
        console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
      });
      return;
    }
    console.warn(
      "[boot] USE_HTTPS=true but SSL_CERT_PATH/SSL_KEY_PATH are missing or invalid; " +
        "falling back to HTTP. See V1_SETUP.md to generate localhost certs."
    );
  }
  http.createServer(app).listen(PORT, () => {
    console.log(`Grant Gni backend (HTTP) on http://localhost:${PORT}`);
    console.log(`  provider=${provider.name} configured=${provider.isConfigured()}`);
    console.log(`  allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  });
}

start();
