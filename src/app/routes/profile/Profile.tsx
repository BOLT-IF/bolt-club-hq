import { useEffect, useState, type SyntheticEvent } from "react";

import { apiFetch } from "../../api/client";
import { Button, ErrorState, Skeleton, useToast } from "../../components/ui";
import type { MemberRow } from "../members/memberApi";
import "../members/members.css";

type Me = Pick<MemberRow, "id" | "displayName" | "rosterName" | "email" | "paymentRef">;

/** Own profile: display name and roster name (the name used in the roster generator). */
export function Profile() {
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [failed, setFailed] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [rosterName, setRosterName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<Me>("/me/profile")
      .then((data) => {
        setMe(data);
        setDisplayName(data.displayName);
        setRosterName(data.rosterName ?? "");
      })
      .catch(() => {
        setFailed(true);
      });
  }, []);

  if (failed) return <ErrorState title="Couldn't load your profile" />;
  if (!me) return <Skeleton label="Loading profile" />;

  async function save(event: SyntheticEvent) {
    event.preventDefault();
    if (!me) return;
    if (displayName.trim() === "") {
      setError("Enter a display name.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/members/${me.id}`, {
        method: "PATCH",
        body: { displayName, rosterName },
      });
      toast.show("Profile saved", "success");
    } catch {
      toast.show("Couldn't save your profile. Try again.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bcq-page" aria-labelledby="profile-title">
      <h1 id="profile-title" className="bcq-page__title">
        Profile
      </h1>
      <form className="bcq-form" onSubmit={(e) => void save(e)} noValidate>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="display-name">
            Display name
          </label>
          <input
            id="display-name"
            className="bcq-input"
            value={displayName}
            autoComplete="name"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "display-name-error" : undefined}
            onChange={(e) => {
              setDisplayName(e.target.value);
            }}
          />
          {error ? (
            <p id="display-name-error" className="bcq-field__error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="bcq-field">
          <label className="bcq-field__label" htmlFor="roster-name">
            Roster name (optional)
          </label>
          <input
            id="roster-name"
            className="bcq-input"
            value={rosterName}
            autoComplete="off"
            aria-describedby="roster-name-hint"
            onChange={(e) => {
              setRosterName(e.target.value);
            }}
          />
          <p id="roster-name-hint" className="bcq-field__hint">
            Shown on the roster when you play. Leave empty to use your first name.
          </p>
        </div>
        <div className="bcq-field">
          <span className="bcq-field__label">Payment reference</span>
          <strong>{me.paymentRef}</strong>
          <p className="bcq-field__hint">
            Write this on your bank transfers so we can match them to you.
          </p>
        </div>
        <Button type="submit" disabled={busy}>
          Save
        </Button>
      </form>
    </section>
  );
}
