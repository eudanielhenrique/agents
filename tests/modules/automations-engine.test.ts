import { describe, expect, test } from "bun:test";
import { processEventForRule } from "@/modules/automations/engine";
import { registerActionHandler } from "@/modules/automations/runner";
import type {
  AutomationRuleConfig,
  NormalizedChannelEvent,
} from "@/modules/automations/types";

describe("automations engine", () => {
  // Register mock handlers for testing
  const mockCalls: Record<string, Record<string, unknown>[]> = {
    "CHANNEL:send_message": [],
    "GOOGLE_SHEETS:append_row": [],
  };

  registerActionHandler("CHANNEL", "send_message", async (_action, payload) => {
    mockCalls["CHANNEL:send_message"]?.push(payload);
    return { sent: true, recipient: payload.to };
  });

  registerActionHandler(
    "GOOGLE_SHEETS",
    "append_row",
    async (_action, payload) => {
      mockCalls["GOOGLE_SHEETS:append_row"]?.push(payload);
      return { appended: true, row: payload };
    },
  );

  const baseEvent: NormalizedChannelEvent = {
    eventId: "evt_123",
    tenantId: 1n,
    channelType: "WHAZING",
    channelInstanceId: "10",
    triggerType: "channel.lead_created",
    occurredAt: new Date("2026-09-09T18:00:00Z"),
    contact: {
      name: "João Silva",
      phone: "+5511999990000",
      tags: ["Campanha-Google", "Interesse-Alto"],
    },
    conversationId: "conv_456",
    data: {
      campaignName: "BlackFriday",
      budget: 500,
    },
  };

  test("skips execution when conditions do not match", async () => {
    const rule: AutomationRuleConfig = {
      id: "rule_1",
      tenantId: 1n,
      name: "Enviar mensagem para leads VIP",
      enabled: true,
      triggerType: "channel.lead_created",
      conditions: [
        { field: "contact.tags", operator: "contains", value: "VIP" }, // Will fail, lead has Campanha-Google
      ],
      actions: [
        {
          id: "act_1",
          order: 0,
          provider: "CHANNEL",
          actionType: "send_message",
          fieldMapping: {
            to: "{{contact.phone}}",
            text: "Olá {{contact.name}}!",
          },
        },
      ],
    };

    const result = await processEventForRule(rule, baseEvent);
    expect(result.status).toBe("SKIPPED_CONDITION");
    expect(result.conditionsPassed).toBe(false);
    expect(result.steps.length).toBe(0);
  });

  test("executes pipeline actions in order when conditions match", async () => {
    const rule: AutomationRuleConfig = {
      id: "rule_2",
      tenantId: 1n,
      name: "Integrar lead da campanha no Google Sheets e WhatsApp",
      enabled: true,
      triggerType: "channel.lead_created",
      conditions: [
        {
          field: "contact.tags",
          operator: "contains",
          value: "Campanha-Google",
        },
        { field: "data.budget", operator: "gte", value: 300 },
      ],
      actions: [
        {
          id: "act_1",
          order: 0,
          provider: "GOOGLE_SHEETS",
          actionType: "append_row",
          fieldMapping: {
            lead_name: "{{contact.name}}",
            lead_phone: "{{contact.phone}}",
            campaign: "{{data.campaignName}}",
          },
        },
        {
          id: "act_2",
          order: 1,
          provider: "CHANNEL",
          actionType: "send_message",
          fieldMapping: {
            to: "{{contact.phone}}",
            text: "Olá {{contact.name}}, recebemos seu contato da campanha {{data.campaignName}}!",
          },
        },
      ],
    };

    const result = await processEventForRule(rule, baseEvent);
    expect(result.status).toBe("SUCCESS");
    expect(result.conditionsPassed).toBe(true);
    expect(result.steps.length).toBe(2);

    expect(result.steps[0]?.status).toBe("SUCCESS");
    expect(result.steps[0]?.provider).toBe("GOOGLE_SHEETS");

    expect(result.steps[1]?.status).toBe("SUCCESS");
    expect(result.steps[1]?.provider).toBe("CHANNEL");

    // Check payload values received by handlers
    const sheetCall = mockCalls["GOOGLE_SHEETS:append_row"]?.pop();
    expect(sheetCall).toEqual({
      lead_name: "João Silva",
      lead_phone: "+5511999990000",
      campaign: "BlackFriday",
    });

    const channelCall = mockCalls["CHANNEL:send_message"]?.pop();
    expect(channelCall).toEqual({
      to: "+5511999990000",
      text: "Olá João Silva, recebemos seu contato da campanha BlackFriday!",
    });
  });

  test("marks execution as PARTIAL if one action succeeds and another fails", async () => {
    const rule: AutomationRuleConfig = {
      id: "rule_3",
      tenantId: 1n,
      name: "Teste de falha parcial",
      enabled: true,
      triggerType: "channel.lead_created",
      conditions: [],
      actions: [
        {
          id: "act_1",
          order: 0,
          provider: "CHANNEL",
          actionType: "send_message",
          fieldMapping: { to: "{{contact.phone}}" },
        },
        {
          id: "act_2",
          order: 1,
          provider: "RD_STATION", // No handler registered for RD_STATION yet
          actionType: "upsert_lead",
          fieldMapping: { email: "test@example.com" },
        },
      ],
    };

    const result = await processEventForRule(rule, baseEvent);
    expect(result.status).toBe("PARTIAL");
    expect(result.steps[0]?.status).toBe("SUCCESS");
    expect(result.steps[1]?.status).toBe("FAILED");
    expect(result.steps[1]?.error).toContain("No action handler registered");
  });
});
