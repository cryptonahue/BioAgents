import { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ComponentChildren;
  maxWidth?: string;
}

/**
 * Presentation lives in `styles/ui.css` (`.ui-modal*`). The only inline style
 * left is `maxWidth`, which is a genuine per-instance value passed by the
 * caller — everything else was a hardcoded dark literal and is now a token.
 */
export function Modal({ isOpen, onClose, children, maxWidth = "500px" }: ModalProps) {
  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="ui-modal" onClick={onClose}>
      <div className="ui-modal__backdrop" />

      <div
        className="ui-modal__panel"
        style={{ maxWidth }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="ui-modal__close"
          aria-label="Close modal"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>

        {children}
      </div>
    </div>
  );
}
