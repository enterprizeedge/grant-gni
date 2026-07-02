# Monetization — Plans, Quotas & Billing

Implemented July 2026. Three subscription tiers + a one-time booster,
server-side token metering, and a free trial for anonymous Marketplace users.

**Two billing modes, same plans and license keys:**

1. **Invoice-first (CURRENT / recommended to start)** — no payment gateway.
   You invoice customers yourself; when they pay, you mint their license key
   with one curl command. Right for B2B at this price point, zero gateway
   setup, revenue this week. See "Invoice-first operations" below.
2. **Paddle self-serve (dormant, ready when needed)** — Merchant of Record
   checkout (Paddle handles EU VAT). All Paddle endpoints return 503 until its
   secrets are configured, so it costs nothing while dormant. Switch it on
   when manual invoicing stops scaling (~20–30 customers); existing invoice
   customers keep their keys unchanged.

## The offer

| Plan | Price | Monthly allowance | What it means for the user |
|------|-------|-------------------|----------------------------|
| Free trial (anonymous) | €0 | 200k tokens | ~8–10 Reviews/edits to evaluate the product. Metered per IP. |
| **Reviewer** | €99/user/mo | 2M tokens | ~80–150 Reviews OR ~40 full-document edit passes. Review & polish — can't draft a full proposal. |
| **Writer** | €299/user/mo | 12M tokens | One full proposal drafting cycle (200–300 edit turns) + continuous Reviews. |
| **Studio** | €799/user/mo | 60M tokens **soft cap** | Multiple proposals in parallel, unlimited Reviews. **Never hard-blocked** — over-cap usage is logged for fair-use follow-up, not cut off. |
| Deadline Boost | €49 one-time | +5M tokens | Credited to the current month. For crunch weeks — cheaper and stickier than a tier jump users cancel afterwards. |

Why these numbers: a competitive Horizon Europe proposal costs 1000+
professional hours (€30k–100k of consultant labour), so Studio is priced
against consultants, not against AI chat apps. Worst-case provider cost
(Writer fully burned, mostly 2.5 Pro) is roughly €30–80 — healthy margin at
every tier. Tier changes mid-cycle are Paddle-prorated, so deadline upgrades
take effect immediately — this is the intended behaviour, not a loophole.
Multiple parallel proposals aren't a problem: tokens are tokens, whatever
document they're spent on; the quota is per license (seat).

Sell **annual plans at 2 months free** (Paddle: add yearly prices) once
monthly is proven.

## How it works (code)

- `backend/src/billing/plans.js` — the catalog above (single source of truth).
- `backend/src/billing/store.js` — licenses + monthly usage counters.
  `BILLING_STORE=memory` (dev) or `firestore` (prod; same service account as
  Vertex, dependency-free REST).
- `backend/src/billing/quota.js` — resolves caller → plan (legacy TENANT_KEYS
  → Paddle license → anonymous trial), enforces the monthly budget (402
  `QUOTA_EXCEEDED` with an upgrade link; Studio soft-logs instead), records
  usage from each response's `usageMetadata`. **Fails open** on store errors —
  billing must never take the product down; rate limits still bound abuse.
- `backend/src/billing/paddle.js` — signature-verified webhook (provisions/
  updates/cancels licenses, credits boosts) + the checkout success page that
  shows buyers their `gg_live_…` key.
- Add-in: License Key field in ⚙ Settings; the key rides along as
  `Authorization: Bearer` on every backend call; a usage meter in Settings
  shows "Plan: Writer — 3.2M of 12M tokens used this month".

## Invoice-first operations (CURRENT MODE)

Setup needed: **only Firestore** (step 1 below) so licenses survive restarts —
skip all Paddle steps. Then your day-to-day is four commands (set
`B=https://your-backend-url` and `T=your ADMIN_TOKEN`):

```bash
# Invoice paid -> mint a key, email it to the customer with a pointer to
# Word -> Grant Gni -> ⚙ Settings -> License Key:
curl -X POST $B/api/admin/licenses -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" \
  -d '{"plan":"writer","tenantId":"acme-consulting","note":"INV-2026-014"}'

# Deadline tier change (up or down, live within seconds):
curl -X POST $B/api/admin/licenses/gg_live_xxx -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" -d '{"plan":"studio"}'

# Sell a €49 Deadline Boost (+5M tokens this month):
curl -X POST $B/api/admin/licenses/gg_live_xxx/boost -H "Authorization: Bearer $T"

# Non-payment / churn -> revoke (key falls back to trial limits):
curl -X POST $B/api/admin/licenses/gg_live_xxx -H "Authorization: Bearer $T" \
  -H "Content-Type: application/json" -d '{"status":"canceled"}'
```

Monthly routine: `curl $B/api/admin/licenses -H "Authorization: Bearer $T"`
lists every license with its plan, status, invoice note, and this month's
usage — that's your renewal-invoicing worksheet. Downgrade-after-deadline is
just another plan update. Suggested invoice terms: monthly or quarterly in
advance, tier changes prorated at your discretion (you control both the
invoice and the switch, so "generous" is cheap goodwill).

Trade-offs to accept: no self-serve signup (trial users must contact you —
put a "Get a license" mailto on the pricing page), manual dunning, and you
handle VAT on your own invoices (your accountant likely already does).

---

## SAM'S SETUP CHECKLIST

### 1. Firestore (10 min) — REQUIRED for invoice mode too
Enable the API and create the default database (native mode) in `grant-gni`:
```bash
gcloud services enable firestore.googleapis.com --project=grant-gni
gcloud firestore databases create --location=europe-west1 --project=grant-gni
```
The runtime service account needs `roles/datastore.user`:
```bash
gcloud projects add-iam-policy-binding grant-gni \
  --member="serviceAccount:418969920062-compute@developer.gserviceaccount.com" \
  --role="roles/datastore.user"
```

### 2. Paddle (30–60 min) — LATER, when self-serve is needed; skip for invoice mode
1. Create a Paddle account (start in **sandbox**: sandbox-vendors.paddle.com).
2. Catalog → create product "Grant Gni" with 4 prices:
   Reviewer €99/mo, Writer €299/mo, Studio €799/mo (recurring monthly),
   Deadline Boost €49 (one-time). Note the 4 price IDs (`pri_…`).
3. Developer Tools → Notifications → add destination
   `https://YOUR-BACKEND-URL/api/billing/webhook/paddle`, subscribe to:
   `subscription.created`, `subscription.activated`, `subscription.updated`,
   `subscription.canceled`, `transaction.completed`. Copy the webhook secret.
4. Developer Tools → Authentication → create an API key.
5. Checkout settings → default payment success URL:
   `https://YOUR-BACKEND-URL/api/billing/key?txn={transaction_id}`
   (this page shows the buyer their license key).
6. Build a simple pricing page at PRICING_URL with Paddle checkout buttons
   for the 3 plans + boost. For the boost button, pass the customer's license
   key as checkout `customData: { license_key: "gg_live_…" }` so the webhook
   can credit the right account (unmatched boosts are logged for manual credit).

### 3. Secrets & config (after sandbox testing works)
Create secrets (console → add a version with the value, like you did for
APP_TOKEN — **remember to actually paste the value**):
`PADDLE_WEBHOOK_SECRET`, `PADDLE_API_KEY`, `PADDLE_PRICE_MAP`
(the map is JSON, e.g. `{"pri_01ab":"reviewer","pri_02cd":"writer","pri_03ef":"studio","pri_04gh":"boost"}`).
Grant the runtime SA `secretmanager.secretAccessor` on each (same commands as
SECURITY_SETUP.md Step 1). Then wire them onto the service — deliberately NOT
in deploy.yml yet, so a missing secret can't fail your CI again:
```bash
gcloud run services update YOUR_SERVICE --region europe-west1 \
  --update-env-vars BILLING_STORE=firestore \
  --update-secrets PADDLE_WEBHOOK_SECRET=PADDLE_WEBHOOK_SECRET:latest,PADDLE_API_KEY=PADDLE_API_KEY:latest,PADDLE_PRICE_MAP=PADDLE_PRICE_MAP:latest
```
(While testing sandbox, also `--update-env-vars PADDLE_API_BASE=https://sandbox-api.paddle.com`;
remove it when you go live. Once stable, move these into deploy.yml's
`--update-secrets` list so they survive future deploys' consistency.)

### 4. Test end-to-end in sandbox
1. Buy Reviewer with Paddle's test card (4242 4242 4242 4242).
2. Success page shows a `gg_live_…` key → paste into Word → ⚙ Settings.
3. Settings shows "Plan: Reviewer — 0.0M of 2.0M tokens…".
4. Chat a few times; the meter moves. In Paddle sandbox, upgrade the
   subscription to Writer → within 5 minutes (license cache TTL) the meter
   shows 12M. Cancel → the key drops back to trial limits.
5. Buy a Boost with your key in customData → allowance +5M for the month.

### 5. Rollout order
1. Deploy backend with `BILLING_STORE=firestore` + Paddle secrets (sandbox).
2. Deploy frontend (adds the License Key field + meter) — safe anytime.
3. Test per step 4. Switch Paddle to live keys/prices. Update PRICING_URL page.
4. Update the Marketplace listing copy: free trial included, subscription
   unlocks full usage ("Additional purchase may be required" flag).

## Notes & known trade-offs (deliberate v1)
- Usage counters are read-modify-write without transactions — a busy caller
  may occasionally get a few thousand tokens free. Favouring the customer;
  revisit if billing must be token-exact.
- License cache TTL is 5 min: plan changes/cancellations take up to 5 min to
  propagate. Fine for this price point.
- Trial is IP-metered: shared offices share a trial pool, VPN users can reset
  it. It's a funnel, not a fortress — the rate limiter still caps abuse.
- Key delivery is via the checkout success page only. If a buyer closes it,
  they can revisit the same URL from their Paddle receipt email
  (`…/api/billing/key?txn=…`). Consider adding transactional email later.
- When AUTH_ENABLED=true, legacy TENANT_KEYS still work and get the
  TENANT_KEYS_PLAN plan (default "writer") — your existing demo clients keep
  working unchanged.
