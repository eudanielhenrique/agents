import { Elysia, t } from "elysia";
import logger from "@/api/lib/logger";
import { doc } from "@/api/lib/openapi";
import {
  processWhazingDelivery,
  receiveWhazingWebhook,
} from "@/modules/whazing/webhook";

// Public, JWT-less Whazing channel webhook receiver. Not behind tenancyPlugin/requireAuth:
// the opaque routeToken resolves the tenant and instance. No HMAC — Whazing does not sign
// payloads. Acks fast and always returns 200. POST only.
export const whazingWebhookController = new Elysia({
  prefix: "/v1/whazing",
  tags: ["Channels"],
}).post(
  "/webhook/:routeToken",
  async ({ params, request }) => {
    const rawBody = await request.text();
    const result = await receiveWhazingWebhook({
      routeToken: params.routeToken,
      rawBody,
    });

    if (
      result.outcome === "queued" &&
      result.tenantId !== undefined &&
      result.instanceId !== undefined &&
      result.deliveryRowId !== undefined &&
      result.normalized !== undefined
    ) {
      const { tenantId, instanceId, deliveryRowId, normalized } = result;
      void processWhazingDelivery({
        tenantId,
        instanceId,
        deliveryRowId,
        normalized,
      }).catch((err) => {
        logger.error(
          "whazing async dispatch failed (delivery %s): %s",
          String(deliveryRowId),
          err instanceof Error ? err.message : String(err),
        );
      });
    }

    return { ack: true, outcome: result.outcome };
  },
  {
    detail: {
      ...doc(
        "Whazing channel webhook",
        "Public channel webhook receiver; authenticated by the opaque per-instance route token. Acks fast and always returns 200 to avoid leaking auth state.",
      ),
      security: [],
    },
    params: t.Object({
      routeToken: t.String({
        description:
          "Opaque per-instance route token that resolves the tenant and instance.",
      }),
    }),
  },
);
