import type { Toast as ToastType } from "../hooks/useToast";

interface ToastProps {
  toast: ToastType;
  onClose: (id: string) => void;
}

const ICONS: Record<string, string> = {
  success: "✓",
  error: "✕",
  warning: "⚠",
  info: "ℹ",
};

/**
 * Presentation lives in `styles/ui.css` (`.toast*`). The variant colors used to
 * be a literal map in this file — saturated fills with hardcoded white text,
 * which failed WCAG AA in both themes. They are now the status tokens' chip
 * slots; see the Toast section of `ui.css` for the measurements.
 */
export function Toast({ toast, onClose }: ToastProps) {
  const { id, message, type } = toast;
  const variant = type in ICONS ? type : "info";

  return (
    <div className={`toast toast--${variant}`} role="status" aria-live="polite">
      <span className="toast__icon" aria-hidden="true">
        {ICONS[variant]}
      </span>
      <span className="toast__message">{message}</span>
      <button
        type="button"
        className="toast__close"
        onClick={() => onClose(id)}
        aria-label="Dismiss notification"
      >
        ×
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
