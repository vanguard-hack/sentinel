import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

// Shared chrome state for the app shell: the desktop sidebar rail (collapsed)
// and the mobile off-canvas drawer (mobileOpen). TopBar (rendered inside each
// page) toggles the drawer; the Sidebar reads/writes the rail.
const LayoutContext = createContext(null);

export function LayoutProvider({ children }) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('sentinel-sidebar') === 'collapsed'
  );
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem('sentinel-sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  const toggleCollapsed = useCallback(() => setCollapsed((c) => !c), []);
  const toggleMobile = useCallback(() => setMobileOpen((o) => !o), []);

  return (
    <LayoutContext.Provider
      value={{ collapsed, setCollapsed, toggleCollapsed, mobileOpen, setMobileOpen, toggleMobile }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const ctx = useContext(LayoutContext);
  return ctx || {
    collapsed: false, setCollapsed: () => {}, toggleCollapsed: () => {},
    mobileOpen: false, setMobileOpen: () => {}, toggleMobile: () => {},
  };
}

// Shared theme hook (light/dark) so the sidebar toggle and every page agree.
export function useThemeMode() {
  const [isDark, setIsDark] = useState(
    () => localStorage.getItem('sentinel-theme') === 'dark'
  );
  useEffect(() => {
    const theme = isDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('sentinel-theme', theme);
  }, [isDark]);
  return [isDark, setIsDark];
}
