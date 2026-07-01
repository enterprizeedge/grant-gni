# Tier 2 — YOUR IP (drop files here)

Your proposal **templates** and your **drafting/review skills/methodology**. This is your
intellectual property: it is used to ground drafting and review prompts but is **never shown
to clients** and never returned in API responses.

**Drop files here** (`.pdf`, `.docx`, `.md`, `.txt`), then run from `backend/`:
```
node scripts/ingest-folder.mjs      # or: npm run ingest:folder
```

**Metadata sidecar** `<filename>.meta.json` — set `docType` to `template` or `skill`:
```json
{ "docType": "template", "programme": "horizon-europe" }
```
```json
{ "docType": "skill", "programme": "horizon-europe" }
```
Unset fields default to `programme: horizon-europe`.
