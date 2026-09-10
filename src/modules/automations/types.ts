// Core type definitions for the Automation & Integration Hub (Pluga/Make style).
// Provides channel-agnostic triggers, conditions, actions, and execution logs.

export const CHANNEL_TRIGGERS = [
  "channel.lead_created",
  "channel.tag_added",
  "channel.tag_removed",
  "channel.kanban_moved",
  "channel.message_received",
  "channel.conversation_started",
  "channel.conversation_closed",
] as const;

export const EXTERNAL_TRIGGERS = [
  "webhook.received",
  "payment.approved",
  "payment.refunded",
  "form.submitted",
] as const;

export const ALL_TRIGGERS = [
  ...CHANNEL_TRIGGERS,
  ...EXTERNAL_TRIGGERS,
] as const;
export type AutomationTriggerType = (typeof ALL_TRIGGERS)[number];

export const ACTION_PROVIDERS = [
  "CHANNEL", // Whazing, WhatsApp, Instagram, Chatwoot
  "WEBHOOK", // Generic HTTP outgoing webhook
  "GOOGLE_SHEETS", // Google Sheets append row / update
  "RD_STATION", // RD Station CRM lead upsert
  "PIPEDRIVE", // Pipedrive deal / person
  "SLACK", // Slack message notification
  "AI", // Intelligent classification / extraction
  "DELIVERY", // Freight / Uber Direct quote calculation
] as const;
export type ActionProvider = (typeof ACTION_PROVIDERS)[number];

export type ConditionOperator =
  | "eq" // Equal
  | "neq" // Not equal
  | "contains" // String contains (case-insensitive)
  | "not_contains"
  | "gt" // Greater than (numeric)
  | "gte" // Greater than or equal
  | "lt" // Less than
  | "lte" // Less than or equal
  | "is_empty" // Value is null, undefined, or empty string
  | "is_not_empty"
  | "in" // Value is inside array
  | "not_in";

export interface AutomationCondition {
  field: string; // Dot-path e.g. "lead.phone", "tag.name", "payload.amount"
  operator: ConditionOperator;
  value?: unknown; // Target value for comparison
}

export interface AutomationActionConfig {
  id: string;
  order: number;
  provider: ActionProvider;
  actionType: string; // e.g. "send_message", "add_tag", "append_row", "post_webhook"
  credentialRef?: string; // Vault reference if external auth is needed
  fieldMapping: Record<string, string>; // Maps target field -> template string (e.g. { "name": "{{contact.name}}" })
  settings?: Record<string, unknown>; // Static configs (e.g. { "spreadsheetId": "...", "sheetName": "Leads" })
}

export interface AutomationRuleConfig {
  id: string;
  tenantId: bigint;
  name: string;
  description?: string;
  enabled: boolean;
  triggerType: AutomationTriggerType;
  triggerFilter?: Record<string, unknown>; // Optional match on trigger (e.g. { "channelInstanceId": "1" })
  conditions: AutomationCondition[]; // Evaluated with AND logic
  actions: AutomationActionConfig[]; // Executed in order
}

export interface ChannelContact {
  id?: string;
  name?: string;
  phone?: string;
  email?: string;
  customAttributes?: Record<string, unknown>;
  tags?: string[];
}

export interface NormalizedChannelEvent {
  eventId: string;
  tenantId: bigint;
  channelType:
    | "WHAZING"
    | "WHATSAPP_CLOUD"
    | "CHATWOOT"
    | "INSTAGRAM"
    | "WEBHOOK";
  channelInstanceId: string;
  triggerType: AutomationTriggerType;
  occurredAt: Date;
  contact?: ChannelContact;
  conversationId?: string;
  data: Record<string, unknown>;
}

export interface ActionStepResult {
  stepIndex: number;
  provider: ActionProvider;
  actionType: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  output?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

export interface AutomationExecutionResult {
  ruleId: string;
  tenantId: bigint;
  triggerType: AutomationTriggerType;
  status: "SUCCESS" | "FAILED" | "SKIPPED_CONDITION" | "PARTIAL";
  conditionsPassed: boolean;
  steps: ActionStepResult[];
  totalDurationMs: number;
  error?: string;
}
