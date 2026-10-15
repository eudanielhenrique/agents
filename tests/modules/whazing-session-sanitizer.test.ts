import { describe, expect, it } from "bun:test";
import { sanitizeWhazingReply } from "@/modules/whazing/sanitizer";
import {
  DEFAULT_SESSION_TTL_HOURS,
  extractSessionConfig,
  hasClosingTag,
} from "@/modules/whazing/session-config";

describe("Whazing sanitizer", () => {
  it("allows clean, normal replies", () => {
    const res = sanitizeWhazingReply(
      "Olá! Como posso te ajudar com a consulta médica hoje?",
    );
    expect(res.ok).toBe(true);
    expect(res.cleanReply).toBe(
      "Olá! Como posso te ajudar com a consulta médica hoje?",
    );
  });

  it("blocks 'Skipped reply' hallucination", () => {
    const res = sanitizeWhazingReply("Skipped reply");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("hallucination_pattern");
  });

  it("blocks orphan PHP/template tags '?>'", () => {
    const res = sanitizeWhazingReply("?>");
    expect(res.ok).toBe(false);
  });

  it("blocks [NO_REPLY] markers", () => {
    const res = sanitizeWhazingReply("[NO_REPLY]");
    expect(res.ok).toBe(false);
  });

  it("blocks English AI disclaimers", () => {
    const res = sanitizeWhazingReply(
      "As an AI language model, I cannot provide medical diagnosis.",
    );
    expect(res.ok).toBe(false);
  });

  it("blocks empty or pure punctuation replies", () => {
    expect(sanitizeWhazingReply("").ok).toBe(false);
    expect(sanitizeWhazingReply("   ").ok).toBe(false);
    expect(sanitizeWhazingReply("...").ok).toBe(false);
    expect(sanitizeWhazingReply("???").ok).toBe(false);
  });

  it("normalizes excessive consecutive newlines", () => {
    const res = sanitizeWhazingReply("Linha 1\n\n\n\nLinha 2");
    expect(res.ok).toBe(true);
    expect(res.cleanReply).toBe("Linha 1\n\nLinha 2");
  });
});

describe("Whazing session config", () => {
  it("defaults to 24h when no settings provided", () => {
    const cfg = extractSessionConfig({});
    expect(cfg.sessionTtlHours).toBe(DEFAULT_SESSION_TTL_HOURS);
    expect(cfg.sessionTtlMs).toBe(24 * 60 * 60 * 1000);
    expect(cfg.closingTagIds).toEqual([]);
  });

  it("extracts custom sessionTtlHours and closingTagIds", () => {
    const cfg = extractSessionConfig({
      session: {
        sessionTtlHours: 12,
        closingTagIds: [71, 80],
      },
    });
    expect(cfg.sessionTtlHours).toBe(12);
    expect(cfg.sessionTtlMs).toBe(12 * 60 * 60 * 1000);
    expect(cfg.closingTagIds).toEqual([71, 80]);
  });

  it("clamps sessionTtlHours between 1 and 168", () => {
    expect(extractSessionConfig({ sessionTtlHours: 0 }).sessionTtlHours).toBe(
      DEFAULT_SESSION_TTL_HOURS,
    );
    expect(extractSessionConfig({ sessionTtlHours: 200 }).sessionTtlHours).toBe(
      168,
    );
  });

  it("detects closing tags correctly", () => {
    expect(hasClosingTag([71, "outro"], [71, 80])).toBe(true);
    expect(hasClosingTag([{ id: 80, name: "finalizado" }], [71, 80])).toBe(
      true,
    );
    expect(hasClosingTag([99], [71, 80])).toBe(false);
    expect(hasClosingTag([], [71])).toBe(false);
  });
});
