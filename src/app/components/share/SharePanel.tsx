import type { EventDetail } from "../../api/events";
import type { SlotProps } from "../../routes/events/slots";
import { useToast } from "../ui";

function ShareIcon() {
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
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" x2="15.42" y1="13.51" y2="17.49" />
      <line x1="15.41" x2="8.59" y1="6.51" y2="10.49" />
    </svg>
  );
}

const TZ = "Europe/Stockholm";

function formatShareTime(startsAt: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TZ,
  }).format(new Date(startsAt));
}

export function buildShareText(
  event: EventDetail,
  origin: string,
): { url: string; summary: string; text: string } {
  const url = `${origin}/e/${encodeURIComponent(event.slug)}`;
  const where = event.location ? ` @ ${event.location}` : "";
  const summary = `🏸 ${event.title} ${formatShareTime(event.startsAt)}${where}, ${String(event.capacity)} spots`;
  return { url, summary, text: `${summary}: ${url}` };
}

/** Share button for the event page (`ShareSlot`): Web Share API with clipboard copy fallback. */
export function SharePanel({ event }: SlotProps) {
  const toast = useToast();

  const onShare = async () => {
    const { url, summary, text } = buildShareText(event, window.location.origin);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: event.title, text: summary, url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.show("Link copied", "success");
    } catch {
      toast.show("Couldn't copy link", "danger");
    }
  };

  return (
    <div className="bcq-share-slot">
      <button type="button" className="bcq-share-pill" onClick={() => void onShare()}>
        <span className="bcq-share-pill__icon">
          <ShareIcon />
        </span>
        <span>Share Event</span>
      </button>
    </div>
  );
}
