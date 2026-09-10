// Evaluates condition rules against an event context.
import { getNestedValue } from "./interpolator";
import type { AutomationCondition } from "./types";

export function evaluateCondition(
  condition: AutomationCondition,
  context: Record<string, unknown>,
): boolean {
  const actual = getNestedValue(context, condition.field);
  const expected = condition.value;

  switch (condition.operator) {
    case "eq":
      return actual === expected;

    case "neq":
      return actual !== expected;

    case "contains": {
      if (typeof actual === "string" && typeof expected === "string") {
        return actual.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(actual)) {
        return actual.includes(expected);
      }
      return false;
    }

    case "not_contains": {
      if (typeof actual === "string" && typeof expected === "string") {
        return !actual.toLowerCase().includes(expected.toLowerCase());
      }
      if (Array.isArray(actual)) {
        return !actual.includes(expected);
      }
      return true;
    }

    case "gt": {
      const numActual = Number(actual);
      const numExpected = Number(expected);
      return (
        !Number.isNaN(numActual) &&
        !Number.isNaN(numExpected) &&
        numActual > numExpected
      );
    }

    case "gte": {
      const numActual = Number(actual);
      const numExpected = Number(expected);
      return (
        !Number.isNaN(numActual) &&
        !Number.isNaN(numExpected) &&
        numActual >= numExpected
      );
    }

    case "lt": {
      const numActual = Number(actual);
      const numExpected = Number(expected);
      return (
        !Number.isNaN(numActual) &&
        !Number.isNaN(numExpected) &&
        numActual < numExpected
      );
    }

    case "lte": {
      const numActual = Number(actual);
      const numExpected = Number(expected);
      return (
        !Number.isNaN(numActual) &&
        !Number.isNaN(numExpected) &&
        numActual <= numExpected
      );
    }

    case "is_empty":
      return (
        actual === undefined ||
        actual === null ||
        actual === "" ||
        (Array.isArray(actual) && actual.length === 0)
      );

    case "is_not_empty":
      return (
        actual !== undefined &&
        actual !== null &&
        actual !== "" &&
        (!Array.isArray(actual) || actual.length > 0)
      );

    case "in": {
      if (Array.isArray(expected)) {
        return expected.includes(actual);
      }
      return false;
    }

    case "not_in": {
      if (Array.isArray(expected)) {
        return !expected.includes(actual);
      }
      return true;
    }

    default:
      return false;
  }
}

export function evaluateAllConditions(
  conditions: AutomationCondition[],
  context: Record<string, unknown>,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  for (const cond of conditions) {
    if (!evaluateCondition(cond, context)) {
      return false;
    }
  }
  return true;
}
