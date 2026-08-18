// Per-agent config for Whazing intake routing: where to move a NEW ticket once we know whether the
// contact has prior history (n8n's "recepção inteligente" flow, item 1) and how to tag + notify a
// campaign-sourced lead (item 2). The "route to the bot" side needs no field here — it is already
// WhazingInbox.whazingQueueId, the same row that maps this agent to a queue. This reader is the
// single source of defaults + clamping for the `agent.settings.whazingIntake` block.

export interface WhazingIntakeConfig {
  enabled: boolean;
  // Queue to move a ticket to when the contact has prior history OR this ticket was already answered
  // by a human — also the target when a manual human takeover is detected (see webhook.ts).
  escalateQueueId: number | null;
  // Whazing tag id applied to a contact whose message carries a campaign entry signal (ctwa_ad).
  campaignTagId: number | null;
  // Internal phone notified about a campaign lead. null = no notification sent.
  campaignNotifyPhone: string | null;
  // Template sent to campaignNotifyPhone. {{ctwaClid}} is interpolated when present.
  campaignNotifyMessage: string;
}

export const WHAZING_INTAKE_DEFAULTS: WhazingIntakeConfig = {
  // Opt-in: reshapes ticket queue placement, so it stays off until explicitly enabled.
  enabled: false,
  escalateQueueId: null,
  campaignTagId: null,
  campaignNotifyPhone: null,
  campaignNotifyMessage:
    "Lead de campanha identificado.\n\nctwaClid: {{ctwaClid}}",
};

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

// A Whazing queue/tag id: a positive integer, or null when absent/invalid.
function idRef(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

// A phone number string, or null when absent/blank.
function phoneRef(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

export function readWhazingIntakeConfig(
  settings: unknown,
): WhazingIntakeConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).whazingIntake
      : undefined;
  if (!s || typeof s !== "object") return { ...WHAZING_INTAKE_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const D = WHAZING_INTAKE_DEFAULTS;
  return {
    enabled: bool(bag.enabled, D.enabled),
    escalateQueueId: idRef(bag.escalateQueueId),
    campaignTagId: idRef(bag.campaignTagId),
    campaignNotifyPhone: phoneRef(bag.campaignNotifyPhone),
    campaignNotifyMessage: str(
      bag.campaignNotifyMessage,
      D.campaignNotifyMessage,
    ),
  };
}
