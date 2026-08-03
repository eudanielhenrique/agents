import {
  Check,
  ChevronDown,
  type LucideIcon,
  Pencil,
  Plug,
  Plus,
  Puzzle,
  RefreshCw,
  Webhook,
  Wrench,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  FormField,
  Select,
  SelectableCard,
  SwitchField,
  Textarea,
  ToolArgPills,
  useModalController,
  useToast,
} from "@/client/components";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import {
  type DiscoveredMcpTool,
  McpServerInstructions,
  McpToolArgs,
} from "@/client/components/mcp/DiscoveredMcpTools";
import { api } from "@/client/lib/api";
import { nativeToolMeta } from "@/client/lib/nativeTools";
import { toolpackToolMeta } from "@/client/lib/toolpackTools";
import { cn } from "@/client/lib/utils";
import { IntegrationEditModal } from "@/client/pages/resources/IntegrationEditModal";
import { McpEditModal } from "@/client/pages/resources/McpEditModal";
import { ToolEditModal } from "@/client/pages/resources/ToolEditModal";
import type {
  GrantState,
  HandoffUiState,
  KanbanWhazingBoardState,
  ToolCatalog,
  WhazingPixUiState,
} from "./types";

// Service-logo adapters so a toolpack integration shows its brand mark in the SelectableCard's
// `icon` slot (which expects a LucideIcon). Module-level → stable identity (no remount per render).
const AsaasLogo = ((p: { className?: string }) => (
  <ServiceLogo service="asaas" className={p.className} />
)) as unknown as LucideIcon;
const CalendarLogo = ((p: { className?: string }) => (
  <ServiceLogo service="google_calendar" className={p.className} />
)) as unknown as LucideIcon;
const DriveLogo = ((p: { className?: string }) => (
  <ServiceLogo service="google_drive" className={p.className} />
)) as unknown as LucideIcon;
const GoogleLogo = ((p: { className?: string }) => (
  <ServiceLogo service="google" className={p.className} />
)) as unknown as LucideIcon;
function integrationIcon(catalogType: string): LucideIcon {
  switch (catalogType) {
    case "ASAAS":
      return AsaasLogo;
    case "GOOGLE_CALENDAR":
      return CalendarLogo;
    case "GOOGLE_DRIVE":
      return DriveLogo;
    default:
      return catalogType.startsWith("GOOGLE_") ? GoogleLogo : Puzzle;
  }
}

// Native tools that carry per-tool config. When granted, their settings render as a configurable card
// (toggle + inline config) outside the simple-toggle grid: handoff (target + summary + transfer
// guidance) and kanban (funnel guidance). Both also accept operator-authored instructions appended to
// the tool's model-facing description.
const HANDOFF_TOOL = "handoff_to_human";
const KANBAN_TOOL = "kanban_move_card";
// set_custom_attribute + assign_label both act on conversation/contact/task (scope) and accept
// operator-authored "when to use" guidance, so they render as configurable cards too. Their guidance
// lives in the flat agent.settings.toolGuidance map (handoff/kanban use their own grouped config).
const ATTR_TOOL = "set_custom_attribute";
const LABEL_TOOL = "assign_label";
// update_kanban_task (edit the linked card's title/description/priority/dates) also takes optional
// operator guidance, so it renders as a configurable card next to kanban_move_card.
const UPDATE_KANBAN_TOOL = "update_kanban_task";
// send_pix_button carries its PIX key/name/type (operator-set, never model-supplied — see
// src/modules/whazing/payments.ts), so it renders as a configurable card too.
const PIX_TOOL = "send_pix_button";

// Tools that are Chatwoot-only and unavailable on Whazing. Hidden from the editor since the active
// transport is Whazing. Kept in the allowlist catalog for back-compat if Chatwoot is re-enabled.
// NOTE: kanban_move_card and update_kanban_task are NOT here — Whazing has its own Kanban Pro API.
const CHATWOOT_ONLY_TOOLS = new Set([
  ATTR_TOOL,
  LABEL_TOOL,
  "set_voice_preference",
  "react_to_message",
]);

interface Props {
  // The agent being edited — scopes the handoff target picker to the accounts it serves.
  agentId: string;
  catalog: ToolCatalog;
  grants: GrantState[];
  onChange: (grants: GrantState[]) => void;
  // Refetch the agent's tool catalog (after creating/editing a resource in-place via the modals
  // below) so a freshly-created tool/server/integration appears without leaving the editor.
  onCatalogChange: () => void | Promise<void>;
  // Config of the handoff_to_human tool. Tool-coupled, so it lives here (Tools tab), not in Behavior.
  // Persisted by the Tools tab's save alongside the grant set.
  transferWithSummary: boolean;
  setTransferWithSummary: (v: boolean) => void;
  handoff: HandoffUiState;
  setHandoff: React.Dispatch<React.SetStateAction<HandoffUiState>>;
  // Operator-authored funnel guidance for the kanban_move_card tool (when/why to move a card between
  // steps), appended to its model-facing description. Persisted in agent.settings.kanban.instructions.
  kanbanInstructions: string;
  setKanbanInstructions: (v: string) => void;
  // Whazing Kanban Pro board snapshot: which board + columns the agent operates on.
  // Null on Chatwoot agents (board is derived from the conversation at runtime).
  kanbanWhazingBoard: KanbanWhazingBoardState | null;
  setKanbanWhazingBoard: React.Dispatch<React.SetStateAction<KanbanWhazingBoardState | null>>;
  // Operator-authored guidance for set_custom_attribute + assign_label (when to use each scope/label/
  // attribute), appended to their model-facing descriptions. Persisted in agent.settings.toolGuidance.
  customAttributeInstructions: string;
  setCustomAttributeInstructions: (v: string) => void;
  labelInstructions: string;
  setLabelInstructions: (v: string) => void;
  // Operator-authored guidance for update_kanban_task (when/how to edit the card's fields), appended to
  // its model-facing description. Persisted in agent.settings.toolGuidance.update_kanban_task.
  updateKanbanTaskInstructions: string;
  setUpdateKanbanTaskInstructions: (v: string) => void;
  // PIX key/name/type for send_pix_button + request_payment. Operator-set, never a model-supplied
  // tool argument. null = not configured (the tools decline). Persisted in agent.settings.whazingPix.
  whazingPix: WhazingPixUiState | null;
  setWhazingPix: React.Dispatch<React.SetStateAction<WhazingPixUiState | null>>;
  // Discovered MCP tools + each server's `instructions` + per-connection collapse state. Lifted to
  // AgentEditorPage so switching agent tabs (which unmounts this editor) does not lose the discovery.
  mcpTools: Record<string, DiscoveredMcpTool[]>;
  setMcpTools: React.Dispatch<
    React.SetStateAction<Record<string, DiscoveredMcpTool[]>>
  >;
  mcpInstructions: Record<string, string | null>;
  setMcpInstructions: React.Dispatch<
    React.SetStateAction<Record<string, string | null>>
  >;
  mcpCollapsed: Record<string, boolean>;
  setMcpCollapsed: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  integrationCollapsed: Record<string, boolean>;
  setIntegrationCollapsed: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
}

function Section({
  id,
  icon: Icon,
  title,
  description,
  action,
  children,
}: {
  // Anchor id + icon (item 9): lets the Tools-tab SectionNav scroll to and highlight this block.
  id?: string;
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      className="flex scroll-mt-4 flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          {Icon && (
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-accent">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0">
            <h3 className="font-medium text-sm text-text-primary">{title}</h3>
            {description && (
              <p className="mt-0.5 text-text-muted text-xs">{description}</p>
            )}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

// Same shell as Section, but the whole header is a disclosure toggle that collapses the body. Used by
// the native-tools block (which lives last): it renders EXPANDED by default (item 15 — the built-ins
// should be visible at a glance), but stays collapsible, with a `badge` slot that shows how many
// native tools are active (and a config dot) even while collapsed.
function CollapsibleSection({
  id,
  icon: Icon,
  title,
  description,
  badge,
  defaultCollapsed,
  children,
}: {
  id?: string;
  icon?: LucideIcon;
  title: string;
  description?: string;
  badge?: React.ReactNode;
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);
  return (
    <section
      id={id}
      className="flex scroll-mt-4 flex-col gap-3 rounded-lg border border-border bg-bg-secondary p-4"
    >
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        className="flex items-start gap-2.5 text-left"
      >
        {Icon && (
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-tertiary text-accent">
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h3 className="flex flex-wrap items-center gap-2 font-medium text-sm text-text-primary">
            {title}
            {badge}
          </h3>
          {description && (
            <p className="mt-0.5 text-text-muted text-xs">{description}</p>
          )}
        </div>
        <ChevronDown
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0 text-text-muted transition-transform",
            { "rotate-180": !collapsed },
          )}
          aria-hidden="true"
        />
      </button>
      {!collapsed && children}
    </section>
  );
}

// In-page "create a new one" button: opens the resource's create/edit modal embedded in the agent
// editor (no new tab, no navigation), so the operator's unsaved editor state survives.
function CreateButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-accent text-xs hover:underline"
    >
      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

// SelectableCard (a <button>) can't nest an edit button, so the pencil is an absolutely-positioned
// sibling overlay sitting just left of the card's check indicator. stopPropagation keeps a pencil
// click from toggling the grant selection.
function EditableCard({
  onEdit,
  editLabel,
  children,
}: {
  onEdit: () => void;
  editLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      {children}
      {/* Vertically center the pencil on the card's selection check (mt-0.5 h-5): top-3.5 + an
          h-5 button put both centers at the same y. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        aria-label={editLabel}
        className="absolute top-3.5 right-9 flex h-5 w-5 items-center justify-center rounded text-text-muted hover:text-text-primary"
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

// A native tool that carries its own settings: a SelectableCard-style toggle header with the config
// rendered INSIDE the same border when the tool is granted. The config is COLLAPSIBLE (a disclosure
// separate from the enable toggle): collapsed by default so several configurable tools don't stack
// into a wall, auto-expanded on a fresh enable (so the operator finds the config), and flagged with a
// dot when it holds non-default content (`configured`). Reusable for any configurable native tool.
function ConfigurableToolCard({
  selected,
  onToggle,
  title,
  description,
  icon: Icon,
  badge,
  configured,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  badge?: React.ReactNode;
  // True when the config holds non-default content — shows a dot on the collapsed header so the
  // operator knows there is hidden config worth opening.
  configured?: boolean;
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const hasConfig = selected && !!children;
  // Enabling the tool reveals its config once (discoverability); a pre-enabled tool loaded from the
  // server stays collapsed (compactness). Disabling is a no-op here (the config stops rendering).
  const handleToggle = () => {
    if (!selected) setExpanded(true);
    onToggle();
  };
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border transition-colors",
        selected ? "border-accent" : "border-border",
      )}
    >
      <div
        className={cn(
          "flex items-stretch transition-colors",
          selected ? "bg-accent/10" : "bg-bg-secondary",
        )}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: a styled selection card needs a button with the checkbox role, not a bare <input>. */}
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          onClick={handleToggle}
          className={cn(
            "group flex flex-1 items-start gap-3 p-3 text-left transition-colors",
            !selected && "hover:bg-bg-hover",
          )}
        >
          {Icon && (
            <span
              className={cn(
                "mt-0.5 shrink-0",
                selected ? "text-accent" : "text-text-muted",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium text-sm text-text-primary">
                {title}
              </span>
              {badge}
              {configured && !expanded && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  aria-hidden="true"
                />
              )}
            </span>
            {description && (
              <span className="text-text-muted text-xs">{description}</span>
            )}
          </span>
          <span
            className={cn(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors",
              selected
                ? "border-accent bg-accent text-accent-foreground"
                : "border-border text-transparent group-hover:border-text-muted",
            )}
            aria-hidden="true"
          >
            <Check className="h-3.5 w-3.5" />
          </span>
        </button>
        {hasConfig && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? t("editor.tools.hideConfig", "Hide settings")
                : t("editor.tools.showConfig", "Settings")
            }
            className="flex shrink-0 items-center self-start p-3 text-text-muted transition-colors hover:text-text-primary"
          >
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                expanded && "rotate-180",
              )}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {hasConfig && expanded && (
        <div className="flex flex-col gap-4 border-border border-t bg-bg-secondary p-3">
          {children}
        </div>
      )}
    </div>
  );
}

// Controlled editor for NATIVE / HTTP / MCP / INTEGRATION grants. RAG lives in
// the Knowledge tab; this component preserves any RAG grant untouched.
export function ToolGrantsEditor({
  agentId,
  catalog,
  grants,
  onChange,
  onCatalogChange,
  transferWithSummary,
  setTransferWithSummary,
  handoff,
  setHandoff,
  kanbanInstructions,
  setKanbanInstructions,
  kanbanWhazingBoard,
  setKanbanWhazingBoard,
  customAttributeInstructions,
  setCustomAttributeInstructions,
  labelInstructions,
  setLabelInstructions,
  updateKanbanTaskInstructions,
  setUpdateKanbanTaskInstructions,
  whazingPix,
  setWhazingPix,
  mcpTools,
  setMcpTools,
  mcpInstructions,
  setMcpInstructions,
  mcpCollapsed,
  setMcpCollapsed,
  integrationCollapsed,
  setIntegrationCollapsed,
}: Props) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  // Create/edit a resource without leaving the agent editor. On save the catalog refetches; a
  // newly-created one is auto-granted to this agent (still needs the Tools-tab save to persist).
  const toolModal = useModalController<{ id?: string }>();
  const mcpModal = useModalController<{ id?: string }>();
  const integrationModal = useModalController<{ id?: string }>();
  // A just-created integration is auto-granted with ALL its tools (matching the manual toggle), but
  // its tool list only arrives once the catalog refetches — defer the grant until the instance shows
  // up in the refreshed catalog (the effect below applies it then).
  const [pendingIntegrationId, setPendingIntegrationId] = useState<
    string | null
  >(null);

  // ── Whazing Kanban Pro board picker ──────────────────────────────────────────
  const [whazingInstances, setWhazingInstances] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string>(
    kanbanWhazingBoard?.instanceId ?? "",
  );
  const [boardsList, setBoardsList] = useState<
    Array<{ id: number; name: string; color: string | null }>
  >([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [columnsLoading, setColumnsLoading] = useState(false);

  // Load Whazing instances once (for the instance picker).
  useEffect(() => {
    api.api.v1.whazing.instances.get().then((res) => {
      if (res.data?.instances) {
        setWhazingInstances(
          res.data.instances.map((i: { id: string | number; name: string }) => ({
            id: String(i.id),
            name: i.name,
          })),
        );
        // Auto-select the first instance if none saved.
        if (!selectedInstanceId && res.data.instances.length === 1) {
          const first = res.data.instances[0];
          if (first) setSelectedInstanceId(String(first.id));
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load boards when the selected instance changes.
  useEffect(() => {
    if (!selectedInstanceId) return;
    setBoardsLoading(true);
    setBoardsList([]);
    api.api.v1.whazing
      .instances({ id: selectedInstanceId })
      .kanban.boards.get()
      .then((res) => {
        if (res.data?.boards) setBoardsList(res.data.boards as Array<{ id: number; name: string; color: string | null }>);
      })
      .finally(() => setBoardsLoading(false));
  }, [selectedInstanceId]);

  function loadColumnsForBoard(boardId: number, boardName: string) {
    setColumnsLoading(true);
    api.api.v1.whazing
      .instances({ id: selectedInstanceId })
      .kanban.boards({ boardId: String(boardId) })
      .columns.get()
      .then((res) => {
        if (res.data?.columns) {
          setKanbanWhazingBoard({
            instanceId: selectedInstanceId,
            boardId,
            boardName,
            columns: res.data.columns as Array<{ id: number; name: string; color: string | null }>,
          });
        }
      })
      .finally(() => setColumnsLoading(false));
  }

  const kindLabel = (kind: string | null | undefined) => {
    switch (kind) {
      case "NATIVE":
        return t("integrations.kind.NATIVE", "Native");
      case "MCP":
        return t("integrations.kind.MCP", "MCP");
      case "TOOLPACK":
        return t("integrations.kind.TOOLPACK", "Tools");
      default:
        return kind ?? "";
    }
  };
  const [discovering, setDiscovering] = useState<string | null>(null);

  const rag = grants.filter((g) => g.source === "RAG");
  const emit = (nonRag: GrantState[]) => onChange([...rag, ...nonRag]);
  const nonRag = grants.filter((g) => g.source !== "RAG");

  const nativeGrant = grants.find((g) => g.source === "NATIVE");
  // Filter out Chatwoot-only tools — only show what works on the active Whazing transport.
  const visibleNative = catalog.native.filter(
    (n) => !CHATWOOT_ONLY_TOOLS.has(n.name),
  );
  const allNativeNames = visibleNative.map((n) => n.name);
  // No explicit NATIVE row ⇒ all native tools (the permissive default for new/legacy agents). The
  // first toggle persists an explicit allowlist (which may even become empty = no native tools).
  const selectedNative = nativeGrant
    ? new Set(nativeGrant.enabledTools ?? [])
    : new Set(allNativeNames);
  const handoffEnabled = selectedNative.has(HANDOFF_TOOL);
  // handoff_to_human carries its own settings; rendered as a configurable card outside the grid below.
  const handoffEntry = visibleNative.find((n) => n.name === HANDOFF_TOOL);
  const kanbanEnabled = selectedNative.has(KANBAN_TOOL);
  const kanbanEntry = visibleNative.find((n) => n.name === KANBAN_TOOL);
  const updateKanbanEnabled = selectedNative.has(UPDATE_KANBAN_TOOL);
  const updateKanbanEntry = visibleNative.find((n) => n.name === UPDATE_KANBAN_TOOL);
  const pixEnabled = selectedNative.has(PIX_TOOL);
  const pixEntry = visibleNative.find((n) => n.name === PIX_TOOL);
  // Chatwoot-only tools: always null since filtered out; kept for type-safety in unused card guards.
  const attrEnabled = false;
  const attrEntry = undefined;
  const labelEnabled = false;
  const labelEntry = undefined;

  // True when any ENABLED configurable native tool holds non-default config — surfaces a dot on the
  // collapsed section header so the operator knows hidden settings are in play. Mirrors each card's
  // own `configured` signal.
  const nativeConfigured =
    (handoffEnabled &&
      (handoff.instructions.trim() !== "" ||
        !transferWithSummary ||
        handoff.whazingQueueId.trim() !== "")) ||
    (kanbanEnabled && (kanbanInstructions.trim() !== "" || kanbanWhazingBoard != null)) ||
    (pixEnabled && whazingPix != null);


  // Apply the deferred auto-grant for a just-created integration once it appears in the refreshed
  // catalog (so we can enable its full tool set, like the manual toggle does).
  // NOTE: depends on `grants`/`onChange` (stable setState) rather than the per-render `emit`/`nonRag`
  // helpers, so it doesn't churn on every render.
  useEffect(() => {
    if (!pendingIntegrationId) return;
    const inst = catalog.integrationInstances.find(
      (i) => i.id === pendingIntegrationId,
    );
    if (!inst) return;
    setPendingIntegrationId(null);
    if (
      grants.some(
        (g) =>
          g.source === "INTEGRATION" && g.integrationInstanceId === inst.id,
      )
    )
      return;
    onChange([
      ...grants,
      {
        source: "INTEGRATION",
        integrationInstanceId: inst.id,
        enabledTools: inst.tools.map((tool) => tool.name),
      },
    ]);
  }, [pendingIntegrationId, catalog, grants, onChange]);

  function toggleNative(name: string) {
    const next = new Set(selectedNative);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    const others = nonRag.filter((g) => g.source !== "NATIVE");
    emit([...others, { source: "NATIVE", enabledTools: [...next] }]);
  }

  function toggleHttp(id: string) {
    const exists = nonRag.some(
      (g) => g.source === "HTTP" && g.toolDefinitionId === id,
    );
    emit(
      exists
        ? nonRag.filter(
            (g) => !(g.source === "HTTP" && g.toolDefinitionId === id),
          )
        : [...nonRag, { source: "HTTP", toolDefinitionId: id }],
    );
  }

  // Idempotent grant-on (used to auto-select a just-created tool, vs the toggle above).
  function selectHttp(id: string) {
    if (nonRag.some((g) => g.source === "HTTP" && g.toolDefinitionId === id))
      return;
    emit([...nonRag, { source: "HTTP", toolDefinitionId: id }]);
  }

  async function onToolSaved(
    saved: { id: string; name: string },
    isNew: boolean,
  ) {
    await onCatalogChange();
    if (isNew) selectHttp(saved.id);
  }

  // Idempotent grant-on for a just-created MCP server (empty tool subset; the operator then discovers
  // + picks tools, same as toggling one on).
  function selectMcp(id: string) {
    if (
      nonRag.some((g) => g.source === "MCP" && g.mcpServerConnectionId === id)
    )
      return;
    emit([
      ...nonRag,
      { source: "MCP", mcpServerConnectionId: id, enabledTools: [] },
    ]);
  }

  async function onMcpSaved(
    saved: { id: string; name: string },
    isNew: boolean,
  ) {
    await onCatalogChange();
    if (isNew) selectMcp(saved.id);
  }

  async function onIntegrationSaved(
    saved: { id: string; name: string },
    isNew: boolean,
  ) {
    await onCatalogChange();
    if (isNew) setPendingIntegrationId(saved.id);
  }

  function toggleMcp(id: string) {
    const exists = nonRag.some(
      (g) => g.source === "MCP" && g.mcpServerConnectionId === id,
    );
    emit(
      exists
        ? nonRag.filter(
            (g) => !(g.source === "MCP" && g.mcpServerConnectionId === id),
          )
        : [
            ...nonRag,
            { source: "MCP", mcpServerConnectionId: id, enabledTools: [] },
          ],
    );
  }

  function setMcpEnabledTools(id: string, tools: string[]) {
    emit(
      nonRag.map((g) =>
        g.source === "MCP" && g.mcpServerConnectionId === id
          ? { ...g, enabledTools: tools }
          : g,
      ),
    );
  }

  async function discoverMcp(id: string) {
    setDiscovering(id);
    try {
      const { data, error } = await api.api.v1["mcp-connections"]({
        id,
      }).discover.post();
      if (error || !data) {
        showToast(
          t("mcp.discoverError", "Could not reach the server."),
          "error",
        );
        return;
      }
      setMcpTools((prev) => ({ ...prev, [id]: data.tools }));
      setMcpInstructions((prev) => ({
        ...prev,
        [id]: data.instructions ?? null,
      }));
      if (data.tools.length === 0) {
        showToast(
          t("mcp.noTools", "No tools advertised by this server."),
          "info",
        );
        return;
      }
      // Default to all tools enabled, but only when the operator hasn't curated a subset yet
      // (empty allowlist) so a re-discover never clobbers an existing selection.
      const grant = nonRag.find(
        (g) => g.source === "MCP" && g.mcpServerConnectionId === id,
      );
      if (grant && (grant.enabledTools?.length ?? 0) === 0) {
        setMcpEnabledTools(
          id,
          data.tools.map((tool) => tool.name),
        );
      }
    } catch {
      showToast(t("mcp.discoverError", "Could not reach the server."), "error");
    } finally {
      setDiscovering(null);
    }
  }

  function toggleIntegration(id: string, allTools: string[]) {
    const exists = nonRag.some(
      (g) => g.source === "INTEGRATION" && g.integrationInstanceId === id,
    );
    emit(
      exists
        ? nonRag.filter(
            (g) =>
              !(g.source === "INTEGRATION" && g.integrationInstanceId === id),
          )
        : [
            ...nonRag,
            {
              source: "INTEGRATION",
              integrationInstanceId: id,
              enabledTools: allTools,
            },
          ],
    );
  }

  function toggleIntegrationTool(id: string, tool: string) {
    emit(
      nonRag.map((g) => {
        if (g.source !== "INTEGRATION" || g.integrationInstanceId !== id)
          return g;
        const current = new Set(g.enabledTools ?? []);
        if (current.has(tool)) current.delete(tool);
        else current.add(tool);
        return { ...g, enabledTools: [...current] };
      }),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Section
        id="tools-http"
        icon={Webhook}
        title={t("editor.tools.http", "HTTP tools")}
        description={t(
          "editor.tools.httpDesc",
          "Declarative tools you defined.",
        )}
        action={
          <CreateButton
            label={t("editor.tools.createNew", "New")}
            onClick={() => toolModal.open({})}
          />
        }
      >
        {catalog.toolDefinitions.length === 0 ? (
          <p className="text-text-muted text-xs">
            {t(
              "editor.tools.noHttp",
              "No HTTP tools yet. Create some in Components.",
            )}
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.toolDefinitions.map((td) => (
              <EditableCard
                key={td.id}
                editLabel={t("common.edit", "Edit")}
                onEdit={() => toolModal.open({ id: td.id })}
              >
                <SelectableCard
                  selected={nonRag.some(
                    (g) => g.source === "HTTP" && g.toolDefinitionId === td.id,
                  )}
                  onToggle={() => toggleHttp(td.id)}
                  icon={Webhook}
                  title={td.label}
                  badge={
                    !td.enabled ? (
                      <Badge variant="secondary">
                        {t("common.disabled", "Disabled")}
                      </Badge>
                    ) : undefined
                  }
                />
              </EditableCard>
            ))}
          </div>
        )}
      </Section>

      <Section
        id="tools-mcp"
        icon={Plug}
        title={t("editor.tools.mcp", "MCP servers")}
        description={t(
          "editor.tools.mcpDesc",
          "Expose a chosen subset of an MCP server's tools.",
        )}
        action={
          <CreateButton
            label={t("editor.tools.createNew", "New")}
            onClick={() => mcpModal.open({})}
          />
        }
      >
        {catalog.mcpConnections.length === 0 ? (
          <p className="text-text-muted text-xs">
            {t("editor.tools.noMcp", "No MCP servers connected yet.")}
          </p>
        ) : (
          catalog.mcpConnections.map((m) => {
            const grant = nonRag.find(
              (g) => g.source === "MCP" && g.mcpServerConnectionId === m.id,
            );
            const tools = mcpTools[m.id];
            const hasTools = !!tools && tools.length > 0;
            const collapsed = mcpCollapsed[m.id] ?? true;
            return (
              <div key={m.id} className="flex flex-col gap-2">
                <EditableCard
                  editLabel={t("common.edit", "Edit")}
                  onEdit={() => mcpModal.open({ id: m.id })}
                >
                  <SelectableCard
                    selected={!!grant}
                    onToggle={() => toggleMcp(m.id)}
                    icon={Plug}
                    title={m.name}
                    badge={
                      !m.enabled ? (
                        <Badge variant="secondary">
                          {t("common.disabled", "Disabled")}
                        </Badge>
                      ) : undefined
                    }
                  />
                </EditableCard>
                {grant && (
                  <div className="ml-6 flex flex-col gap-2 border-border border-l pl-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        loading={discovering === m.id}
                        onClick={() => discoverMcp(m.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {t("editor.tools.discover", "Discover tools")}
                      </Button>
                      {hasTools ? (
                        <button
                          type="button"
                          aria-expanded={!collapsed}
                          onClick={() =>
                            setMcpCollapsed((prev) => ({
                              ...prev,
                              [m.id]: !collapsed,
                            }))
                          }
                          className="flex flex-1 items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-bg-hover"
                        >
                          <ChevronDown
                            className={cn(
                              "h-4 w-4 shrink-0 text-text-muted transition-transform",
                              { "rotate-180": !collapsed },
                            )}
                            aria-hidden="true"
                          />
                          <span className="font-medium text-text-secondary text-xs">
                            {collapsed
                              ? t("editor.tools.mcpExpandList", "Show tools")
                              : t("editor.tools.mcpCollapseList", "Hide tools")}
                          </span>
                          <span className="text-text-muted text-xs">
                            {t("editor.tools.mcpSelected", "{{n}} selected", {
                              n: grant.enabledTools?.length ?? 0,
                            })}
                          </span>
                        </button>
                      ) : (
                        <span className="text-text-muted text-xs">
                          {t("editor.tools.mcpSelected", "{{n}} selected", {
                            n: grant.enabledTools?.length ?? 0,
                          })}
                        </span>
                      )}
                      {hasTools && (
                        <div className="flex items-center gap-3">
                          <button
                            type="button"
                            className="text-accent text-xs hover:underline disabled:no-underline disabled:opacity-50"
                            disabled={
                              (grant.enabledTools?.length ?? 0) === tools.length
                            }
                            onClick={() =>
                              setMcpEnabledTools(
                                m.id,
                                tools.map((tool) => tool.name),
                              )
                            }
                          >
                            {t("editor.tools.selectAll", "Select all")}
                          </button>
                          <button
                            type="button"
                            className="text-accent text-xs hover:underline disabled:no-underline disabled:opacity-50"
                            disabled={(grant.enabledTools?.length ?? 0) === 0}
                            onClick={() => setMcpEnabledTools(m.id, [])}
                          >
                            {t("editor.tools.clear", "Clear")}
                          </button>
                        </div>
                      )}
                    </div>
                    <McpServerInstructions
                      instructions={mcpInstructions[m.id]}
                    />
                    {hasTools && !collapsed && (
                      <div className="flex flex-col gap-2">
                        {tools.map((tool) => (
                          <SelectableCard
                            key={tool.name}
                            selected={(grant.enabledTools ?? []).includes(
                              tool.name,
                            )}
                            onToggle={() => {
                              const cur = new Set(grant.enabledTools ?? []);
                              if (cur.has(tool.name)) cur.delete(tool.name);
                              else cur.add(tool.name);
                              setMcpEnabledTools(m.id, [...cur]);
                            }}
                            title={
                              <span className="font-mono text-xs">
                                {tool.name}
                              </span>
                            }
                            description={
                              <span className="flex flex-col gap-1.5">
                                {tool.description && (
                                  <span>{tool.description}</span>
                                )}
                                <McpToolArgs args={tool.args} />
                              </span>
                            }
                          />
                        ))}
                      </div>
                    )}
                    {(grant.enabledTools?.length ?? 0) === 0 && (
                      <p className="text-warning text-xs">
                        {t(
                          "editor.tools.mcpNoTools",
                          "Select at least one tool, or this server does nothing.",
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Section>

      <Section
        id="tools-integrations"
        icon={Puzzle}
        title={t("editor.tools.integrations", "Integrations")}
        description={t(
          "editor.tools.integrationsDesc",
          "Toolpacks from activated catalog integrations.",
        )}
        action={
          <CreateButton
            label={t("editor.tools.createNew", "New")}
            onClick={() => integrationModal.open({})}
          />
        }
      >
        {catalog.integrationInstances.length === 0 ? (
          <p className="text-text-muted text-xs">
            {t("editor.tools.noIntegrations", "No integrations activated yet.")}
          </p>
        ) : (
          catalog.integrationInstances.map((inst) => {
            const grant = nonRag.find(
              (g) =>
                g.source === "INTEGRATION" &&
                g.integrationInstanceId === inst.id,
            );
            const allTools = inst.tools.map((tool) => tool.name);
            const collapsed = integrationCollapsed[inst.id] ?? true;
            return (
              <div key={inst.id} className="flex flex-col gap-2">
                <EditableCard
                  editLabel={t("common.edit", "Edit")}
                  onEdit={() => integrationModal.open({ id: inst.id })}
                >
                  <SelectableCard
                    selected={!!grant}
                    onToggle={() => toggleIntegration(inst.id, allTools)}
                    icon={integrationIcon(inst.catalogType)}
                    title={inst.name}
                    badge={
                      <Badge variant="info">
                        {kindLabel(inst.kind ?? inst.catalogType)}
                      </Badge>
                    }
                  />
                </EditableCard>
                {grant && inst.tools.length > 0 && (
                  <div className="ml-6 flex flex-col gap-2 border-border border-l pl-3">
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setIntegrationCollapsed((prev) => ({
                          ...prev,
                          [inst.id]: !collapsed,
                        }))
                      }
                      className="flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-bg-hover"
                    >
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 shrink-0 text-text-muted transition-transform",
                          { "rotate-180": !collapsed },
                        )}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-text-secondary text-xs">
                        {collapsed
                          ? t(
                              "editor.tools.integrationExpandList",
                              "Show tools",
                            )
                          : t(
                              "editor.tools.integrationCollapseList",
                              "Hide tools",
                            )}
                      </span>
                      <span className="text-text-muted text-xs">
                        {t("editor.tools.mcpSelected", "{{n}} selected", {
                          n: grant.enabledTools?.length ?? 0,
                        })}
                      </span>
                    </button>
                    {!collapsed &&
                      inst.tools.map((tool) => {
                        const meta = toolpackToolMeta(tool.name, t);
                        return (
                          <SelectableCard
                            key={tool.name}
                            selected={(grant.enabledTools ?? []).includes(
                              tool.name,
                            )}
                            onToggle={() =>
                              toggleIntegrationTool(inst.id, tool.name)
                            }
                            icon={meta.icon}
                            title={meta.label}
                            description={
                              <span className="flex flex-col gap-1.5">
                                {meta.description && (
                                  <span>{meta.description}</span>
                                )}
                                {tool.args.length > 0 && (
                                  <ToolArgPills args={tool.args} />
                                )}
                              </span>
                            }
                          />
                        );
                      })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Section>

      <CollapsibleSection
        id="tools-native"
        icon={Wrench}
        title={t("editor.tools.native", "Native tools")}
        description={t(
          "editor.tools.nativeDesc",
          "Built-in actions the agent can take. Selected tools are available to the agent.",
        )}
        badge={
          <span className="flex items-center gap-1.5 font-normal text-text-muted text-xs">
            {t("editor.tools.nativeActiveCount", "{{count}} active", {
              count: selectedNative.size,
            })}
            {nativeConfigured && (
              <span
                className="h-1.5 w-1.5 rounded-full bg-accent"
                aria-hidden="true"
              />
            )}
          </span>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2">
          {visibleNative
            .filter((n) => n.name !== HANDOFF_TOOL && n.name !== PIX_TOOL)
            .map((n) => {
              const meta = nativeToolMeta(n.name, t);
              return (
                <SelectableCard
                  key={n.name}
                  selected={selectedNative.has(n.name)}
                  onToggle={() => toggleNative(n.name)}
                  icon={meta.icon}
                  title={meta.label}
                  description={meta.description}
                />
              );
            })}
        </div>
        {handoffEntry && (
          <ConfigurableToolCard
            selected={handoffEnabled}
            onToggle={() => toggleNative(HANDOFF_TOOL)}
            icon={nativeToolMeta(HANDOFF_TOOL, t).icon}
            title={nativeToolMeta(HANDOFF_TOOL, t).label}
            description={nativeToolMeta(HANDOFF_TOOL, t).description}
            configured={
              handoff.instructions.trim() !== "" ||
              !transferWithSummary ||
              handoff.whazingQueueId.trim() !== ""
            }
          >
            <SwitchField
              checked={transferWithSummary}
              onCheckedChange={setTransferWithSummary}
              label={t(
                "editor.transferWithSummary",
                "Post a private summary before handing off to a human",
              )}
            />
            <FormField
              label={t("editor.whazingQueueId", "Whazing queue ID")}
              description={t(
                "editor.whazingQueueIdHint",
                "Whazing queue number to route the ticket to after handoff. Find it in your Whazing dashboard (queue list).",
              )}
            >
              <input
                type="number"
                min={1}
                step={1}
                value={handoff.whazingQueueId}
                onChange={(e) =>
                  setHandoff({ ...handoff, whazingQueueId: e.target.value })
                }
                placeholder="ex.: 5"
                className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
            </FormField>
            <FormField
              label={t("editor.handoffInstructions", "Transfer instructions")}
              group
              description={t(
                "editor.handoffInstructionsHint",
                "Optional. Centralizes the transfer logic (when and to whom to escalate). Appended to the handoff tool description the AI reads.",
              )}
            >
              <Textarea
                value={handoff.instructions}
                onChange={(e) =>
                  setHandoff({ ...handoff, instructions: e.target.value })
                }
                rows={3}
                placeholder={t(
                  "editor.handoffInstructionsPlaceholder",
                  "e.g. Only escalate after two failed attempts. Send billing issues to the Finance team.",
                )}
              />
            </FormField>
          </ConfigurableToolCard>
        )}
        {kanbanEntry && (
          <ConfigurableToolCard
            selected={kanbanEnabled}
            onToggle={() => toggleNative(KANBAN_TOOL)}
            icon={nativeToolMeta(KANBAN_TOOL, t).icon}
            title={nativeToolMeta(KANBAN_TOOL, t).label}
            description={nativeToolMeta(KANBAN_TOOL, t).description}
            configured={kanbanInstructions.trim() !== "" || kanbanWhazingBoard != null}
          >
            {/* Whazing Kanban Pro board picker */}
            <FormField
              label={t("editor.kanbanWhazingConnection", "Whazing connection")}
              description={t(
                "editor.kanbanWhazingConnectionHint",
                "Select the Whazing instance to load boards from.",
              )}
            >
              <select
                value={selectedInstanceId}
                onChange={(e) => {
                  setSelectedInstanceId(e.target.value);
                  setKanbanWhazingBoard(null);
                }}
                className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50"
              >
                <option value="">{t("common.select", "Select…")}</option>
                {whazingInstances.map((inst) => (
                  <option key={inst.id} value={inst.id}>
                    {inst.name}
                  </option>
                ))}
              </select>
            </FormField>

            {selectedInstanceId && (
              <FormField
                label={t("editor.kanbanWhazingBoard", "Board")}
                description={t(
                  "editor.kanbanWhazingBoardHint",
                  "Choose the Kanban Pro board this agent operates on. Columns will load automatically.",
                )}
              >
                <select
                  value={kanbanWhazingBoard?.boardId ?? ""}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    const board = boardsList.find((b) => b.id === id);
                    if (board) loadColumnsForBoard(board.id, board.name);
                    else setKanbanWhazingBoard(null);
                  }}
                  disabled={boardsLoading}
                  className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/50 disabled:opacity-50"
                >
                  <option value="">
                    {boardsLoading
                      ? t("common.loading", "Loading…")
                      : t("common.select", "Select…")}
                  </option>
                  {boardsList.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </FormField>
            )}

            {kanbanWhazingBoard && (
              <FormField
                label={t("editor.kanbanWhazingColumns", "Columns")}
                group
                description={t(
                  "editor.kanbanWhazingColumnsHint",
                  "These IDs are injected into the agent's kanban tool description so it knows which columnId to use.",
                )}
              >
                {columnsLoading ? (
                  <p className="text-text-muted text-xs">{t("common.loading", "Loading…")}</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {kanbanWhazingBoard.columns.map((col) => (
                      <div
                        key={col.id}
                        className="flex items-center justify-between rounded-md border border-border bg-bg-tertiary px-3 py-1.5 text-xs"
                      >
                        <span className="text-text-primary">{col.name}</span>
                        <span className="font-mono text-text-muted">ID: {col.id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </FormField>
            )}

            <FormField
              label={t("editor.kanbanInstructions", "Funnel guidance")}
              group
              description={t(
                "editor.kanbanInstructionsHint",
                "Optional. Explains when to move a card between columns. The board and column IDs above are already injected automatically.",
              )}
            >
              <Textarea
                value={kanbanInstructions}
                onChange={(e) => setKanbanInstructions(e.target.value)}
                rows={3}
                placeholder={t(
                  "editor.kanbanInstructionsPlaceholder",
                  'e.g. Move to "Proposta" only after pricing was shared. Move to "Fechado" when customer confirms.',
                )}
              />
            </FormField>
          </ConfigurableToolCard>
        )}
        {updateKanbanEntry && (
          <ConfigurableToolCard
            selected={updateKanbanEnabled}
            onToggle={() => toggleNative(UPDATE_KANBAN_TOOL)}
            icon={nativeToolMeta(UPDATE_KANBAN_TOOL, t).icon}
            title={nativeToolMeta(UPDATE_KANBAN_TOOL, t).label}
            description={nativeToolMeta(UPDATE_KANBAN_TOOL, t).description}
            configured={updateKanbanTaskInstructions.trim() !== ""}
          >
            <FormField
              label={t("editor.updateKanbanInstructions", "Usage guidance")}
              group
              description={t(
                "editor.updateKanbanInstructionsHint",
                "Optional. Explains when and how the agent should edit the card's title, description, priority or dates. The AI already sees the current card values; this adds your rules. Appended to the tool description.",
              )}
            >
              <Textarea
                value={updateKanbanTaskInstructions}
                onChange={(e) =>
                  setUpdateKanbanTaskInstructions(e.target.value)
                }
                rows={3}
                placeholder={t(
                  "editor.updateKanbanInstructionsPlaceholder",
                  "e.g. When the customer confirms a meeting, set the due date; keep the title as the customer's full name.",
                )}
              />
            </FormField>
          </ConfigurableToolCard>
        )}
        {attrEntry && (
          <ConfigurableToolCard
            selected={attrEnabled}
            onToggle={() => toggleNative(ATTR_TOOL)}
            icon={nativeToolMeta(ATTR_TOOL, t).icon}
            title={nativeToolMeta(ATTR_TOOL, t).label}
            description={nativeToolMeta(ATTR_TOOL, t).description}
            configured={customAttributeInstructions.trim() !== ""}
          >
            <FormField
              label={t("editor.attrInstructions", "Usage guidance")}
              group
              description={t(
                "editor.attrInstructionsHint",
                "Optional. Explains which attribute to set on the conversation, the contact, or the kanban card, and when. The AI already sees the defined attributes; this adds your rules. Appended to the tool description.",
              )}
            >
              <Textarea
                value={customAttributeInstructions}
                onChange={(e) => setCustomAttributeInstructions(e.target.value)}
                rows={3}
                placeholder={t(
                  "editor.attrInstructionsPlaceholder",
                  'e.g. Save the qualified budget on the contact as "orcamento"; set "lead_stage" on the card.',
                )}
              />
            </FormField>
          </ConfigurableToolCard>
        )}
        {labelEntry && (
          <ConfigurableToolCard
            selected={labelEnabled}
            onToggle={() => toggleNative(LABEL_TOOL)}
            icon={nativeToolMeta(LABEL_TOOL, t).icon}
            title={nativeToolMeta(LABEL_TOOL, t).label}
            description={nativeToolMeta(LABEL_TOOL, t).description}
            configured={labelInstructions.trim() !== ""}
          >
            <FormField
              label={t("editor.labelInstructions", "Usage guidance")}
              group
              description={t(
                "editor.labelInstructionsHint",
                "Optional. Explains which label to add to the conversation, the contact, or the kanban card, and when. The AI already sees the existing labels; this adds your rules. Appended to the tool description.",
              )}
            >
              <Textarea
                value={labelInstructions}
                onChange={(e) => setLabelInstructions(e.target.value)}
                rows={3}
                placeholder={t(
                  "editor.labelInstructionsPlaceholder",
                  'e.g. Add "vip" to the contact for premium customers; tag the conversation "urgent" when the customer is upset.',
                )}
              />
            </FormField>
          </ConfigurableToolCard>
        )}
        {pixEntry && (
          <ConfigurableToolCard
            selected={pixEnabled}
            onToggle={() => toggleNative(PIX_TOOL)}
            icon={nativeToolMeta(PIX_TOOL, t).icon}
            title={nativeToolMeta(PIX_TOOL, t).label}
            description={nativeToolMeta(PIX_TOOL, t).description}
            configured={whazingPix != null}
          >
            <p className="text-text-muted text-xs">
              {t(
                "editor.pixHint",
                "Used by both 'Send PIX key' and 'Request payment'. The AI never chooses or types this key — only what's configured here is ever sent.",
              )}
            </p>
            <FormField label={t("editor.pixKey", "PIX key")}>
              <input
                type="text"
                value={whazingPix?.pixKey ?? ""}
                onChange={(e) =>
                  setWhazingPix({
                    pixKey: e.target.value,
                    pixName: whazingPix?.pixName ?? "",
                    pixType: whazingPix?.pixType ?? "CNPJ",
                  })
                }
                placeholder={t("editor.pixKeyPlaceholder", "ex.: 11.071.697/0001-08")}
                className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
            </FormField>
            <FormField label={t("editor.pixName", "Recipient name")}>
              <input
                type="text"
                value={whazingPix?.pixName ?? ""}
                onChange={(e) =>
                  setWhazingPix({
                    pixKey: whazingPix?.pixKey ?? "",
                    pixName: e.target.value,
                    pixType: whazingPix?.pixType ?? "CNPJ",
                  })
                }
                placeholder={t("editor.pixNamePlaceholder", "ex.: Empresa Ltda")}
                className="w-full rounded-lg border border-border bg-bg-secondary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/50"
              />
            </FormField>
            <FormField label={t("editor.pixType", "Key type")}>
              <Select
                value={whazingPix?.pixType ?? "CNPJ"}
                onChange={(e) =>
                  setWhazingPix({
                    pixKey: whazingPix?.pixKey ?? "",
                    pixName: whazingPix?.pixName ?? "",
                    pixType: e.target.value as WhazingPixUiState["pixType"],
                  })
                }
              >
                <option value="CPF">CPF</option>
                <option value="CNPJ">CNPJ</option>
                <option value="PHONE">{t("editor.pixTypePhone", "Telefone")}</option>
                <option value="EMAIL">{t("editor.pixTypeEmail", "E-mail")}</option>
                <option value="EVP">{t("editor.pixTypeEvp", "Chave aleatória")}</option>
              </Select>
            </FormField>
          </ConfigurableToolCard>
        )}
        <p className="text-text-muted text-xs">
          {t(
            "editor.tools.nativeContextNote",
            "The conversation and contact are provided automatically — the AI only decides to use a tool and fills its specific arguments.",
          )}
        </p>
        {selectedNative.size === 0 && (
          <p className="text-text-muted text-xs">
            {t(
              "editor.tools.noNativeSelected",
              "No native tools selected — the agent can only chat.",
            )}
          </p>
        )}
      </CollapsibleSection>

      <ToolEditModal modal={toolModal} sharedNotice onSaved={onToolSaved} />
      <McpEditModal modal={mcpModal} sharedNotice onSaved={onMcpSaved} />
      <IntegrationEditModal
        modal={integrationModal}
        sharedNotice
        onSaved={onIntegrationSaved}
      />
    </div>
  );
}
