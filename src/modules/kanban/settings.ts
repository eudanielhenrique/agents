import { readToolInstructions } from "@/modules/handoff/settings";

// Per-agent kanban config, read from `agent.settings.kanban`.
export interface KanbanWhazingColumn {
  id: number;
  name: string;
}

// Saved snapshot of a Whazing Kanban Pro board + its columns. Persisted at editor time so the
// runtime can inject board/column context into the tool description without an extra API call.
export interface KanbanWhazingBoard {
  // WhazingInstance id (BigInt serialised as string).
  instanceId: string;
  boardId: number;
  boardName: string;
  columns: KanbanWhazingColumn[];
}

export interface KanbanConfig {
  // Operator-authored funnel guidance. null ⇒ none. Trimmed + length-capped on read.
  instructions: string | null;
  // Whazing Kanban Pro board snapshot. Null on Chatwoot agents (board derived from the conversation).
  whazingBoard: KanbanWhazingBoard | null;
}

export const KANBAN_DEFAULTS: KanbanConfig = {
  instructions: null,
  whazingBoard: null,
};

function readWhazingBoard(v: unknown): KanbanWhazingBoard | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  if (typeof b.boardId !== "number" || typeof b.boardName !== "string") return null;
  const instanceId = typeof b.instanceId === "string" ? b.instanceId : "";
  const cols = Array.isArray(b.columns)
    ? b.columns
        .filter((c): c is { id: number; name: string } =>
          typeof c === "object" && c !== null && typeof c.id === "number" && typeof c.name === "string",
        )
    : [];
  return { instanceId, boardId: b.boardId, boardName: b.boardName, columns: cols };
}

export function readKanbanConfig(settings: unknown): KanbanConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).kanban
      : undefined;
  if (!s || typeof s !== "object") return { ...KANBAN_DEFAULTS };
  const bag = s as Record<string, unknown>;
  return {
    instructions: readToolInstructions(bag.instructions),
    whazingBoard: readWhazingBoard(bag.whazingBoard),
  };
}
