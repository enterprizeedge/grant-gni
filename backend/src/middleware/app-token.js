// Optional shared app token — a cheap "is this our add-in?" gate.
// ---------------------------------------------------------------------------
// The add-in ships a constant token and sends it as `X-App-Token` on every
// backend call. The token is public by nature (anyone can extract it from the
// bundle), so this is NOT authentication — it only stops naive drive-by abuse
// of the open endpoints (scripts that found the Cloud Run URL). Real per-client
// auth remains TENANT_KEYS / Authorization bearer.
//
// Config (env):
//   APP_TOKEN = expected value of the X-App-Token header.
//               UNSET (default) -> gate disabled, nothing breaks.
//
// Rollout order matters: deploy the frontend that sends the header FIRST, then
// set APP_TOKEN on the backend. Setting APP_TOKEN before clients send the
// header would lock out live users.
// ---------------------------------------------------------------------------

const APP_TOKEN = process.env.APP_TOKEN || "";

export function requireAppToken(req, res, next) {
  if (!APP_TOKEN) return next(); // gate disabled until configured
  const supplied = String(req.headers["x-app-token"] || "");
  if (supplied === APP_TOKEN) return next();
  return res.status(401).json({
    error: {
      message:
        "This endpoint only serves the Grant Gni add-in. Please update the add-in to the latest version.",
      code: "APP_TOKEN_REQUIRED",
    },
  });
}
