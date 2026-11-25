import type { EventDetail } from "../../api/events";
import type { SlotProps } from "../../routes/events/slots";
import { Button, useToast } from "../ui";

const TZ = "Europe/Stockholm";

function formatShareTime(startsAt: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TZ,
  }).format(new Date(startsAt));
}

export function buildShareText(event: EventDetail, origin: string): { url: string; text: string } {
  const url = `${origin}/e/${encodeURIComponent(event.slug)}`;
  const where = event.location ? ` @ ${event.location}` : "";
  const text = `🏸 ${event.title} ${formatShareTime(event.startsAt)}${where}, ${String(event.capacity)} spots: ${url}`;
  return { url, text };
}

/** Share button for the event page (`ShareSlot`): Web Share API with clipboard copy fallback. */
export function SharePanel({ event }: SlotProps) {
  const toast = useToast();

  const onShare = async () => {
    const { url, text } = buildShareText(event, window.location.origin);
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: event.title, text, url });
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
      <Button variant="secondary" onClick={() => void onShare()}>
        Share event
      </Button>
    </div>
  );
}
