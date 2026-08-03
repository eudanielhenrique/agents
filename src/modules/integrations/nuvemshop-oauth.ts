import { decryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import {
  buildOAuthCallbackHtml,
  newNonce,
} from "@/modules/vault/oauth-core";

// Nuvemshop/Tiendanube OAuth 2.0 mechanics for the self-service "Connect" flow (self-contained
// here rather than under vault/ since — unlike google_oauth/mcp_oauth — the credential this mints
// is a plain static Bearer token with no refresh cycle; the OAuth dance is a one-time bootstrap,
// not an ongoing vault credential *kind*).
//
// Differences from Google's flow (see vault/google-oauth.ts), all confirmed against Tiendanube's
// docs (tiendanube.github.io/api-documentation/authentication, checked 2026-08):
//   - No PKCE — Tiendanube's authorize/token endpoints never mention code_challenge; it's a plain
//     confidential-client "authorization_code" grant (client_secret sent in the token exchange).
//   - No refresh — the issued access_token never expires, so there is nothing to refresh/store
//     beyond the token itself.
//   - client_id/client_secret are PLATFORM-WIDE (one Partner App, config.nuvemshopClientId/Secret),
//     never per-tenant/per-entry like Google's — a tenant never brings their own OAuth app here.
//   - The authorize URL path segment IS the client_id ("app id" and "client id" are the same value
//     in Tiendanube's model).

const AUTHORIZE_ORIGIN = "https://www.tiendanube.com";
const TOKEN_ENDPOINT = "https://www.tiendanube.com/apps/authorize/token";
const TOKEN_TIMEOUT_MS = 10_000;

// OAuth state is short-lived: it only has to survive the consent round-trip.
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface NuvemshopOAuthState {
  v: 1;
  tenantId: string;
  userId: string;
  // The name the created IntegrationInstance gets; chosen by the operator before starting the flow.
  integrationName: string;
  exp: number;
  nonce: string;
}

export function buildState(params: {
  tenantId: string;
  userId: string;
  integrationName: string;
}): NuvemshopOAuthState {
  return {
    v: 1,
    tenantId: params.tenantId,
    userId: params.userId,
    integrationName: params.integrationName,
    exp: Date.now() + STATE_TTL_MS,
    nonce: newNonce(),
  };
}

export function decryptOAuthState(blob: string): NuvemshopOAuthState {
  const state = decryptJson<NuvemshopOAuthState>(blob);
  if (
    state?.v !== 1 ||
    typeof state.tenantId !== "string" ||
    typeof state.userId !== "string" ||
    typeof state.integrationName !== "string" ||
    typeof state.exp !== "number" ||
    typeof state.nonce !== "string"
  ) {
    throw new AppError("invalid oauth state", 400);
  }
  return state;
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  state: string;
}): string {
  const url = new URL(
    `${AUTHORIZE_ORIGIN}/apps/${encodeURIComponent(params.clientId)}/authorize`,
  );
  url.searchParams.set("state", params.state);
  return url.toString();
}

interface NuvemshopTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  user_id?: string | number;
  store_id?: string | number;
  error?: string;
  error_description?: string;
}

export interface ExchangedNuvemshopTokens {
  accessToken: string;
  storeId: string;
}

// Exchanges the authorization code for the store's (non-expiring) access token. Network only
// targets the fixed Tiendanube token endpoint (no SSRF surface — no operator-supplied URL here).
export async function exchangeCodeForTokens(params: {
  code: string;
  clientId: string;
  clientSecret: string;
}): Promise<ExchangedNuvemshopTokens> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TOKEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        grant_type: "authorization_code",
        code: params.code,
      }),
      redirect: "error",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const json = (await res.json().catch(() => ({}))) as NuvemshopTokenResponse;
  if (!res.ok || json.error) {
    throw new AppError(
      `nuvemshop token endpoint error: ${json.error ?? res.status}`,
      res.status === 400 ? 400 : 502,
      "errors.nuvemshopTokenExchangeFailed",
    );
  }
  const storeId = json.user_id ?? json.store_id;
  if (!json.access_token || storeId == null) {
    throw new AppError(
      "nuvemshop token response missing access_token or user_id",
      502,
      "errors.nuvemshopTokenExchangeFailed",
    );
  }
  return { accessToken: json.access_token, storeId: String(storeId) };
}

// Renders the shared CSP-safe consent-popup callback, bound to the Nuvemshop channel/type the SPA
// listens on.
export function buildCallbackHtml(
  ok: boolean,
  message: string,
  targetOrigin: string,
): string {
  return buildOAuthCallbackHtml({
    ok,
    message,
    targetOrigin,
    channel: "oauth-nuvemshop",
    type: "nuvemshop-oauth",
    title: "Nuvemshop OAuth",
  });
}
