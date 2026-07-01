# Tier 1 — PUBLIC knowledge (drop files here)

Call texts, programme guidelines, public evaluation rules. Anyone can see these; they can be
cited back to clients.

**Drop files here** (`.pdf`, `.docx`, `.md`, `.txt`), then run from `backend/`:
```
node scripts/ingest-folder.mjs      # or: npm run ingest:folder
```

**Metadata (optional but recommended):** add a sidecar next to each file named
`<filename>.meta.json`. Example — `call-CL5-2026.pdf.meta.json`:
```json
{ "docType": "call", "callId": "HORIZON-CL5-2026-D3-01", "programme": "horizon-europe",
  "cluster": "4", "topic": "AI", "trl": 6, "country": null }
```
For `.md` files you can instead put `program:/docType:/section:/callId:` in YAML frontmatter.
Anything unset defaults to `programme: horizon-europe`.
