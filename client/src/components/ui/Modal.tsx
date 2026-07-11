import { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  children: ComponentChildren;
  maxWidth?: string;
  /** Render the built-in close affordance. Off for dialogs whose own footer
   *  already carries a Cancel action. */
  showClose?: boolean;
  /** Whether Escape and a backdrop click dismiss the modal. Off while a
   *  dialog is mid-flight, so a stray key cannot abandon work in progress. */
  dismissible?: boolean;
  /** Accessible name. Only needed when the content has no heading of its own. */
  label?: string;
}

/**
 * The app's one modal primitive. It is a NATIVE `<dialog>` carrying Basecoat's
 * `.dialog` class.
 *
 * WHY NATIVE, AND WHY IT WAS NOT OPTIONAL
 *
 * Basecoat's `.dialog` is written against a real `<dialog>` element and cannot
 * be worn by a div. Read `basecoat-css/dist/components/dialog.css`: the class
 * is `opacity-0` at rest and only becomes visible under `&:is([open],
 * :popover-open)`, and its scrim is `backdrop:*` — i.e. `::backdrop`, a
 * pseudo-element that exists only on a top-layer element. On a div the class
 * renders nothing at all. So this was never a free choice between two working
 * options; the div overlay was the thing that had to go.
 *
 * That it is also the accessible answer is the happy part. `showModal()` gives
 * us, from the platform, three things the old `.ui-modal` div either faked or
 * simply did not have:
 *
 *   - a real focus trap (the rest of the document goes inert — Tab cannot walk
 *     out of the dialog; the old overlay let you Tab straight into the page
 *     behind it),
 *   - Escape, dispatched as a `cancel` event we can veto (see `dismissible`),
 *     instead of a `keydown` listener bolted onto `document`,
 *   - top-layer promotion, so the modal cannot be occluded by a z-index race.
 *
 * PREACT WIRING
 *
 * `<dialog>` is imperative — `open` as an ATTRIBUTE renders a non-modal dialog
 * with no backdrop and no focus trap, so `showModal()` has to be called. The
 * element therefore stays mounted and an effect drives it from `isOpen`,
 * rather than the component returning `null`. Two edges that follow from that:
 *
 *   - `close()` fires the `close` event whether the user or we did it. The
 *     `selfClosing` ref stops our own effect-driven `close()` from calling
 *     `onClose()` back at the parent, which would be a redundant round-trip.
 *   - Clicking the backdrop targets the `<dialog>` element itself (the panel
 *     inside it is a separate box), which is what `e.target === el` tests. No
 *     stopPropagation() plumbing in the children is needed any more.
 *
 * Presentation is Basecoat's, apart from four things `styles/ui.css` adds back.
 * See the header of that block for what and why.
 */
export function Modal({
  isOpen,
  onClose,
  children,
  maxWidth = "500px",
  showClose = true,
  dismissible = true,
  label,
}: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const selfClosing = useRef(false);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;

    if (isOpen && !el.open) {
      el.showModal();
    } else if (!isOpen && el.open) {
      selfClosing.current = true;
      el.close();
      selfClosing.current = false;
    }
  }, [isOpen]);

  // `showModal()` makes the page inert but does NOT lock its scroll, so the
  // content behind the modal still scrolls under the wheel. This stays.
  useEffect(() => {
    if (!isOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      aria-label={label}
      onCancel={(e) => {
        // The `cancel` event IS Escape. Vetoing it is how a native dialog
        // declines to be dismissed.
        if (!dismissible) e.preventDefault();
      }}
      onClose={() => {
        if (!selfClosing.current) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === dialogRef.current) onClose();
      }}
    >
      <article className="ui-modal__panel" style={{ maxWidth }}>
        {showClose && (
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
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        )}

        {children}
      </article>
    </dialog>
  );
}
