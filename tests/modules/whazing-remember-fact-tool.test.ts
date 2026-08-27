import { describe, expect, test } from "bun:test";
import { buildWhazingNativeTools } from "@/modules/whazing/tools";

function findTool(ctx: Parameters<typeof buildWhazingNativeTools>[0]): {
  invoke: (args: unknown) => Promise<unknown>;
} {
  const tools = buildWhazingNativeTools(ctx, ["remember_fact"]);
  const t = tools.find((x) => x.name === "remember_fact");
  if (!t) throw new Error("remember_fact not found");
  return t;
}

describe("whazing remember_fact", () => {
  test("no contactId in ctx → safe message, no store call", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: client is never touched on this path
    const t = findTool({ client: {} as any, instanceId: 1n, ticketId: 1 });
    const out = String(
      await t.invoke({ key: "preferencia_contato", value: "prefere áudio" }),
    );
    expect(out.toLowerCase()).toContain("no contact in scope");
  });

  test("no tenantId in ctx → safe message, no store call", async () => {
    const t = findTool({
      // biome-ignore lint/suspicious/noExplicitAny: client is never touched on this path
      client: {} as any,
      instanceId: 1n,
      ticketId: 1,
      contactId: 42,
    });
    const out = String(
      await t.invoke({ key: "preferencia_contato", value: "prefere áudio" }),
    );
    expect(out.toLowerCase()).toContain("no contact in scope");
  });
});
