import { useState } from "preact/hooks";
import { useIsSignedIn } from "@coinbase/cdp-hooks";
import { useSignInWithEmail } from "@coinbase/cdp-hooks";
import { useVerifyEmailOTP } from "@coinbase/cdp-hooks";
import { useEvmAddress } from "@coinbase/cdp-hooks";
import { useSignOut } from "@coinbase/cdp-hooks";

interface EmbeddedWalletAuthProps {
  onWalletConnected?: (address: string) => void;
  usdcBalance?: string;
}

/**
 * Presentation lives in `styles/wallet.css` (`.wallet-*`). This component used
 * to carry 91 hardcoded color literals in inline `style={{}}` props — a private
 * dark theme that PR 2's token sweep never reached, so every panel here stayed
 * black in light mode. It also reimplemented `:hover` with `onMouseOver` /
 * `onMouseOut` handlers, which is why none of these controls had a focus ring.
 */
export function EmbeddedWalletAuth({ onWalletConnected, usdcBalance }: EmbeddedWalletAuthProps) {
  const { isSignedIn } = useIsSignedIn();
  const { signInWithEmail } = useSignInWithEmail();
  const { verifyEmailOTP } = useVerifyEmailOTP();
  const { signOut } = useSignOut();
  const { evmAddress } = useEvmAddress();

  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [flowId, setFlowId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  const handleEmailSubmit = async (e: Event) => {
    e.preventDefault();
    if (!email || isSigningIn) return;

    setError(null);
    setIsSigningIn(true);
    try {
      const result = await signInWithEmail({ email });
      setFlowId(result.flowId);
    } catch (err: any) {
      console.error("Sign in failed:", err);
      setError(err?.message || "Failed to send verification code. Please try again.");
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleOtpSubmit = async (e: Event) => {
    e.preventDefault();
    if (!flowId || !otp || isVerifying) return;

    setError(null);
    setIsVerifying(true);
    try {
      const { user } = await verifyEmailOTP({ flowId, otp });

      const address = user.evmAccounts?.[0];
      if (address && onWalletConnected) {
        onWalletConnected(address);
      }

      setFlowId(null);
      setOtp("");
      setEmail("");
    } catch (err: any) {
      console.error("OTP verification failed:", err);
      setError(err?.message || "Invalid verification code. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut();
      setFlowId(null);
      setOtp("");
      setEmail("");
      setError(null);
    } catch (err: any) {
      console.error("Sign out failed:", err);
      setError(err?.message || "Failed to sign out.");
    }
  };

  const handleBack = () => {
    setFlowId(null);
    setOtp("");
    setError(null);
  };

  const handleCopyAddress = () => {
    if (!evmAddress) return;
    navigator.clipboard.writeText(evmAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const errorBanner = error && (
    <div className="wallet-error" role="alert">
      <svg
        className="wallet-error__icon"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <span>{error}</span>
    </div>
  );

  // Connected state — show wallet info
  if (isSignedIn && evmAddress) {
    return (
      <div className="wallet-connected">
        <div className="wallet-connected__row">
          <div className="wallet-connected__status">
            <span className="wallet-connected__dot" aria-hidden="true" />
            <div className="wallet-connected__meta">
              <div className="wallet-connected__labels">
                <span className="wallet-connected__label">Wallet Connected</span>
                {usdcBalance && (
                  <span className="wallet-connected__balance">${usdcBalance} USDC</span>
                )}
              </div>
              <div className="wallet-connected__address">
                {evmAddress.slice(0, 8)}...{evmAddress.slice(-6)}
              </div>
            </div>
          </div>

          <div className="wallet-connected__actions">
            <button
              type="button"
              onClick={handleCopyAddress}
              className="wallet-chip wallet-chip--accent"
              data-copied={copied ? "true" : "false"}
            >
              {copied ? (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                  </svg>
                  Copy
                </>
              )}
            </button>
            <button type="button" onClick={handleSignOut} className="wallet-chip wallet-chip--muted">
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // OTP verification state
  if (flowId) {
    const otpComplete = otp.length === 6;

    return (
      <div className="wallet-panel">
        <div className="wallet-panel__header">
          <div className="wallet-panel__badge wallet-panel__badge--round">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
              <polyline points="22,6 12,13 2,6"></polyline>
            </svg>
          </div>
          <h3 className="wallet-panel__title">Check Your Email</h3>
          <p className="wallet-panel__subtitle">We sent a 6-digit verification code to</p>
          <p className="wallet-panel__email">{email}</p>
        </div>

        <form onSubmit={handleOtpSubmit}>
          <div className="field wallet-field">
            <label className="label wallet-label" for="wallet-otp">
              Verification Code
            </label>
            <input
              id="wallet-otp"
              type="text"
              value={otp}
              onChange={(e) => setOtp((e.target as HTMLInputElement).value)}
              placeholder="000000"
              maxLength={6}
              autoFocus
              disabled={isVerifying}
              class={`input wallet-input--otp${otpComplete ? " wallet-input--complete" : ""}`}
            />
          </div>

          {errorBanner}

          <div className="payment-modal__actions">
            <button
              type="button"
              onClick={handleBack}
              disabled={isVerifying}
              className="wallet-btn wallet-btn--secondary"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={isVerifying || !otpComplete}
              className="wallet-btn wallet-btn--primary"
            >
              {isVerifying && <span className="wallet-btn__spinner" aria-hidden="true" />}
              {isVerifying ? "Verifying..." : "Verify Code"}
            </button>
          </div>
        </form>
      </div>
    );
  }

  // Email input state — initial onboarding
  return (
    <div className="wallet-panel">
      <div className="wallet-panel__header">
        <div className="wallet-panel__badge wallet-panel__badge--square">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
        </div>
        <h3 className="wallet-panel__title">Welcome to BioAgents</h3>
        <p className="wallet-panel__subtitle">Create your secure wallet with just your email</p>
        <p className="wallet-panel__hint">No extensions • No seed phrases • 100% self-custodial</p>
      </div>

      <form onSubmit={handleEmailSubmit}>
        <div className="field wallet-field">
          <label className="label wallet-label" for="wallet-email">
            Email Address
          </label>
          <input
            id="wallet-email"
            type="email"
            value={email}
            onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
            placeholder="you@example.com"
            required
            disabled={isSigningIn}
            autoFocus
            className="input"
          />
        </div>

        {errorBanner}

        <button
          type="submit"
          disabled={isSigningIn || !email}
          className="wallet-btn wallet-btn--primary wallet-btn--block"
        >
          {isSigningIn && <span className="wallet-btn__spinner" aria-hidden="true" />}
          {isSigningIn ? "Sending Code..." : "Continue with Email"}
          {!isSigningIn && (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12"></line>
              <polyline points="12 5 19 12 12 19"></polyline>
            </svg>
          )}
        </button>
      </form>

      <div className="wallet-note">
        <div className="wallet-note__row">
          <div className="wallet-note__icon">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            </svg>
          </div>
          <div>
            <p className="wallet-note__title">Secure &amp; Self-Custodial</p>
            <p className="wallet-note__body">
              Your wallet is secured by your email. Only you have access to your funds. We never store
              your private keys.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
