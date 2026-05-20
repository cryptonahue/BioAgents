import { useState } from 'preact/hooks';
import { Modal } from './ui/Modal';

const ROLES = [
  'Researcher',
  'Conservation',
  'Investor',
  'Developer',
  'Student',
  'Other',
];

interface WaitlistModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTestAgent?: () => void;
}

export function WaitlistModal({ isOpen, onClose, onTestAgent }: WaitlistModalProps) {
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    wallet_address: '',
    role: '',
    organization: '',
    use_case: '',
    referral_source: '',
    twitter_handle: '',
    agreed_to_updates: false,
  });

  const updateField = (field: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
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

  const handleClose = () => {
    onClose();
    setTimeout(() => {
      setSubmitted(false);
      setError('');
    }, 300);
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} maxWidth="520px">
      {submitted ? (
        <div className="waitlist-success">
          <h2>You're on the list!</h2>
          <p>
            We'll notify you when access opens. Want to try sooner? Whitelisted
            users can Test Agent today.
          </p>
          {onTestAgent && (
            <button type="button" className="btn-coral" onClick={onTestAgent}>
              Test Agent
            </button>
          )}
        </div>
      ) : (
        <form className="waitlist-form" onSubmit={handleSubmit}>
          <h2>Join the CoralGPT Waitlist</h2>
          <p className="waitlist-form-subtitle">
            Be first to know when we expand access. Your answers help us build
            the right product for coral science.
          </p>

          {error && <div className="waitlist-error">{error}</div>}

          <div className="waitlist-field">
            <label htmlFor="wl-name">Full Name *</label>
            <input
              id="wl-name"
              required
              value={form.full_name}
              onInput={(e) => updateField('full_name', (e.target as HTMLInputElement).value)}
            />
          </div>

          <div className="waitlist-field">
            <label htmlFor="wl-email">Email *</label>
            <input
              id="wl-email"
              type="email"
              required
              value={form.email}
              onInput={(e) => updateField('email', (e.target as HTMLInputElement).value)}
            />
          </div>

          <div className="waitlist-field">
            <label htmlFor="wl-wallet">Wallet Address</label>
            <input
              id="wl-wallet"
              placeholder="0x..."
              value={form.wallet_address}
              onInput={(e) => updateField('wallet_address', (e.target as HTMLInputElement).value)}
            />
          </div>

          <div className="waitlist-field">
            <label htmlFor="wl-role">Role *</label>
            <select
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

          <div className="waitlist-field">
            <label htmlFor="wl-org">Organization (optional)</label>
            <input
              id="wl-org"
              value={form.organization}
              onInput={(e) => updateField('organization', (e.target as HTMLInputElement).value)}
            />
          </div>

          <div className="waitlist-field">
            <label htmlFor="wl-use-case">What would you use CoralGPT for? *</label>
            <textarea
              id="wl-use-case"
              required
              value={form.use_case}
              onInput={(e) => updateField('use_case', (e.target as HTMLTextAreaElement).value)}
            />
          </div>

          <div className="waitlist-field">
            <label htmlFor="wl-referral">How did you hear about us?</label>
            <input
              id="wl-referral"
              placeholder="Twitter / Friend / Event..."
              value={form.referral_source}
              onInput={(e) => updateField('referral_source', (e.target as HTMLInputElement).value)}
            />
          </div>

          <div className="waitlist-field">
            <label htmlFor="wl-twitter">X / Twitter handle (optional)</label>
            <input
              id="wl-twitter"
              placeholder="@"
              value={form.twitter_handle}
              onInput={(e) => updateField('twitter_handle', (e.target as HTMLInputElement).value)}
            />
          </div>

          <label className="waitlist-checkbox">
            <input
              type="checkbox"
              checked={form.agreed_to_updates}
              onChange={(e) =>
                updateField('agreed_to_updates', (e.target as HTMLInputElement).checked)
              }
            />
            <span>I agree to receive updates about CoralGPT and $CRLAI</span>
          </label>

          <button type="submit" className="btn-coral" disabled={loading} style={{ width: '100%' }}>
            {loading ? 'Submitting...' : 'Join Waitlist'}
          </button>
        </form>
      )}
    </Modal>
  );
}
