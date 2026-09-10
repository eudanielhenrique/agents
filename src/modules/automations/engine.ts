// Core engine that matches events against rules, evaluates filters, and runs action pipelines.

import { evaluateAllConditions } from "./evaluator";
import { executeAction } from "./runner";
import type {
  ActionStepResult,
  AutomationExecutionResult,
  AutomationRuleConfig,
  NormalizedChannelEvent,
} from "./types";

export function matchesTriggerFilter(
  filter: Record<string, unknown> | undefined,
  event: NormalizedChannelEvent,
): boolean {
  if (!filter || Object.keys(filter).length === 0) return true;

  for (const [key, expected] of Object.entries(filter)) {
    if (
      key === "channelInstanceId" &&
      event.channelInstanceId !== String(expected)
    ) {
      return false;
    }
    if (key === "channelType" && event.channelType !== expected) {
      return false;
    }
    // Deep match inside event data if key starts with data.
    if (key.startsWith("data.")) {
      const dataKey = key.slice(5);
      if (event.data[dataKey] !== expected) {
        return false;
      }
    }
  }

  return true;
}

export async function processEventForRule(
  rule: AutomationRuleConfig,
  event: NormalizedChannelEvent,
): Promise<AutomationExecutionResult> {
  const start = Date.now();

  if (!rule.enabled) {
    return {
      ruleId: rule.id,
      tenantId: rule.tenantId,
      triggerType: event.triggerType,
      status: "SKIPPED_CONDITION",
      conditionsPassed: false,
      steps: [],
      totalDurationMs: 0,
    };
  }

  if (rule.triggerType !== event.triggerType) {
    return {
      ruleId: rule.id,
      tenantId: rule.tenantId,
      triggerType: event.triggerType,
      status: "SKIPPED_CONDITION",
      conditionsPassed: false,
      steps: [],
      totalDurationMs: 0,
    };
  }

  if (!matchesTriggerFilter(rule.triggerFilter, event)) {
    return {
      ruleId: rule.id,
      tenantId: rule.tenantId,
      triggerType: event.triggerType,
      status: "SKIPPED_CONDITION",
      conditionsPassed: false,
      steps: [],
      totalDurationMs: Date.now() - start,
    };
  }

  const context: Record<string, unknown> = {
    contact: event.contact,
    data: event.data,
    conversationId: event.conversationId,
    channelType: event.channelType,
    occurredAt: event.occurredAt.toISOString(),
  };

  const conditionsPassed = evaluateAllConditions(rule.conditions, context);
  if (!conditionsPassed) {
    return {
      ruleId: rule.id,
      tenantId: rule.tenantId,
      triggerType: event.triggerType,
      status: "SKIPPED_CONDITION",
      conditionsPassed: false,
      steps: [],
      totalDurationMs: Date.now() - start,
    };
  }

  const steps: ActionStepResult[] = [];
  let hasFailure = false;

  const sortedActions = [...rule.actions].sort((a, b) => a.order - b.order);
  for (const action of sortedActions) {
    const stepResult = await executeAction(action, event);
    steps.push(stepResult);
    if (stepResult.status === "FAILED") {
      hasFailure = true;
    }
  }

  const status =
    steps.length === 0
      ? "SUCCESS"
      : hasFailure
        ? steps.some((s) => s.status === "SUCCESS")
          ? "PARTIAL"
          : "FAILED"
        : "SUCCESS";

  return {
    ruleId: rule.id,
    tenantId: rule.tenantId,
    triggerType: event.triggerType,
    status,
    conditionsPassed: true,
    steps,
    totalDurationMs: Date.now() - start,
  };
}

export async function processEventForRules(
  rules: AutomationRuleConfig[],
  event: NormalizedChannelEvent,
): Promise<AutomationExecutionResult[]> {
  const matchingRules = rules.filter(
    (r) => r.enabled && r.triggerType === event.triggerType,
  );

  const results: AutomationExecutionResult[] = [];
  for (const rule of matchingRules) {
    const res = await processEventForRule(rule, event);
    results.push(res);
  }

  return results;
}
