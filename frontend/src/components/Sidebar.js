import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { splitEmail } from '../utils/profile';
import {
  Home, AlertTriangle, Map, Brain, Database,
  MessageSquare, Users, ChevronRight, LogOut,
  UserCircle, PanelLeftClose, ShieldCheck, NotebookPen, Headset, Building2, CalendarClock,
  ScrollText, Images, ChevronsUpDown, ShieldOff, Grip } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useAccess } from '../context/AccessContext';
import { useLayout } from '../context/LayoutContext';
import LanguageSwitcher from './LanguageSwitcher';
import { canAccess, ROLE_LABELS } from '../utils/access';
import { logAudit } from '../utils/audit';
import Avatar from './Avatar';
import SentinelMark from './SentinelMark';
import Tooltip from './ui/Tooltip';

// Every feature lives here. `soon` items are shown disabled.
const NAV = [
  { to: '/reports', Icon: Home, key: 'reports' },
  { to: '/ai-analytics', Icon: Brain, key: 'aiAnalytics' },
  { to: '/assistant', Icon: MessageSquare, key: 'assistant' },
  { to: '/investigation-diary', Icon: NotebookPen, key: 'investigationDiary' },
  { to: '/report-studio', Icon: ScrollText, key: 'reportStudio' },
  { to: '/records', Icon: Images, key: 'records' },
  { to: '/action-queue', Icon: CalendarClock, key: 'actionQueue' },
  { to: '/case-files', Icon: Database, key: 'caseFiles' },
  { to: '/crime-map', Icon: Map, key: 'crimeMap' },
  { to: '/incidents', Icon: AlertTriangle, key: 'incidents' },
  { to: '/custody', Icon: Building2, key: 'custody' },
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

// Phone navigation is a bottom bar, not the off-canvas drawer. A bar holds
// about five slots against a thirteen-item feature list, so four destinations
// live in it and "More" opens the drawer this component already renders —
// which is where the full list, the language switcher and the account menu
// live. Any of these four a role cannot reach is backfilled from whatever it
// can, so the bar is never short a slot.
const BOTTOM_KEYS = ['reports', 'aiAnalytics', 'assistant', 'reportStudio'];
const BOTTOM_SLOTS = 4;

// Exported for its own test: the backfill is the part with a way to be wrong.
export function bottomNavItems(nav, keys = BOTTOM_KEYS, slots = BOTTOM_SLOTS) {
  return [
    ...keys.map((k) => nav.find((i) => i.key === k)).filter(Boolean),
    ...nav.filter((i) => !keys.includes(i.key)),
  ].slice(0, slots);
}

export default function Sidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation();
  const { user, signOut } = useAuth();
  const { role: appRole, isAdmin, ready } = useAccess();
  const { collapsed, toggleCollapsed, mobileOpen, setMobileOpen, toggleMobile } = useLayout();
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

  const bottom = bottomNavItems(nav);
  // Which slot the bubble sits in. The drawer's own button is the last slot,
  // so opening it slides the bubble there; -1 means the route came from the
  // drawer and no slot owns it.
  const bubbleAt = mobileOpen
    ? bottom.length
    : bottom.findIndex((i) => pathname.startsWith(i.to));

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
            <span className="sb-brand-mark"><SentinelMark size={19} /></span>
            <span className="sb-brand-name">SENTINEL</span>
          </button>
          <Tooltip
            className="sb-collapse"
            onPress={toggleCollapsed}
            label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight size={16} /> : <PanelLeftClose size={16} />}
          </Tooltip>
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
          {/* Phone-width home for the language switcher. The top bar cannot
              hold it at 390px without spilling onto a second row, and it is
              an account setting rather than page chrome — the rest of which
              is already in this drawer. Theme now lives only in the top bar's
              ThemeToggle, visible at every width, so it is not duplicated
              here. */}
          <div className="sb-settings">
            <LanguageSwitcher />
          </div>

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
                <button className="sb-menu-item" onClick={() => { setMenuOpen(false); navigate('/anonymize'); setMobileOpen(false); }}>
                  <ShieldOff size={16} /> Anonymize
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

      {/* Phone only — CSS keeps it out of the layout above 900px. The label is
          truncated when it has to be (Kannada and Hindi module names run long),
          so the full one stays on the title. */}
      <nav className="app-bottomnav" aria-label="Primary">
        <span
          className={`bn-bubble ${bubbleAt < 0 ? 'bn-bubble-hidden' : ''}`}
          style={{ '--bn-i': bubbleAt < 0 ? 0 : bubbleAt, '--bn-n': bottom.length + 1 }}
          aria-hidden="true"
        />
        {bottom.map((item) => (
          <button
            key={item.key}
            className={`bn-item ${pathname.startsWith(item.to) ? 'active' : ''}`}
            onClick={() => go(item)}
            title={labelFor(item)}
          >
            <item.Icon size={21} strokeWidth={1.8} />
            <span className="bn-label">{labelFor(item)}</span>
          </button>
        ))}
        <button
          className={`bn-item ${mobileOpen ? 'active' : ''}`}
          onClick={toggleMobile}
          aria-expanded={mobileOpen}
          title={t('common.more', 'More')}
        >
          <Grip size={21} strokeWidth={1.8} />
          <span className="bn-label">{t('common.more', 'More')}</span>
        </button>
      </nav>
    </>
  );
}
