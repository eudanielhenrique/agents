import { describe, expect, test } from "bun:test";
import type { InboxReplyClient } from "@/lib/transport/inbox-client";
import {
  deliverReply,
  readSplitConfig,
  SPLIT_DEFAULTS,
  splitReply,
  typingDelayMs,
} from "@/modules/split/service";

const cfg = SPLIT_DEFAULTS;

describe("readSplitConfig", () => {
  test("defaults to enabled", () => {
    expect(readSplitConfig(undefined).enabled).toBe(true);
    expect(readSplitConfig({ split: {} })).toEqual(SPLIT_DEFAULTS);
  });
  test("clamps numeric knobs", () => {
    const c = readSplitConfig({
      split: { enabled: true, maxChars: 5, typingWpm: 99999 },
    });
    expect(c.enabled).toBe(true);
    expect(c.maxChars).toBe(80);
    expect(c.typingWpm).toBe(1000);
  });
});

describe("splitReply", () => {
  test("splits on blank lines into balloons", () => {
    expect(splitReply("Olá!\n\nComo posso ajudar?", cfg)).toEqual([
      "Olá!",
      "Como posso ajudar?",
    ]);
  });
  test("a single paragraph stays one balloon", () => {
    expect(splitReply("uma resposta curta", cfg)).toEqual([
      "uma resposta curta",
    ]);
  });
  test("an over-long paragraph splits on sentences", () => {
    const small = { ...cfg, maxChars: 20 };
    const out = splitReply(
      "Primeira frase. Segunda frase aqui. Terceira.",
      small,
    );
    expect(out.length).toBeGreaterThan(1);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(40);
  });
  test("caps the balloon count, merging the overflow", () => {
    const many = "a\n\nb\n\nc\n\nd\n\ne\n\nf\n\ng";
    const out = splitReply(many, { ...cfg, maxChunks: 3 });
    expect(out.length).toBe(3);
    expect(out[2]).toContain("g");
  });
});

describe("typingDelayMs", () => {
  test("scales with word count and clamps", () => {
    expect(typingDelayMs("uma", cfg)).toBe(cfg.minDelayMs); // tiny → floor
    const long = `${"palavra ".repeat(500)}`;
    expect(typingDelayMs(long, cfg)).toBe(cfg.maxDelayMs); // huge → ceiling
  });
});

describe("deliverReply", () => {
  function stub(rec: { sent: string[]; typing: boolean[] }) {
    return {
      sendMessage: async (_c: number, content: string) => {
        rec.sent.push(content);
        return {};
      },
      toggleTyping: async (_c: number, on: boolean) => {
        rec.typing.push(on);
        return {};
      },
    } as unknown as InboxReplyClient;
  }
  const noSleep = async () => {};

  test("disabled → a single send, no typing", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const n = await deliverReply(
      stub(rec),
      1,
      "oi\n\ntudo bem?",
      { ...SPLIT_DEFAULTS, enabled: false },
      noSleep,
    );
    expect(n).toBe(1);
    expect(rec.sent).toEqual(["oi\n\ntudo bem?"]);
    expect(rec.typing).toEqual([]);
  });

  test("enabled → one send per balloon, with typing toggles", async () => {
    const rec = { sent: [] as string[], typing: [] as boolean[] };
    const n = await deliverReply(
      stub(rec),
      1,
      "Olá!\n\nComo vai?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(n).toBe(2);
    expect(rec.sent).toEqual(["Olá!", "Como vai?"]);
    // typing on before each balloon + a final off
    expect(rec.typing).toEqual([true, true, false]);
  });
});
