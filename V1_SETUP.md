# Grant Gni — v1 Setup & Test Guide

**What changed in v1:** the add-in is now called **Grant Gni** and no longer calls
Google directly. All AI requests go through a small **backend gateway** that holds
the LLM key server-side. "Bring your own key" is gone — there is no API-key field
in Settings anymore. This is the foundation that auth + subscriptions (v2), Vertex
AI + RAG (v3), Excel (v4), and analytics (v5) plug into.

```
Word task pane  ──HTTPS──▶  Grant Gni backend (/api/generate)  ──▶  Gemini
   (no key)                  (holds GEMINI_API_KEY)
```

---

## What you need for v1

- Node.js 18+ (you already build the add-in with it).
- **One Google Gemini API key** for the backend to use — get it at
  https://aistudio.google.com/app/apikey. This is the only secret you supply, and
  it goes in a local `.env` file (never in chat, never committed).

Everything else (auth, Stripe, Vertex, a cloud domain) comes in later versions.

---

## Step 1 — Trust the local dev certificate (once)

Office task panes run over HTTPS, and the browser will **block** an HTTPS task pane
from calling an HTTP backend. So the backend must also be HTTPS locally. The Office
tooling already generates a trusted `localhost` certificate:

```bash
npx office-addin-dev-certs install
```

This creates certs in your user profile, typically:

```
C:\Users\<you>\.office-addin-dev-certs\localhost.crt
C:\Users\<you>\.office-addin-dev-certs\localhost.key
```

Note those two paths — you'll point the backend at them in Step 2.

## Step 2 — Configure & start the backend

```bash
cd backend
npm install
copy .env.example .env        # (Windows)   — or: cp .env.example .env
```

Open `backend/.env` and set:

- `GEMINI_API_KEY=` → paste your Gemini key.
- `SSL_CERT_PATH=` → full path to `localhost.crt` from Step 1.
- `SSL_KEY_PATH=`  → full path to `localhost.key` from Step 1.

Leave `USE_HTTPS=true` and `ALLOWED_ORIGINS=https://localhost:3000` as-is. Then:

```bash
npm start
```

You should see:

```
Grant Gni backend (HTTPS) on https://localhost:3001
  provider=gemini configured=true
```

Quick check (in a second terminal):

```bash
curl -k https://localhost:3001/health
# {"ok":true,...,"provider":"gemini","providerConfigured":true}
```

If `providerConfigured` is `false`, your `GEMINI_API_KEY` isn't set — fix `.env`
and restart. If it falls back to HTTP, your cert paths are wrong.

## Step 3 — Build & sideload the add-in (as before)

From the project root, in a separate terminal:

```bash
npm install
npm start
```

This builds the add-in, serves it on `https://localhost:3000`, and opens Word with
**Grant Gni** sideloaded.

## Step 4 — Confirm it works

1. In Word, open the **Grant Gni** task pane (Home tab → Assistant).
2. Open **Settings** (⚙). Confirm there is **no API-key field** — just a note that
   AI access is managed by your subscription.
3. Type a prompt in the chat (e.g. "summarize this document") and send. A reply
   should come back — that traffic went Word → your backend → Gemini.
4. Ask it to edit something (e.g. "tighten the first paragraph") and confirm the
   change applies as a tracked-change/redline.
5. Sanity check: stop the backend (`Ctrl+C`) and send another prompt — it should
   fail. That proves the add-in is going through your backend, not Google directly.

---

## Notes for later versions

- **Pointing at a deployed backend:** the add-in reads an optional localStorage
  override. In the task pane's dev console run
  `localStorage.setItem("grantGniBackendUrl", "https://your-domain")` — otherwise it
  defaults to `https://localhost:3001`. When you deploy (Cloud Run), also add that
  domain to `<AppDomains>` in `manifest.xml`.
- **v2 (auth + Stripe):** the gateway has a marked seam in
  `backend/src/server.js` (`/api/generate`) where request authentication, the
  subscription/quota check, and usage logging will go.
- **v3 (Vertex AI):** swap `LLM_PROVIDER=vertex` and add a `vertex.js` provider
  alongside `backend/src/providers/gemini.js`; the add-in needs no change.
