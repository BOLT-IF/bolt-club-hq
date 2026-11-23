/** Integer +/- control for counts such as guests. Clamped to [min, max]. */
export function Stepper({
  label,
  value,
  min = 0,
  max = 99,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly onChange: (next: number) => void;
}) {
  const atMin = value <= min;
  const atMax = value >= max;
  return (
    <div className="bcq-stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="bcq-stepper__btn"
        aria-label={`Decrease ${label}`}
        disabled={atMin}
        onClick={() => {
          onChange(Math.max(min, value - 1));
        }}
      >
        −
      </button>
      <output className="bcq-stepper__value" aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        className="bcq-stepper__btn"
        aria-label={`Increase ${label}`}
        disabled={atMax}
        onClick={() => {
          onChange(Math.min(max, value + 1));
        }}
      >
        +
      </button>
    </div>
  );
}
