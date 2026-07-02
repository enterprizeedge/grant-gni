// Plan catalog — the single source of truth for tiers, prices and quotas.
// ---------------------------------------------------------------------------
// PRICING RATIONALE (July 2026):
//   A competitive Horizon Europe proposal costs 1000+ professional hours
//   (€30k–100k+ in consultant labour), so pricing anchors against consultant
//   rates, not against generic AI chat subscriptions. Quotas are TOKEN budgets
//   enforced server-side but always described to users in plain language
//   ("enough for ~80 Reviews", "a full proposal cycle").
//
//   Sizing math (typical proposal doc = 30–60k tokens of context per chat
//   turn; a Review ≈ 10–25k tokens total):
//     reviewer  2M/mo  ≈ 80–150 Reviews OR ~40 full-document edit turns.
//                        Enough to review and polish — not enough to draft.
//     writer   12M/mo  ≈ one full proposal drafting cycle (200–300 edit
//                        turns) plus continuous Reviews.
//     studio   60M/mo  SOFT cap ≈ several proposals in parallel. Studio is
//                        never hard-blocked (agencies at deadline must not be
//                        cut off); past the soft cap requests are logged and
//                        flagged for fair-use follow-up.
//     boost    +5M     one-time top-up for deadline crunches — cheaper and
//                        stickier than forcing a tier jump users will cancel.
//   Mid-cycle tier changes are handled by Paddle with proration, so users can
//   jump to a higher tier the week before a deadline and drop back after.
// ---------------------------------------------------------------------------

export const PLANS = Object.freeze({
  trial: {
    id: "trial",
    name: "Free trial",
    pricePerMonthEur: 0,
    monthlyTokens: 200_000, // ~8–10 Reviews/edits — enough to evaluate, keyed by IP
    hardLimit: true,
  },
  reviewer: {
    id: "reviewer",
    name: "Reviewer",
    pricePerMonthEur: 99,
    monthlyTokens: 2_000_000,
    hardLimit: true,
  },
  writer: {
    id: "writer",
    name: "Writer",
    pricePerMonthEur: 299,
    monthlyTokens: 12_000_000,
    hardLimit: true,
  },
  studio: {
    id: "studio",
    name: "Studio",
    pricePerMonthEur: 799,
    monthlyTokens: 60_000_000,
    hardLimit: false, // soft cap: log + flag, never block (deadline safety)
  },
});

// One-time top-up (Paddle one-time price). Credited to the CURRENT month.
export const BOOST_TOKENS = 5_000_000;
export const BOOST_PRICE_EUR = 49;

export function getPlan(id) {
  return PLANS[id] || PLANS.trial;
}

// Where quota-exceeded errors send users. Override with PRICING_URL.
export const PRICING_URL =
  process.env.PRICING_URL || "https://www.zaviontechnologies.com/grant-gni/pricing";

// UTC month key used for usage documents, e.g. "2026-07".
export function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

// Human-readable remaining-allowance line for /api/usage and error messages.
export function describeUsage(plan, used, extra) {
  const allowance = plan.monthlyTokens + (extra || 0);
  const pct = allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0;
  return {
    plan: plan.id,
    planName: plan.name,
    usedTokens: used,
    allowanceTokens: allowance,
    boostTokens: extra || 0,
    percentUsed: pct,
    hardLimit: plan.hardLimit,
  };
}
