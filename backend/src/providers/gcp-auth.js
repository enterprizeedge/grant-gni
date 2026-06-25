// GCP service-account auth — dependency-free.
// ---------------------------------------------------------------------------
// Mints OAuth2 access tokens from a service-account JSON key using Node's crypto
// (signed JWT -> token exchange), so we don't pull in google-auth-library.
//
// The SA key (Secret Manager secret "sa_key") can be provided as either:
//   - SA_KEY                       : the JSON content as a string (Cloud Run env), or
//   - GOOGLE_APPLICATION_CREDENTIALS : a path to the JSON file.
//
// Tokens are cached in-process until shortly before expiry.
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import fs from "node:fs";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

let cachedKey = null;
let tokenCache = { token: null, exp: 0 };

function loadServiceAccount() {
  if (cachedKey) return cachedKey;
  let raw = process.env.SA_KEY;
  if (!raw && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    raw = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, "utf8");
  }
  if (!raw) {
    throw new Error(
      "No service-account key found. Set SA_KEY (JSON) or GOOGLE_APPLICATION_CREDENTIALS (path)."
    );
  }
  cachedKey = typeof raw === "string" ? JSON.parse(raw) : raw;
  return cachedKey;
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function isConfigured() {
  try {
    loadServiceAccount();
    return true;
  } catch {
    return false;
  }
}

export function getProjectId() {
  return loadServiceAccount().project_id;
}

export async function getAccessToken() {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;

  const sa = loadServiceAccount();
  const tokenUri = sa.token_uri || "https://oauth2.googleapis.com/token";
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: SCOPE,
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signingInput = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key);
  const assertion = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    throw new Error(`GCP token exchange failed (${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  tokenCache = { token: json.access_token, exp: now + (json.expires_in || 3600) };
  return tokenCache.token;
}
