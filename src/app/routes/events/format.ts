const TZ = "Europe/Stockholm";

/** "Thu 11 Mar, 19:00–20:30" in club time, from UTC instants. */
export function formatWhen(startsAt: string, endsAt: string): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: TZ,
  }).format(new Date(startsAt));
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TZ,
  });
  return `${day}, ${time.format(new Date(startsAt))}–${time.format(new Date(endsAt))}`;
}
