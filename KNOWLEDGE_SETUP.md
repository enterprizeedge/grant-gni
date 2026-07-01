# Grant Gni — Adding Knowledge & Running a Test System

How to load real knowledge into the three tiers, with metadata, so Review and drafting work
on real proposals for your testers. **Everything is folder + one command — you don't run
around.**

## The three tiers

| Tier | What goes in | Who sees it | Folder |
|---|---|---|---|
| **1 — Public** | call texts, programme guidelines, public rules | everyone (citable) | `backend/knowledge/tier1/` |
| **2 — Your IP** | your **templates** + drafting/review **skills** | **never shown to clients** — prompt-only | `backend/knowledge/tier2/` |
| **3 — Client** | a client's own **winning proposals** / guidelines | only that client; deletable | `backend/knowledge/tier3/<clientId>/` |

All three feed **both** drafting and review.

---

## How retrieval + metadata filtering works (read this)

Every Review does: **semantic (vector) search → metadata filtering → Vertex reranking → top
passages → the model.** The filtering is now **live**:

- **Always filtered:** `tier` (public/IP/client), `client` (tenant isolation for tier 3), and
  **`programme`**. So always set `programme` (defaults to `horizon-europe`).
- **Filtered when you set them (optional):** `cluster`, `topic`, `trl`, `country`. Set these
  in the **Review pane** to narrow retrieval to matching documents.
- **Soft (not a hard filter):** `section` steers the query wording (so call/template context
  isn't accidentally excluded). `docType` is stored and shown but not filtered, so a Review
  still sees calls + templates + exemplars together.
- **Safety fallback:** if your optional filters are so specific that *nothing* matches, the
  system automatically relaxes to `programme`-only and retries — a Review never comes back
  empty just because a filter was too tight.

> **Still not wired:** BM25 keyword / hybrid search (Phase 3). Retrieval is dense-vector +
> metadata filtering + rerank. Say the word to add hybrid keyword search.

### How to use the filters
In the add-in's **Review** pane, fill any of **Cluster / Topic / TRL / Country** before
clicking Review. Example: reviewing an Impact section of a Cluster-4, AI, TRL-6 proposal —
set Cluster `4`, Topic `AI`, TRL `6`. Retrieval then prefers documents tagged that way. Leave
them blank to search everything for the programme. For the filters to bite, the documents
must carry matching metadata (see §1) — so tag your tier-1/2/3 files with the same
`cluster`/`topic`/`trl` values you'll filter on.

---

## 0. Prerequisites (once)

```
curl https://grant-gni-backend-418969920062.europe-west1.run.app/health
```
Expect `"kbBackend":"qdrant"`, `"provider":"vertex"`, `"providerConfigured":true`, `"version":"0.5.0"`.

Create the collections (safe to re-run):
```
curl -X POST ".../api/admin/bootstrap" -H "Content-Type: application/json" -d "{}"
```

---

## 1. Where to put files + how to add metadata

Drop files into the tier folders (each folder has a README with examples):

```
backend/knowledge/
  tier1/                         # public: call texts, programme guides
    call-CL5-2026.pdf
    call-CL5-2026.pdf.meta.json
  tier2/                         # YOUR IP: templates + skills
    proposal-template.docx
    proposal-template.docx.meta.json
    review-methodology.md
  tier3/
    acme/                        # Client ID "acme"
      acme-winning-2024.pdf
      acme-winning-2024.pdf.meta.json
    globex/                      # Client ID "globex"
      globex-impact.docx
```

Supported files: **.pdf, .docx, .md, .txt**. `README.md` and `*.meta.json` are ignored.

### Metadata — three ways to set it
1. **Sidecar JSON (works for any file):** put `<filename>.meta.json` next to the file.
2. **YAML frontmatter (`.md` only):** `program:/docType:/section:/callId:` at the top.
3. **CLI flags** (single-file command in §3).

**Metadata fields:**

| Field | Meaning | Example |
|---|---|---|
| `programme` | funding programme — **filtered, always set it** | `horizon-europe` |
| `docType` | `call` \| `programme` \| `template` \| `skill` \| `winning-proposal` \| `guideline` | `call` |
| `section` | `excellence` \| `impact` \| `implementation` | `impact` |
| `callId` | specific call identifier | `HORIZON-CL5-2026-D3-01` |
| `cluster` | (stored) programme cluster | `4` |
| `topic` | (stored) topic/theme | `AI` |
| `trl` | (stored) technology readiness level (number) | `6` |
| `country` | (stored) | `Norway` |

Example `call-CL5-2026.pdf.meta.json`:
```json
{ "docType": "call", "callId": "HORIZON-CL5-2026-D3-01", "programme": "horizon-europe",
  "cluster": "4", "topic": "AI", "trl": 6, "country": null }
```
Anything unset defaults to `programme: horizon-europe`.

---

## 2. Ingest everything — one command

From `backend/`:
```
npm run ingest:folder
```
This walks all three tier folders, resolves metadata (sidecar / frontmatter / defaults),
sends each file to the backend, which extracts text, embeds on Vertex, and stores in Qdrant.
Re-running overwrites the same chunks (no duplicates). For tier 3, the client folder name
becomes the Client ID automatically.

---

## 3. Add a single file (alternative)

```
cd backend
node scripts/add-knowledge.mjs --tier 1 --file "C:\docs\call.pdf" --docType call --programme horizon-europe --callId HORIZON-CL5-2026-D3-01
node scripts/add-knowledge.mjs --tier 2 --file "C:\ip\template.docx" --docType template
node scripts/add-knowledge.mjs --tier 3 --tenant acme --file "C:\clients\acme\winning.pdf" --docType winning-proposal --section impact
```
Flags: `--tier --tenant --file --docType --section --programme --callId --cluster --topic --trl --country`.

Testers can also self-upload **tier 3** in the add-in's **Review** pane (set Client ID →
"Add to my knowledge base") — no folder needed.

---

## 4. Do I need to "run ingest" after a client uploads? — No.

**Add-in uploads are ingested instantly.** When a client uses **Add to my knowledge base** in
the Review pane, the file is extracted, embedded on Vertex, and stored in Qdrant *in that same
request*. There is **no separate ingest step** for client uploads — it's ready for their next
Review immediately.

You only run an ingest command (`npm run ingest:folder` / `add-knowledge.mjs`) for files **you**
place in the `backend/knowledge/` folders (your tier-1/tier-2 content, or tier-3 you pre-load).

### See which clients have uploaded (and how much)
```
curl "https://grant-gni-backend-418969920062.europe-west1.run.app/api/admin/tenants"
```
Returns each Client ID with its indexed-passage count, e.g.
`{"tenants":[{"tenantId":"acme","passages":42},{"tenantId":"globex","passages":18}]}`.
That's your signal of who has data — no need to guess or run anything.

## 5. Verify & manage

```
curl .../health                              # global tier-1 & tier-2 counts
curl ".../api/tenant/acme/status"            # one client's private KB (docs + passages)
curl -X DELETE ".../api/tenant/acme/documents"   # GDPR wipe for one client
```

---

## 6. What a tester does (end-to-end)

1. Install the add-in (`FRONTEND_DEPLOYMENT.md`), open their proposal in Word.
2. In **Review**, set their **Client ID**, upload 1–3 past **winning proposals** (tier 3).
3. Pick a section → **Review** → suggestions grounded in the call (tier 1), your templates +
   methodology (tier 2, hidden from them), and their own proposals (tier 3).
4. Use **chat** to draft/edit; the **Checklist** runs your checks on every document.

Each tester uses a **distinct Client ID** so tier-3 data stays separate.

---

## Notes

- **Auth:** for testing, `AUTH_ENABLED=false` is fine (separation by Client ID). Turn on auth
  before real client data — see `V3_VECTOR_DB_SETUP.md` §5.
- **Re-ingest** only when you change `EMBED_MODEL`/`EMBED_DIM`. Changing the LLM, domain, or
  frontend does not require it.
- The synthetic demo corpus is separate (`npm run ingest:qdrant`); for a clean real system,
  use the folders above instead.
