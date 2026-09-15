import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Home } from 'lucide-react';
import { useLayout } from '../context/LayoutContext';
import GlobalSearch from './GlobalSearch';
import LanguageSwitcher from './LanguageSwitcher';
import LiveClock from './LiveClock';

// Slim per-page header inside the app shell. Left: mobile menu button + a
// breadcrumb trail (home icon / current module). Center: optional search.
// Right: page-specific actions (children).
export default function TopBar({ title, parent, parentTo, search, children }) {
  const { toggleMobile } = useLayout();
  const navigate = useNavigate();
  const isHome = title === 'Home';

  return (
    <header className="topbar">
      <button className="topbar-menu" onClick={toggleMobile} aria-label="Open menu">
        <Menu size={19} />
      </button>

      <nav className="topbar-crumbs" aria-label="Breadcrumb">
        <button
          className={`crumb-home ${isHome ? 'active' : ''}`}
          onClick={() => navigate('/reports')}
          title="Home"
          aria-label="Home"
        >
          <Home size={16} />
        </button>
        {parent && (
          <>
            <span className="crumb-sep">/</span>
            {parentTo ? (
              <button type="button" className="crumb crumb-link" onClick={() => navigate(parentTo)}>{parent}</button>
            ) : (
              <span className="crumb">{parent}</span>
            )}
          </>
        )}
        {!isHome && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb crumb-active">{title}</span>
          </>
        )}
      </nav>

      {/* Docks the clock/language/search/actions cluster to the header's
          right edge. `.topbar-search` (flex: 1) did this job when a page
          passed a search box, but no page currently does — so on every page
          the cluster was packing left, right after the breadcrumb, with dead
          space between it and the header's actual right edge. This spacer
          keeps the same effect for every page, search box or not. */}
      {search ? <div className="topbar-search">{search}</div> : <div className="topbar-spacer" />}
      <LiveClock />
      <LanguageSwitcher />
      <div className="topbar-global"><GlobalSearch /></div>
      {children && <div className="topbar-actions">{children}</div>}
    </header>
  );
}
