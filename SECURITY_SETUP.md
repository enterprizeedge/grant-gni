# Security Hardening — Setup & Rollout Guide

This documents the security changes from the CTO review implementation pass
(July 2026) and — most importantly — **the steps SAM must do by hand**, in
order. The code is already in place; nothing activates until you do these
steps, so the current production behaviour is unchanged until you act.

## What changed in code (already done)

| # | Change | Where |
|---|--------|-------|
| 1 | Per-caller rate limiting + daily quota on `/api/generate`, `/api/advise`, `/api/retrieve`, tenant upload | `backend/src/middleware/rate-limit.js` |
| 2 | Optional `X-App-Token` gate (add-in identifier, blocks drive-by abuse) | `backend/src/middleware/app-token.js` + frontend sends it everywhere |
| 3 | CORS default locked to `https://grant-gni.pages.dev` + `https://localhost:3000` (was: any origin) | `backend/src/server.js` |
| 4 | Admin endpoints **fail closed**: 503 until `ADMIN_TOKEN` is set, 401 without it | `backend/src/auth/auth.js` |
| 5 | `/api/retrieve` now goes through `requireTenant` (no more body-spoofable tenantId) | `backend/src/server.js` |
| 6 | Structured JSON request logs incl. token usage (visible in Cloud Logging) | `backend/src/middleware/request-log.js` |
| 7 | XSS fix: model output sanitized with DOMPurify before rendering | `src/taskpane/modules/chat/chat-ui.js` |
| 8 | AI safety filter default `BLOCK_ONLY_HIGH`, user-configurable in Advanced Settings (was hardcoded `BLOCK_NONE`) | `src/taskpane/modules/settings/settings-store.js` + `taskpane.html` |
| 9 | `.env` now loads before module init (`import "dotenv/config"`) — AUTH/TENANT env vars actually work in local dev | `backend/src/server.js` |
| 10 | Test runners + CI gate: backend tests block deploys; add-in tests run non-blocking (flip later) | `backend/tests/`, `tests/run-all.mjs`, `.github/workflows/deploy.yml` |
| 11 | Module extractions: settings → `modules/settings/settings-store.js`, checkpoints → `modules/checkpoints/checkpoints.js` | `src/taskpane/` |

---

## SAM'S TO-DO LIST (in this order)

### Step 0 — Local verification (10 min)

```bash
# Backend: install (restores express/pdf-parse if needed) and run new tests
cd backend
npm install
npm test          # expect: 3/3 backend test files passed

# Frontend: update lockfile (adds dompurify) and make sure it builds
cd ..
npm install
npm run build     # webpack will catch any syntax issue instantly
npm test          # add-in test baseline — note any pre-existing failures
```

> Note: I could not run the webpack build in my sandbox (file-mount limitation),
> so `npm run build` is the definitive syntax check for the frontend edits.
> The backend was fully smoke-tested (boot + rate limit + app token + admin
> fail-closed + CORS all verified working).

### Step 1 — Create the new Secret Manager secrets (BEFORE pushing to main)

The updated deploy workflow wires three new secrets. **The deploy will fail
until these exist.** Generate strong values (e.g. `openssl rand -hex 24`).

```bash
# Admin token (protects /api/admin/* — ingest, seed, bootstrap, tenant list)
printf '%s' "REPLACE_WITH_RANDOM_VALUE" | gcloud secrets create ADMIN_TOKEN \
  --project=grant-gni --data-file=- --replication-policy=automatic

# App token — MUST MATCH the value in src/taskpane/modules/backend/app-token.js
# (currently "gg-addin-2026-07-r1")
printf '%s' "gg-addin-2026-07-r1" | gcloud secrets create APP_TOKEN \
  --project=grant-gni --data-file=- --replication-policy=automatic

# Tenant keys: JSON map of client API key -> tenantId. Start with your demo org.
printf '%s' '{"sk_live_REPLACE_ME":"demo"}' | gcloud secrets create TENANT_KEYS \
  --project=grant-gni --data-file=- --replication-policy=automatic

# Give the Cloud Run runtime SA access (it already has it for sa_key/QDRANT_*,
# repeat to be safe):
gcloud secrets add-iam-policy-binding ADMIN_TOKEN --project=grant-gni \
  --member="serviceAccount:YOUR_RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding APP_TOKEN --project=grant-gni \
  --member="serviceAccount:YOUR_RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
gcloud secrets add-iam-policy-binding TENANT_KEYS --project=grant-gni \
  --member="serviceAccount:YOUR_RUNTIME_SA" --role="roles/secretmanager.secretAccessor"
```

### Step 2 — Deploy the FRONTEND first (critical ordering)

The backend will start requiring `X-App-Token` as soon as the APP_TOKEN secret
is wired (next backend deploy). Clients running the OLD frontend don't send
that header and would be locked out. So:

```bash
npm run build -- --env urlProd=https://grant-gni.pages.dev/
npx wrangler pages deploy dist --project-name grant-gni
```

`_headers` sets no-cache, so live users pick up the new bundle immediately.
Give it a few minutes, verify the pane still works in Word, then proceed.

### Step 3 — Push to main (deploys the hardened backend)

The workflow now: runs backend tests (blocking) → deploys with the new secrets
and `ALLOWED_ORIGINS` + `RATE_LIMIT_ENABLED` env. Watch the Actions run.

Verify after deploy (replace URL if different):

```bash
B=https://grant-gni-backend-418969920062.europe-west1.run.app

# No app token -> 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/generate -H 'Content-Type: application/json' -d '{}'

# With app token -> 200 (real model response)
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/api/generate?model=gemini-2.5-flash" \
  -H 'Content-Type: application/json' -H 'X-App-Token: gg-addin-2026-07-r1' \
  -d '{"contents":[{"role":"user","parts":[{"text":"say hi"}]}]}'

# Admin without token -> 401 (was: fully open!)
curl -s -o /dev/null -w "%{http_code}\n" -X POST $B/api/admin/bootstrap
```

### Step 4 — Flip AUTH_ENABLED=true (when ready to issue client keys)

**Consequence to understand first:** with auth on, `/api/advise`, `/api/retrieve`
and tenant KB endpoints require a valid Bearer key from TENANT_KEYS. Users
without a key lose the Review/KB features (chat keeps working — it's gated by
app token + rate limits, not tenant auth). So issue keys to your real clients
first (add entries to the TENANT_KEYS secret, add new secret version), have
them paste the key in the add-in (it's sent as `Authorization: Bearer`), then:

```bash
gcloud run services update SERVICE_NAME --region europe-west1 \
  --update-env-vars AUTH_ENABLED=true
```

### Step 5 — Least-privilege service account (Rec 10)

Audit what the deploy/runtime SAs currently have (the commit history mentions
adding "Storage Admin" — broader than needed):

```bash
gcloud projects get-iam-policy grant-gni \
  --flatten="bindings[].members" --filter="bindings.members:serviceAccount" \
  --format="table(bindings.members,bindings.role)"
```

The runtime SA needs only: `roles/aiplatform.user` (Vertex generate/embed),
`roles/discoveryengine.viewer` (ranking API), `roles/secretmanager.secretAccessor`.
The deploy SA needs: `roles/run.admin`, `roles/iam.serviceAccountUser`,
`roles/cloudbuild.builds.editor`, `roles/artifactregistry.writer`,
`roles/storage.objectAdmin` **scoped to the Cloud Build staging bucket only**
(not project-wide Storage Admin). Remove anything broader (Editor, Owner,
project-wide Storage Admin).

### Step 6 — Alerts (15 min, recommended)

The backend now emits one JSON log line per request with `severity`, `status`,
`ms`, `caller`, `model` and token `usage`. In Cloud Console → Logging:
- Create a logs-based metric on `jsonPayload.status=429` (rate-limit hits) and
  alert if it spikes (someone probing).
- Create a metric on `jsonPayload.usage.totalTokens` (sum) and alert on a daily
  budget threshold — this is your spend early-warning.

---

## Config reference (new env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `RATE_LIMIT_ENABLED` | `true` | Master switch for rate limiting |
| `RATE_LIMIT_PER_MIN` | `10` | Sustained requests/min per caller |
| `RATE_LIMIT_BURST` | `20` | Burst capacity per caller |
| `RATE_LIMIT_DAILY` | `500` | Requests per caller per UTC day |
| `APP_TOKEN` | unset (gate off) | Expected `X-App-Token` header value |
| `ALLOWED_ORIGINS` | pages.dev + localhost | CORS allow-list; `*` = any (don't, in prod) |
| `ADMIN_TOKEN` | unset (admin = 503) | Bearer token for `/api/admin/*` |

**Known limitation (accepted):** rate-limit counters are per Cloud Run
instance, so with N instances the effective limit is up to N×. Fine as an
abuse brake; move to a shared store (Redis/Firestore) when limits must be
exact for billing.

**App-token rotation:** change the constant in
`src/taskpane/modules/backend/app-token.js`, deploy the frontend, wait for
clients to refresh (no-cache makes this fast), then add a new APP_TOKEN secret
version. During the window, old clients get a clear "update the add-in" error.
