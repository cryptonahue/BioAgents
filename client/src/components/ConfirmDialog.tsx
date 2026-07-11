/**
 * Reusable confirmation modal. Use for destructive actions so a stray click
 * can't do damage.
 *
 * It no longer builds its own overlay: the fixed-position scrim, the centering,
 * the Escape handling and the backdrop click all come from `ui/Modal`, which is
 * a native `<dialog>` on Basecoat's `.dialog`. `busy` maps onto Modal's
 * `dismissible` — while the confirmed action is in flight, Escape and the
 * backdrop are both vetoed, which is what the old hand-rolled keydown listener
 * was doing by hand.
 *
 * `showClose` is off: the footer's Cancel IS the close affordance, and a second
 * X floating over it read as a third, ambiguous choice on a destructive prompt.
 */
import { Modal } from "./ui/Modal";
import { Button } from "./ui/Button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Style the confirm button as destructive (red). Default true. */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  destructive = true,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      isOpen={open}
      onClose={onCancel}
      maxWidth="420px"
      showClose={false}
      dismissible={!busy}
      label={title}
    >
      <div className="confirm-dialog">
        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-message">{message}</p>
        <div className="confirm-actions">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            onClick={onConfirm}
            disabled={busy}
            loading={busy}
          >
            {busy ? "Deleting…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
