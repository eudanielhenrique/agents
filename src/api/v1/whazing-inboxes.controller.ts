import { Elysia, t } from "elysia";
import { doc, errors } from "@/api/lib/openapi";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import { ForbiddenError, TenantTargetRequiredError } from "@/lib/errors";
import { instanceIdentity } from "@/lib/instance";
import type { TenantContext } from "@/lib/tenancy";
import {
  createWhazingInbox,
  deleteWhazingInbox,
  listWhazingInboxes,
  updateWhazingInbox,
} from "@/modules/whazing/management";

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

export const whazingInboxesController = new Elysia({
  prefix: "/v1/whazing",
  tags: ["Channels"],
})
  .use(tenancyPlugin)
  .get(
    "/instances/:id/inboxes",
    async ({ tenantContext, params }) => ({
      instance: instanceIdentity,
      inboxes: await listWhazingInboxes(
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
        "List Whazing inboxes",
        "List the inboxes (queue→agent mappings) for a Whazing instance.",
      ),
      response: errors(400, 401, 403),
    },
  )
  .post(
    "/instances/:id/inboxes",
    async ({ tenantContext, params, body }) => {
      const b = body as {
        whazingQueueId?: string | null;
        name?: string | null;
        agentId?: string | null;
      };
      return {
        instance: instanceIdentity,
        inbox: await createWhazingInbox(
          ctxOrThrow(tenantContext),
          BigInt(params.id),
          {
            whazingQueueId: b.whazingQueueId,
            name: b.name,
            agentId: b.agentId ? BigInt(b.agentId) : null,
          },
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Whazing instance id (BigInt string)." }),
      }),
      body: t.Object({
        whazingQueueId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "Whazing queue id to map (null = catch-all).",
          }),
        ),
        name: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "Optional display name for this queue mapping.",
          }),
        ),
        agentId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "Agent id (BigInt string) that answers this queue, or null.",
          }),
        ),
      }),
      detail: doc(
        "Create Whazing inbox",
        "Map a Whazing queue to an agent.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .put(
    "/instances/:id/inboxes/:inboxId",
    async ({ tenantContext, params, body }) => {
      const b = body as {
        whazingQueueId?: string | null;
        name?: string | null;
        agentId?: string | null;
      };
      return {
        instance: instanceIdentity,
        inbox: await updateWhazingInbox(
          ctxOrThrow(tenantContext),
          BigInt(params.inboxId),
          BigInt(params.id),
          {
            ...(b.whazingQueueId !== undefined && {
              whazingQueueId: b.whazingQueueId,
            }),
            ...(b.name !== undefined && { name: b.name }),
            ...(b.agentId !== undefined && {
              agentId: b.agentId ? BigInt(b.agentId) : null,
            }),
          },
        ),
      };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Whazing instance id (BigInt string)." }),
        inboxId: t.String({ description: "Whazing inbox id (BigInt string)." }),
      }),
      body: t.Object({
        whazingQueueId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "New Whazing queue id.",
          }),
        ),
        name: t.Optional(
          t.Union([t.String(), t.Null()], { description: "New display name." }),
        ),
        agentId: t.Optional(
          t.Union([t.String(), t.Null()], {
            description: "Agent id (BigInt string) or null to unbind.",
          }),
        ),
      }),
      detail: doc(
        "Update Whazing inbox",
        "Update the queue id, name, or agent binding for a Whazing inbox.",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .delete(
    "/instances/:id/inboxes/:inboxId",
    async ({ tenantContext, params }) => {
      await deleteWhazingInbox(
        ctxOrThrow(tenantContext),
        BigInt(params.inboxId),
        BigInt(params.id),
      );
      return { instance: instanceIdentity, success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Whazing instance id (BigInt string)." }),
        inboxId: t.String({ description: "Whazing inbox id (BigInt string)." }),
      }),
      detail: doc(
        "Delete Whazing inbox",
        "Remove a queue→agent mapping from a Whazing instance.",
      ),
      response: errors(400, 401, 403, 404),
    },
  );
