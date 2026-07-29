import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, NotFoundError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createWhazingInstance,
  disconnectWhazingInstance,
  getWhazingInstance,
  listWhazingInstances,
  reconnectWhazingInstance,
  updateWhazingInstance,
} from "@/modules/whazing/management";
import { loadWhazingClient } from "@/modules/whazing/instance";

// Whazing instance management (per-tenant). TENANT_ADMIN. apiKey is write-only —
// never returned in any response. routeToken is encrypted at rest and exposed only
// via the derived webhookUrl (so the operator can copy it into the Whazing dashboard).

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const whazingController = new Elysia({
  prefix: "/v1/whazing",
  tags: ["Channels"],
})
  .use(tenancyPlugin)
  .get(
    "/instances",
    async ({ tenantContext }) => ({
      instance: instanceIdentity,
      instances: await listWhazingInstances(ctxOrThrow(tenantContext)),
    }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List Whazing instances",
        "List the tenant's Whazing instances. apiKey is never returned.",
      ),
      response: errors(401, 403),
    },
  )
  .get(
    "/instances/:id",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      whazingInstance: await getWhazingInstance(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Whazing instance id (BigInt string)." }),
      }),
      detail: doc(
        "Get Whazing instance",
        "Returns a single Whazing instance by id, including the webhookUrl. apiKey is never returned.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/instances",
    async ({ tenantContext, body }) => {
      const b = body as { name: string; baseUrl: string; apiKey: string };
      return {
        instance: instanceIdentity,
        whazingInstance: await createWhazingInstance(ctxOrThrow(tenantContext), {
          name: b.name,
          baseUrl: b.baseUrl,
          apiKey: b.apiKey,
        }),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        name: t.String({
          minLength: 1,
          maxLength: 200,
          description: "Display name for this Whazing instance.",
        }),
        baseUrl: t.String({
          description: "Base URL of the Whazing API (e.g. https://api.whazing.com).",
        }),
        apiKey: t.String({
          minLength: 1,
          description: "Whazing API key; encrypted at rest, never returned.",
        }),
      }),
      detail: doc(
        "Create Whazing instance",
        "Register a new Whazing instance. Returns the instance with its webhookUrl to paste into the Whazing dashboard. apiKey is encrypted and never returned.",
      ),
      response: errors(400, 401, 403),
    },
  )
  .put(
    "/instances/:id",
    async ({ tenantContext, params, body }) => {
      const b = body as {
        name?: string;
        baseUrl?: string;
        apiKey?: string;
      };
      return {
        instance: instanceIdentity,
        whazingInstance: await updateWhazingInstance(
          ctxOrThrow(tenantContext),
          BigInt(params.id),
          b,
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Whazing instance id (BigInt string)." }),
      }),
      body: t.Object({
        name: t.Optional(
          t.String({
            minLength: 1,
            maxLength: 200,
            description: "New display name.",
          }),
        ),
        baseUrl: t.Optional(
          t.String({ description: "New base URL." }),
        ),
        apiKey: t.Optional(
          t.String({
            minLength: 1,
            description: "New API key; re-encrypted at rest, never returned.",
          }),
        ),
      }),
      detail: doc(
        "Update Whazing instance",
        "Update the name, baseUrl, or apiKey of a Whazing instance.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .delete(
    "/instances/:id",
    async ({ tenantContext, params }) => {
      await disconnectWhazingInstance(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Whazing instance id (BigInt string)." }),
      }),
      detail: doc(
        "Disconnect Whazing instance",
        "Soft-disconnect the instance by setting disconnectedAt; rows are kept for history.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/instances/:id/reconnect",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      whazingInstance: await reconnectWhazingInstance(
        ctxOrThrow(tenantContext),
        BigInt(params.id),
      ),
    }),
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Whazing instance id (BigInt string)." }),
      }),
      detail: doc(
        "Reconnect Whazing instance",
        "Clear disconnectedAt to resume webhook processing for a previously disconnected instance.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  // ── Kanban Pro resource proxies (editor-time pickers) ────────────────────────
  .get(
    "/instances/:id/kanban/boards",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const client = await loadWhazingClient(
        ctx.tenantId as bigint,
        BigInt(params.id),
      ).catch(() => {
        throw new NotFoundError();
      });
      const data = (await client.kanbanGetBoards()) as Record<string, unknown>;
      const boards = (Array.isArray(data?.boards) ? data.boards : []) as Array<{
        id: number;
        name: string;
        color?: string;
        description?: string;
      }>;
      return {
        boards: boards.map((b) => ({ id: b.id, name: b.name, color: b.color ?? null })),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({ id: t.String() }),
      detail: doc(
        "List Whazing Kanban boards",
        "Proxy to GET /kanbanpro/boards on the Whazing instance. Used by the agent editor board picker.",
      ),
      response: errors(401, 403, 404),
    },
  )
  .get(
    "/instances/:id/kanban/boards/:boardId/columns",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const client = await loadWhazingClient(
        ctx.tenantId as bigint,
        BigInt(params.id),
      ).catch(() => {
        throw new NotFoundError();
      });
      const data = (await client.kanbanGetColumns(Number(params.boardId))) as Record<
        string,
        unknown
      >;
      const columns = (Array.isArray(data?.columns) ? data.columns : []) as Array<{
        id: number;
        name: string;
        color?: string;
        position?: number;
      }>;
      return {
        columns: columns
          .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
          .map((c) => ({ id: c.id, name: c.name, color: c.color ?? null })),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({ id: t.String(), boardId: t.String() }),
      detail: doc(
        "List Whazing Kanban columns",
        "Proxy to GET /kanbanpro/boards/:boardId/columns. Used by the agent editor column picker.",
      ),
      response: errors(401, 403, 404),
    },
  );
