# Grant Gni — Frontend Deployment (Cloudflare Pages)

The task pane is a static webpack build. Host it on Cloudflare Pages (free HTTPS),
then share the built `manifest.xml` with testers.

**Live URL:** `https://grant-gni.pages.dev`
**Backend:** `https://grant-gni-backend-418969920062.europe-west1.run.app` (already wired in)

---

## Deploy / update the frontend

From the repo root:

```
# 1. Build, pointing the manifest at your Pages URL (trailing slash matters!)
npm run build -- --env urlProd=https://grant-gni.pages.dev/

# 2. Deploy the whole dist/ folder
npx wrangler pages deploy dist --project-name grant-gni
```

First time only, log in / create the project:
```
npx wrangler login
npx wrangler pages project create grant-gni --production-branch main
```

Verify these all load over HTTPS:
- `https://grant-gni.pages.dev/taskpane.html`
- `https://grant-gni.pages.dev/commands.html`
- `https://grant-gni.pages.dev/manifest.xml`

`_headers` (in the repo root, copied into `dist/`) sets `no-cache` on the JS/HTML, so
testers get updates immediately after a redeploy — no re-sideload needed for code changes.

---

## Share the manifest with testers

Upload **`dist/manifest.xml`** (the built one — its URLs already point to `pages.dev`) to
Dropbox / Google Drive / a web page as a **direct download**. Do **not** share the repo-root
`manifest.xml` (that still says `localhost:3000`).

Bump `<Version>` in `manifest.xml` before each release so Word refreshes the add-in.

### How a tester installs it
- **Word on the web (easiest):** Insert → Add-ins → **Upload My Add-in** → pick `manifest.xml`.
- **Word desktop (Windows):** put `manifest.xml` in a shared folder → File → Options → Trust
  Center → **Trusted Add-in Catalogs** → add the folder (tick "Show in Menu") → restart Word →
  Insert → My Add-ins → **Shared Folder** → Grant Gni.

---

## One backend setting for a new frontend origin

CORS must allow the Pages origin (set once on Cloud Run):
```
gcloud run services update grant-gni-backend --region europe-west1 ^
  --update-env-vars "ALLOWED_ORIGINS=https://grant-gni.pages.dev,https://localhost:3000"
```

---

## Updating: which change needs what

| You changed… | Rebuild frontend? | Redeploy Pages? | Re-share manifest? | Deploy backend? |
|---|---|---|---|---|
| Task pane UI / JS | yes | yes | no | no |
| Manifest (name, icons, version, URLs) | yes | yes | **yes** | no |
| Backend logic / knowledge | no | no | no | yes (push to `main`) |

**Custom domain later:** Pages → project → Custom domains → add e.g.
`addin.zaviontechnologies.com`, then rebuild with `--env urlProd=https://addin.zaviontechnologies.com/`
and re-share the manifest.
