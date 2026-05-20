import { useState } from 'preact/hooks';

export function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!password.trim()) {
      setError('Please enter a password');
      return;
    }

    setIsLoading(true);
    setError('');

    try {
      const isValid = await onLogin(password);
      if (!isValid) {
        setError('Invalid password');
        setPassword('');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
      setPassword('');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-container">
        <div className="login-header">
          <div className="login-logo-icon">
            <img
              src="/images/token.png"
              alt="BioAgents"
              width={48}
              height={48}
              decoding="async"
            />
          </div>
          <h1 className="login-title">
            <span className="login-title-bio">BIO</span>
            <span className="login-title-agents">AGENTS</span>
          </h1>
          <p className="login-subtitle">
            Enter password to access the development UI
          </p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-input-group">
            <input
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              placeholder="Enter password"
              className="login-input"
              autoFocus
            />
          </div>

          {error && (
            <div className="login-error">
              {error}
            </div>
          )}

          <button type="submit" className="login-button" disabled={isLoading}>
            {isLoading ? 'Verifying...' : 'Access UI'}
          </button>
        </form>

        <div className="login-footer">
          <p>This is a development interface for the BioAgents framework</p>
        </div>
      </div>
    </div>
  );
}
