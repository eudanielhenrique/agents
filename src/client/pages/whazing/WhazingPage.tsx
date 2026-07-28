import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RadioTower,
  Trash2,
  Unplug,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  DataBoundary,
  EmptyState,
  FormField,
  Input,
  Modal,
  PageContainer,
  Skeleton,
  Tooltip,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";
import { isValidHttpUrl } from "@/client/lib/validation";

// ── Types ─────────────────────────────────────────────────────────────────────

type InstancesData = Awaited<
  ReturnType<typeof api.api.v1.whazing.instances.get>
>["data"];
type WhazingInstance = NonNullable<InstancesData>["instances"][number];

type InboxesData = Awaited<
  ReturnType<
    ReturnType<typeof api.api.v1.whazing.instances>["inboxes"]["get"]
  >
>["data"];
type WhazingInbox = NonNullable<InboxesData>["inboxes"][number];

type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
type AgentLite = NonNullable<AgentsData>["agents"][number];

// ── Skeleton ──────────────────────────────────────────────────────────────────

const SKEL_KEYS = ["w0", "w1"];

function WhazingSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true">
      {SKEL_KEYS.map((k) => (
        <Card key={k} className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-3 w-64" />
          </div>
          <div className="flex gap-1">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-8" />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Agent picker for inboxes ──────────────────────────────────────────────────

const pickerItemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary";

function InboxAgentPicker({
  value,
  agents,
  onChange,
  label,
}: {
  value: string | null;
  agents: AgentLite[];
  onChange: (agentId: string | null) => Promise<void>;
  label: string;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const current = agents.find((a) => a.id === value) ?? null;

  async function select(next: string | null) {
    if (next === value) return;
    setPending(true);
    try {
      await onChange(next);
    } catch {
      // toast handled by caller; value stays unchanged on failure
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={pending}
          aria-label={label}
          className="flex w-52 shrink-0 items-center justify-between gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none disabled:opacity-60"
        >
          <span className={cn("truncate", { "text-text-muted": !current })}>
            {current ? current.name : t("whazing.noAgent", "No agent")}
          </span>
          {pending ? (
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-text-muted"
              aria-hidden="true"
            />
          ) : (
            <ChevronDown
              className="h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
          )}
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 max-h-72 w-52 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg"
        >
          <DropdownMenuPrimitive.Item
            className={pickerItemCls}
            onSelect={() => void select(null)}
          >
            <span className="flex-1 truncate">
              {t("whazing.noAgent", "No agent")}
            </span>
            {value === null && (
              <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
            )}
          </DropdownMenuPrimitive.Item>
          {agents.map((a) => (
            <DropdownMenuPrimitive.Item
              key={a.id}
              className={pickerItemCls}
              onSelect={() => void select(a.id)}
            >
              <span className="flex-1 truncate">{a.name}</span>
              {value === a.id && (
                <Check className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              )}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

// ── Webhook URL copy button ───────────────────────────────────────────────────

function WebhookUrlCopy({ url }: { url: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex items-center gap-1.5 overflow-hidden rounded-lg border border-border bg-bg-tertiary px-3 py-2">
      <code className="flex-1 truncate font-mono text-xs text-text-secondary">
        {url}
      </code>
      <Tooltip
        content={copied ? t("common.copied", "Copied!") : t("common.copy", "Copy")}
      >
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={t("whazing.copyWebhookUrl", "Copy webhook URL")}
          className="shrink-0 rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </Tooltip>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function WhazingPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();

  const [instances, setInstances] = useState<WhazingInstance[]>([]);
  const [inboxesByInstance, setInboxesByInstance] = useState<
    Record<string, WhazingInbox[]>
  >({});
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Modals
  const createModal = useModalController();
  const editModal = useModalController<WhazingInstance>();
  const addInboxModal = useModalController<{ instanceId: string }>();
  const editInboxModal = useModalController<WhazingInbox>();

  // Create form
  const [createName, setCreateName] = useState("");
  const [createBaseUrl, setCreateBaseUrl] = useState("");
  const [createApiKey, setCreateApiKey] = useState("");
  const [creating, setCreating] = useState(false);

  // Edit form
  const [editName, setEditName] = useState("");
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [saving, setSaving] = useState(false);

  // Inbox form
  const [inboxQueueId, setInboxQueueId] = useState("");
  const [inboxName, setInboxName] = useState("");
  const [savingInbox, setSavingInbox] = useState(false);

  const loadInboxes = useCallback(async (ids: string[]) => {
    const results = await Promise.allSettled(
      ids.map((id) =>
        api.api.v1.whazing.instances({ id }).inboxes.get(),
      ),
    );
    const next: Record<string, WhazingInbox[]> = {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as string;
      const r = results[i];
      if (r.status === "fulfilled" && r.value.data) {
        next[id] = r.value.data.inboxes;
      }
    }
    setInboxesByInstance((prev) => ({ ...prev, ...next }));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [inst, ag] = await Promise.all([
        api.api.v1.whazing.instances.get(),
        api.api.v1.agents.get(),
      ]);
      if (inst.error || !inst.data) {
        setError(true);
        return;
      }
      setInstances([...inst.data.instances]);
      if (ag.data) setAgents([...ag.data.agents]);
      await loadInboxes(inst.data.instances.map((i) => i.id));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [loadInboxes]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Create instance ───────────────────────────────────────────────────────

  function openCreate() {
    setCreateName("");
    setCreateBaseUrl("");
    setCreateApiKey("");
    createModal.open();
  }

  async function submitCreate() {
    if (!createName.trim() || !createBaseUrl.trim() || !createApiKey.trim())
      return;
    setCreating(true);
    try {
      const { data, error: err } = await api.api.v1.whazing.instances.post({
        name: createName.trim(),
        baseUrl: createBaseUrl.trim(),
        apiKey: createApiKey.trim(),
      });
      if (err || !data) throw err ?? new Error("no data");
      showToast(t("whazing.created", "Instance created."), "success");
      createModal.close();
      await load();
    } catch {
      showToast(
        t("whazing.createError", "Could not create the instance."),
        "error",
      );
    } finally {
      setCreating(false);
    }
  }

  // ── Edit instance ─────────────────────────────────────────────────────────

  function openEdit(inst: WhazingInstance) {
    setEditName(inst.name);
    setEditBaseUrl(inst.baseUrl);
    setEditApiKey("");
    editModal.open(inst);
  }

  async function submitEdit() {
    const inst = editModal.payload;
    if (!inst) return;
    setSaving(true);
    try {
      const body: { name?: string; baseUrl?: string; apiKey?: string } = {};
      if (editName.trim() !== inst.name) body.name = editName.trim();
      if (editBaseUrl.trim() !== inst.baseUrl)
        body.baseUrl = editBaseUrl.trim();
      if (editApiKey.trim()) body.apiKey = editApiKey.trim();

      const { error: err } = await api.api.v1.whazing
        .instances({ id: inst.id })
        .put(body);
      if (err) throw err;
      showToast(t("whazing.saved", "Instance updated."), "success");
      editModal.close();
      await load();
    } catch {
      showToast(
        t("whazing.saveError", "Could not update the instance."),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  // ── Disconnect instance ───────────────────────────────────────────────────

  async function disconnect(inst: WhazingInstance) {
    try {
      const { error: err } = await api.api.v1.whazing
        .instances({ id: inst.id })
        .delete();
      if (err) throw err;
      showToast(t("whazing.disconnected", "Instance disconnected."), "success");
      await load();
    } catch {
      showToast(
        t("whazing.disconnectError", "Could not disconnect."),
        "error",
      );
    }
  }

  // ── Reconnect instance ────────────────────────────────────────────────────

  async function reconnect(inst: WhazingInstance) {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: Eden Treaty type regenerates after build
      const res = await (api.api.v1.whazing.instances({ id: inst.id }) as any)
        .reconnect.post();
      if (res.error) throw res.error;
      showToast(t("whazing.reconnected", "Instance reconnected."), "success");
      await load();
    } catch {
      showToast(
        t("whazing.reconnectError", "Could not reconnect."),
        "error",
      );
    }
  }

  // ── Add inbox ─────────────────────────────────────────────────────────────

  function openAddInbox(instanceId: string) {
    setInboxQueueId("");
    setInboxName("");
    addInboxModal.open({ instanceId });
  }

  async function submitAddInbox() {
    const payload = addInboxModal.payload;
    if (!payload) return;
    setSavingInbox(true);
    try {
      const { error: err } = await api.api.v1.whazing
        .instances({ id: payload.instanceId })
        .inboxes.post({
          whazingQueueId: inboxQueueId.trim() || null,
          name: inboxName.trim() || null,
          agentId: null,
        });
      if (err) throw err;
      showToast(t("whazing.inboxAdded", "Queue added."), "success");
      addInboxModal.close();
      await loadInboxes([payload.instanceId]);
    } catch {
      showToast(
        t("whazing.inboxAddError", "Could not add the queue."),
        "error",
      );
    } finally {
      setSavingInbox(false);
    }
  }

  // ── Edit inbox ────────────────────────────────────────────────────────────

  function openEditInbox(inbox: WhazingInbox) {
    setInboxQueueId(inbox.whazingQueueId ?? "");
    setInboxName(inbox.name ?? "");
    editInboxModal.open(inbox);
  }

  async function submitEditInbox() {
    const inbox = editInboxModal.payload;
    if (!inbox) return;
    setSavingInbox(true);
    try {
      const { error: err } = await api.api.v1.whazing
        .instances({ id: inbox.instanceId })
        .inboxes({ inboxId: inbox.id })
        .put({
          whazingQueueId: inboxQueueId.trim() || null,
          name: inboxName.trim() || null,
        });
      if (err) throw err;
      showToast(t("whazing.inboxSaved", "Queue updated."), "success");
      editInboxModal.close();
      await loadInboxes([inbox.instanceId]);
    } catch {
      showToast(
        t("whazing.inboxSaveError", "Could not update the queue."),
        "error",
      );
    } finally {
      setSavingInbox(false);
    }
  }

  // ── Bind inbox agent ──────────────────────────────────────────────────────

  async function bindAgent(inbox: WhazingInbox, agentId: string | null) {
    const { error: err } = await api.api.v1.whazing
      .instances({ id: inbox.instanceId })
      .inboxes({ inboxId: inbox.id })
      .put({ agentId });
    if (err) {
      showToast(
        t("whazing.bindError", "Could not update the queue agent."),
        "error",
      );
      throw err;
    }
    setInboxesByInstance((prev) => ({
      ...prev,
      [inbox.instanceId]: (prev[inbox.instanceId] ?? []).map((ib) =>
        ib.id === inbox.id ? { ...ib, agentId } : ib,
      ),
    }));
    showToast(t("whazing.bound", "Queue updated."), "success");
  }

  // ── Delete inbox ──────────────────────────────────────────────────────────

  async function deleteInbox(inbox: WhazingInbox) {
    try {
      const { error: err } = await api.api.v1.whazing
        .instances({ id: inbox.instanceId })
        .inboxes({ inboxId: inbox.id })
        .delete();
      if (err) throw err;
      showToast(t("whazing.inboxDeleted", "Queue removed."), "success");
      setInboxesByInstance((prev) => ({
        ...prev,
        [inbox.instanceId]: (prev[inbox.instanceId] ?? []).filter(
          (ib) => ib.id !== inbox.id,
        ),
      }));
    } catch {
      showToast(
        t("whazing.inboxDeleteError", "Could not remove the queue."),
        "error",
      );
    }
  }

  // ── Form validation ───────────────────────────────────────────────────────

  const createUrlInvalid =
    createBaseUrl.trim() !== "" && !isValidHttpUrl(createBaseUrl);
  const editUrlInvalid =
    editBaseUrl.trim() !== "" && !isValidHttpUrl(editBaseUrl);

  const createDirty =
    createName.trim() !== "" ||
    createBaseUrl.trim() !== "" ||
    createApiKey.trim() !== "";

  const editPayload = editModal.payload;
  const editDirty =
    editName !== (editPayload?.name ?? "") ||
    editBaseUrl !== (editPayload?.baseUrl ?? "") ||
    editApiKey.trim() !== "";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <RadioTower className="h-6 w-6 text-accent" aria-hidden="true" />
          <div>
            <h1 className="font-semibold text-text-primary text-xl">
              {t("whazing.title", "Whazing")}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "whazing.subtitle",
                "Connect Whazing instances and route queues to agents.",
              )}
            </p>
          </div>
        </div>
        <Button onClick={openCreate}>
          <Plus className="h-4 w-4" aria-hidden="true" />
          {t("whazing.addInstance", "Add instance")}
        </Button>
      </header>

      <DataBoundary
        loading={loading}
        error={error}
        onRetry={load}
        skeleton={<WhazingSkeleton />}
      >
        {instances.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={RadioTower}
              title={t("whazing.noInstances", "No Whazing instances")}
              description={t(
                "whazing.noInstancesDesc",
                "Add a Whazing instance to start routing queues to agents. You will receive a webhook URL to paste into the Whazing dashboard.",
              )}
              action={
                <Button onClick={openCreate}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t("whazing.addInstance", "Add instance")}
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-6">
            {instances.map((inst) => {
              const inboxes = inboxesByInstance[inst.id] ?? [];
              const disconnected = inst.disconnectedAt !== null;
              return (
                <Card key={inst.id} className="overflow-hidden p-0">
                  {/* Instance header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-border border-b bg-bg-tertiary/40 px-4 py-3">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-text-primary">
                          {inst.name}
                        </span>
                        {disconnected && (
                          <Badge variant="warning">
                            {t("whazing.disconnectedBadge", "Disconnected")}
                          </Badge>
                        )}
                      </div>
                      <a
                        href={inst.baseUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-text-muted text-xs transition-colors hover:text-text-primary"
                      >
                        {inst.baseUrl}
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => openAddInbox(inst.id)}
                        disabled={disconnected}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {t("whazing.addQueue", "Add queue")}
                      </Button>
                      <Tooltip content={t("whazing.editInstance", "Edit instance")}>
                        <button
                          type="button"
                          onClick={() => openEdit(inst)}
                          aria-label={t("whazing.editInstance", "Edit instance")}
                          className="inline-flex shrink-0 items-center justify-center rounded p-1.5 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </button>
                      </Tooltip>
                      {disconnected ? (
                        <Tooltip content={t("whazing.reconnect", "Reconnect instance")}>
                          <button
                            type="button"
                            onClick={() => void reconnect(inst)}
                            aria-label={t("whazing.reconnect", "Reconnect instance")}
                            className="inline-flex shrink-0 items-center justify-center rounded p-1.5 text-text-muted transition-colors hover:bg-success/10 hover:text-success"
                          >
                            <PlugZap className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </Tooltip>
                      ) : (
                        <Tooltip content={t("whazing.disconnect", "Disconnect instance")}>
                          <button
                            type="button"
                            onClick={() => void disconnect(inst)}
                            aria-label={t("whazing.disconnect", "Disconnect instance")}
                            className="inline-flex shrink-0 items-center justify-center rounded p-1.5 text-text-muted transition-colors hover:bg-error/10 hover:text-error"
                          >
                            <Unplug className="h-4 w-4" aria-hidden="true" />
                          </button>
                        </Tooltip>
                      )}
                    </div>
                  </div>

                  {/* Webhook URL */}
                  <div className="border-border border-b px-4 py-3">
                    <p className="mb-1.5 text-text-muted text-xs">
                      {t("whazing.webhookUrlLabel", "Webhook URL — paste in your Whazing dashboard")}
                    </p>
                    <WebhookUrlCopy url={inst.webhookUrl} />
                  </div>

                  {/* Queues / inboxes */}
                  {inboxes.length === 0 ? (
                    <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
                      <p className="text-sm text-text-muted">
                        {t(
                          "whazing.noQueues",
                          "No queues mapped yet. Add a queue to route messages to an agent.",
                        )}
                      </p>
                      {!disconnected && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => openAddInbox(inst.id)}
                        >
                          <Plus className="h-4 w-4" aria-hidden="true" />
                          {t("whazing.addQueue", "Add queue")}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <ul>
                      {inboxes.map((ib) => (
                        <li
                          key={ib.id}
                          className="flex items-center justify-between gap-3 border-border border-b px-4 py-3 last:border-b-0"
                        >
                          <div className="flex min-w-0 flex-col gap-0.5">
                            {ib.name && (
                              <span className="font-medium text-sm text-text-primary">
                                {ib.name}
                              </span>
                            )}
                            <span className="font-mono text-text-muted text-xs">
                              {ib.whazingQueueId
                                ? `Queue: ${ib.whazingQueueId}`
                                : t("whazing.catchAll", "Catch-all queue")}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            {disconnected ? (
                              <span className="shrink-0 text-text-muted text-xs">
                                {t("whazing.instanceDisconnected", "Instance disconnected")}
                              </span>
                            ) : (
                              <InboxAgentPicker
                                value={ib.agentId}
                                agents={agents}
                                label={t("whazing.answeringAgent", "Answering agent")}
                                onChange={(agentId) => bindAgent(ib, agentId)}
                              />
                            )}
                            <Tooltip content={t("whazing.editQueue", "Edit queue")}>
                              <button
                                type="button"
                                onClick={() => openEditInbox(ib)}
                                aria-label={t("whazing.editQueue", "Edit queue")}
                                className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                              >
                                <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </Tooltip>
                            <Tooltip content={t("whazing.deleteQueue", "Delete queue")}>
                              <button
                                type="button"
                                onClick={() => void deleteInbox(ib)}
                                aria-label={t("whazing.deleteQueue", "Delete queue")}
                                className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-error/10 hover:text-error"
                              >
                                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              </button>
                            </Tooltip>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </DataBoundary>

      {/* ── Create modal ─────────────────────────────────────────────────── */}
      <Modal
        modal={createModal}
        unsavedChanges={createDirty}
        title={t("whazing.createTitle", "Add Whazing instance")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => createModal.close()}
              disabled={creating}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={() => void submitCreate()}
              loading={creating}
              disabled={
                !createName.trim() ||
                !createBaseUrl.trim() ||
                createUrlInvalid ||
                !createApiKey.trim()
              }
            >
              {t("common.add", "Add")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            {t(
              "whazing.createDesc",
              "Enter the Whazing API details. You will receive a webhook URL to paste into the Whazing dashboard.",
            )}
          </p>
          <FormField label={t("whazing.instanceName", "Name")} required>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t("whazing.instanceNamePlaceholder", "My Whazing")}
            />
          </FormField>
          <FormField
            label={t("whazing.baseUrl", "Base URL")}
            required
            error={
              createUrlInvalid
                ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                : null
            }
          >
            <Input
              value={createBaseUrl}
              onChange={(e) => setCreateBaseUrl(e.target.value)}
              placeholder="https://api.whazing.com"
            />
          </FormField>
          <FormField
            label={t("whazing.apiKey", "API key")}
            required
            description={t(
              "whazing.apiKeyHint",
              "Stored encrypted, never shown again.",
            )}
          >
            <Input
              type="password"
              showPasswordToggle
              value={createApiKey}
              onChange={(e) => setCreateApiKey(e.target.value)}
            />
          </FormField>
        </div>
      </Modal>

      {/* ── Edit modal ───────────────────────────────────────────────────── */}
      <Modal
        modal={editModal}
        unsavedChanges={editDirty}
        title={t("whazing.editTitle", "Edit instance")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => editModal.close()}
              disabled={saving}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={() => void submitEdit()}
              loading={saving}
              disabled={
                !editName.trim() ||
                !editBaseUrl.trim() ||
                editUrlInvalid
              }
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label={t("whazing.instanceName", "Name")} required>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
          </FormField>
          <FormField
            label={t("whazing.baseUrl", "Base URL")}
            required
            error={
              editUrlInvalid
                ? t("common.invalidUrl", "Must be a valid http(s) URL.")
                : null
            }
          >
            <Input
              value={editBaseUrl}
              onChange={(e) => setEditBaseUrl(e.target.value)}
            />
          </FormField>
          <FormField
            label={t("whazing.apiKey", "API key")}
            description={t(
              "whazing.apiKeyEditHint",
              "Leave blank to keep the current key.",
            )}
          >
            <Input
              type="password"
              showPasswordToggle
              value={editApiKey}
              onChange={(e) => setEditApiKey(e.target.value)}
              placeholder={t("whazing.apiKeyPlaceholder", "••••••••")}
            />
          </FormField>
        </div>
      </Modal>

      {/* ── Add inbox modal ──────────────────────────────────────────────── */}
      <Modal
        modal={addInboxModal}
        title={t("whazing.addQueueTitle", "Add queue")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => addInboxModal.close()}
              disabled={savingInbox}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={() => void submitAddInbox()}
              loading={savingInbox}
            >
              {t("common.add", "Add")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            {t(
              "whazing.addQueueDesc",
              "Map a Whazing queue ID to an agent. Leave Queue ID blank to create a catch-all that handles any queue not explicitly mapped.",
            )}
          </p>
          <FormField
            label={t("whazing.queueId", "Queue ID")}
            description={t(
              "whazing.queueIdHint",
              "The Whazing queue identifier. Leave blank for a catch-all.",
            )}
          >
            <Input
              value={inboxQueueId}
              onChange={(e) => setInboxQueueId(e.target.value)}
              placeholder="queue_123"
            />
          </FormField>
          <FormField
            label={t("whazing.queueName", "Display name")}
            description={t("whazing.queueNameHint", "Optional label for this queue.")}
          >
            <Input
              value={inboxName}
              onChange={(e) => setInboxName(e.target.value)}
              placeholder={t("whazing.queueNamePlaceholder", "Support")}
            />
          </FormField>
        </div>
      </Modal>

      {/* ── Edit inbox modal ─────────────────────────────────────────────── */}
      <Modal
        modal={editInboxModal}
        title={t("whazing.editQueueTitle", "Edit queue")}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => editInboxModal.close()}
              disabled={savingInbox}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              onClick={() => void submitEditInbox()}
              loading={savingInbox}
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label={t("whazing.queueId", "Queue ID")}>
            <Input
              value={inboxQueueId}
              onChange={(e) => setInboxQueueId(e.target.value)}
              placeholder="queue_123"
            />
          </FormField>
          <FormField label={t("whazing.queueName", "Display name")}>
            <Input
              value={inboxName}
              onChange={(e) => setInboxName(e.target.value)}
            />
          </FormField>
        </div>
      </Modal>
    </PageContainer>
  );
}
