import { route } from 'preact-router';
import { usePrivy } from '@privy-io/react-auth';
import { useAuth } from '../hooks';
import { WaitlistModal } from '../components/WaitlistModal';
import { useState } from 'preact/hooks';
import { useLandingScroll } from '../hooks/useLandingScroll';

export function AccessPendingPage() {
  useLandingScroll();
  const { userEmail } = useAuth();
  const { user } = usePrivy();
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  const displayEmail =
    userEmail ||
    user?.email?.address ||
    user?.google?.email ||
    'your account';

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
      </header>

      <div className="access-pending-content">
        <div className="access-pending-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </div>
        <h1>Access Pending Approval</h1>
        <p>You're signed in as {displayEmail}</p>
        <p>Your account isn't whitelisted yet.</p>
        <p>
          CoralGPT is in early access. Join the waitlist and we'll notify you
          when your spot opens.
        </p>

        <div className="access-pending-actions">
          <button type="button" className="btn-coral" onClick={() => setWaitlistOpen(true)}>
            Join Waitlist
          </button>
          <button type="button" className="btn-ghost" onClick={() => route('/', true)}>
            Back to Home
          </button>
        </div>

        <p className="access-pending-support">
          Already approved? Contact support@coralgpt.xyz
        </p>
      </div>

      <WaitlistModal isOpen={waitlistOpen} onClose={() => setWaitlistOpen(false)} />
    </div>
  );
}
