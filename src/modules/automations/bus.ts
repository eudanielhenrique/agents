// Tenant-scoped event bus for dispatching channel and external triggers to automation rules.

import logger from "@/api/lib/logger";
import { processEventForRules } from "./engine";
import type {
  AutomationExecutionResult,
  AutomationRuleConfig,
  NormalizedChannelEvent,
} from "./types";

export interface AutomationRuleRepository {
  getRulesForTrigger(
    tenantId: bigint,
    triggerType: string,
  ): Promise<AutomationRuleConfig[]>;
  saveExecutionLog(result: AutomationExecutionResult): Promise<void>;
}

// In-memory fallback repository for unit tests and local execution
export class InMemoryAutomationRepository implements AutomationRuleRepository {
  private rules: AutomationRuleConfig[] = [];
  public executionLogs: AutomationExecutionResult[] = [];

  constructor(rules: AutomationRuleConfig[] = []) {
    this.rules = rules;
  }

  addRule(rule: AutomationRuleConfig): void {
    this.rules.push(rule);
  }

  async getRulesForTrigger(
    tenantId: bigint,
    triggerType: string,
  ): Promise<AutomationRuleConfig[]> {
    return this.rules.filter(
      (r) =>
        r.tenantId === tenantId && r.triggerType === triggerType && r.enabled,
    );
  }

  async saveExecutionLog(result: AutomationExecutionResult): Promise<void> {
    this.executionLogs.push(result);
  }
}

let activeRepository: AutomationRuleRepository =
  new InMemoryAutomationRepository();

export function setAutomationRepository(repo: AutomationRuleRepository): void {
  activeRepository = repo;
}

export function getAutomationRepository(): AutomationRuleRepository {
  return activeRepository;
}

/**
 * Dispatches an event through the automation engine.
 * Never throws — any unexpected internal error is caught and logged.
 */
export async function emitChannelEvent(
  event: NormalizedChannelEvent,
): Promise<AutomationExecutionResult[]> {
  try {
    const repo = getAutomationRepository();
    const rules = await repo.getRulesForTrigger(
      event.tenantId,
      event.triggerType,
    );

    if (rules.length === 0) {
      return [];
    }

    const results = await processEventForRules(rules, event);

    // Save execution logs asynchronously
    for (const result of results) {
      try {
        await repo.saveExecutionLog(result);
      } catch (logErr) {
        logger.error(
          "Failed to save automation execution log for rule=%s: %s",
          result.ruleId,
          logErr instanceof Error ? logErr.message : String(logErr),
        );
      }
    }

    return results;
  } catch (err) {
    logger.error(
      "emitChannelEvent error for tenant=%s trigger=%s: %s",
      String(event.tenantId),
      event.triggerType,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}
