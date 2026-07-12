import { useState, useEffect } from 'preact/hooks';
import { Modal } from './ui/Modal';
import {
  EMPTY_WAITLIST_FORM,
  ROLES,
  STEP_COUNT,
  WAITLIST_STEPS,
  advance,
  goBack,
  isLastStep,
  progressPercent,
  stepNumber,
  validateStep,
  type WaitlistForm,
} from './waitlistSteps';

interface WaitlistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTestAgent?: () => void;
}

/**
 * THE FORM IS THREE STEPS, AND `form` IS NOT.
 *
 * The step index selects which fields are RENDERED; it never owns their values.
 * That is the whole reason Back is lossless — going back unmounts a step's inputs
 * but `form` lives up here, so walking forward again re-renders them with
 * everything the user typed. There is no per-step state to resynchronise and no
 * draft to merge.
 *
 * The step machine itself is in `waitlistSteps.ts` — pure, no hooks, and tested
 * directly (see `__tests__/waitlistSteps.test.ts`). What stays here is the DOM.
 *
 * THE API CONTRACT IS UNCHANGED. `handleSubmit` still POSTs `JSON.stringify(form)`
 * — the same nine keys, the same endpoint — because `form` is still the same
 * object it always was. Splitting the form changed WHEN fields are shown, not
 * WHAT is sent.
 *
 * `noValidate` IS DELIBERATE. With native validation on, Enter or Next on an empty
 * required field pops the browser's own bubble and our `.alert` never runs — two
 * competing error surfaces, one of which cannot be styled or focused. The
 * `required` attributes STAY (they are what tells a screen reader the field is
 * required); only the browser's UI for them is off.
 */
export function WaitlistModal({ isOpen, onClose, onTestAgent }: WaitlistModalProps) {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WaitlistForm>(EMPTY_WAITLIST_FORM);

  const updateField = (field: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const current = WAITLIST_STEPS[step];

  // On entering a step, move focus to its first control. Without this, focus
  // stays on the Next button the user just pressed — which is now a DIFFERENT
  // step's Next button — and a keyboard user has to Shift-Tab backwards into the
  // form they were just sent to.
  useEffect(() => {
    if (!isOpen || submitted) return;
    const el = document.getElementById(current.firstFieldId);
    if (el) (el as HTMLElement).focus();
  }, [step, isOpen, submitted, current.firstFieldId]);

  const doSubmit = async () => {
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || 'Failed to join waitlist');
        return;
      }

      setSubmitted(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  /**
   * ONE submit handler for the whole form, dispatching on the step. This is what
   * makes Enter behave: a native form submits on Enter in any text field, so on
   * steps 1 and 2 that keystroke ADVANCES (after validating) instead of firing a
   * half-empty payload at the server. Only the last step actually submits.
   */
  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (loading) return;

    if (!isLastStep(step)) {
      const next = advance(step, form);
      setError(next.error ?? '');
      setStep(next.step);
      return;
    }

    // Belt and braces: the user cannot reach the last step without passing the
    // earlier ones, but re-check rather than trust the path taken to get here.
    // If something IS wrong, send them back to the step that owns it — reporting
    // "enter your email" on a screen with no email field would be a dead end.
    const firstBad = WAITLIST_STEPS.findIndex((_, i) => validateStep(i, form) !== null);
    if (firstBad !== -1) {
      setError(validateStep(firstBad, form) ?? '');
      setStep(firstBad);
      return;
    }

    void doSubmit();
  };

  const handleBack = () => {
    setError('');
    setStep((s) => goBack(s));
  };

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      setSubmitted(false);
      setError('');
      setStep(0);
      setForm(EMPTY_WAITLIST_FORM);
    }, 300);
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} maxWidth="520px">
      {submitted ? (
        <div className="card waitlist-success">
          <header>
            <h2>You're on the list!</h2>
            <p>
              We'll notify you when access opens. Want to try sooner? Whitelisted
              users can Test Agent today.
            </p>
          </header>
          {onTestAgent && (
            <section>
              <button
                type="button"
                className="btn btn-marketing"
                data-variant="outline"
                data-tone="coral"
                onClick={onTestAgent}
              >
                Test Agent
              </button>
            </section>
          )}
        </div>
      ) : (
        <form className="card waitlist-form" onSubmit={handleSubmit} noValidate>
          <header>
            <h2>Join the CoralGPT Waitlist</h2>
            <p>
              Be first to know when we expand access. Your answers help us build
              the right product for coral science.
            </p>

            {/* Basecoat ships `.progress` (a track plus a `> span` fill) and it is
                used here rather than inventing a bar. Lyra gives it the flex box,
                the `overflow-hidden` clip and the fill's transition; it ships no
                height and no colour, which `coralgpt.css` supplies from tokens.
                The ARIA is rendered by Preact — there is no Basecoat JS. */}
            <div className="waitlist-progress-row">
              <div
                className="progress waitlist-progress"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={STEP_COUNT}
                aria-valuenow={stepNumber(step)}
                aria-label={`Step ${stepNumber(step)} of ${STEP_COUNT}: ${current.title}`}
              >
                <span style={{ width: `${progressPercent(step)}%` }} />
              </div>
              <p className="waitlist-progress-label">
                Step {stepNumber(step)} of {STEP_COUNT}
              </p>
            </div>
          </header>

          <section>
            <h3 className="waitlist-step-title" id={`wl-step-${current.id}`}>
              {current.title}
            </h3>
            <p className="waitlist-step-description">{current.description}</p>

            {error && (
              <div className="alert" data-tone="danger" data-variant="default" role="alert">
                <strong>{error}</strong>
              </div>
            )}

            {step === 0 && (
              <>
                <div className="field">
                  <label className="label" htmlFor="wl-name">
                    Full Name *
                  </label>
                  <input
                    className="input"
                    id="wl-name"
                    required
                    value={form.full_name}
                    onInput={(e) => updateField('full_name', (e.target as HTMLInputElement).value)}
                  />
                </div>

                <div className="field">
                  <label className="label" htmlFor="wl-email">
                    Email *
                  </label>
                  <input
                    className="input"
                    id="wl-email"
                    type="email"
                    required
                    value={form.email}
                    onInput={(e) => updateField('email', (e.target as HTMLInputElement).value)}
                  />
                </div>

                <div className="field">
                  <label className="label" htmlFor="wl-wallet">
                    Wallet Address
                  </label>
                  <input
                    className="input"
                    id="wl-wallet"
                    placeholder="0x..."
                    value={form.wallet_address}
                    onInput={(e) => updateField('wallet_address', (e.target as HTMLInputElement).value)}
                  />
                </div>
              </>
            )}

            {step === 1 && (
              <>
                <div className="field">
                  <label className="label" htmlFor="wl-role">
                    Role *
                  </label>
                  <select
                    className="select"
                    id="wl-role"
                    required
                    value={form.role}
                    onChange={(e) => updateField('role', (e.target as HTMLSelectElement).value)}
                  >
                    <option value="">Select...</option>
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {role}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="label" htmlFor="wl-org">
                    Organization (optional)
                  </label>
                  <input
                    className="input"
                    id="wl-org"
                    value={form.organization}
                    onInput={(e) => updateField('organization', (e.target as HTMLInputElement).value)}
                  />
                </div>

                <div className="field">
                  <label className="label" htmlFor="wl-use-case">
                    What would you use CoralGPT for? *
                  </label>
                  <textarea
                    className="textarea"
                    id="wl-use-case"
                    required
                    value={form.use_case}
                    onInput={(e) => updateField('use_case', (e.target as HTMLTextAreaElement).value)}
                  />
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div className="field">
                  <label className="label" htmlFor="wl-referral">
                    How did you hear about us?
                  </label>
                  <input
                    className="input"
                    id="wl-referral"
                    placeholder="Twitter / Friend / Event..."
                    value={form.referral_source}
                    onInput={(e) => updateField('referral_source', (e.target as HTMLInputElement).value)}
                  />
                </div>

                <div className="field">
                  <label className="label" htmlFor="wl-twitter">
                    X / Twitter handle (optional)
                  </label>
                  <input
                    className="input"
                    id="wl-twitter"
                    placeholder="@"
                    value={form.twitter_handle}
                    onInput={(e) => updateField('twitter_handle', (e.target as HTMLInputElement).value)}
                  />
                </div>

                {/* The opt-in is a HORIZONTAL field, i.e. the checkbox and its label
                    as SIBLINGS. Nesting the input inside the label is the other
                    shape Basecoat supports, and Lyra skins that one as a bordered,
                    tinted "checkbox card" (`.field > label:has(input[type=checkbox])`
                    gets `border` + `p-2` + `has-[:checked]:bg-primary/5`), which is
                    not what this row is. */}
                <div className="field waitlist-consent" data-orientation="horizontal">
                  <input
                    className="input"
                    type="checkbox"
                    id="wl-updates"
                    checked={form.agreed_to_updates}
                    onChange={(e) =>
                      updateField('agreed_to_updates', (e.target as HTMLInputElement).checked)
                    }
                  />
                  <label className="label" htmlFor="wl-updates">
                    I agree to receive updates about CoralGPT and $CRLAI
                  </label>
                </div>
              </>
            )}

            <div className="waitlist-actions">
              {step > 0 && (
                <button
                  type="button"
                  className="btn"
                  data-variant="outline"
                  onClick={handleBack}
                  disabled={loading}
                >
                  Back
                </button>
              )}

              {/* Both are `type="submit"`, which is what routes Enter through
                  `handleSubmit` and lets it decide: advance, or send. */}
              <button
                type="submit"
                className="btn btn-marketing waitlist-submit"
                data-variant="outline"
                data-tone="coral"
                disabled={loading}
              >
                {isLastStep(step)
                  ? loading
                    ? 'Submitting...'
                    : 'Join Waitlist'
                  : 'Continue'}
              </button>
            </div>
          </section>
        </form>
      )}
    </Modal>
  );
}
