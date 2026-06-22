# Grant Gni — Knowledge Layer (RAG + Templates + Call Context)

This stage adds the **Advisor**: a dedicated panel in the add-in that reviews a
section of the proposal against (1) exemplar passages from winning proposals,
(2) the program's template criteria, and (3) the active call's strategic intent —
all retrieved from a vector store and fed to the LLM as grounding.

```
Advisor panel ──▶ POST /api/advise ──▶ retrieve top matches (winning + template + call)
                                   └─▶ LLM critiques the draft against them ──▶ JSON suggestions
```

First slice targets **Horizon Europe** and ships with **synthetic placeholder
content** so the whole pipeline runs today. You replace it with real material later.

---

## How it's built (and how it upgrades)

- **Embeddings are swappable** (`backend/src/knowledge/embeddings.js`):
  - `local` — deterministic, offline, no key. Used for development/testing.
  - `gemini` — real semantic embeddings via your key. Use this for quality.
  - Vertex AI embeddings slot in later as a third provider, same interface.
- **Vector store is swappable** (`backend/src/knowledge/vector-store.js`): a simple
  file store today (`backend/data/vector-store.json`), behind an interface that
  pgvector or Vertex AI Vector Search will implement at scale — no app changes.
- **Knowledge corpus** lives in `backend/knowledge/<program>/*.md`, each file with
  YAML-ish frontmatter (`program`, `docType`, `section`, `callId`). `docType` is one
  of `template`, `call`, `winning-proposal`.

## Step 1 — Choose an embedding provider

In `backend/.env`:

```
# Development (no key needed, lower quality):
EMBED_PROVIDER=local

# Recommended for real use (uses your GEMINI_API_KEY):
EMBED_PROVIDER=gemini
EMBED_MODEL=text-embedding-004
```

## Step 2 — Ingest the corpus

```bash
cd backend
npm run ingest
```

You'll see e.g. `Ingested 16 chunks from 5 files using "gemini" embeddings.` Re-run
this any time you add or change files in `backend/knowledge/`. (Switching
`EMBED_PROVIDER` requires re-ingesting, since vectors must match the query provider.)

Quick check:

```bash
curl -k https://localhost:3001/health      # -> "knowledge":{"size":16,...}
```

## Step 3 — Use the Advisor in Word

1. Start the backend (`npm start` in `backend/`) and the add-in (`npm start` at root).
2. In Word, open Grant Gni and click the **★ Advisor** button (top right).
3. Pick the program (Horizon Europe), optionally a section and call ID.
4. Select a paragraph/section in your document (or none, to review the whole doc).
5. Click **Get advice** — you'll get grounded, evaluator-style suggestions, each with
   the source it was based on.

The synthetic sample call ID you can try: `HORIZON-CL5-2026-D3-01-SYNTH`.

---

## Replacing synthetic content with real material

Drop real files into `backend/knowledge/horizon-europe/` (or new program folders)
using the same frontmatter, then re-run `npm run ingest`. For winning proposals use:

```
---
program: horizon-europe
docType: winning-proposal
section: excellence        # or impact / implementation
title: "..."
source: "internal-ref"
---
```

**Important:** winning proposals are confidential third-party IP. Only ingest
documents you have the rights/consent to use, keep the store in an EU region when we
deploy, and prefer redacted versions where possible.

## What's verified vs. what needs you

- **Verified locally:** ingestion, retrieval (`/api/retrieve`), and the full
  `/api/advise` flow (retrieval → grounded prompt → structured JSON suggestions),
  using local embeddings and a mock LLM.
- **Needs you:** a `GEMINI_API_KEY` to run real embeddings + advice, and sideloading
  in Word to try the Advisor panel. Real proposal/template content when you're ready.

## Next stages (unchanged order)
3. Excel budget/resource add-in · 4. MLflow / usage analytics · 5. Auth + subscriptions.
