import { useState, useEffect } from 'preact/hooks';
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

/**
 * The 3-step access request form.
 *
 * ---------------------------------------------------------------------------
 * IT IS NO LONGER A MODAL, AND THAT IS THE POINT.
 *
 * This is the body of the old `WaitlistModal`, lifted out of `ui/Modal` and
 * rendered INLINE by `AccessPendingPage`. Three reasons, in order of weight:
 *
 *   1. A modal INTERRUPTS a task. Post-auth there is no task to interrupt — the
 *      page behind this form is a bare "you cannot come in yet" notice, so a
 *      dialog would be a dialog over nothing. The form IS the page's purpose,
 *      and the thing a page exists to do belongs in the page.
 *
 *   2. THE MODAL HAD EXACTLY ONE REMAINING CALLER. The landing's pre-auth
 *      waitlist form is gone (one door — you sign in, and the system decides
 *      what you see), so `WaitlistModal` would have been a dialog wrapper opened
 *      unconditionally by a single consumer. That is a page with extra steps.
 *
 *   3. It walks away from a live layout hazard. Lyra's `.card` is
 *      `overflow-hidden`, and a non-`visible` overflow computes a flex item's
 *      `min-height: auto` to ZERO — which already clipped this very form inside
 *      `.dialog` once, with no scrollbar to escape by. It is guarded with
 *      `flex-shrink: 0`, but the guard is only needed because the form was in a
 *      dialog. Out of the dialog, the hazard is not guarded against; it is
 *      absent.
 *
 * ---------------------------------------------------------------------------
 * The step machine (`waitlistSteps.ts`) is REUSED VERBATIM — pure, hook-free and
 * already unit-tested. The step index selects which fields are RENDERED; `form`
 * lives up here and owns their values, which is what makes Back lossless.
 *
 * PREFILL: identity is established by Privy BEFORE this form runs, so the email
 * and wallet we already hold are filled in rather than retyped. Email stays
 * REQUIRED and editable — a wallet-only user has none upstream, and it is the
 * channel the approval notification goes out on.
 *
 * `noValidate` IS DELIBERATE. With native validation on, Enter on an empty
 * required field pops the browser's own bubble and our `.alert` never runs — two
 * competing error surfaces, one of which cannot be styled or focused. The
 * `required` attributes STAY (they are what tells a screen reader the field is
 * required); only the browser's UI for them is off.
 */

export interface AccessRequestFormProps {
  /** From the verified Privy identity. */
  prefill?: { email?: string | null; walletAddress?: string | null };
  /** Resolves to the Privy access token — the auth for POST /api/access-request. */
  getAccessToken: () => Promise<string | null>;
  /** Fired once the request is accepted, so the page can swap to the notice. */
  onSubmitted: () => void;
}

export function AccessRequestForm({
  prefill,
  getAccessToken,
  onSubmitted,
}: AccessRequestFormProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<WaitlistForm>(EMPTY_WAITLIST_FORM);

  // Seed from the Privy identity. Guarded on the CURRENT value rather than a
  // "did we prefill yet" flag: `prefill` arrives asynchronously (the Privy user
  // resolves after mount), and this way a late arrival still fills an untouched
  // field while never clobbering something the user has already typed.
  useEffect(() => {
    if (!prefill) return;
    setForm((prev) => ({
      ...prev,
      email: prev.email || prefill.email || '',
      wallet_address: prev.wallet_address || prefill.walletAddress || '',
    }));
  }, [prefill?.email, prefill?.walletAddress]);

  const updateField = (field: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const current = WAITLIST_STEPS[step];

  // On entering a step, move focus to its first control. Without this, focus
  // stays on the Continue button the user just pressed — which is now a
  // DIFFERENT step's button — and a keyboard user has to Shift-Tab backwards
  // into the form they were just sent to.
  useEffect(() => {
    const el = document.getElementById(current.firstFieldId);
    if (el) (el as HTMLElement).focus();
  }, [step, current.firstFieldId]);

  const doSubmit = async () => {
    setError('');
    setLoading(true);

    try {
      // The Privy token IS the auth for this endpoint — a pending user holds no
      // JWT, and minting one would open every guarded route in the app. See the
      // header of `src/routes/access-request.ts`.
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setError('Your session expired. Please sign in again.');
        return;
      }

      const response = await fetch('/api/access-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken, ...form }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || 'Failed to submit your request.');
        return;
      }

      onSubmitted();
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

  return (
    <form className="card waitlist-form" onSubmit={handleSubmit} noValidate>
      <header>
        <h2>Request access</h2>
        <p>
          CoralGPT is in private beta. Tell us who you are and what you would use
          it for — we approve researchers individually.
        </p>

        {/* Basecoat ships `.progress` (a track plus a `> span` fill) and it is
            used here rather than inventing a bar. Lyra gives it the flex box, the
            `overflow-hidden` clip and the fill's transition; it ships no height
            and no colour, which `coralgpt.css` supplies from tokens. The ARIA is
            rendered by Preact — there is no Basecoat JS. */}
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
              {/* Email is REQUIRED even though Privy may not have one: it is how
                  we tell them they were approved. */}
              <p className="waitlist-field-hint">
                We will email you here when your access is approved.
              </p>
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
                onInput={(e) =>
                  updateField('wallet_address', (e.target as HTMLInputElement).value)
                }
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
              {/* Basecoat ships TWO selects: `.select:not(select)` is the JS
                  listbox, `select.select` is the native element with no JS. This
                  is the native one — no Basecoat JS is loaded anywhere. */}
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
                onInput={(e) =>
                  updateField('organization', (e.target as HTMLInputElement).value)
                }
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
                onInput={(e) =>
                  updateField('use_case', (e.target as HTMLTextAreaElement).value)
                }
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
                onInput={(e) =>
                  updateField('referral_source', (e.target as HTMLInputElement).value)
                }
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
                onInput={(e) =>
                  updateField('twitter_handle', (e.target as HTMLInputElement).value)
                }
              />
            </div>

            {/* The opt-in is a HORIZONTAL field, i.e. the checkbox and its label
                as SIBLINGS. Nesting the input inside the label is the other shape
                Basecoat supports, and Lyra skins that one as a bordered, tinted
                "checkbox card" (`.field > label:has(input[type=checkbox])` gets
                `border` + `p-2` + `has-[:checked]:bg-primary/5`), which is not
                what this row is. */}
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
                : 'Submit request'
              : 'Continue'}
          </button>
        </div>
      </section>
    </form>
  );
}
