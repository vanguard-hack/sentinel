import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Home, Sun, Moon } from 'lucide-react';
import { useLayout, useThemeMode } from '../context/LayoutContext';
import GlobalSearch from './GlobalSearch';
import LanguageSwitcher from './LanguageSwitcher';
import LiveClock from './LiveClock';
import Tooltip from './ui/Tooltip';
import SegmentedControl from './ui/SegmentedControl';

// Slim per-page header inside the app shell. Left: mobile menu button + a
// breadcrumb trail (home icon / current module). Center: optional search.
// Right: page-specific actions (children).
export default function TopBar({ title, parent, parentTo, search, children }) {
  const { toggleMobile } = useLayout();
  const [isDark, setIsDark] = useThemeMode();
  const navigate = useNavigate();
  const isHome = title === 'Home';

  return (
    <header className="topbar">
      <Tooltip className="topbar-menu" onPress={toggleMobile} label="Open menu">
        <Menu size={19} />
      </Tooltip>

      <nav className="topbar-crumbs" aria-label="Breadcrumb">
        <Tooltip
          className={`crumb-home ${isHome ? 'active' : ''}`}
          onPress={() => navigate('/reports')}
          label="Home"
        >
          <Home size={16} />
        </Tooltip>
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

      {/* One wrapper around everything trailing, so the narrow-screen rule has
          a single thing to move. Left as loose siblings, the bar overflowed on
          a phone and each control wrapped independently, which put the search
          on one row and the language switcher on another. On desktop the
          wrapper is inert: it carries the same 16px gap the bar already had. */}
      <div className="topbar-tools">
        <SegmentedControl
          aria-label="Theme"
          items={[
            { id: 'light', label: '', Icon: Sun, srLabel: 'Light mode' },
            { id: 'dark', label: '', Icon: Moon, srLabel: 'Dark mode' },
          ]}
          selected={isDark ? 'dark' : 'light'}
          onChange={(id) => setIsDark(id === 'dark')}
        />
        <LiveClock />
        <LanguageSwitcher />
        <div className="topbar-global"><GlobalSearch /></div>
        {children && <div className="topbar-actions">{children}</div>}
      </div>
    </header>
  );
}
