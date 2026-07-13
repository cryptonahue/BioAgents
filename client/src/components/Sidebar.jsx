import { useState, useRef, useEffect } from 'preact/hooks';
import { route } from 'preact-router';
import {
  Button,
  DropdownMenu,
  IconButton,
  Menu,
  MenuHeading,
  MenuItem,
  MenuPopover,
  MenuSeparator,
  menuTriggerProps,
} from './ui';
import { Icon } from './icons';
import { BioAgentsMark } from './BioAgentsMark';
import { ThemeToggle } from './ThemeToggle';
import { useAuth, useAdmin } from '../hooks';
import { useVersion, shortSha, formatDate } from '../hooks/useVersion';

/** Id namespace for the account menu's trigger/popover/menu wiring. */
const USER_MENU = 'sidebar-user';

export function Sidebar({ sessions, currentSessionId, onSessionSelect, onNewSession, onDeleteSession, isMobileOpen, onMobileClose, coralGptMode = false, privyLogout, currentPath = '' }) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { logout, isLoggingOut, userEmail } = useAuth();
  const { isAdmin } = useAdmin();
  const { version, sha, buildDate } = useVersion();

  // User identity derived from the signed-in email. Username is the local part
  // of the address; the avatar shows its first character uppercased.
  const username = userEmail ? userEmail.split('@')[0] : 'Account';
  const avatarInitial = (username.charAt(0) || 'U').toUpperCase();

  // User menu popover (opens upward from the footer pill). Open/close, Escape,
  // outside-click dismissal and the arrow-key navigation all live in
  // <DropdownMenu> — the document-level `mousedown` + `keydown` listeners this
  // component used to install are gone. See the header of `ui/Menu.tsx`.
  const [userMenuOpen, setUserMenuOpen] = useState(false);

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

  /**
   * A session row is a `<div role="button" tabIndex={0}>` wearing Basecoat's
   * `.item`, so the keyboard activation the browser gives a real `<button>` for
   * free has to be spelled out: Enter and Space select the row, and Space has its
   * default page-scroll suppressed.
   *
   * The row is a div rather than a button because it CONTAINS a button (the
   * delete action), and a `<button>` may not nest interactive content. Making it
   * a focusable div is what buys the row keyboard access at all — before this it
   * had none, and the whole chat history was mouse-only.
   */
  const handleSessionKeyDown = (e, sessionId) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSessionSelect(sessionId);
    }
  };

  return (
    // `app-sidebar`, NOT `sidebar`. The bare `sidebar` class is Basecoat's own
    // sidebar COMPONENT (@layer components), and this div is not one — it has no
    // <nav>, no [data-side] and no [data-sidebar-initialized]. Wearing that class
    // pulled Basecoat's sidebar rules onto this element, most damagingly
    // `.sidebar:not([data-side]) + * { margin-left: var(--sidebar-width) }`, which
    // pushed the adjacent content pane 260px to the right. See global.css.
    <div className={`app-sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobileOpen ? 'open' : ''}`}>
      <div className="sidebar-header">
        {!isCollapsed && (
          <>
            <div className="sidebar-branding">
              <div className="sidebar-logo">
                {coralGptMode ? (
                  <img
                    src="/images/coralgpt.png"
                    alt="CoralGPT"
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
                {/* Appearance control, grouped with the other view controls */}
                <ThemeToggle />
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
              <div className="input-group">
                <input
                  ref={searchInputRef}
                  type="text"
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
                size="lg"
                icon="search"
                iconSize={18}
                title="Search chats"
                onClick={openSearch}
                className="sidebar-search-btn"
              >
                <span>Search chats</span>
              </Button>
            )}
            <Button
              variant="secondary"
              size="lg"
              icon="plus"
              iconSize={18}
              onClick={onNewSession}
              className="new-session-btn"
            >
              New Chat
            </Button>
            <Button
              variant="ghost"
              size="lg"
              icon="messageSquare"
              iconSize={16}
              onClick={() => route('/chat')}
              className={`sidebar-library-btn${navActive('/chat')}`}
            >
              Chat
            </Button>
            <Button
              variant="ghost"
              size="lg"
              icon="bookOpen"
              iconSize={16}
              onClick={() => route('/library')}
              className={`sidebar-library-btn${navActive('/library')}`}
            >
              Library
            </Button>
            <Button
              variant="ghost"
              size="lg"
              icon="brainCircuit"
              iconSize={16}
              onClick={() => route('/brain')}
              className={`sidebar-library-btn${navActive('/brain')}`}
            >
              Research Brain
            </Button>
            <Button
              variant="ghost"
              size="lg"
              icon="share"
              iconSize={16}
              onClick={() => route('/graph')}
              className={`sidebar-library-btn${navActive('/graph')}`}
            >
              Graph
            </Button>
            {isAdmin && (
              <Button
                variant="ghost"
                size="lg"
                icon="settings"
                iconSize={16}
                onClick={() => route('/admin')}
                className={`sidebar-admin-btn${navActive('/admin')}`}
              >
                Admin
              </Button>
            )}
            {isAdmin && !coralGptMode && (
              <Button
                variant="ghost"
                size="lg"
                icon="folder"
                iconSize={16}
                onClick={() => route('/corpus')}
                className={`sidebar-admin-btn${navActive('/corpus')}`}
              >
                Corpus
              </Button>
            )}
          </>
        )}
        {isCollapsed && (
          // The collapsed rail. Every control that must stay reachable while the
          // sidebar is 60px wide lives here, stacked and centred — the expand
          // button, and the theme toggle. The toggle is rendered in exactly ONE
          // other place (`sidebar-header-actions` above), inside the
          // `!isCollapsed` branch, so without this copy collapsing the sidebar
          // made the theme impossible to change at all. Same component, same
          // `aria-label`, same focus ring; only the row it sits in differs.
          <div className="sidebar-rail-actions">
            <IconButton
              icon="chevronRight"
              onClick={() => setIsCollapsed(!isCollapsed)}
              title="Expand sidebar"
              variant="ghost"
              className="toggle-sidebar-btn"
            />
            <ThemeToggle />
          </div>
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
                    className={`item session-item ${session.id === currentSessionId ? 'active' : ''}`}
                    data-variant="outline"
                    role="button"
                    tabIndex={0}
                    aria-current={session.id === currentSessionId ? 'true' : undefined}
                    onClick={() => onSessionSelect(session.id)}
                    onKeyDown={(e) => handleSessionKeyDown(e, session.id)}
                  >
                    <section className="session-info">
                      <span className="session-title">{session.title || 'New conversation'}</span>
                    </section>
                    <aside>
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
                    </aside>
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
                    className={`item session-item ${session.id === currentSessionId ? 'active' : ''}`}
                    data-variant="outline"
                    role="button"
                    tabIndex={0}
                    aria-current={session.id === currentSessionId ? 'true' : undefined}
                    onClick={() => onSessionSelect(session.id)}
                    onKeyDown={(e) => handleSessionKeyDown(e, session.id)}
                  >
                    <section className="session-info">
                      <span className="session-title">{session.title || 'New conversation'}</span>
                    </section>
                    <aside>
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
                    </aside>
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
                    className={`item session-item ${session.id === currentSessionId ? 'active' : ''}`}
                    data-variant="outline"
                    role="button"
                    tabIndex={0}
                    aria-current={session.id === currentSessionId ? 'true' : undefined}
                    onClick={() => onSessionSelect(session.id)}
                    onKeyDown={(e) => handleSessionKeyDown(e, session.id)}
                  >
                    <section className="session-info">
                      <span className="session-title">{session.title || 'New conversation'}</span>
                    </section>
                    <aside>
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
                    </aside>
                  </div>
                ))}
              </>
            )}
            {q && visibleSessions.length === 0 && (
              <div className="empty sessions-empty">
                <header>
                  <p>No chats found</p>
                </header>
              </div>
            )}
          </div>

          <div className="sidebar-footer">
            <DropdownMenu
              className="sidebar-user"
              open={userMenuOpen}
              onOpen={() => setUserMenuOpen(true)}
              onClose={() => setUserMenuOpen(false)}
            >
              {/* The account pill is a ghost `.btn`, the same variant and size as
                  the nav buttons above it — which is why the footer no longer reads
                  as a pre-Basecoat leftover.

                  IT MUST STAY A DIRECT CHILD OF `.dropdown-menu`. `Menu.tsx` resolves
                  the trigger with `:scope > button, :scope > [aria-haspopup]` and
                  `console.error`s if it cannot find one (Escape would silently drop
                  focus onto <body>), and Lyra reaches the popover through
                  `.dropdown-menu > [data-popover]`, a child selector. Do not wrap it
                  in a layout div.

                  There is no `open` class any more. `menuTriggerProps()` already
                  stamps `aria-expanded`, and Lyra's ghost variant keys
                  `aria-expanded:bg-muted` off exactly that — so the open state, which
                  the removed class existed to paint, now paints itself from the ARIA
                  the trigger was already rendering. The chevron rotation keys off the
                  same attribute. */}
              <button
                type="button"
                className="btn sidebar-user-trigger"
                data-variant="ghost"
                data-size="lg"
                onClick={() => setUserMenuOpen((open) => !open)}
                title={userEmail || 'Account'}
                {...menuTriggerProps(USER_MENU, userMenuOpen)}
              >
                {/* Basecoat's `.avatar`. Lyra gives it `rounded-full` and the
                    `size-6` box; the initial goes in the `<span>` its rules expect
                    (`.avatar > span:not(.avatar-badge)`). The app's only other
                    `.avatar` was dead `display: none` markup in the chat message —
                    see the note in `Message.jsx`. */}
                <span className="avatar sidebar-user-avatar" data-size="sm">
                  <span>{avatarInitial}</span>
                </span>
                <span className="sidebar-user-name">{username}</span>
                <Icon name="chevronDown" size={16} className="sidebar-user-chevron" />
              </button>
              <MenuPopover idPrefix={USER_MENU} open={userMenuOpen} side="top">
                <MenuHeading>{userEmail || 'Signed in'}</MenuHeading>
                <MenuSeparator />
                <Menu idPrefix={USER_MENU}>
                  {/* Closing is DropdownMenu's job — it also hands focus back to
                      the trigger, which routing away from here would otherwise
                      strand on a detached node. */}
                  <MenuItem onClick={() => route('/settings')}>
                    <Icon name="settings" size={16} />
                    <span>Settings</span>
                  </MenuItem>
                  <MenuItem
                    variant="destructive"
                    onClick={handleLogout}
                    disabled={isLoggingOut}
                  >
                    <Icon name="logout" size={16} />
                    <span>{isLoggingOut ? 'Logging out…' : 'Log out'}</span>
                  </MenuItem>
                </Menu>
              </MenuPopover>
            </DropdownMenu>
            <div className="sidebar-powered-by">
              <span className="sidebar-powered-label">powered by</span>
              {/* The mark is inlined, not an <img>, so it can be filled with
                  currentColor and follow the theme. See BioAgentsMark.tsx. */}
              <BioAgentsMark className="sidebar-powered-logo" />
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
