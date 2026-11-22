import { Loader2, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  Switch,
  useModalController,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";

type InstancesData = Awaited<
  ReturnType<typeof api.api.v1.whazing.instances.get>
>["data"];
type Instance = NonNullable<InstancesData>["instances"][number];

type InboxesData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.whazing.instances>["inboxes"]["get"]>
>["data"];
type Inbox = NonNullable<InboxesData>["inboxes"][number];

type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
type AgentLite = NonNullable<AgentsData>["agents"][number];

// Agent editor "Channels" tab, Whazing side — mirrors ChannelsTab.tsx (which does the same thing
// for Chatwoot) but binds/unbinds THIS agent to Whazing QUEUES instead of Chatwoot inboxes. Acts
// immediately (no Save button), same as ChannelsTab: binding has a side effect (routes future
// messages on that queue to this agent) that the operator expects to take effect right away.
export function WhazingChannelsTab({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const confirm = useModalController<ConfirmPayload>();

  const [instances, setInstances] = useState<Instance[]>([]);
  const [inboxesByInstance, setInboxesByInstance] = useState<
    Record<string, Inbox[]>
  >({});
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [inst, ag] = await Promise.all([
        api.api.v1.whazing.instances.get(),
        api.api.v1.agents.get({ query: { pageSize: 100 } }),
      ]);
      if (inst.error || !inst.data) {
        setError(true);
        return;
      }
      const activeInstances = inst.data.instances.filter(
        (i) => i.disconnectedAt === null,
      );
      setInstances(activeInstances);
      if (ag.data) setAgents([...ag.data.agents]);
      const results = await Promise.all(
        activeInstances.map((i) =>
          api.api.v1.whazing.instances({ id: i.id }).inboxes.get(),
        ),
      );
      const byInstance: Record<string, Inbox[]> = {};
      results.forEach((r, idx) => {
        const inst = activeInstances[idx];
        if (inst && r.data) byInstance[inst.id] = [...r.data.inboxes];
      });
      setInboxesByInstance(byInstance);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function setBinding(inbox: Inbox, nextAgentId: string | null) {
    setPending(inbox.id);
    try {
      const { error: err } = await api.api.v1.whazing
        .instances({ id: inbox.instanceId })
        .inboxes({ inboxId: inbox.id })
        .put({ agentId: nextAgentId });
      if (err) throw err;
      setInboxesByInstance((prev) => ({
        ...prev,
        [inbox.instanceId]: (prev[inbox.instanceId] ?? []).map((ib) =>
          ib.id === inbox.id ? { ...ib, agentId: nextAgentId } : ib,
        ),
      }));
      showToast(t("whazing.bound", "Queue updated."), "success");
    } catch {
      showToast(
        t("whazing.bindError", "Could not update the queue agent."),
        "error",
      );
    } finally {
      setPending(null);
    }
  }

  function onToggle(inbox: Inbox, next: boolean) {
    if (!next) {
      void setBinding(inbox, null);
      return;
    }
    if (inbox.agentId !== null && inbox.agentId !== agentId) {
      const owner =
        agents.find((a) => a.id === inbox.agentId)?.name ??
        t("editor.channels.otherAgent", "another agent");
      confirm.open({
        title: t("editor.channels.reassignTitle", "Reassign inbox"),
        message: t(
          "editor.channels.reassignBody",
          '"{{inbox}}" is currently answered by "{{owner}}". Reassign it to "{{agent}}"?',
          {
            inbox:
              inbox.name ??
              inbox.whazingQueueId ??
              t("whazing.catchAll", "Catch-all queue"),
            owner,
            agent: agentName,
          },
        ),
        confirmLabel: t("editor.channels.reassignConfirm", "Reassign"),
        onConfirm: () => setBinding(inbox, agentId),
      });
      return;
    }
    void setBinding(inbox, agentId);
  }

  const groups = instances
    .map((inst) => ({ inst, items: inboxesByInstance[inst.id] ?? [] }))
    .filter((g) => g.items.length > 0);
  const showInstanceHeaders = groups.length > 1;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-medium text-text-primary">
          <MessageSquare className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("editor.whazingChannels.title", "Queues")}
        </h2>
        <p className="mt-0.5 text-text-muted text-xs">
          {t(
            "editor.whazingChannels.desc",
            "Connect this agent to the Whazing queues it should answer. Changes apply immediately.",
          )}
        </p>
      </div>

      <DataBoundary loading={loading} error={error} onRetry={load}>
        {instances.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={MessageSquare}
              title={t(
                "editor.whazingChannels.noInstance",
                "No Whazing connected",
              )}
              description={t(
                "editor.whazingChannels.noInstanceDesc",
                "Connect a Whazing instance under Whazing, then come back to bind this agent to its queues.",
              )}
              action={
                <Button onClick={() => navigate("/channels?tab=whazing")}>
                  {t("editor.whazingChannels.goToWhazing", "Go to Whazing")}
                </Button>
              }
            />
          </Card>
        ) : groups.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={MessageSquare}
              title={t("editor.channels.empty", "No inboxes available")}
              description={t(
                "editor.whazingChannels.emptyDesc",
                "Add a queue to a Whazing instance first.",
              )}
            />
          </Card>
        ) : (
          groups.map(({ inst, items }) => (
            <div key={inst.id} className="flex flex-col gap-1.5">
              {showInstanceHeaders && (
                <div className="flex items-center gap-1.5 px-1 text-text-muted text-xs">
                  <MessageSquare
                    className="h-3.5 w-3.5 shrink-0"
                    aria-hidden="true"
                  />
                  <span className="truncate">{inst.name}</span>
                </div>
              )}
              <Card className="p-0">
                <ul>
                  {items.map((ib) => {
                    const mine = ib.agentId === agentId;
                    const otherOwner =
                      ib.agentId !== null && ib.agentId !== agentId
                        ? (agents.find((a) => a.id === ib.agentId)?.name ??
                          t("editor.channels.otherAgent", "another agent"))
                        : null;
                    return (
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
                          {otherOwner && (
                            <span className="text-text-muted text-xs">
                              {t(
                                "editor.channels.ownedBy",
                                "Answered by {{name}}",
                                {
                                  name: otherOwner,
                                },
                              )}
                            </span>
                          )}
                          {pending === ib.id ? (
                            <Loader2
                              className="h-5 w-5 animate-spin text-text-muted"
                              aria-hidden="true"
                            />
                          ) : (
                            <Switch
                              checked={mine}
                              onCheckedChange={(next) => onToggle(ib, next)}
                              aria-label={t(
                                "editor.channels.toggleAria",
                                "Answer {{inbox}} with this agent",
                                { inbox: ib.name ?? ib.whazingQueueId ?? "" },
                              )}
                            />
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          ))
        )}
      </DataBoundary>

      <ConfirmDialog modal={confirm} />
    </div>
  );
}
