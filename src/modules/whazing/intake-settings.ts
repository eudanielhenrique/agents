// Per-agent config for Whazing intake routing: where to move a NEW ticket once we know whether the
// contact has prior history (n8n's "recepção inteligente" flow, item 1) and how to tag + notify a
// campaign-sourced lead (item 2). The "route to the bot" side needs no field here — it is already
// WhazingInbox.whazingQueueId, the same row that maps this agent to a queue. This reader is the
// single source of defaults + clamping for the `agent.settings.whazingIntake` block.

export interface WhazingIntakeConfig {
  // Reroutes a brand-new ticket to escalateQueueId by prior history / already-answered. Independent
  // of campaignEnabled — some clients want history-based routing, some don't, and both are common
  // wanting ONLY campaign tagging (see campaignEnabled).
  historyRoutingEnabled: boolean;
  // Tags + notifies a campaign-sourced lead (ctwa_ad signal). Independent of historyRoutingEnabled —
  // most clients running ads want this ON even when they don't want history-based rerouting.
  campaignEnabled: boolean;
  // Queue to move a ticket to when the contact has prior history OR this ticket was already answered
  // by a human — also the target when a manual human takeover is detected (see webhook.ts).
  escalateQueueId: number | null;
  // Target bot queue for fresh, unescalated tickets when history routing is on. Optional (null = use inbox queue).
  botQueueId: number | null;
  // Whazing tag id applied to a contact whose message carries a campaign entry signal (ctwa_ad).
  campaignTagId: number | null;
  // Internal phone notified about a campaign lead. null = no notification sent.
  campaignNotifyPhone: string | null;
  // Template sent to campaignNotifyPhone. {{ctwaClid}} is interpolated when present.
  campaignNotifyMessage: string;
}

export const WHAZING_INTAKE_DEFAULTS: WhazingIntakeConfig = {
  // Opt-in: reshapes ticket queue placement, so it stays off until explicitly enabled.
  historyRoutingEnabled: false,
  campaignEnabled: false,
  escalateQueueId: null,
  botQueueId: null,
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
  if (!settings || typeof settings !== "object") {
    return { ...WHAZING_INTAKE_DEFAULTS };
  }
  const rec = settings as Record<string, unknown>;
  const s =
    rec.whazingIntake && typeof rec.whazingIntake === "object"
      ? rec.whazingIntake
      : rec.intake && typeof rec.intake === "object"
        ? rec.intake
        : "historyRoutingEnabled" in rec ||
            "campaignEnabled" in rec ||
            "enabled" in rec
          ? rec
          : undefined;
  if (!s || typeof s !== "object") return { ...WHAZING_INTAKE_DEFAULTS };
  const bag = s as Record<string, unknown>;
  const D = WHAZING_INTAKE_DEFAULTS;
  // Backward compat: a config saved before the split only has `enabled` — inherit it into BOTH new
  // flags so an already-working tenant (history routing + campaign tagging together) keeps working
  // exactly as before until the operator explicitly separates them in the editor.
  const legacyEnabled = bool(bag.enabled, false);
  return {
    historyRoutingEnabled: bool(bag.historyRoutingEnabled, legacyEnabled),
    campaignEnabled: bool(bag.campaignEnabled, legacyEnabled),
    escalateQueueId: idRef(bag.escalateQueueId),
    botQueueId: idRef(bag.botQueueId),
    campaignTagId: idRef(bag.campaignTagId),
    campaignNotifyPhone: phoneRef(bag.campaignNotifyPhone),
    campaignNotifyMessage: str(
      bag.campaignNotifyMessage,
      D.campaignNotifyMessage,
    ),
  };
}
