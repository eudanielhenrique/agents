import { describe, expect, test } from "bun:test";
import {
  emitChannelEvent,
  InMemoryAutomationRepository,
  setAutomationRepository,
} from "@/modules/automations/bus";
import { registerActionHandler } from "@/modules/automations/runner";
import type {
  AutomationRuleConfig,
  NormalizedChannelEvent,
} from "@/modules/automations/types";

describe("automations event bus", () => {
  const sentWebhooks: Record<string, unknown>[] = [];

  registerActionHandler("WEBHOOK", "test_notify", async (_action, payload) => {
    sentWebhooks.push(payload);
    return { ok: true };
  });

  test("dispatches event to matching tenant rules and writes execution logs", async () => {
    const repo = new InMemoryAutomationRepository();

    const rule: AutomationRuleConfig = {
      id: "rule_bus_1",
      tenantId: 42n,
      name: "Notificar webhook quando lead VIP chegar",
      enabled: true,
      triggerType: "channel.lead_created",
      conditions: [
        { field: "contact.tags", operator: "contains", value: "VIP" },
      ],
      actions: [
        {
          id: "act_1",
          order: 0,
          provider: "WEBHOOK",
          actionType: "test_notify",
          fieldMapping: {
            phone: "{{contact.phone}}",
            name: "{{contact.name}}",
          },
        },
      ],
    };

    repo.addRule(rule);
    setAutomationRepository(repo);

    const event: NormalizedChannelEvent = {
      eventId: "evt_bus_99",
      tenantId: 42n,
      channelType: "WHAZING",
      channelInstanceId: "5",
      triggerType: "channel.lead_created",
      occurredAt: new Date(),
      contact: {
        name: "Ana Clara",
        phone: "+5511977776666",
        tags: ["VIP"],
      },
      data: {},
    };

    const results = await emitChannelEvent(event);
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("SUCCESS");
    expect(results[0]?.ruleId).toBe("rule_bus_1");

    // Verify webhook payload
    const received = sentWebhooks.pop();
    expect(received).toEqual({
      phone: "+5511977776666",
      name: "Ana Clara",
    });

    // Verify execution log stored in repository
    expect(repo.executionLogs.length).toBe(1);
    expect(repo.executionLogs[0]?.status).toBe("SUCCESS");
  });

  test("ignores rules from other tenants (tenant isolation)", async () => {
    const repo = new InMemoryAutomationRepository();

    const ruleTenant1: AutomationRuleConfig = {
      id: "rule_tenant_1",
      tenantId: 1n,
      name: "Tenant 1 Rule",
      enabled: true,
      triggerType: "channel.lead_created",
      conditions: [],
      actions: [],
    };

    repo.addRule(ruleTenant1);
    setAutomationRepository(repo);

    // Event from Tenant 2
    const eventTenant2: NormalizedChannelEvent = {
      eventId: "evt_diff_tenant",
      tenantId: 2n,
      channelType: "WHAZING",
      channelInstanceId: "5",
      triggerType: "channel.lead_created",
      occurredAt: new Date(),
      data: {},
    };

    const results = await emitChannelEvent(eventTenant2);
    expect(results.length).toBe(0);
    expect(repo.executionLogs.length).toBe(0);
  });
});
