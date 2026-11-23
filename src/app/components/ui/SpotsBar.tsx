/** Visualises taken/total places. Carries the numbers as text for screen readers. */
export function SpotsBar({
  taken,
  total,
  label = "Spots",
}: {
  readonly taken: number;
  readonly total: number;
  readonly label?: string;
}) {
  const safeTotal = Math.max(0, Math.trunc(total));
  const safeTaken = Math.min(Math.max(0, Math.trunc(taken)), safeTotal);
  const percent = safeTotal === 0 ? 0 : Math.round((safeTaken / safeTotal) * 100);
  const full = safeTotal > 0 && safeTaken >= safeTotal;
  return (
    <div className="bcq-spots">
      <div className="bcq-spots__meta">
        <span>{label}</span>
        <span>{full ? "Full" : `${String(safeTaken)} of ${String(safeTotal)} taken`}</span>
      </div>
      <div
        className="bcq-spots__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeTotal}
        aria-valuenow={safeTaken}
        aria-valuetext={`${String(safeTaken)} of ${String(safeTotal)}`}
      >
        <div className="bcq-spots__fill" style={{ width: `${String(percent)}%` }} />
      </div>
    </div>
  );
}
