import { useCallback, useEffect, useRef, useState } from "react";

import { ApiError, apiFetch, newIdempotencyKey } from "../../api/client";
import type { SlotProps } from "../../routes/events/slots";
import { Button, EmptyState, ErrorState, Skeleton, StatusChip } from "../ui";
import "./attendance.css";

type MarkableAttendance = "attended" | "no_show";

interface AttendanceRow {
  readonly kind: "member" | "guest";
  readonly id: string;
  readonly memberId?: string;
  readonly rsvpId?: string;
  readonly hostName?: string;
  readonly name: string;
  readonly tier: number;
  readonly attendance: "unknown" | MarkableAttendance;
  readonly effectiveAttendance: MarkableAttendance;
}

interface AttendanceResponse {
  readonly eventId: string;
  readonly lockedForOrganizer: boolean;
  readonly canEdit: boolean;
  readonly hasUnmarked: boolean;
  readonly attendees: readonly AttendanceRow[];
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: AttendanceResponse };

export function AttendancePanel({ event, viewer }: SlotProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState<Record<string, MarkableAttendance>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey());

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!viewer.canManage || event.status === "cancelled") return;
    let cancelled = false;
    apiFetch<AttendanceResponse>(`/events/${encodeURIComponent(event.id)}/attendance`)
      .then((data) => {
        if (cancelled) return;
        const initial: Record<string, MarkableAttendance> = {};
        for (const row of data.attendees) {
          initial[row.id] = row.effectiveAttendance;
        }
        setDraft(initial);
        setState({ kind: "ready", data });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [event.id, viewer.canManage, event.status, reloadKey]);

  if (!viewer.canManage || event.status === "cancelled") return null;
  if (state.kind === "loading") return <Skeleton label="Loading attendance" />;
  if (state.kind === "error") {
    return <ErrorState onRetry={retry}>Could not load attendance.</ErrorState>;
  }

  const { data } = state;

  const toggle = (id: string) => {
    setSavedNotice(false);
    setSaveError(null);
    idempotencyKeyRef.current = newIdempotencyKey();
    setDraft((prev) => ({
      ...prev,
      [id]: prev[id] === "no_show" ? "attended" : "no_show",
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSavedNotice(false);
    const rsvps = data.attendees
      .filter((a) => a.kind === "member")
      .map((a) => ({ id: a.id, attendance: draft[a.id] ?? a.effectiveAttendance }));
    const guests = data.attendees
      .filter((a) => a.kind === "guest")
      .map((a) => ({ id: a.id, attendance: draft[a.id] ?? a.effectiveAttendance }));

    try {
      const updated = await apiFetch<AttendanceResponse>(
        `/events/${encodeURIComponent(event.id)}/attendance`,
        {
          method: "PUT",
          body: { rsvps, guests },
          idempotencyKey: idempotencyKeyRef.current,
        },
      );
      idempotencyKeyRef.current = newIdempotencyKey();
      setState({ kind: "ready", data: updated });
      setSavedNotice(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setSaveError("Attendance is locked after 7 days. Only admins can edit.");
      } else {
        setSaveError("Could not save attendance. Please try again.");
      }
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        idempotencyKeyRef.current = newIdempotencyKey();
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="attendance-heading" className="bcq-attendance">
      <div className="bcq-attendance__head">
        <h2 id="attendance-heading" className="bcq-attendance__title">
          Attendance
        </h2>
        {data.lockedForOrganizer ? (
          <StatusChip tone="warning">Locked after 7 days</StatusChip>
        ) : data.hasUnmarked ? (
          <StatusChip>Default: Attended</StatusChip>
        ) : (
          <StatusChip tone="success">Saved</StatusChip>
        )}
      </div>

      {data.lockedForOrganizer && !data.canEdit ? (
        <p className="bcq-attendance__note">
          Attendance is locked after 7 days. Ask an admin if a correction is needed.
        </p>
      ) : (
        <p className="bcq-attendance__note">
          Everyone confirmed defaults to attended. Tap a player to mark a no-show.
        </p>
      )}

      {data.attendees.length === 0 ? (
        <EmptyState title="No confirmed attendees">
          Confirmed players will appear here once spots are allocated.
        </EmptyState>
      ) : (
        <>
          <ul className="bcq-attendance__list">
            {data.attendees.map((row) => {
              const value = draft[row.id] ?? row.effectiveAttendance;
              const isNoShow = value === "no_show";
              return (
                <li key={row.id} className="bcq-attendance__row">
                  <div>
                    <span className="bcq-attendance__name">{row.name}</span>
                    {row.kind === "guest" && row.hostName ? (
                      <span className="bcq-attendance__meta">Guest of {row.hostName}</span>
                    ) : null}
                  </div>
                  {data.canEdit ? (
                    <Button
                      variant={isNoShow ? "danger" : "secondary"}
                      className="bcq-attendance__toggle"
                      aria-pressed={isNoShow}
                      aria-label={`${row.name}: ${isNoShow ? "No-Show" : "Attended"}`}
                      onClick={() => {
                        toggle(row.id);
                      }}
                    >
                      {isNoShow ? "No-Show" : "Attended"}
                    </Button>
                  ) : (
                    <StatusChip tone={isNoShow ? "danger" : "success"}>
                      {isNoShow ? "No-Show" : "Attended"}
                    </StatusChip>
                  )}
                </li>
              );
            })}
          </ul>

          {saveError ? (
            <p className="bcq-attendance__error" role="alert">
              {saveError}
            </p>
          ) : null}

          {data.canEdit ? (
            <div className="bcq-attendance__actions">
              <Button variant="primary" block disabled={saving} onClick={() => void handleSave()}>
                {saving ? "Saving…" : "Save Attendance"}
              </Button>
              {savedNotice ? <span className="bcq-attendance__saved">Saved</span> : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
