// Executes individual automation actions and pipelines with error boundaries and telemetry.

import logger from "@/api/lib/logger";
import { calculateDeliveryQuote } from "@/modules/delivery";
import { interpolateFieldMapping } from "./interpolator";
import type {
  ActionProvider,
  ActionStepResult,
  AutomationActionConfig,
  NormalizedChannelEvent,
} from "./types";

export type ActionHandler = (
  action: AutomationActionConfig,
  mappedPayload: Record<string, unknown>,
  event: NormalizedChannelEvent,
) => Promise<Record<string, unknown>>;

// Registry of provider handlers
const HANDLERS = new Map<string, ActionHandler>();

export function registerActionHandler(
  provider: ActionProvider,
  actionType: string,
  handler: ActionHandler,
): void {
  const key = `${provider}:${actionType}`;
  HANDLERS.set(key, handler);
}

// Built-in Webhook POST action handler
registerActionHandler("WEBHOOK", "post", async (action, mappedPayload) => {
  const url = String(action.settings?.url || mappedPayload.url || "");
  if (!url) {
    throw new Error("Action WEBHOOK:post requires a valid url");
  }

  // Allow custom headers or fallback
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((action.settings?.headers as Record<string, string>) || {}),
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(mappedPayload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `Webhook POST failed [${response.status}]: ${errorText.slice(0, 300)}`,
    );
  }

  const result = await response.json().catch(() => ({ status: "ok" }));
  return { status: response.status, body: result };
});

// Built-in Delivery freight calculation action handler
registerActionHandler(
  "DELIVERY",
  "calculate_quote",
  async (action, mappedPayload) => {
    const destination = String(
      mappedPayload.destination ||
        mappedPayload.address ||
        mappedPayload.endereco ||
        mappedPayload.bairro ||
        "",
    ).trim();

    if (!destination) {
      throw new Error(
        "Action DELIVERY:calculate_quote requires a destination address or neighborhood",
      );
    }

    const origin = mappedPayload.origin
      ? String(mappedPayload.origin).trim()
      : undefined;
    const config = (action.settings || {}) as Record<string, unknown>;

    const quote = await calculateDeliveryQuote(
      { destinationAddress: destination, originAddress: origin },
      config,
    );

    return {
      provider: quote.provider,
      distanceKm: quote.distanceKm,
      durationMinutes: quote.durationMinutes,
      priceBrl: quote.priceBrl,
      formattedPrice: quote.formattedPrice,
      originAddress: quote.originAddress,
      destinationAddress: quote.destinationAddress,
      summaryMessage: quote.summaryMessage,
      quoteId: quote.quoteId,
    };
  },
);

export async function executeAction(
  action: AutomationActionConfig,
  event: NormalizedChannelEvent,
): Promise<ActionStepResult> {
  const start = Date.now();
  const context: Record<string, unknown> = {
    contact: event.contact,
    data: event.data,
    conversationId: event.conversationId,
    channelType: event.channelType,
    occurredAt: event.occurredAt.toISOString(),
  };

  const mappedPayload = interpolateFieldMapping(action.fieldMapping, context);
  const handlerKey = `${action.provider}:${action.actionType}`;
  const handler = HANDLERS.get(handlerKey);

  if (!handler) {
    return {
      stepIndex: action.order,
      provider: action.provider,
      actionType: action.actionType,
      status: "FAILED",
      error: `No action handler registered for ${handlerKey}`,
      durationMs: Date.now() - start,
    };
  }

  try {
    const output = await handler(action, mappedPayload, event);
    return {
      stepIndex: action.order,
      provider: action.provider,
      actionType: action.actionType,
      status: "SUCCESS",
      output,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      "Automation action %s failed for rule action id=%s: %s",
      handlerKey,
      action.id,
      errorMsg,
    );
    return {
      stepIndex: action.order,
      provider: action.provider,
      actionType: action.actionType,
      status: "FAILED",
      error: errorMsg,
      durationMs: Date.now() - start,
    };
  }
}
