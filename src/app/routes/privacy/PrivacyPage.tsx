import "./privacy.css";
import { useState } from "react";

import { ApiError, apiFetch } from "../../api/client";
import { Button } from "../../components/ui";

const EXPORT_FILENAME = "bolt-hq-data-export.json";

function triggerJsonDownload(data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = EXPORT_FILENAME;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return "Your account cannot export data yet. Pending or erased accounts cannot export.";
  }
  return "Couldn't export your data. Try again.";
}

/**
 * Privacy notice and personal data export (S2.5, PLAN §16).
 * Readable without signing in so sign-in can link here; export requires an active
 * or exited (inactive) member session (`GET /me/export`).
 */
export function PrivacyPage() {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function downloadExport() {
    setBusy(true);
    setDone(false);
    setError(null);
    try {
      const payload = await apiFetch<Record<string, unknown>>("/me/export");
      triggerJsonDownload(payload);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bcq-page bcq-privacy" aria-labelledby="privacy-title">
      <h1 id="privacy-title" className="bcq-page__title">
        Privacy
      </h1>

      <article className="bcq-privacy__card" aria-labelledby="privacy-data-heading">
        <h2 id="privacy-data-heading" className="bcq-privacy__heading">
          What BOLT HQ Stores
        </h2>
        <p className="bcq-privacy__text">
          BOLT IF stores only the data needed to run club sessions, attendance, and member payments:
        </p>
        <ul className="bcq-privacy__list">
          <li>
            <strong>Account and profile:</strong> display name, email address, optional roster name,
            membership status, and bank-transfer payment reference.
          </li>
          <li>
            <strong>Sessions and guests:</strong> your RSVPs, attendance, season passes, and the
            display names of any guests you bring.
          </li>
          <li>
            <strong>Money:</strong> charges, payments, payment claims, and adjustments on your
            member ledger.
          </li>
          <li>
            <strong>Notifications and polls:</strong> inbox messages, mute preferences, push
            subscription endpoints, and your poll votes.
          </li>
        </ul>
      </article>

      <article className="bcq-privacy__card" aria-labelledby="privacy-retention-heading">
        <h2 id="privacy-retention-heading" className="bcq-privacy__heading">
          How Long We Keep Data
        </h2>
        <ul className="bcq-privacy__list">
          <li>
            <strong>Financial ledger entries:</strong> kept for <strong>7 years</strong> to meet
            accounting requirements.
          </li>
          <li>
            <strong>Notification send logs:</strong> purged automatically after{" "}
            <strong>1 year</strong>.
          </li>
          <li>
            <strong>Poll option images:</strong> deleted automatically <strong>6 months</strong>{" "}
            after a poll closes.
          </li>
          <li>
            <strong>Encrypted database backups:</strong> retained for <strong>90 days</strong>.
          </li>
        </ul>
      </article>

      <article className="bcq-privacy__card" aria-labelledby="privacy-rights-heading">
        <h2 id="privacy-rights-heading" className="bcq-privacy__heading">
          Your Rights: Export &amp; Erasure
        </h2>
        <p className="bcq-privacy__text">
          You can download a copy of your personal data as JSON at any time, including after you
          leave the club.
        </p>
        <p className="bcq-privacy__text">
          To erase your account, settle any remaining ledger balance (or ask an admin to waive it)
          and request erasure from a club admin. Erasure deletes your sign-in account and push
          subscriptions, replaces your name with &ldquo;Former member #id&rdquo; and guest names
          with &ldquo;Guest&rdquo;, pseudonymizes audit logs, and retains only financial ledger
          amounts for the statutory retention period listed above.
        </p>
        <div>
          <Button
            type="button"
            disabled={busy}
            onClick={() => {
              void downloadExport();
            }}
          >
            {busy ? "Preparing Export…" : "Download My Data (JSON)"}
          </Button>
        </div>
        {done ? (
          <p className="bcq-privacy__status" role="status">
            Your data export is ready.
          </p>
        ) : null}
        {error ? (
          <p className="bcq-privacy__error" role="alert">
            {error}
          </p>
        ) : null}
      </article>
    </section>
  );
}
