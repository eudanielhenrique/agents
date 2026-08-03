import { Elysia, t } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { doc, errors } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import { AppError, ForbiddenError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import { roleAtLeast, type TenantContext } from "@/lib/tenancy";
import { createIntegrationInstance } from "@/modules/integrations/service";
import {
  buildAuthorizeUrl,
  buildCallbackHtml,
  buildState,
  decryptOAuthState,
  exchangeCodeForTokens,
} from "@/modules/integrations/nuvemshop-oauth";
import { createVaultEntry } from "@/modules/vault/service";

// Nuvemshop self-service "Connect" flow. Two controllers, mirroring oauth-google.controller.ts:
//   - nuvemshopConnectController: starts the flow (builds the authorize URL), TENANT_ADMIN, under
//     the tenancy plugin.
//   - nuvemshopCallbackController: the popup redirect target, mounted OUTSIDE the tenancy plugin
//     (Tiendanube's redirect carries no X-Tenant-Id), cookie-auth only. On success it creates BOTH
//     the vault credential AND the integration instance in one shot — the point of this flow is
//     that the operator never types a store id or pastes a token by hand.

// translate('errors.nuvemshopNotConfigured', 'Nuvemshop integration is not configured on this instance')
// translate('errors.nuvemshopTokenExchangeFailed', 'Failed to exchange the Nuvemshop authorization code')

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new ForbiddenError();
  return ctx;
}

function requireNuvemshopConfigured(): void {
  if (!config.nuvemshopOAuthEnabled) {
    throw new AppError(
      "Nuvemshop integration is not configured on this instance (missing NUVEMSHOP_CLIENT_ID/SECRET)",
      400,
      "errors.nuvemshopNotConfigured",
    );
  }
}

export const nuvemshopConnectController = new Elysia({
  prefix: "/v1/integrations/nuvemshop",
  tags: ["Resources"],
})
  .use(tenancyPlugin)
  .post(
    "/connect",
    async ({ tenantContext, body }) => {
      requireNuvemshopConfigured();
      const ctx = ctxOrThrow(tenantContext);
      const state = encryptJson(
        buildState({
          tenantId: String(ctx.tenantId),
          userId: String(ctx.userId),
          integrationName: body.name,
        }),
      );
      const url = buildAuthorizeUrl({
        clientId: config.nuvemshopClientId,
        state,
      });
      return { instance: instanceIdentity, url };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Begin Nuvemshop OAuth connect",
        "Builds the Tiendanube authorization URL and signed state to start the self-service connect flow. The callback creates both the vault credential and the integration instance.",
      ),
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 200,
          description: "Display name for the integration instance to create on success.",
        }),
      }),
      response: errors(400, 401, 403),
    },
  );

const HTML_HEADERS = { "content-type": "text/html; charset=utf-8" } as const;

function htmlError(status: number, message: string, origin: string): Response {
  return new Response(buildCallbackHtml(false, message, origin), {
    status,
    headers: HTML_HEADERS,
  });
}

export const nuvemshopCallbackController = new Elysia({
  prefix: "/v1/oauth/nuvemshop",
  tags: ["Settings"],
})
  .use(authPlugin)
  .get(
    "/callback",
    async ({ getAuthUser, query, request }) => {
      let origin = "";
      try {
        origin = new URL(config.publicUrl).origin;
      } catch {
        const headerOrigin = request.headers.get("origin");
        if (headerOrigin && headerOrigin !== "null") origin = headerOrigin;
      }

      if (!config.nuvemshopOAuthEnabled) {
        return htmlError(400, "nuvemshop_not_configured", origin);
      }
      if (query.error) {
        return htmlError(400, query.error, origin);
      }
      if (!query.code || !query.state) {
        return htmlError(400, "missing_code_or_state", origin);
      }

      const user = await getAuthUser();
      if (!user) {
        return htmlError(401, "unauthenticated", origin);
      }

      try {
        const state = decryptOAuthState(query.state);
        if (state.exp <= Date.now()) {
          return htmlError(400, "state_expired", origin);
        }
        if (state.userId !== String(user.id)) {
          return htmlError(401, "state_user_mismatch", origin);
        }
        const sameTenant =
          user.tenantId !== null && String(user.tenantId) === state.tenantId;
        const authorized =
          user.role === "SUPER_ADMIN" ||
          (sameTenant && roleAtLeast(user.role, "TENANT_ADMIN"));
        if (!authorized) {
          return htmlError(401, "not_authorized", origin);
        }

        const tokens = await exchangeCodeForTokens({
          code: query.code,
          clientId: config.nuvemshopClientId,
          clientSecret: config.nuvemshopClientSecret,
        });

        const tenantId = BigInt(state.tenantId);
        const tenantCtx: TenantContext = {
          tenantId,
          userId: BigInt(state.userId),
          role: "TENANT_ADMIN",
        };
        // Tenant is already known + trusted (from the signed state, not a cross-tenant lookup), so
        // these run tenant-scoped directly — no asSuperAdmin needed (contrast with the Google
        // callback, which resolves a bare vault entry id across tenants first).
        const vaultEntry = await createVaultEntry(
          tenantCtx,
          {
            name: `Nuvemshop - ${state.integrationName}`,
            value: tokens.accessToken,
            kind: "generic",
          },
          undefined,
          undefined,
          basePrisma,
        );
        const created = await createIntegrationInstance(
          tenantId,
          {
            catalogType: "NUVEMSHOP",
            name: state.integrationName,
            config: { storeId: tokens.storeId },
            credentialRef: vaultEntry.ref,
          },
          basePrisma,
        );

        // The success "message" slot carries the new instance id (stringified bigint) — the opener
        // uses it to refetch/select the just-created integration without a second round-trip.
        return new Response(
          buildCallbackHtml(true, String(created.id), origin),
          { status: 200, headers: HTML_HEADERS },
        );
      } catch (err) {
        logger.warn({ err }, "nuvemshop oauth callback failed");
        return htmlError(400, "callback_failed", origin);
      }
    },
    {
      detail: {
        ...doc(
          "Nuvemshop OAuth callback",
          "Public popup redirect target for the Nuvemshop consent flow; cookie-authenticated in-handler and bound by the signed state. Creates the vault credential and the integration instance on success. Always returns HTML so the popup can postMessage the result to its opener and self-close.",
        ),
        security: [],
      },
      query: t.Object({
        code: t.Optional(
          t.String({
            description: "Nuvemshop OAuth authorization code to exchange for the access token.",
          }),
        ),
        state: t.Optional(
          t.String({
            description:
              "Opaque encrypted state that binds the flow to the issuing user, tenant and integration name.",
          }),
        ),
        error: t.Optional(
          t.String({
            description: "OAuth error code returned by Tiendanube when consent fails.",
          }),
        ),
      }),
    },
  );
