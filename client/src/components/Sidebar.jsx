import { useState, useRef, useEffect } from 'preact/hooks';
import { route } from 'preact-router';
import { Button, IconButton } from './ui';
import { Icon } from './icons';
import { useAuth, useAdmin } from '../hooks';
import { useVersion, shortSha, formatDate } from '../hooks/useVersion';

export function Sidebar({ sessions, currentSessionId, onSessionSelect, onNewSession, onDeleteSession, isMobileOpen, onMobileClose, coralGptMode = false, privyLogout, currentPath = '' }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { logout, isLoggingOut, userEmail } = useAuth();
  const { isAdmin } = useAdmin();
  const { version, sha, buildDate } = useVersion();

  // User identity derived from the signed-in email. Username is the local part
  // of the address; the avatar shows its first character uppercased.
  const username = userEmail ? userEmail.split('@')[0] : 'Account';
  const avatarInitial = (username.charAt(0) || 'U').toUpperCase();

  // User menu popover (opens upward from the footer pill).
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef(null);

  // Close the user menu on outside click and on Escape.
  useEffect(() => {
    if (!userMenuOpen) return;
    const onPointer = (e) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) {
        setUserMenuOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setUserMenuOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [userMenuOpen]);

  // Active section highlight. Falls back to the live pathname so the
  // sidebar still marks the right item if the parent doesn't pass it.
  const path = currentPath || (typeof window !== 'undefined' ? window.location.pathname : '');
  const navActive = (prefix) => (path === prefix || path.startsWith(prefix + '/') ? ' active' : '');

  // Session search (client-side filter over the session list).
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef(null);

  const openSearch = () => {
    setSearchOpen(true);
    // Focus after the input mounts.
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };

  // ⌘K / Ctrl+K opens the search.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const q = searchQuery.trim().toLowerCase();
  const visibleSessions = q
    ? sessions.filter((s) => (s.title || 'New conversation').toLowerCase().includes(q))
    : sessions;

  const handleLogout = async () => {
    if (coralGptMode && privyLogout) {
      await privyLogout();
    }
    await logout();
    route(coralGptMode ? '/' : '/login', true);
  };

  // Group sessions by time period
  const groupSessions = () => {
    const now = new Date();
    const today = [];
    const yesterday = [];
    const older = [];

    visibleSessions.forEach((session) => {
      if (!session.createdAt) {
        today.push(session);
        return;
      }
      const sessionDate = new Date(session.createdAt);
      const diffTime = Math.abs(now - sessionDate);
      const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        today.push(session);
      } else if (diffDays === 1) {
        yesterday.push(session);
      } else {
        older.push(session);
      }
    });

    return { today, yesterday, older };
  };

  const { today, yesterday, older } = groupSessions();

  return (
    <div className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobileOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        {!isCollapsed && (
          <>
            <div className="sidebar-branding">
              <div className="sidebar-logo">
                {coralGptMode ? (
                  <img
                    src="/images/coralagent.png"
                    alt="MesoReefDAO"
                    className="sidebar-logo-img"
                    decoding="async"
                  />
                ) : (
                  <>
                    <div className="logo-icon">
                      <img
                        src="/images/token.png"
                        alt=""
                        width={24}
                        height={24}
                        decoding="async"
                      />
                    </div>
                    <div className="logo-text">
                      <span className="logo-bio">BIO</span>
                      <span className="logo-agents">AGENTS</span>
                    </div>
                  </>
                )}
              </div>
              <div className="sidebar-header-actions">
                {/* Close button for mobile */}
                <IconButton
                  icon="close"
                  onClick={onMobileClose}
                  title="Close menu"
                  variant="ghost"
                  className="mobile-close-btn"
                />
                {/* Collapse button for desktop */}
                <IconButton
                  icon="chevronLeft"
                  onClick={() => setIsCollapsed(!isCollapsed)}
                  title="Collapse sidebar"
                  variant="ghost"
                  className="toggle-sidebar-btn"
                />
              </div>
            </div>
            {searchOpen ? (
              <div className="sidebar-search-input-wrap">
                <input
                  ref={searchInputRef}
                  type="text"
                  className="sidebar-search-input"
                  placeholder="Search chats…"
                  value={searchQuery}
                  onInput={(e) => setSearchQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') closeSearch();
                  }}
                />
                <IconButton
                  icon="close"
                  size={14}
                  onClick={closeSearch}
                  title="Close search"
                  variant="ghost"
                  className="sidebar-search-close"
                />
              </div>
            ) : (
              <Button
                variant="ghost"
                icon="search"
                title="Search chats"
                onClick={openSearch}
                className="sidebar-search-btn"
              >
                <span>Search chats</span>
                <kbd className="kbd">⌘K</kbd>
              </Button>
            )}
            <Button
              variant="secondary"
              icon="plus"
              onClick={onNewSession}
              className="new-session-btn"
            >
              New Chat
            </Button>
            <Button
              variant="ghost"
              icon="messageSquare"
              onClick={() => route('/chat')}
              className={`sidebar-library-btn${navActive('/chat')}`}
            >
              Chat
            </Button>
            <Button
              variant="ghost"
              icon="bookOpen"
              onClick={() => route('/library')}
              className={`sidebar-library-btn${navActive('/library')}`}
            >
              Library
            </Button>
            <Button
              variant="ghost"
              icon="brainCircuit"
              onClick={() => route('/brain')}
              className={`sidebar-library-btn${navActive('/brain')}`}
            >
              Research Brain
            </Button>
            <Button
              variant="ghost"
              icon="share"
              onClick={() => route('/graph')}
              className={`sidebar-library-btn${navActive('/graph')}`}
            >
              Graph
            </Button>
            {isAdmin && (
              <Button
                variant="ghost"
                icon="settings"
                onClick={() => route('/admin')}
                className={`sidebar-admin-btn${navActive('/admin')}`}
              >
                Admin
              </Button>
            )}
            {isAdmin && !coralGptMode && (
              <Button
                variant="ghost"
                icon="folder"
                onClick={() => route('/corpus')}
                className={`sidebar-admin-btn${navActive('/corpus')}`}
              >
                Corpus
              </Button>
            )}
          </>
        )}
        {isCollapsed && (
          <IconButton
            icon="chevronRight"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title="Expand sidebar"
            variant="ghost"
            className="toggle-sidebar-btn"
            style={{ margin: '0 auto' }}
          />
        )}
      </div>

      {!isCollapsed && (
        <>
          <div className="sessions-list">
            {today.length > 0 && (
              <>
                <div className="sessions-list-header">Today</div>
                {today.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === currentSessionId ? 'active' : ''}`}
                    onClick={() => onSessionSelect(session.id)}
                  >
                    <div className="session-info">
                      <span className="session-title">{session.title || 'New conversation'}</span>
                    </div>
                    <IconButton
                      icon="close"
                      size={14}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      title="Delete session"
                      variant="ghost"
                      className="delete-session-btn"
                    />
                  </div>
                ))}
              </>
            )}

            {yesterday.length > 0 && (
              <>
                <div className="sessions-list-header">Yesterday</div>
                {yesterday.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === currentSessionId ? 'active' : ''}`}
                    onClick={() => onSessionSelect(session.id)}
                  >
                    <div className="session-info">
                      <span className="session-title">{session.title || 'New conversation'}</span>
                    </div>
                    <IconButton
                      icon="close"
                      size={14}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      title="Delete session"
                      variant="ghost"
                      className="delete-session-btn"
                    />
                  </div>
                ))}
              </>
            )}

            {older.length > 0 && (
              <>
                <div className="sessions-list-header">Previous</div>
                {older.map((session) => (
                  <div
                    key={session.id}
                    className={`session-item ${session.id === currentSessionId ? 'active' : ''}`}
                    onClick={() => onSessionSelect(session.id)}
                  >
                    <div className="session-info">
                      <span className="session-title">{session.title || 'New conversation'}</span>
                    </div>
                    <IconButton
                      icon="close"
                      size={14}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteSession(session.id);
                      }}
                      title="Delete session"
                      variant="ghost"
                      className="delete-session-btn"
                    />
                  </div>
                ))}
              </>
            )}
            {q && visibleSessions.length === 0 && (
              <div className="sessions-empty">No chats found</div>
            )}
          </div>

          <div className="sidebar-footer">
            <div className="sidebar-user" ref={userMenuRef}>
              <button
                type="button"
                className={`sidebar-user-trigger${userMenuOpen ? ' open' : ''}`}
                onClick={() => setUserMenuOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                title={userEmail || 'Account'}
              >
                <span className="sidebar-user-avatar">{avatarInitial}</span>
                <span className="sidebar-user-name">{username}</span>
                <Icon name="chevronDown" size={16} className="sidebar-user-chevron" />
              </button>
              {userMenuOpen && (
                <div className="sidebar-user-menu" role="menu">
                  <div className="sidebar-user-menu-email">
                    {userEmail || 'Signed in'}
                  </div>
                  <div className="sidebar-user-menu-sep" />
                  <button
                    type="button"
                    className="sidebar-user-menu-item"
                    role="menuitem"
                    onClick={() => {
                      setUserMenuOpen(false);
                      route('/settings');
                    }}
                  >
                    <Icon name="settings" size={16} />
                    <span>Settings</span>
                  </button>
                  <button
                    type="button"
                    className="sidebar-user-menu-item sidebar-user-menu-item--danger"
                    role="menuitem"
                    onClick={handleLogout}
                    disabled={isLoggingOut}
                  >
                    <Icon name="logout" size={16} />
                    <span>{isLoggingOut ? 'Logging out…' : 'Log out'}</span>
                  </button>
                </div>
              )}
            </div>
            <div className="sidebar-powered-by">
              <span className="sidebar-powered-label">powered by</span>
              <img
                src="/images/BIOLogo-dark.svg?v=2"
                alt="BioAgents"
                className="sidebar-powered-logo"
                decoding="async"
              />
            </div>
            <div
              className="sidebar-version"
              title={`Build ${version} (${shortSha(sha)}) at ${formatDate(buildDate)}`}
            >
              BioAgents v{version} · {shortSha(sha)} · {formatDate(buildDate)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
