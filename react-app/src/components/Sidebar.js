import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { splitEmail } from '../utils/profile';
import {
  Shield, Home, AlertTriangle, Map, Brain, Database,
  MessageSquare, Users, ChevronRight, Sun, Moon, LogOut,
  UserCircle, PanelLeftClose, ShieldCheck, NotebookPen, Headset, Building2,
  ScrollText, Images, ChevronsUpDown,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useAccess } from '../context/AccessContext';
import { useLayout, useThemeMode } from '../context/LayoutContext';
import { canAccess, ROLE_LABELS } from '../utils/access';
import { logAudit } from '../utils/audit';
import Avatar from './Avatar';

// Every feature lives here. `soon` items are shown disabled.
const NAV = [
  { to: '/reports', Icon: Home, key: 'reports' },
  { to: '/incidents', Icon: AlertTriangle, key: 'incidents' },
  { to: '/crime-map', Icon: Map, key: 'crimeMap' },
  { to: '/ai-analytics', Icon: Brain, key: 'aiAnalytics' },
  { to: '/case-files', Icon: Database, key: 'caseFiles' },
  { to: '/investigation-diary', Icon: NotebookPen, key: 'investigationDiary' },
  { to: '/report-studio', Icon: ScrollText, key: 'reportStudio' },
  { to: '/records', Icon: Images, key: 'records' },
  { to: '/custody', Icon: Building2, key: 'custody' },
  { to: '/assistant', Icon: MessageSquare, key: 'assistant' },
  {
    to: '/personnel', Icon: Users, key: 'personnel',
    children: [
      { to: '/personnel', key: 'personnel', labelKey: 'directory', exact: true },
      { to: '/personnel/roster', key: 'dutyRoster' },
      { to: '/personnel/org-chart', key: 'orgChart' },
    ],
  },
  { to: '/access', Icon: ShieldCheck, key: 'access' },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const { role: appRole, isAdmin, ready } = useAccess();
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen } = useLayout();
  const [isDark, setIsDark] = useThemeMode();
  const [menuOpen, setMenuOpen] = useState(false);
  const profileRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e) => {
      if (profileRef.current && !profileRef.current.contains(e.target)) setMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const displayName =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    user?.email_id || 'Officer';
  const role = isAdmin ? 'Admin' : ROLE_LABELS[appRole] || 'Officer';
  // The name falls back to the address when an account has no first or last
  // name, and printing it again underneath would say nothing new.
  const email = displayName === user?.email_id ? '' : (user?.email_id || '');
  const mail = splitEmail(email);

  // Hide what the route guard would block anyway. Until roles load the full
  // list shows (the guard still protects every route), so the sidebar never
  // renders empty.
  const nav = NAV
    .filter((item) => (item.key === 'access' ? isAdmin : !ready || canAccess(appRole, item.key)))
    .map((item) =>
      item.children && ready
        ? { ...item, children: item.children.filter((c) => canAccess(appRole, c.key)) }
        : item
    );

  const labelFor = (item) =>
    item.label || t(`modules.${item.labelKey || item.key}.label`, item.key);

  const go = (item) => {
    if (item.soon || !item.to) return;
    navigate(item.to);
    setMobileOpen(false);
  };

  return (
    <>
      <div
        className={`app-scrim ${mobileOpen ? 'show' : ''}`}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />
      <aside className={`app-sidebar ${collapsed ? 'rail' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
        <div className="sb-brand">
          {/* The wordmark is the way home — the one thing every user reaches
              for when they want to start over. */}
          <button
            type="button"
            className="sb-brand-home"
            onClick={() => navigate('/reports')}
            title="Home"
            aria-label="Go to Home"
          >
            <span className="sb-brand-mark"><Shield size={20} strokeWidth={2} /></span>
            <span className="sb-brand-name">SENTINEL</span>
          </button>
          <button
            className="sb-collapse"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand' : 'Collapse'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>

        <nav className="sb-nav">
          {nav.map((item) => {
            const sectionActive = item.to && pathname.startsWith(item.to);
            // When a section's children are visible, the active child carries
            // the highlight; the parent only lights up in the collapsed rail.
            const active = item.children ? sectionActive && collapsed : sectionActive;
            return (
              <React.Fragment key={item.key}>
                <button
                  className={`sb-item ${active ? 'active' : ''} ${item.soon ? 'soon' : ''}`}
                  onClick={() => go(item)}
                  title={collapsed ? labelFor(item) : undefined}
                  disabled={item.soon}
                >
                  <item.Icon size={19} strokeWidth={1.8} className="sb-item-icon" />
                  <span className="sb-item-label">{labelFor(item)}</span>
                </button>
                {item.children && !collapsed && sectionActive && (
                  <div className="sb-subnav">
                    {item.children.map((c) => {
                      const childActive = c.exact
                        ? pathname === c.to
                        : pathname.startsWith(c.to);
                      return (
                        <button
                          key={c.key}
                          className={`sb-subitem ${childActive ? 'active' : ''}`}
                          onClick={() => go(c)}
                        >
                          {labelFor(c)}
                        </button>
                      );
                    })}
                  </div>
                )}
              </React.Fragment>
            );
          })}
        </nav>

        <div className="sb-footer">
          {collapsed ? (
            <button
              className="sb-item sb-theme icononly"
              onClick={() => setIsDark((d) => !d)}
              title={isDark ? 'Light mode' : 'Dark mode'}
              aria-label={isDark ? 'Light mode' : 'Dark mode'}
            >
              {isDark ? <Sun size={19} strokeWidth={1.8} className="sb-item-icon" />
                      : <Moon size={19} strokeWidth={1.8} className="sb-item-icon" />}
            </button>
          ) : (
            <div className="sb-theme-seg" role="group" aria-label="Theme">
              <button
                className={`sb-theme-opt ${!isDark ? 'active' : ''}`}
                onClick={() => setIsDark(false)}
                aria-pressed={!isDark}
              >
                <Sun size={16} strokeWidth={1.8} /> Light
              </button>
              <button
                className={`sb-theme-opt ${isDark ? 'active' : ''}`}
                onClick={() => setIsDark(true)}
                aria-pressed={isDark}
              >
                <Moon size={16} strokeWidth={1.8} /> Dark
              </button>
            </div>
          )}

          <div className="sb-profile" ref={profileRef}>
            <button
              className={`sb-account ${menuOpen ? 'open' : ''}`}
              onClick={() => setMenuOpen((o) => !o)}
              title={collapsed ? [displayName, email].filter(Boolean).join(' · ') : undefined}
            >
              <Avatar user={user} size={34} />
              <span className="sb-account-id">
                <span className="sb-account-name">{displayName}</span>
                {mail && (
                  // Two spans, not one string: the local part is what gives way
                  // when the address is too long, so the domain survives. The
                  // full address is on the title for the cases where it does
                  // not fit at all.
                  <span className="sb-account-mail" title={email}>
                    <span className="sb-account-mail-user">{mail.user}</span>
                    {mail.domain && <span className="sb-account-mail-domain">{mail.domain}</span>}
                  </span>
                )}
                <span className="sb-account-role">{role}</span>
              </span>
              <ChevronsUpDown size={15} className="sb-account-caret" />
            </button>

            {menuOpen && (
              <div className="sb-menu" role="menu">
                <button className="sb-menu-item" onClick={() => { setMenuOpen(false); navigate('/profile'); setMobileOpen(false); }}>
                  <UserCircle size={16} /> View profile
                </button>
                <button className="sb-menu-item" onClick={() => { setMenuOpen(false); navigate('/help'); setMobileOpen(false); }}>
                  <Headset size={16} /> Help center
                </button>
                <button
                  className="sb-menu-item sb-menu-danger"
                  onClick={() => { logAudit('sign-out', 'Sign in'); signOut(); }}
                >
                  <LogOut size={16} /> {t('action.signOut', 'Sign out')}
                </button>
              </div>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
