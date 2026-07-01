# Tier 3 — CLIENT-private knowledge (one subfolder per client)

Each client's own past **winning proposals** and their guidelines. Private to that client,
deletable per client.

**Create one subfolder per client** (the folder name = the Client ID used in the add-in),
then drop the client's files inside:
```
tier3/
  acme/           <- Client ID "acme"
    acme-winning-2024.pdf
    acme-winning-2024.pdf.meta.json
  globex/         <- Client ID "globex"
    globex-impact.docx
```

Then run from `backend/`:
```
node scripts/ingest-folder.mjs      # or: npm run ingest:folder
```

**Metadata sidecar** `<filename>.meta.json`:
```json
{ "docType": "winning-proposal", "section": "impact", "programme": "horizon-europe" }
```
`section` = `excellence` | `impact` | `implementation`. Unset fields default to
`programme: horizon-europe`.

> Testers can also self-upload their tier-3 docs directly in the add-in's **Review** pane
> (set their Client ID → "Add to my knowledge base") — no folder needed.
