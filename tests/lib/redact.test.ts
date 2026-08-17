import { describe, expect, test } from "bun:test";
import { redactSecretsDeep, redactSecretsInText, truncate } from "@/lib/redact";

describe("truncate", () => {
  test("leaves a short string untouched", () => {
    expect(truncate("oi")).toBe("oi");
  });

  test("cuts a string past the default budget and marks it", () => {
    const s = "a".repeat(16_001);
    const out = truncate(s);
    expect(out.endsWith("…[truncated]")).toBe(true);
    expect(out.length).toBe(16_000 + "…[truncated]".length);
  });

  // Regression: a real agent system prompt (base instructions + <attribute_values> + MCP-context
  // block) commonly runs several thousand characters — it must survive whole now that FLOWLOG_SWEEP
  // bounds the table by age, not by rationing bytes per row.
  test("a realistic system prompt is not truncated", () => {
    const prompt = "Você é uma secretária prestativa.\n\n".repeat(200); // ~7.2k chars
    expect(truncate(prompt)).toBe(prompt);
  });
});

describe("redactSecretsDeep", () => {
  test("truncates a long string value nested in an object", () => {
    const out = redactSecretsDeep({ systemPrompt: "x".repeat(20_000) }) as {
      systemPrompt: string;
    };
    expect(out.systemPrompt.endsWith("…[truncated]")).toBe(true);
    expect(out.systemPrompt.length).toBe(16_000 + "…[truncated]".length);
  });

  test("scrubs a secret-shaped value before truncating", () => {
    const out = redactSecretsInText(
      "Authorization: Bearer sk-abcdefghijklmnop",
    );
    expect(out).not.toContain("sk-abcdefghijklmnop");
  });
});
