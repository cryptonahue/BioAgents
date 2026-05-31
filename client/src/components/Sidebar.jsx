import { useState } from 'preact/hooks';
import { route } from 'preact-router';
import { Button, IconButton } from './ui';
import { useAuth } from '../hooks';

export function Sidebar({ sessions, currentSessionId, onSessionSelect, onNewSession, onDeleteSession, isMobileOpen, onMobileClose, coralGptMode = false, privyLogout }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { logout, isLoggingOut } = useAuth();

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

    sessions.forEach((session) => {
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
                  {coralGptMode ? (
                    <>
                      <span className="logo-bio">CORAL</span>
                      <span className="logo-agents">GPT</span>
                    </>
                  ) : (
                    <>
                      <span className="logo-bio">BIO</span>
                      <span className="logo-agents">AGENTS</span>
                    </>
                  )}
                </div>
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
            <Button
              variant="ghost"
              icon="search"
              title="Search chats"
              className="sidebar-search-btn"
            >
              <span>Search chats</span>
              <kbd className="kbd">⌘K</kbd>
            </Button>
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
              icon="bookOpen"
              onClick={() => route('/library')}
              className="sidebar-library-btn"
            >
              Library
            </Button>
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
          </div>

          <div className="sidebar-footer">
            <Button
              variant="ghost"
              icon="logout"
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="sidebar-logout-btn"
              title="Logout"
            >
              {isLoggingOut ? 'Logging out...' : 'Logout'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
