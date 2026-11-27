import { BottomSheet } from "./BottomSheet";
import { Button } from "./Button";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Confirmation step for irreversible or money-moving actions. Solid red is reserved for final destructive confirm. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <BottomSheet open={open} title={title} onClose={onCancel}>
      <p className="bcq-confirm__text">{description}</p>
      <div className="bcq-confirm__actions">
        <Button variant="tonal" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={destructive ? "destructive-solid" : "primary"} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </BottomSheet>
  );
}
