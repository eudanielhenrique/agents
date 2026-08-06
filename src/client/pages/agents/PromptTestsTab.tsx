import {
  CheckCircle2,
  ListChecks,
  Pencil,
  Play,
  Plus,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  FormField,
  Input,
  Modal,
  type ModalController,
  Skeleton,
  Textarea,
  useModalController,
  useOnModalOpen,
  useToast,
} from "@/client/components";
import { api } from "@/client/lib/api";

// Agent editor "Tests" tab: single-turn prompt regression scenarios (a fixed user message +
// assertions) replayed via the playground turn path, so a prompt edit can be checked for
// regressions before publishing. "Run all" always tests the CURRENT editor systemPrompt state
// (saved or not) — the same live value GeneralTab saves — so it catches an in-progress edit
// before the operator even clicks Save. Results are ephemeral (not persisted): re-running clears
// the previous pass/fail state.

type TestCasesData = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.agents>["prompt-tests"]["get"]>
>["data"];
type TestCaseRow = NonNullable<TestCasesData>["testCases"][number];

type RunData = Awaited<
  ReturnType<
    ReturnType<typeof api.api.v1.agents>["prompt-tests"]["run"]["post"]
  >
>["data"];
type TestResultRow = NonNullable<RunData>["results"][number];

const SKELETON_KEYS = ["pt-0", "pt-1", "pt-2"];

function toCsv(arr: readonly string[] | undefined): string {
  return (arr ?? []).join(", ");
}

function fromCsv(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

interface TestCaseFormState {
  name: string;
  userMessage: string;
  mustContain: string;
  mustNotContain: string;
  mustCallTool: string;
  mustNotCallTool: string;
}

const EMPTY_FORM: TestCaseFormState = {
  name: "",
  userMessage: "",
  mustContain: "",
  mustNotContain: "",
  mustCallTool: "",
  mustNotCallTool: "",
};

function TestCaseModal({
  modal,
  agentId,
  onSaved,
}: {
  modal: ModalController<TestCaseRow | null>;
  agentId: string;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [form, setForm] = useState<TestCaseFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const editing = modal.payload;

  useOnModalOpen(modal, () => {
    setForm(
      editing
        ? {
            name: editing.name,
            userMessage: editing.userMessage,
            mustContain: toCsv(editing.assertions.mustContain),
            mustNotContain: toCsv(editing.assertions.mustNotContain),
            mustCallTool: toCsv(editing.assertions.mustCallTool),
            mustNotCallTool: toCsv(editing.assertions.mustNotCallTool),
          }
        : EMPTY_FORM,
    );
  });

  async function handleSubmit() {
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        userMessage: form.userMessage,
        assertions: {
          mustContain: fromCsv(form.mustContain),
          mustNotContain: fromCsv(form.mustNotContain),
          mustCallTool: fromCsv(form.mustCallTool),
          mustNotCallTool: fromCsv(form.mustNotCallTool),
        },
      };
      const { error } = editing
        ? await api.api.v1
            .agents({ id: agentId })
            ["prompt-tests"]({ testId: editing.id })
            .patch(body)
        : await api.api.v1.agents({ id: agentId })["prompt-tests"].post(body);
      if (error) {
        showToast(
          t("promptTests.saveError", "Could not save the test case."),
          "error",
        );
        return;
      }
      onSaved();
      modal.close();
    } finally {
      setSaving(false);
    }
  }

  const isDirty =
    form.name.trim() !== "" ||
    form.userMessage.trim() !== "" ||
    form.mustContain !== "" ||
    form.mustNotContain !== "";

  return (
    <Modal
      modal={modal}
      title={
        editing
          ? t("promptTests.editTitle", "Edit test case")
          : t("promptTests.addTitle", "New test case")
      }
      size="md"
      unsavedChanges={isDirty}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!saving) void handleSubmit();
        }}
      >
        <FormField label={t("promptTests.name", "Name")}>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            disabled={saving}
            placeholder={t(
              "promptTests.namePlaceholder",
              "e.g. Convênio question",
            )}
          />
        </FormField>
        <FormField label={t("promptTests.userMessage", "User message")}>
          <Textarea
            value={form.userMessage}
            onChange={(e) => setForm({ ...form, userMessage: e.target.value })}
            rows={2}
            required
            disabled={saving}
          />
        </FormField>
        <FormField label={t("promptTests.mustContain", "Reply must contain")}>
          <Input
            value={form.mustContain}
            onChange={(e) => setForm({ ...form, mustContain: e.target.value })}
            disabled={saving}
            placeholder={t(
              "promptTests.csvPlaceholder",
              "comma-separated, e.g. particular, Barra de São Francisco",
            )}
          />
        </FormField>
        <FormField
          label={t("promptTests.mustNotContain", "Reply must NOT contain")}
        >
          <Input
            value={form.mustNotContain}
            onChange={(e) =>
              setForm({ ...form, mustNotContain: e.target.value })
            }
            disabled={saving}
            placeholder={t(
              "promptTests.csvPlaceholder",
              "comma-separated, e.g. particular, Barra de São Francisco",
            )}
          />
        </FormField>
        <FormField label={t("promptTests.mustCallTool", "Must call tool")}>
          <Input
            value={form.mustCallTool}
            onChange={(e) => setForm({ ...form, mustCallTool: e.target.value })}
            disabled={saving}
            placeholder={t(
              "promptTests.toolCsvPlaceholder",
              "comma-separated tool names, e.g. handoff_to_human",
            )}
          />
        </FormField>
        <FormField
          label={t("promptTests.mustNotCallTool", "Must NOT call tool")}
        >
          <Input
            value={form.mustNotCallTool}
            onChange={(e) =>
              setForm({ ...form, mustNotCallTool: e.target.value })
            }
            disabled={saving}
            placeholder={t(
              "promptTests.toolCsvPlaceholder",
              "comma-separated tool names, e.g. handoff_to_human",
            )}
          />
        </FormField>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={modal.close}
            disabled={saving}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            type="submit"
            loading={saving}
            disabled={saving || !form.name.trim() || !form.userMessage.trim()}
          >
            {t("common.save", "Save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function PromptTestsTab({
  agentId,
  systemPrompt,
}: {
  agentId: string;
  systemPrompt: string;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [testCases, setTestCases] = useState<TestCaseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, TestResultRow>>({});
  const modal = useModalController<TestCaseRow | null>();

  const fetchTestCases = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.api.v1
        .agents({ id: agentId })
        ["prompt-tests"].get();
      if (data) setTestCases(data.testCases);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void fetchTestCases();
  }, [fetchTestCases]);

  async function runAll() {
    setRunning(true);
    setResults({});
    try {
      const { data, error } = await api.api.v1
        .agents({ id: agentId })
        ["prompt-tests"].run.post({ draftSystemPrompt: systemPrompt });
      if (error) {
        showToast(
          t("promptTests.runError", "Could not run the test suite."),
          "error",
        );
        return;
      }
      if (data) {
        const map: Record<string, TestResultRow> = {};
        for (const r of data.results) map[r.testCaseId] = r;
        setResults(map);
      }
    } finally {
      setRunning(false);
    }
  }

  async function deleteCase(tc: TestCaseRow) {
    const { error } = await api.api.v1
      .agents({ id: agentId })
      ["prompt-tests"]({ testId: tc.id })
      .delete();
    if (error) {
      showToast(
        t("promptTests.deleteError", "Could not delete the test case."),
        "error",
      );
      return;
    }
    showToast(t("promptTests.deleted", "Test case deleted."), "success");
    void fetchTestCases();
  }

  const passCount = Object.values(results).filter((r) => r.passed).length;
  const hasResults = Object.keys(results).length > 0;

  return (
    <div className="space-y-4">
      <TestCaseModal modal={modal} agentId={agentId} onSaved={fetchTestCases} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {t(
            "promptTests.subtitle",
            "Single-turn scenarios replayed against the current (even unsaved) prompt, so you catch regressions before publishing.",
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => modal.open(null)}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("promptTests.add", "New test case")}
          </Button>
          <Button
            size="sm"
            onClick={() => void runAll()}
            loading={running}
            disabled={running || testCases.length === 0}
          >
            <Play className="h-4 w-4" aria-hidden="true" />
            {t("promptTests.runAll", "Run all")}
          </Button>
        </div>
      </div>

      {hasResults && (
        <Card className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-accent" aria-hidden="true" />
          <span className="text-sm text-text-primary">
            {t("promptTests.summary", "{{pass}} of {{total}} passed", {
              pass: passCount,
              total: testCases.length,
            })}
          </span>
        </Card>
      )}

      {loading ? (
        <div className="space-y-2" role="status">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          {SKELETON_KEYS.map((key) => (
            <Card key={key} className="flex flex-col gap-2">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-full" />
            </Card>
          ))}
        </div>
      ) : testCases.length === 0 ? (
        <Card>
          <p className="py-8 text-center text-sm text-text-muted">
            {t(
              "promptTests.none",
              "No test cases yet. Add one to start catching prompt regressions.",
            )}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {testCases.map((tc) => {
            const result = results[tc.id];
            return (
              <Card key={tc.id} className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      {result &&
                        (result.passed ? (
                          <CheckCircle2
                            className="h-4 w-4 shrink-0 text-success"
                            aria-hidden="true"
                          />
                        ) : (
                          <XCircle
                            className="h-4 w-4 shrink-0 text-error"
                            aria-hidden="true"
                          />
                        ))}
                      <span className="font-medium text-sm text-text-primary">
                        {tc.name}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-text-secondary text-xs">
                      {tc.userMessage}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => modal.open(tc)}
                      aria-label={t("common.edit", "Edit")}
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-text-secondary text-xs transition-colors hover:bg-bg-hover hover:text-text-primary"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void deleteCase(tc)}
                      aria-label={t("common.delete", "Delete")}
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 font-medium text-text-secondary text-xs transition-colors hover:bg-error/10 hover:text-error"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1">
                  {tc.assertions.mustContain.map((s) => (
                    <Badge key={`mc-${s}`} variant="secondary">
                      {t("promptTests.badgeContain", "+ {{value}}", {
                        value: s,
                      })}
                    </Badge>
                  ))}
                  {tc.assertions.mustNotContain.map((s) => (
                    <Badge key={`mnc-${s}`} variant="secondary">
                      {t("promptTests.badgeNotContain", "− {{value}}", {
                        value: s,
                      })}
                    </Badge>
                  ))}
                  {tc.assertions.mustCallTool.map((s) => (
                    <Badge key={`mct-${s}`} variant="secondary">
                      {t("promptTests.badgeCallTool", "🔧 {{value}}", {
                        value: s,
                      })}
                    </Badge>
                  ))}
                  {tc.assertions.mustNotCallTool.map((s) => (
                    <Badge key={`mnct-${s}`} variant="secondary">
                      {t("promptTests.badgeNotCallTool", "🚫 {{value}}", {
                        value: s,
                      })}
                    </Badge>
                  ))}
                </div>
                {result && !result.passed && (
                  <div className="rounded-lg border border-error/30 bg-error/5 p-2 text-xs">
                    <p className="font-medium text-error">
                      {t("promptTests.failures", "Failures:")}
                    </p>
                    <ul className="mt-1 list-inside list-disc text-text-secondary">
                      {result.failures.map((f) => (
                        <li key={f}>{f}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-text-muted">
                      {t("promptTests.actualReply", "Reply: {{reply}}", {
                        reply: result.reply,
                      })}
                    </p>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
