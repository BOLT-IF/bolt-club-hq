const TZ = "Europe/Stockholm";

/** Milliseconds Stockholm is ahead of UTC at `instant` (3_600_000 in winter, 7_200_000 in summer). */
function offsetAt(instant: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall - instant;
}

/** "2027-03-12" + "19:00" club time → UTC ISO string. Times in the DST gap shift forward an hour. */
export function stockholmToUtc(date: string, time: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const [hh = 0, mm = 0] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let utc = wall - offsetAt(wall);
  utc = wall - offsetAt(utc);
  return new Date(utc).toISOString();
}
