// Resolves dynamic template variables such as {{contact.name}} or {{data.order_id}}
// against an execution context safely and deterministically.

export function getNestedValue(obj: unknown, path: string): unknown {
  if (obj == null) return undefined;
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current == null || typeof current !== "object") {
      return undefined;
    }
    // Support array index syntax: e.g. "items[0]"
    const match = part.match(/^([a-zA-Z0-9_]+)\[(\d+)\]$/);
    if (match?.[1] && match?.[2]) {
      const prop = match[1];
      const index = parseInt(match[2], 10);
      const arr = (current as Record<string, unknown>)[prop];
      if (!Array.isArray(arr)) return undefined;
      current = arr[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

const TEMPLATE_VAR_REGEX = /\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}/g;

export function interpolateTemplate(
  template: string,
  context: Record<string, unknown>,
): string {
  if (!template || typeof template !== "string") return "";

  return template.replace(TEMPLATE_VAR_REGEX, (_match, varPath) => {
    const value = getNestedValue(context, varPath);
    if (value === undefined || value === null) {
      return "";
    }
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return "";
      }
    }
    return String(value);
  });
}

export function interpolateFieldMapping(
  mapping: Record<string, string>,
  context: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [targetKey, templateOrPath] of Object.entries(mapping)) {
    if (typeof templateOrPath !== "string") {
      result[targetKey] = templateOrPath;
      continue;
    }

    // If the template is EXACTLY a single variable (e.g. "{{data.amount}}"),
    // preserve the raw type (number, boolean, array, object) instead of stringifying!
    const exactMatch = templateOrPath
      .trim()
      .match(/^\{\{\s*([a-zA-Z0-9_.[\]]+)\s*\}\}$/);
    if (exactMatch?.[1]) {
      const rawVal = getNestedValue(context, exactMatch[1]);
      result[targetKey] = rawVal;
    } else {
      result[targetKey] = interpolateTemplate(templateOrPath, context);
    }
  }

  return result;
}
