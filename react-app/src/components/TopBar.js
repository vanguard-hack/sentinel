import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Menu, Home } from 'lucide-react';
import { useLayout } from '../context/LayoutContext';

// Slim per-page header inside the app shell. Left: mobile menu button + a
// breadcrumb trail (home icon / current module). Center: optional search.
// Right: page-specific actions (children).
export default function TopBar({ title, parent, search, children }) {
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
            <span className="crumb">{parent}</span>
          </>
        )}
        {!isHome && (
          <>
            <span className="crumb-sep">/</span>
            <span className="crumb crumb-active">{title}</span>
          </>
        )}
      </nav>

      {search && <div className="topbar-search">{search}</div>}
      {children && <div className="topbar-actions">{children}</div>}
    </header>
  );
}
