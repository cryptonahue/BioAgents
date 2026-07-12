import type { Toast as ToastType } from "../hooks/useToast";
import { Icon } from "./icons";

interface ToastProps {
  toast: ToastType;
  onClose: (id: string) => void;
}

/**
 * The type glyphs are `Icon` NAMES now, not the literal characters the map used
 * to hold. `✓ ✕ ⚠ ℹ` were dingbats rendered as text: they picked up whatever
 * glyph the system font happened to have, they could not take a `weight`, and
 * they sat on the text baseline rather than on the icon grid the rest of the app
 * uses.
 *
 * The disc spellings are deliberate. A toast is a STATUS announcement, so
 * success and error take `checkCircle` / `xCircle` (the glyph inside a ring)
 * rather than the bare `check` / `close`, which are this app's affordance icons
 * — the tick on a done row, the X on a dismiss button. `.toast__close` below is
 * exactly such an affordance and correctly takes the bare `close`.
 *
 * Presentation lives in `styles/ui.css` (`.toast*`). The variant colors used to
 * be a literal map in this file — saturated fills with hardcoded white text,
 * which failed WCAG AA in both themes. They are now the status tokens' chip
 * slots; see the Toast section of `ui.css` for the measurements.
 */
const ICONS: Record<string, string> = {
  success: "checkCircle",
  error: "xCircle",
  warning: "alertTriangle",
  info: "info",
};

export function Toast({ toast, onClose }: ToastProps) {
  const { id, message, type } = toast;
  const variant = type in ICONS ? type : "info";

  return (
    <div className={`toast toast--${variant}`} role="status" aria-live="polite">
      {/* Decorative: `role="status"` already announces the message, and the
          toast's type is carried by the copy itself. */}
      <span className="toast__icon" aria-hidden="true">
        <Icon name={ICONS[variant]} size={16} />
      </span>
      <span className="toast__message">{message}</span>
      <button
        type="button"
        className="toast__close"
        onClick={() => onClose(id)}
        aria-label="Dismiss notification"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

interface ToastContainerProps {
  toasts: ToastType[];
  onClose: (id: string) => void;
}

export function ToastContainer({ toasts, onClose }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="toast-container">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onClose={onClose} />
      ))}
    </div>
  );
}
