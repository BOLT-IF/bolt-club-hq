import { getToken } from "@clerk/react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type SyntheticEvent,
} from "react";

import { ApiError } from "../../api/client";
import { useAuthEnabled } from "../../auth/AuthProvider";
import { MemberImage, resizeImageToFit, type PickedImage } from "../../components/ImagePicker";
import {
  ActionSheet,
  BottomSheet,
  Button,
  CompactEmptyState,
  DisclosureSection,
  ErrorState,
  OverflowButton,
  Skeleton,
  StatusChip,
} from "../../components/ui";
import { cx } from "../../lib/cx";
import { navigate } from "../../lib/navigate";
import {
  closePoll,
  createPoll,
  deletePoll,
  listPolls,
  uploadPollImage,
  type NewPoll,
  type Poll,
  type ResultsVisibility,
} from "./api";
import { PollsGate } from "./shared";
import "./polls.css";

const MAX_OPTIONS = 20;
const MAX_IMAGES = 8;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

interface OptionDraft {
  readonly label: string;
  readonly image: PickedImage | null;
}

const emptyOptions = (): OptionDraft[] => [
  { label: "", image: null },
  { label: "", image: null },
];

const VISIBILITY_LABELS: Record<ResultsVisibility, string> = {
  always: "Everyone, at any time",
  after_vote: "Members after they vote",
  after_close: "Everyone once the poll closes",
  admins: "Admins only",
};

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "Europe/Stockholm",
});

function formatShortCloseDate(iso: string): string {
  return shortDateFormatter.format(new Date(iso));
}

/** `<input type="datetime-local">` gives local wall time; send it as a UTC instant. */
const toIso = (local: string): string | null => (local ? new Date(local).toISOString() : null);

function PlusIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function BarChartIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  );
}

function ImagePlusIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7" />
      <line x1="16" y1="5" x2="22" y2="5" />
      <line x1="19" y1="2" x2="19" y2="8" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

function TrashIcon({ size = 18 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function LockIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function OptionMediaControl({
  index,
  value,
  disabled,
  onChange,
  onUpload,
  onError,
}: {
  readonly index: number;
  readonly value: PickedImage | null;
  readonly disabled: boolean;
  readonly onChange: (next: PickedImage | null) => void;
  readonly onUpload: (blob: Blob) => Promise<{ key: string; url: string }>;
  readonly onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    onError(null);
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      onError("Choose a JPEG, PNG, WebP, or GIF image.");
      return;
    }

    setBusy(true);
    try {
      const resized = await resizeImageToFit(file);
      const uploaded = await onUpload(resized);
      let previewUrl = uploaded.url;
      if (typeof URL.createObjectURL === "function") {
        try {
          previewUrl = URL.createObjectURL(resized);
        } catch {
          // jsdom/restricted environments may not support Blob URL creation.
        }
      }
      onChange({ key: uploaded.key, url: uploaded.url, previewUrl });
    } catch (err: unknown) {
      onError(err instanceof Error && err.message ? err.message : "Could not upload image.");
    } finally {
      setBusy(false);
    }
  };

  const num = String(index + 1);

  if (value) {
    return (
      <button
        type="button"
        className="bcq-poll-opt-thumb"
        aria-label={`Remove image for option ${num}`}
        onClick={() => {
          if (value.previewUrl?.startsWith("blob:") && typeof URL.revokeObjectURL === "function") {
            URL.revokeObjectURL(value.previewUrl);
          }
          onChange(null);
        }}
      >
        <img src={value.previewUrl ?? value.url} alt="" className="bcq-poll-opt-thumb__img" />
        <span className="bcq-poll-opt-thumb__badge" aria-hidden="true">
          ×
        </span>
      </button>
    );
  }

  return (
    <label
      className={cx("bcq-poll-opt-media", (disabled || busy) && "is-disabled")}
      title={
        disabled ? `Maximum ${String(MAX_IMAGES)} images per poll` : `Add image to option ${num}`
      }
    >
      <ImagePlusIcon />
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="bcq-visually-hidden"
        aria-label={`Add image to option ${num}`}
        disabled={disabled || busy}
        onChange={(e) => {
          void handleFile(e);
        }}
      />
      {busy ? (
        <span role="status" className="bcq-visually-hidden">
          Uploading image
        </span>
      ) : null}
    </label>
  );
}

function ToggleSwitchRow({
  label,
  subtitle,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly subtitle?: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  const labelId = useId();
  const subId = useId();

  return (
    <div className="bcq-switch-row">
      <div className="bcq-switch-row__text">
        <span id={labelId} className="bcq-switch-row__label">
          {label}
        </span>
        {subtitle ? (
          <span id={subId} className="bcq-switch-row__sub">
            {subtitle}
          </span>
        ) : null}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={subtitle ? subId : undefined}
        className={cx("bcq-toggle", checked && "is-on")}
        onClick={() => {
          onChange(!checked);
        }}
      >
        <span className="bcq-toggle__track" aria-hidden="true">
          <span className="bcq-toggle__thumb" />
        </span>
      </button>
    </div>
  );
}

function NewPollSheet({
  open,
  onClose,
  onCreated,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (p: Poll) => void;
}) {
  const authEnabled = useAuthEnabled();
  const formRef = useRef<HTMLFormElement>(null);
  const closesId = useId();
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<OptionDraft[]>(emptyOptions);
  const [multiChoice, setMultiChoice] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [visibility, setVisibility] = useState<ResultsVisibility>("always");
  const [closesAt, setClosesAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const imageCount = options.filter((o) => o.image !== null).length;
  const uploadImage = (blob: Blob) =>
    uploadPollImage(blob, authEnabled ? () => getToken().catch(() => null) : undefined);

  const submitPayload = () => {
    if (options.some((o) => o.image !== null && o.label.trim() === "")) {
      setError("Every option with an image needs a label.");
      return;
    }
    const activeOptions = options
      .map((o) => ({ label: o.label.trim(), imageKey: o.image?.key ?? null }))
      .filter((o) => o.label !== "");
    const hasImages = activeOptions.some((o) => o.imageKey !== null);

    setBusy(true);
    setError(null);
    const payload: NewPoll = {
      question: question.trim(),
      options: activeOptions.map((o) => o.label),
      ...(hasImages ? { optionImages: activeOptions.map((o) => o.imageKey) } : {}),
      multiChoice,
      anonymous,
      resultsVisibility: visibility,
      closesAt: toIso(closesAt),
    };
    createPoll(payload)
      .then((p) => {
        setQuestion("");
        setOptions(emptyOptions());
        setMultiChoice(false);
        setAnonymous(false);
        setVisibility("always");
        setClosesAt("");
        onClose();
        onCreated(p);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError && err.status === 403
            ? "Only admins can create polls."
            : "The poll wasn't created. Check the question, at least two different options and a future closing time.",
        );
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const handleSubmit = (e: SyntheticEvent) => {
    e.preventDefault();
    submitPayload();
  };

  const handleFooterSubmit = () => {
    const form = formRef.current;
    if (form && typeof form.reportValidity === "function" && !form.reportValidity()) {
      return;
    }
    submitPayload();
  };

  return (
    <BottomSheet
      open={open}
      title="New Poll"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="bcq-poll-sheet__footer">
          <Button
            type="button"
            block
            disabled={busy}
            className="bcq-poll-sheet__submit"
            onClick={handleFooterSubmit}
          >
            <PlusIcon />
            <span>Create Poll</span>
          </Button>
          <Button type="button" variant="tonal" block disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      }
    >
      <form ref={formRef} onSubmit={handleSubmit} className="bcq-poll-sheet__form">
        <label className="bcq-poll-field">
          <span className="bcq-poll-field__label">Question</span>
          <input
            className="bcq-poll-input"
            required
            maxLength={300}
            placeholder="Ask members a question..."
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
            }}
          />
        </label>

        <div className="bcq-poll-field">
          <span className="bcq-poll-field__label">Options</span>
          <div className="bcq-poll-opt-list">
            {options.map((opt, i) => (
              <div key={i} className="bcq-poll-opt-row">
                <input
                  className="bcq-poll-input bcq-poll-opt-row__input"
                  aria-label={`Option ${String(i + 1)}`}
                  placeholder={`Option ${String(i + 1)}`}
                  required={i < 2}
                  maxLength={120}
                  value={opt.label}
                  onChange={(e) => {
                    const next = [...options];
                    next[i] = { ...opt, label: e.target.value };
                    setOptions(next);
                  }}
                />
                <OptionMediaControl
                  index={i}
                  value={opt.image}
                  disabled={!opt.image && imageCount >= MAX_IMAGES}
                  onUpload={uploadImage}
                  onError={setError}
                  onChange={(image) => {
                    const next = [...options];
                    next[i] = { ...opt, image };
                    setOptions(next);
                  }}
                />
                {options.length > 2 ? (
                  <button
                    type="button"
                    className="bcq-poll-opt-remove"
                    aria-label={`Remove option ${String(i + 1)}`}
                    onClick={() => {
                      if (
                        opt.image?.previewUrl?.startsWith("blob:") &&
                        typeof URL.revokeObjectURL === "function"
                      ) {
                        URL.revokeObjectURL(opt.image.previewUrl);
                      }
                      setOptions(options.filter((_, idx) => idx !== i));
                    }}
                  >
                    <TrashIcon size={17} />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
          {options.length < MAX_OPTIONS ? (
            <Button
              type="button"
              variant="tonal"
              block
              className="bcq-poll-opt-add"
              onClick={() => {
                setOptions([...options, { label: "", image: null }]);
              }}
            >
              <PlusIcon />
              <span>Add Option</span>
            </Button>
          ) : null}
        </div>

        <div className="bcq-switch-group">
          <ToggleSwitchRow
            label="Allow Multiple Choices"
            checked={multiChoice}
            onChange={setMultiChoice}
          />
          <ToggleSwitchRow
            label="Anonymous Poll"
            subtitle="Names are never shown and cannot be changed later"
            checked={anonymous}
            onChange={setAnonymous}
          />
        </div>

        <label className="bcq-poll-field">
          <span className="bcq-poll-field__label">Who Sees Results</span>
          <select
            className="bcq-poll-input"
            value={visibility}
            onChange={(e) => {
              setVisibility(e.target.value as ResultsVisibility);
            }}
          >
            {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <div className="bcq-poll-field">
          <label htmlFor={closesId} className="bcq-poll-field__label">
            Closes (Optional)
          </label>
          <div className="bcq-datetime-wrap">
            <span className="bcq-datetime-wrap__icon" aria-hidden="true">
              <CalendarIcon />
            </span>
            <input
              id={closesId}
              type="datetime-local"
              className={cx(
                "bcq-poll-input bcq-datetime-input",
                !closesAt && "is-empty",
                closesAt && "has-clear",
              )}
              value={closesAt}
              onChange={(e) => {
                setClosesAt(e.target.value);
              }}
            />
            {!closesAt ? (
              <span className="bcq-datetime-placeholder" aria-hidden="true">
                No closing date
              </span>
            ) : null}
            {closesAt ? (
              <button
                type="button"
                className="bcq-datetime-clear"
                aria-label="Clear closing date"
                onClick={() => {
                  setClosesAt("");
                }}
              >
                <ClearIcon />
              </button>
            ) : null}
          </div>
        </div>

        {error ? (
          <p role="status" className="bcq-poll__error">
            {error}
          </p>
        ) : null}
      </form>
    </BottomSheet>
  );
}

function PollActionSheet({
  poll,
  onClose,
  onClosePoll,
  onDeletePoll,
}: {
  readonly poll: Poll;
  readonly onClose: () => void;
  readonly onClosePoll: () => Promise<void>;
  readonly onDeletePoll: () => Promise<void>;
}) {
  const [confirmStep, setConfirmStep] = useState<"close" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const handleCopyLink = () => {
    const shareUrl = `${window.location.origin}/polls/${poll.id}`;
    const clipboard = navigator.clipboard as Clipboard | undefined;
    (clipboard ? clipboard.writeText(shareUrl) : Promise.reject(new Error("no clipboard")))
      .then(() => {
        setCopied(true);
        if (timerRef.current !== null) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          setCopied(false);
        }, 2000);
      })
      .catch(() => {
        // Ignore clipboard denial.
      });
  };

  if (confirmStep !== null) {
    const isDelete = confirmStep === "delete";
    return (
      <BottomSheet
        open
        title={isDelete ? "Delete Poll?" : "Close Poll?"}
        onClose={() => {
          if (!busy) onClose();
        }}
      >
        <div className="bcq-actionsheet">
          <p className="bcq-confirm__text">
            {isDelete
              ? "The poll, its options, and all votes will be removed permanently."
              : "Close this poll? Members will no longer be able to vote."}
          </p>
          <ActionSheet.Group>
            <ActionSheet.Item
              tone="destructive-solid"
              disabled={busy}
              onClick={() => void run(isDelete ? onDeletePoll : onClosePoll)}
            >
              {isDelete ? "Delete Poll" : "Close Poll"}
            </ActionSheet.Item>
            <ActionSheet.Cancel
              onClick={() => {
                setConfirmStep(null);
              }}
            />
          </ActionSheet.Group>
        </div>
      </BottomSheet>
    );
  }

  const voteCount = poll.results?.totalVoters ?? 0;
  const subtitle = `${String(voteCount)} ${voteCount === 1 ? "Vote" : "Votes"} · ${poll.closed ? "Closed" : "Active"}`;

  return (
    <ActionSheet.Root
      open
      title={poll.question}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <ActionSheet.Header title={subtitle} />
      <ActionSheet.Group>
        <button
          type="button"
          className={cx(
            "bcq-actionsheet__item",
            copied ? "bcq-actionsheet__item--copied" : "bcq-actionsheet__item--tonal",
          )}
          disabled={busy}
          onClick={handleCopyLink}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          <span>{copied ? "Copied" : "Copy Poll Link"}</span>
        </button>

        <ActionSheet.Divider />

        {poll.closed ? null : (
          <ActionSheet.Item
            icon={<LockIcon />}
            tone="destructive-tonal"
            disabled={busy}
            onClick={() => {
              setConfirmStep("close");
            }}
          >
            Close Poll
          </ActionSheet.Item>
        )}

        <ActionSheet.Item
          icon={<TrashIcon />}
          tone="destructive-tonal"
          disabled={busy}
          onClick={() => {
            setConfirmStep("delete");
          }}
        >
          Delete Poll
        </ActionSheet.Item>

        <ActionSheet.Cancel onClick={onClose} />
      </ActionSheet.Group>
    </ActionSheet.Root>
  );
}

function AdminPollCard({
  poll,
  onActions,
}: {
  readonly poll: Poll;
  readonly onActions: () => void;
}) {
  const resultMap = new Map(poll.results?.options.map((r) => [r.optionId, r.votes]) ?? []);
  const totalVoters = poll.results?.totalVoters ?? 0;
  const totalVotes = poll.results?.options.reduce((sum, r) => sum + r.votes, 0) ?? 0;
  const maxVotes = poll.results?.options.reduce((max, r) => Math.max(max, r.votes), 0) ?? 0;
  const pctDenom = Math.max(poll.multiChoice ? totalVoters : totalVotes, 1);

  const metaParts: string[] = [];
  if (poll.results) {
    metaParts.push(`${String(totalVoters)} ${totalVoters === 1 ? "Vote" : "Votes"}`);
  }
  if (poll.closesAt) {
    metaParts.push(`${poll.closed ? "Closed" : "Closes"} ${formatShortCloseDate(poll.closesAt)}`);
  }

  return (
    <li className={cx("bcq-poll-card", poll.closed && "bcq-poll-card--closed")}>
      <div className="bcq-poll-card__top">
        <a
          className="bcq-poll-card__title"
          href={`/polls/${poll.id}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            navigate(`/polls/${poll.id}`);
          }}
        >
          {poll.question}
        </a>
        <OverflowButton
          label={`Actions for ${poll.question}`}
          className="bcq-poll-card__overflow"
          onClick={onActions}
        />
      </div>

      <div className="bcq-poll-card__badges">
        <StatusChip tone={poll.closed ? "neutral" : "success"}>
          {poll.closed ? "Closed" : "Active"}
        </StatusChip>
        {poll.multiChoice ? <StatusChip tone="neutral">Multiple Choice</StatusChip> : null}
        {poll.anonymous ? <StatusChip tone="neutral">Anonymous</StatusChip> : null}
      </div>

      {metaParts.length > 0 ? <p className="bcq-poll-card__meta">{metaParts.join(" · ")}</p> : null}

      <ul className="bcq-poll-card__options">
        {poll.options.map((opt) => {
          const votes = resultMap.get(opt.id) ?? 0;
          const pct =
            poll.resultsVisible && poll.results && (totalVotes > 0 || totalVoters > 0)
              ? Math.min(100, Math.round((votes / pctDenom) * 100))
              : 0;
          const isLeader = votes > 0 && votes === maxVotes;
          return (
            <li key={opt.id} className="bcq-poll-card__opt">
              <div className="bcq-poll-card__opt-head">
                <span className="bcq-poll-card__opt-label">
                  {opt.imageUrl ? (
                    <MemberImage src={opt.imageUrl} className="bcq-poll__bar-thumb" />
                  ) : null}
                  <span>{opt.label}</span>
                </span>
                {poll.resultsVisible && poll.results ? (
                  <span className="bcq-poll-card__opt-stat">
                    {votes} ({pct}%)
                  </span>
                ) : null}
              </div>
              {poll.resultsVisible && poll.results ? (
                <span className="bcq-poll-card__bar" aria-hidden="true">
                  <span
                    className={cx("bcq-poll-card__bar-fill", isLeader && "is-leader")}
                    style={{ width: `${String(pct)}%` }}
                  />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

function AdminPolls() {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error" } | { kind: "ready"; polls: Poll[] }
  >({ kind: "loading" });
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedPoll, setSelectedPoll] = useState<Poll | null>(null);

  const load = useCallback(() => {
    listPolls()
      .then((polls) => {
        setState({ kind: "ready", polls });
      })
      .catch(() => {
        setState({ kind: "error" });
      });
  }, []);
  useEffect(load, [load]);

  const activePolls = state.kind === "ready" ? state.polls.filter((p) => !p.closed) : [];
  const closedPolls = state.kind === "ready" ? state.polls.filter((p) => p.closed) : [];

  return (
    <section aria-labelledby="admin-polls-title" className="bcq-polls-page">
      <div className="bcq-page-head">
        <h1 id="admin-polls-title" className="bcq-page__title">
          Polls
        </h1>
        <Button
          variant="primary"
          className="bcq-btn--compact"
          onClick={() => {
            setCreateOpen(true);
          }}
        >
          <PlusIcon />
          <span>New Poll</span>
        </Button>
      </div>

      {state.kind === "loading" ? <Skeleton label="Loading polls" /> : null}
      {state.kind === "error" ? (
        <ErrorState onRetry={load}>Could not load polls.</ErrorState>
      ) : null}
      {state.kind === "ready" ? (
        <div className="bcq-polls-groups">
          <div className="bcq-polls-section">
            <h2 className="bcq-section-subheader">Active Polls</h2>
            {activePolls.length === 0 ? (
              <CompactEmptyState title="No Active Polls" icon={<BarChartIcon />}>
                Tap + New Poll to ask members
              </CompactEmptyState>
            ) : (
              <ul className="bcq-polls">
                {activePolls.map((p) => (
                  <AdminPollCard
                    key={p.id}
                    poll={p}
                    onActions={() => {
                      setSelectedPoll(p);
                    }}
                  />
                ))}
              </ul>
            )}
          </div>

          {closedPolls.length > 0 ? (
            <DisclosureSection label={`Closed Polls (${String(closedPolls.length)})`}>
              <ul className="bcq-polls">
                {closedPolls.map((p) => (
                  <AdminPollCard
                    key={p.id}
                    poll={p}
                    onActions={() => {
                      setSelectedPoll(p);
                    }}
                  />
                ))}
              </ul>
            </DisclosureSection>
          ) : null}
        </div>
      ) : null}

      <NewPollSheet
        open={createOpen}
        onClose={() => {
          setCreateOpen(false);
        }}
        onCreated={load}
      />

      {selectedPoll ? (
        <PollActionSheet
          poll={selectedPoll}
          onClose={() => {
            setSelectedPoll(null);
          }}
          onClosePoll={async () => {
            await closePoll(selectedPoll.id);
            load();
          }}
          onDeletePoll={async () => {
            await deletePoll(selectedPoll.id);
            load();
          }}
        />
      ) : null}
    </section>
  );
}

export function AdminPollsPage() {
  return (
    <PollsGate>
      <AdminPolls />
    </PollsGate>
  );
}
