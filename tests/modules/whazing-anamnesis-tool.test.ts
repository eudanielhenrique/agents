import { describe, expect, test } from "bun:test";
import { buildWhazingNativeTools } from "@/modules/whazing/tools";

function fakeClient(initialExtraInfo: Array<{ name: string; value: string }>) {
  let extraInfo = initialExtraInfo;
  const updateCalls: Array<Array<{ name: string; value: string }>> = [];
  const client = {
    getContact: async (_contactId: number) => ({
      id: 1,
      name: "Test",
      extraInfo,
    }),
    updateContactExtraInfo: async (
      _contactId: number,
      next: Array<{ name: string; value: string }>,
    ) => {
      updateCalls.push(next);
      extraInfo = next;
      return {};
    },
  };
  return { client, updateCalls };
}

function findTool(
  ticketId: number,
  client: unknown,
  contactId: number,
  knownAnamnesisFields?: string[],
) {
  const tools = buildWhazingNativeTools(
    {
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake — only getContact/updateContactExtraInfo are called
      client: client as any,
      instanceId: 1n,
      ticketId,
      contactId,
      knownAnamnesisFields,
    },
    ["save_anamnesis_data"],
  );
  const t = tools.find((x) => x.name === "save_anamnesis_data");
  if (!t) throw new Error("save_anamnesis_data not found");
  return t;
}

describe("save_anamnesis_data", () => {
  test("upserts a field by name, preserving unrelated existing fields", async () => {
    const { client, updateCalls } = fakeClient([
      { name: "Motivo", value: "Dor de cabeça" },
      { name: "Alergia", value: "Nenhuma" },
    ]);
    const t = findTool(1, client, 42);
    await t.invoke({
      fields: [{ name: "Motivo", value: "Dor de cabeça forte" }],
    });
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]).toEqual([
      { name: "Motivo", value: "Dor de cabeça forte" },
      { name: "Alergia", value: "Nenhuma" },
    ]);
  });

  test("adds a brand new field when the contact has none yet", async () => {
    const { client, updateCalls } = fakeClient([]);
    const t = findTool(2, client, 43);
    await t.invoke({ fields: [{ name: "Duração", value: "3 dias" }] });
    expect(updateCalls[0]).toEqual([{ name: "Duração", value: "3 dias" }]);
  });

  test("declines cleanly when there is no contact id", async () => {
    const { client, updateCalls } = fakeClient([]);
    const tools = buildWhazingNativeTools(
      {
        // biome-ignore lint/suspicious/noExplicitAny: minimal fake client
        client: client as any,
        instanceId: 1n,
        ticketId: 3,
      },
      ["save_anamnesis_data"],
    );
    const t = tools.find((x) => x.name === "save_anamnesis_data");
    if (!t) throw new Error("save_anamnesis_data not found");
    const result = await t.invoke({ fields: [{ name: "X", value: "Y" }] });
    expect(result).toContain("No contact id");
    expect(updateCalls).toHaveLength(0);
  });

  test("description names existing fields so the model reuses them instead of inventing near-duplicates", () => {
    const { client } = fakeClient([]);
    const t = findTool(4, client, 44, ["Motivo", "Duração"]);
    expect(t.description).toContain("Motivo, Duração");
    expect(t.description).toContain("reuse the existing name verbatim");
  });

  test("description has no field-reuse note when the contact has no known fields yet", () => {
    const { client } = fakeClient([]);
    const t = findTool(5, client, 45);
    expect(t.description).not.toContain("reuse the existing name verbatim");
  });
});
