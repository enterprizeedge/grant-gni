# Grant Gni — V3: Production Vector DB (Qdrant + Vertex AI)

This stage moves the knowledge layer off the static JSON files onto **Qdrant Cloud**,
with **Vertex AI** for embeddings, generation, and reranking, a **3-tier** security
model, and **minimal auth** that binds a request to a tenant server-side.

Everything ships **behind feature flags** — your current Gemini/file setup keeps running
until you deliberately flip the switches below.

---

## 1. Architecture (as built)

```
Upload (PDF/Word/MD/TXT)
   -> extract text  -> section-aware chunking
   -> Vertex embeddings (gemini-embedding-001, 1536-dim)  [independent of the LLM]
   -> Qdrant collection by TIER (+ metadata payload)

Query (drafting or review)
   -> Vertex query-embedding
   -> Qdrant search across tiers (metadata-filtered)
        tier 1 kb_public     (public, citable)
        tier 2 kb_ip         (YOUR IP — used in prompt, NEVER returned)
        tier 3 kb_clients    (forced tenantId filter — client-private)
   -> merge -> Vertex Ranking API rerank (semantic-ranker-default-004) -> top-k
   -> LLM (Gemini on Vertex) with retry + model fallback
```

How this maps to your phased plan: **Stage 1** (Qdrant + embeddings + LLM) ✅,
**Stage 2** (metadata filtering) ✅, **Phase 4** (reranker) ✅. **Phase 3** (hybrid
BM25 + vector) and **Phase 5** (context compression) are scaffolded but intentionally
deferred — see §7.

### Tier → collection → access

| Tier | Content | Collection | Filter | Returned to client? |
|---|---|---|---|---|
| 1 PUBLIC | call/programme text, guidelines | `kb_public` | metadata only | yes (citations) |
| 2 IP | your templates + drafting/review skills | `kb_ip` | metadata only | **never** (prompt-only) |
| 3 CLIENT | client's own winning proposals/guidelines | `kb_clients` | **mandatory `tenantId`** | only to that client; delete-by-filter for GDPR |

All three tiers feed **both** drafting and review; only the injected skill changes.

---

## 2. One-time GCP / IAM setup

You've already: created project `grant-gni` (billing on, `europe-west1`), enabled
**Vertex AI** + **Discovery Engine** APIs, created the service account + JSON key, created
the Qdrant cluster (Frankfurt), and stored secrets `sa_key`, `QDRANT_URL`, `QDRANT_API_KEY`.

Two things to confirm:

1. **The Cloud Run runtime service account can read the secrets.** Grant
   `roles/secretmanager.secretAccessor` on each of `sa_key`, `QDRANT_URL`, `QDRANT_API_KEY`
   to whatever SA the Cloud Run service runs as (your new SA, or the default compute SA).
2. **That SA has** `roles/aiplatform.user` (or *Agent Platform User*) and
   `roles/discoveryengine.user` so Vertex generate/embeddings/ranking calls succeed.

The CI/CD deploy already injects the secrets as env vars `SA_KEY`, `QDRANT_URL`,
`QDRANT_API_KEY` and sets the static Vertex config — see `.github/workflows/deploy.yml`.
It does **not** flip the cutover switches; you do that in §4.

---

## 3. Install + deploy the code

Push to `main`. The pipeline runs `npm install` (the Dockerfile now uses `install`, so the
new `pdf-parse` dependency resolves) and deploys. After it's green, check:

```
curl https://<your-cloud-run-url>/health
# expect: "kbBackend":"file", "authEnabled":false  (still legacy — not flipped yet)
```

---

## 4. Cutover (deliberate, reversible)

Flip the switches on the Cloud Run service **after** §2 is confirmed. Set these env vars
(Console → Cloud Run → Edit & Deploy New Revision → Variables, or `gcloud run services
update`):

```
KB_BACKEND=qdrant
LLM_PROVIDER=vertex
EMBED_PROVIDER=vertex
```

Then seed **server-side** (recommended — uses the server's Vertex + Qdrant config, so
you need NO GCP creds on your laptop):

```
# create collections + seed all 3 tiers in one call
curl -X POST "https://<url>/api/admin/seed"           # add ?recreate=true to rebuild (see below)

# confirm
curl https://<url>/health                             # kbBackend should be "qdrant"
```

(With AUTH_ENABLED, add `-H "Authorization: Bearer <ADMIN_TOKEN>"`.)

> **If you see `Vector dimension error: expected dim 1536, got 256`** — that means the
> seed ran with the local 256-dim embedder instead of Vertex. It happens when running the
> CLI (`npm run ingest:qdrant`) locally without `EMBED_PROVIDER=vertex`. Fix: seed via
> `POST /api/admin/seed` after the cutover (Vertex is active there), or, if collections
> were already created at the wrong dim, rebuild them once:
> `curl -X POST "https://<url>/api/admin/seed?recreate=true"`.

The CLI (`cd backend && npm run ingest:qdrant`) still works if you prefer it, but it needs
`QDRANT_URL`, `QDRANT_API_KEY`, `SA_KEY` (or `GOOGLE_APPLICATION_CREDENTIALS`) and
`EMBED_PROVIDER=vertex` in your local `backend/.env`. Add `-- --recreate` to rebuild.

Open the add-in → **Review** a section. You should get suggestions grounded in the seeded
tiers. **Rollback** at any time by setting `KB_BACKEND=file` (and `LLM_PROVIDER=gemini`)
again — the legacy path is untouched.

---

## 5. Turn on auth (protects tier-2 IP + tier-3 client data)

Until this is on, `tenantId` is taken from the request and is spoofable — fine for the
synthetic first pass, **required before real IP or real client documents go in**.

1. Issue an opaque key per client and build the map, store it as Secret Manager secret and
   expose as env `TENANT_KEYS`, e.g. `{"sk_demo_a1b2":"demo"}`.
2. Set an `ADMIN_TOKEN` (random string) for `/api/admin/*`.
3. Set `AUTH_ENABLED=true`.
4. In the add-in, store the client's key:
   `localStorage.setItem("grantGniClientKey", "sk_demo_a1b2")`. The add-in already sends it
   as `Authorization: Bearer …`; the backend resolves the tenant from it and ignores any
   tenantId in the body/URL. (A proper sign-in screen replaces this later.)

---

## 6. Cluster sizing (your numbers)

~10 clients × 50 docs × ~8000 pages ≈ ~20k chunks at 1536-dim ≈ ~120 MB of vectors. Your
1 GiB / 4 GiB starter node handles this comfortably (payload is stored on-disk). Scale the
Qdrant node up when total chunks pass a few hundred thousand.

---

## 7. Deferred (ready to add next)

- **Phase 3 — Hybrid (BM25 + vector):** Qdrant supports it natively via the Query API +
  sparse vectors. The store adapter is structured for it; we add a sparse encoder and switch
  `search` to the Query API with fusion.
- **Phase 5 — Context compression:** add only after rerank is proven, and apply it to long
  tier-3 docs (not to exemplars, whose exact phrasing is the value).
- **Real auth provider:** swap the API-key map for a verified IdP token (Google Identity /
  Auth0 / Entra) mapped to `tenantId`.

---

## 8. Key files

| File | Purpose |
|---|---|
| `backend/src/config/knowledge.js` | tiers, collections, GCP/Qdrant config |
| `backend/src/providers/gcp-auth.js` | SA-JSON → access token (dependency-free) |
| `backend/src/providers/vertex.js` | Vertex generate / embed / rerank |
| `backend/src/knowledge/stores/qdrant-store.js` | Qdrant REST adapter |
| `backend/src/knowledge/kb.js` | tier-aware ingest + retrieval orchestrator |
| `backend/src/auth/auth.js` | minimal tenant-binding auth |
| `backend/scripts/ingest-knowledge.js` | seed the 3 tiers (`npm run ingest:qdrant`) |
