import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Shield, Home, AlertTriangle, Map, Brain, Database,
  MessageSquare, Users, ChevronLeft, ChevronRight, Sun, Moon, LogOut,
  UserCircle, PanelLeftClose,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useLayout, useThemeMode } from '../context/LayoutContext';
import Avatar from './Avatar';

// Every feature lives here. `soon` items are shown disabled.
const NAV = [
  { to: '/reports', Icon: Home, key: 'reports', label: 'Home' },
  { to: '/incidents', Icon: AlertTriangle, key: 'incidents' },
  { to: '/crime-map', Icon: Map, key: 'crimeMap' },
  { to: '/ai-analytics', Icon: Brain, key: 'aiAnalytics' },
  { to: '/case-files', Icon: Database, key: 'caseFiles' },
  { to: '/assistant', Icon: MessageSquare, key: 'assistant' },
  {
    to: '/personnel', Icon: Users, key: 'personnel',
    children: [
      { to: '/personnel', key: 'personnelDirectory', label: 'Directory', exact: true },
      { to: '/personnel/roster', key: 'dutyRoster', label: 'Duty Roster' },
      { to: '/personnel/org-chart', key: 'orgChart', label: 'Org Chart' },
    ],
  },
];

export default function Sidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
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
  const role = (user?.role_details?.role_name || 'Officer').replace(/^App Administrator$/i, 'Admin');

  const labelFor = (item) =>
    item.label || t(`modules.${item.key}.label`, item.key);

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
          <div className="sb-brand-mark"><Shield size={20} strokeWidth={2} /></div>
          <span className="sb-brand-name">SENTINEL</span>
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
          {NAV.map((item) => {
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
                          {c.label}
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
              title={collapsed ? displayName : undefined}
            >
              <Avatar user={user} size={34} />
              <span className="sb-account-id">
                <span className="sb-account-name">{displayName}</span>
                <span className="sb-account-role">{role}</span>
              </span>
              <ChevronLeft size={15} className="sb-account-caret" />
            </button>

            {menuOpen && (
              <div className="sb-menu" role="menu">
                <button className="sb-menu-item" onClick={() => { setMenuOpen(false); navigate('/profile'); setMobileOpen(false); }}>
                  <UserCircle size={16} /> View profile
                </button>
                <button className="sb-menu-item sb-menu-danger" onClick={signOut}>
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
