import { useEffect, useState } from 'preact/hooks';
import { route } from 'preact-router';
import { usePrivy } from '@privy-io/react-auth';
import { useAuth } from '../hooks';
import { AccessRequestForm } from '../components/AccessRequestForm';
import { ThemeToggle } from '../components/ThemeToggle';
import { useLandingScroll } from '../hooks/useLandingScroll';

/**
 * The second half of the funnel — and no longer a dead end.
 *
 * You only arrive here by signing in and NOT being whitelisted. What you see is
 * decided by the state the server just reported:
 *
 *   no request yet   -> the 3-step request form, PREFILLED from the Privy
 *                       identity. Submitting writes a `waitlist_leads` row that
 *                       hangs off a real `user_id`.
 *   already asked    -> "Your request is under review." Plus sign-out.
 *   approved         -> you never land here; `/chat` is where you go.
 *
 * The form is INLINE, not a modal. See the header of `AccessRequestForm` for
 * why — briefly: the form IS this page's purpose, so there is nothing for a
 * dialog to interrupt.
 *
 * This page THEMES (light and dark). It was un-pinned from dark in an earlier
 * commit and that stands: the toggle in the footer is real here, exactly as it
 * is on the landing.
 */

type RequestState = 'checking' | 'needs-request' | 'under-review';

export function AccessPendingPage() {
  useLandingScroll();
  const { userEmail, isAuthenticated } = useAuth();
  const { user, ready, authenticated, getAccessToken, logout } = usePrivy();
  const [state, setState] = useState<RequestState>('checking');
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(userEmail);

  // Whitelisted already? Then this page is not for you.
  useEffect(() => {
    if (isAuthenticated) route('/chat', true);
  }, [isAuthenticated]);

  /**
   * Ask the server where we stand.
   *
   * `/api/auth/privy` is the ONE call that knows: it reports
   * `{ whitelisted, hasRequest, email, walletAddress }` on its 403. Re-asking it
   * here (rather than trusting state handed over by the landing) is what makes a
   * RELOAD of this URL work — a user who bookmarks it, or refreshes after
   * submitting, still gets the right screen.
   */
  useEffect(() => {
    if (!ready || !authenticated) return;

    let cancelled = false;

    (async () => {
      try {
        const accessToken = await getAccessToken();
        if (!accessToken) return;

        const res = await fetch('/api/auth/privy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken }),
        });
        const data = await res.json();
        if (cancelled) return;

        if (data.whitelisted) {
          route('/chat', true);
          return;
        }

        if (data.email) setEmail(data.email);
        if (data.walletAddress) setWalletAddress(data.walletAddress);
        setState(data.hasRequest ? 'under-review' : 'needs-request');
      } catch {
        // The server is unreachable. Show the form rather than a spinner that
        // never resolves: submitting is idempotent server-side (a user who
        // already asked gets `alreadyRequested`, not a duplicate row), so the
        // worst case is a form they did not need — not a broken page.
        if (!cancelled) setState('needs-request');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, authenticated]);

  const displayEmail = email || user?.email?.address || user?.google?.email || null;

  const handleSignOut = async () => {
    await logout();
    route('/', true);
  };

  return (
    <div className="access-pending-page">
      <header className="landing-header">
        <a href="/" className="landing-brand">
          <img src="/images/token.png" alt="CoralGPT" width={32} height={32} />
          <span className="landing-brand-text">
            <span className="coral">CORAL</span>
            <span className="gpt">GPT</span>
          </span>
        </a>
        <div className="landing-nav-actions">
          <button
            type="button"
            className="btn btn-marketing"
            data-variant="outline"
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      </header>

      <div className="access-pending-content">
        {state === 'checking' && (
          <p className="access-pending-checking" role="status">
            Checking your access…
          </p>
        )}

        {state === 'needs-request' && (
          <AccessRequestForm
            prefill={{ email: displayEmail, walletAddress }}
            getAccessToken={getAccessToken}
            onSubmitted={() => setState('under-review')}
          />
        )}

        {state === 'under-review' && (
          <div className="card access-pending-card">
            <header>
              <div className="access-pending-icon" aria-hidden="true">
                <svg
                  width="28"
                  height="28"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <h1>Your request is under review</h1>
              <p>
                Thanks — we have your request.
                {displayEmail ? ` We will email ${displayEmail} ` : ' We will email you '}
                as soon as your access is approved.
              </p>
            </header>
            <section>
              <p className="access-pending-note">
                CoralGPT is in private beta and we approve researchers
                individually, so this usually takes a few days. You do not need
                to do anything else.
              </p>
            </section>
            <footer>
              <button
                type="button"
                className="btn btn-marketing"
                data-variant="outline"
                onClick={() => route('/', true)}
              >
                Back to home
              </button>
              <button
                type="button"
                className="btn btn-marketing"
                data-variant="outline"
                onClick={handleSignOut}
              >
                Sign out
              </button>
            </footer>
          </div>
        )}

        <p className="access-pending-support">
          Already approved but still seeing this? Contact support@coralgpt.xyz
        </p>
      </div>

      <footer className="landing-footer">
        <div className="landing-footer-legal">
          © 2026 CoralGPT · BioAgent powered by $CRLAI
        </div>
        {/* Hidden while light mode is disabled (dark-only); see
            LIGHT_MODE_ENABLED in contexts/ThemeContext.tsx. */}
        {/* <ThemeToggle /> */}
      </footer>
    </div>
  );
}
