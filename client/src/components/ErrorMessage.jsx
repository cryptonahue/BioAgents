// Phosphor equivalents of the Lucide icons this used to import:
// AlertCircle -> WarningCircle, AlertTriangle -> Warning, Info -> Info, X -> X.
import { Info, Warning, WarningCircle, X } from '@phosphor-icons/react';

export function ErrorMessage({ message, onClose, type = 'error' }) {
  const icons = {
    error: WarningCircle,
    warning: Warning,
    info: Info,
  };

  const Icon = icons[type] || icons.error;

  return (
    <div className={`toast-message toast-${type} show`}>
      <div className="toast-content">
        <div className="toast-icon">
          <Icon size={20} />
        </div>
        <div className="toast-text">{message}</div>
      </div>
      {onClose && (
        <button className="toast-close" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      )}
    </div>
  );
}
