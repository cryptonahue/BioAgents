import './utils/crypto-polyfill';
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import Router, { route } from 'preact-router';
import { usePrivy } from '@privy-io/react-auth';
import { CDPProvider } from './providers/CDPProvider';
import { CoralPrivyProvider } from './providers/PrivyProvider';
import { AuthProvider } from './contexts';
import { ProvenanceProvider } from './contexts/ProvenanceContext';
import { LoginPage, ChatPage, LandingPage, AccessPendingPage, LibraryPage, PaperPage, ResearchBrainPage, CorpusDashboardPage, AdminPage, ViewerPage, LibraryViewerPage } from './pages';
import { useAuth } from './hooks';
import { Footer } from './components/Footer';
import './styles/global.css';
import './styles/coralgpt.css';
import './styles/library.css';
import './styles/corpus.css';
import './styles/admin.css';
import './styles/provenance.css';

function LoadingScreen() {
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: 'var(--bg-primary, #0a0a0a)',
      color: 'var(--text-secondary, #a1a1a1)',
    }}>
      Loading...
    </div>
  );
}

function LegacyAppShell() {
  const { isAuthenticated, isAuthRequired, isChecking, isLoggingOut } = useAuth();

  useEffect(() => {
    if (isChecking || isLoggingOut) return;

    const currentPath = window.location.pathname;

    if (isAuthRequired && !isAuthenticated && currentPath !== '/login') {
      route('/login', true);
    }

    if (isAuthenticated && currentPath === '/login') {
      route('/chat', true);
    }
  }, [isAuthenticated, isAuthRequired, isChecking, isLoggingOut]);

  const handleRouteChange = (e) => {
    const { url } = e;
    if (isChecking || isLoggingOut) return;

    if (isAuthRequired && !isAuthenticated && url !== '/login') {
      route('/login', true);
    }

    if (isAuthenticated && url === '/login') {
      route('/chat', true);
    }
  };

  if (isChecking) {
    return <LoadingScreen />;
  }

  return (
    <>
      <Router onChange={handleRouteChange}>
        <LoginPage path="/login" />
        <ChatPage path="/chat/:sessionId?" />
        <LibraryPage path="/library" />
        <PaperPage path="/library/:docId" />
        <LibraryViewerPage path="/library/:docId/viewer" />
        <ViewerPage path="/viewer/:sourceId" />
        <ResearchBrainPage path="/brain" />
        <CorpusDashboardPage path="/corpus" />
        <AdminPage path="/admin" />
        <Redirect path="/" to="/chat" />
        <NotFound default redirectTo="/chat" />
      </Router>
      <Footer />
    </>
  );
}

function CoralAppShell() {
  const { isAuthenticated, isChecking, isLoggingOut } = useAuth();
  const { logout: privyLogout } = usePrivy();

  useEffect(() => {
    document.body.classList.add('coralgpt-theme');
    return () => document.body.classList.remove('coralgpt-theme');
  }, []);

  useEffect(() => {
    if (isChecking || isLoggingOut) return;

    const currentPath = window.location.pathname;
    if (currentPath.startsWith('/chat') && !isAuthenticated) {
      route('/', true);
    }
  }, [isAuthenticated, isChecking, isLoggingOut]);

  const handleRouteChange = (e) => {
    const { url } = e;
    if (isChecking || isLoggingOut) return;

    if (url.startsWith('/chat') && !isAuthenticated) {
      route('/', true);
    }
  };

  if (isChecking) {
    return <LoadingScreen />;
  }

  return (
    <>
      <Router onChange={handleRouteChange}>
        <LandingPage path="/" />
        <AccessPendingPage path="/access-pending" />
        <ChatPage path="/chat/:sessionId?" coralGptMode privyLogout={privyLogout} />
        <LibraryPage path="/library" coralGptMode />
        <PaperPage path="/library/:docId" coralGptMode />
        <LibraryViewerPage path="/library/:docId/viewer" coralGptMode />
        <ViewerPage path="/viewer/:sourceId" coralGptMode />
        <ResearchBrainPage path="/brain" coralGptMode />
        <AdminPage path="/admin" />
        <NotFound default redirectTo="/" />
      </Router>
      <Footer />
    </>
  );
}

function Redirect({ to }) {
  useEffect(() => {
    route(to, true);
  }, [to]);
  return null;
}

function NotFound({ redirectTo }) {
  useEffect(() => {
    route(redirectTo, true);
  }, [redirectTo]);
  return null;
}

function Root() {
  const [x402Enabled, setX402Enabled] = useState(null);
  const [authConfig, setAuthConfig] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/x402/config')
        .then((res) => (res.ok ? res.json() : { enabled: false }))
        .catch(() => ({ enabled: false })),
      fetch('/api/auth/config')
        .then((res) => (res.ok ? res.json() : { coralGptEnabled: false }))
        .catch(() => ({ coralGptEnabled: false })),
    ]).then(([x402Config, authCfg]) => {
      setX402Enabled(x402Config.enabled === true);
      setAuthConfig(authCfg);
    });
  }, []);

  if (x402Enabled === null || authConfig === null) {
    return <LoadingScreen />;
  }

  const coralGptEnabled = authConfig.coralGptEnabled === true;
  const privyAppId = authConfig.privyAppId;

  if (coralGptEnabled && privyAppId) {
    return (
      <AuthProvider>
        <CoralPrivyProvider appId={privyAppId}>
          <ProvenanceProvider>
            <CoralAppShell />
          </ProvenanceProvider>
        </CoralPrivyProvider>
      </AuthProvider>
    );
  }

  if (x402Enabled) {
    return (
      <AuthProvider>
        <CDPProvider>
          <ProvenanceProvider>
            <LegacyAppShell />
          </ProvenanceProvider>
        </CDPProvider>
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <ProvenanceProvider>
        <LegacyAppShell />
      </ProvenanceProvider>
    </AuthProvider>
  );
}

const root = document.getElementById('app');
if (root) {
  render(<Root />, root);
} else {
  console.error('Root element #app not found');
}
