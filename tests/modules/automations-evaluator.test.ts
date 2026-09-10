import { describe, expect, test } from "bun:test";
import {
  evaluateAllConditions,
  evaluateCondition,
} from "@/modules/automations/evaluator";

describe("automations condition evaluator", () => {
  const context = {
    contact: {
      name: "Carlos Eduardo",
      phone: "5511988887777",
      tags: ["VIP", "Interessado"],
      city: null,
    },
    data: {
      orderTotal: 1500,
      status: "PAID",
      category: "consultoria",
    },
  };

  test("eq and neq operators", () => {
    expect(
      evaluateCondition(
        { field: "data.status", operator: "eq", value: "PAID" },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "data.status", operator: "eq", value: "PENDING" },
        context,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: "data.status", operator: "neq", value: "CANCELED" },
        context,
      ),
    ).toBe(true);
  });

  test("contains and not_contains operators (case insensitive)", () => {
    expect(
      evaluateCondition(
        { field: "contact.name", operator: "contains", value: "carlos" },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "contact.tags", operator: "contains", value: "VIP" },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "contact.tags", operator: "contains", value: "LeadFrio" },
        context,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: "contact.tags", operator: "not_contains", value: "LeadFrio" },
        context,
      ),
    ).toBe(true);
  });

  test("numeric comparisons gt, gte, lt, lte", () => {
    expect(
      evaluateCondition(
        { field: "data.orderTotal", operator: "gt", value: 1000 },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "data.orderTotal", operator: "gt", value: 2000 },
        context,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: "data.orderTotal", operator: "gte", value: 1500 },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "data.orderTotal", operator: "lt", value: 2000 },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "data.orderTotal", operator: "lte", value: 1500 },
        context,
      ),
    ).toBe(true);
  });

  test("is_empty and is_not_empty operators", () => {
    expect(
      evaluateCondition(
        { field: "contact.city", operator: "is_empty" },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "contact.missingField", operator: "is_empty" },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { field: "contact.name", operator: "is_not_empty" },
        context,
      ),
    ).toBe(true);
  });

  test("in and not_in operators with arrays", () => {
    expect(
      evaluateCondition(
        { field: "data.status", operator: "in", value: ["PAID", "SETTLED"] },
        context,
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        {
          field: "data.status",
          operator: "in",
          value: ["REFUNDED", "CHARGEBACK"],
        },
        context,
      ),
    ).toBe(false);
    expect(
      evaluateCondition(
        { field: "data.status", operator: "not_in", value: ["REFUNDED"] },
        context,
      ),
    ).toBe(true);
  });

  test("evaluateAllConditions with multiple AND conditions", () => {
    const conditions = [
      { field: "data.status", operator: "eq" as const, value: "PAID" },
      { field: "data.orderTotal", operator: "gte" as const, value: 1000 },
      { field: "contact.tags", operator: "contains" as const, value: "VIP" },
    ];
    expect(evaluateAllConditions(conditions, context)).toBe(true);

    const failingConditions = [
      ...conditions,
      { field: "data.category", operator: "eq" as const, value: "software" }, // false
    ];
    expect(evaluateAllConditions(failingConditions, context)).toBe(false);
  });
});
