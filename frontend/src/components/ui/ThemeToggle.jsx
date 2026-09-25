// frontend/src/components/ui/ThemeToggle.jsx
//
// One switch, one icon visible at a time — a floating frosted-glass button
// that crossfades between sun and moon (dribbble.com/shots/27293193). Same
// control on a phone as on a desktop; nothing about it moves to the sidebar
// drawer at narrow widths.
import { Switch } from 'react-aria-components';
import { Sun, Moon } from 'lucide-react';
import './ThemeToggle.css';

export default function ThemeToggle({ isDark, onChange, className = '' }) {
  return (
    <Switch
      isSelected={isDark}
      onChange={onChange}
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`theme-toggle ${className}`}
    >
      <span className="theme-toggle-track">
        <Sun size={16} strokeWidth={2.2} className="theme-toggle-icon theme-toggle-icon-sun" />
        <Moon size={16} strokeWidth={2.2} className="theme-toggle-icon theme-toggle-icon-moon" />
      </span>
    </Switch>
  );
}
