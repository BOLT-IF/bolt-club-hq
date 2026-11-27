import { useCallback, useEffect, useState } from "react";

import { ApiError } from "../../../api/client";
import {
  ActionSheet,
  BottomSheet,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  MoreHorizontalIcon,
  Skeleton,
  StatusChip,
  useToast,
} from "../../../components/ui";
import { RuleForm } from "./RuleForm";
import {
  deleteReminderRule,
  getErrorCode,
  KIND_LABEL,
  listReminderRules,
  previewReminderRule,
  toRuleInput,
  updateReminderRule,
  type PlaceholdersMap,
  type PreviewResponse,
  type ReminderRule,
} from "./remindersApi";
import "./reminders.css";

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "forbidden" }
  | { readonly kind: "error" }
  | {
      readonly kind: "ready";
      readonly rules: readonly ReminderRule[];
      readonly placeholders: PlaceholdersMap;
    };

type EditorState =
  { readonly mode: "create" } | { readonly mode: "edit"; readonly rule: ReminderRule };

interface PreviewState {
  readonly rule: ReminderRule;
  readonly loading: boolean;
  readonly data: PreviewResponse | null;
  readonly error: string | null;
}

function formatInterval(days: number): string {
  return `Every ${String(days)} ${days === 1 ? "day" : "days"}`;
}

function describeRule(rule: ReminderRule): string {
  if (rule.kind === "payment_due") {
    return `Balance ≥ ${String(rule.params.thresholdSek)} kr · ${formatInterval(rule.minIntervalDays)}`;
  }
  const triggers: string[] = [];
  if (rule.params.atPublish) triggers.push("At publish");
  if (rule.params.hoursBeforeClose !== null) {
    triggers.push(`${String(rule.params.hoursBeforeClose)}h before close`);
  }
  const timing = triggers.length > 0 ? triggers.join(" and ") : "No trigger set";
  return `${timing} · ${formatInterval(rule.minIntervalDays)}`;
}

/** Reminder rules admin page (S6.5b). */
export function AdminReminders() {
  const toast = useToast();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [deleting, setDeleting] = useState<ReminderRule | null>(null);
  const [hasSendsRule, setHasSendsRule] = useState<ReminderRule | null>(null);
  const [selectedRule, setSelectedRule] = useState<ReminderRule | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await listReminderRules();
      setState({
        kind: "ready",
        rules: data.items,
        placeholders: data.placeholders,
      });
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 403) {
        setState({ kind: "forbidden" });
      } else {
        setState({ kind: "error" });
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    listReminderRules()
      .then((data) => {
        if (!cancelled) {
          setState({
            kind: "ready",
            rules: data.items,
            placeholders: data.placeholders,
          });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState(
          error instanceof ApiError && error.status === 403
            ? { kind: "forbidden" }
            : { kind: "error" },
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleEnabled = async (rule: ReminderRule) => {
    setBusyId(rule.id);
    try {
      const nextEnabled = !rule.enabled;
      await updateReminderRule(rule.id, toRuleInput(rule, { enabled: nextEnabled }));
      toast.show(nextEnabled ? "Rule enabled" : "Rule disabled", "success");
      await load();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 403) {
        setState({ kind: "forbidden" });
      } else {
        toast.show("Could not update rule", "danger");
      }
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async (rule: ReminderRule) => {
    setDeleting(null);
    setBusyId(rule.id);
    try {
      await deleteReminderRule(rule.id);
      toast.show("Rule deleted", "success");
      if (editor?.mode === "edit" && editor.rule.id === rule.id) setEditor(null);
      await load();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 403) {
        setState({ kind: "forbidden" });
        return;
      }
      if (
        error instanceof ApiError &&
        error.status === 409 &&
        getErrorCode(error) === "rule_has_sends"
      ) {
        setHasSendsRule(rule);
        return;
      }
      toast.show("Could not delete rule", "danger");
    } finally {
      setBusyId(null);
    }
  };

  const disableInstead = async (rule: ReminderRule) => {
    setHasSendsRule(null);
    setBusyId(rule.id);
    try {
      await updateReminderRule(rule.id, toRuleInput(rule, { enabled: false }));
      toast.show("Rule disabled", "success");
      await load();
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 403) {
        setState({ kind: "forbidden" });
      } else {
        toast.show("Could not disable rule", "danger");
      }
    } finally {
      setBusyId(null);
    }
  };

  const openPreview = async (rule: ReminderRule) => {
    setPreview({ rule, loading: true, data: null, error: null });
    try {
      const data = await previewReminderRule(rule.id);
      setPreview({ rule, loading: false, data, error: null });
    } catch (error: unknown) {
      if (error instanceof ApiError && error.status === 403) {
        setPreview(null);
        setState({ kind: "forbidden" });
        return;
      }
      setPreview({
        rule,
        loading: false,
        data: null,
        error: "Could not load the reminder preview.",
      });
    }
  };

  if (state.kind === "loading") return <Skeleton lines={4} label="Loading reminder rules" />;
  if (state.kind === "forbidden") {
    return (
      <section className="bcq-state bcq-state--empty">
        <h1 className="bcq-state__title">Admins only</h1>
        <p className="bcq-state__body">You need admin access to see this page.</p>
      </section>
    );
  }
  if (state.kind === "error") {
    return (
      <ErrorState
        title="Couldn't load reminder rules"
        onRetry={() => {
          setState({ kind: "loading" });
          void load();
        }}
      >
        Check your connection, or that you are signed in as an admin.
      </ErrorState>
    );
  }

  const placeholders = state.placeholders;

  return (
    <section aria-labelledby="admin-reminders-title">
      <div className="bcq-reminders-head">
        <h1 id="admin-reminders-title" className="bcq-page__title">
          Reminders
        </h1>
        {editor === null ? (
          <Button
            onClick={() => {
              setEditor({ mode: "create" });
            }}
          >
            New Rule
          </Button>
        ) : null}
      </div>

      {editor ? (
        <RuleForm
          key={editor.mode === "edit" ? editor.rule.id : "new"}
          initial={editor.mode === "edit" ? editor.rule : null}
          placeholders={placeholders}
          onSaved={async () => {
            setEditor(null);
            await load();
          }}
          onCancel={() => {
            setEditor(null);
          }}
          onForbidden={() => {
            setEditor(null);
            setState({ kind: "forbidden" });
          }}
        />
      ) : null}

      {state.rules.length === 0 ? (
        <EmptyState title="No Reminder Rules Yet">
          Create a payment or un-RSVPed event rule to send automatic reminders.
        </EmptyState>
      ) : (
        <ul className="bcq-reminders-list" aria-label="Reminder rules">
          {state.rules.map((rule) => (
            <li key={rule.id} className="bcq-reminder-card">
              <div className="bcq-reminder-card__top">
                <div className="bcq-reminder-card__head-info">
                  <h2 className="bcq-reminder-card__title">{KIND_LABEL[rule.kind]}</h2>
                  <StatusChip tone={rule.enabled ? "success" : "neutral"}>
                    {rule.enabled ? "Enabled" : "Disabled"}
                  </StatusChip>
                </div>
                <button
                  type="button"
                  className="bcq-member__overflow"
                  aria-label={`Actions for ${KIND_LABEL[rule.kind]}`}
                  onClick={() => {
                    setSelectedRule(rule);
                  }}
                >
                  <MoreHorizontalIcon />
                </button>
              </div>
              <p className="bcq-reminder-card__meta">{describeRule(rule)}</p>
              <p className="bcq-reminder-card__template">{rule.template}</p>
            </li>
          ))}
        </ul>
      )}

      <ActionSheet.Root
        open={selectedRule !== null}
        title="Rule Actions"
        onClose={() => {
          setSelectedRule(null);
        }}
      >
        {selectedRule ? (
          <>
            <ActionSheet.Header
              title={KIND_LABEL[selectedRule.kind]}
              subtitle={describeRule(selectedRule)}
            />
            <ActionSheet.Group>
              <ActionSheet.Item
                onClick={() => {
                  const target = selectedRule;
                  setSelectedRule(null);
                  void openPreview(target);
                }}
              >
                Preview
              </ActionSheet.Item>
              <ActionSheet.Item
                disabled={busyId === selectedRule.id}
                onClick={() => {
                  const target = selectedRule;
                  setSelectedRule(null);
                  void toggleEnabled(target);
                }}
              >
                {selectedRule.enabled ? "Disable" : "Enable"}
              </ActionSheet.Item>
              <ActionSheet.Item
                onClick={() => {
                  const target = selectedRule;
                  setSelectedRule(null);
                  setEditor({ mode: "edit", rule: target });
                }}
              >
                Edit
              </ActionSheet.Item>
            </ActionSheet.Group>
            <ActionSheet.Divider />
            <ActionSheet.Item
              tone="destructive-tonal"
              disabled={busyId === selectedRule.id}
              onClick={() => {
                const target = selectedRule;
                setSelectedRule(null);
                setDeleting(target);
              }}
            >
              Delete
            </ActionSheet.Item>
            <ActionSheet.Cancel
              onClick={() => {
                setSelectedRule(null);
              }}
            />
          </>
        ) : null}
      </ActionSheet.Root>

      <BottomSheet
        open={preview !== null}
        title={preview ? `Preview: ${KIND_LABEL[preview.rule.kind]}` : "Preview"}
        onClose={() => {
          setPreview(null);
        }}
      >
        {preview?.loading ? <Skeleton lines={3} label="Loading preview" /> : null}
        {preview?.error ? <ErrorState>{preview.error}</ErrorState> : null}
        {preview?.data ? (
          <div className="bcq-preview">
            <p className="bcq-preview__count">
              <strong>
                {String(preview.data.count)} {preview.data.count === 1 ? "member" : "members"}
              </strong>{" "}
              would receive this reminder now.
            </p>
            {preview.data.sample ? (
              <div>
                <h3 className="bcq-preview__section-title">Sample message</h3>
                <div className="bcq-preview__sample">
                  <p className="bcq-preview__sample-title">{preview.data.sample.title}</p>
                  <p className="bcq-preview__sample-body">{preview.data.sample.body}</p>
                  <p className="bcq-preview__sample-link">Link: {preview.data.sample.link}</p>
                </div>
              </div>
            ) : null}
            {preview.data.recipients.length > 0 ? (
              <div>
                <h3 className="bcq-preview__section-title">Recipients</h3>
                <ul className="bcq-preview__recipients">
                  {preview.data.recipients.map((r) => (
                    <li key={r.memberId}>{r.displayName}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="bcq-reminder-card__meta">No members match this rule right now.</p>
            )}
          </div>
        ) : null}
      </BottomSheet>

      <ConfirmDialog
        open={deleting !== null}
        title="Delete Reminder Rule?"
        description="This removes the rule permanently. Rules that have already sent reminders cannot be deleted."
        confirmLabel="Delete Rule"
        destructive
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          if (deleting) void confirmDelete(deleting);
        }}
      />

      {hasSendsRule?.enabled ? (
        <ConfirmDialog
          open
          title="Rule cannot be deleted"
          description="This rule has already sent reminders, so it stays in the send log. Disable it instead so it stops sending."
          confirmLabel="Disable instead"
          onCancel={() => {
            setHasSendsRule(null);
          }}
          onConfirm={() => {
            void disableInstead(hasSendsRule);
          }}
        />
      ) : (
        <BottomSheet
          open={hasSendsRule !== null}
          title="Rule cannot be deleted"
          onClose={() => {
            setHasSendsRule(null);
          }}
        >
          <p className="bcq-confirm__text">
            This rule has already sent reminders, so it stays in the send log. It is already
            disabled and will not send again.
          </p>
          <Button
            onClick={() => {
              setHasSendsRule(null);
            }}
          >
            OK
          </Button>
        </BottomSheet>
      )}
    </section>
  );
}
