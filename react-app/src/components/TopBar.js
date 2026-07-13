import React from 'react';
import { Menu } from 'lucide-react';
import { useLayout } from '../context/LayoutContext';

// Slim per-page header inside the app shell. Left: mobile menu button + page
// title. Center: optional search. Right: page-specific actions (children).
export default function TopBar({ title, subtitle, search, children }) {
  const { toggleMobile } = useLayout();
  return (
    <header className="topbar">
      <button className="topbar-menu" onClick={toggleMobile} aria-label="Open menu">
        <Menu size={19} />
      </button>
      <div className="topbar-title">
        <h1>{title}</h1>
        {subtitle && <span className="topbar-sub">{subtitle}</span>}
      </div>
      {search && <div className="topbar-search">{search}</div>}
      {children && <div className="topbar-actions">{children}</div>}
    </header>
  );
}
