// frontend/src/components/ui/ThemeToggle.jsx
//
// One switch, not two buttons — a floating frosted-glass pill with a knob
// that slides between a sun and a moon (dribbble.com/shots/27293193). Same
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
        <Sun size={11} strokeWidth={2.2} className="theme-toggle-rail-icon theme-toggle-rail-sun" />
        <Moon size={11} strokeWidth={2.2} className="theme-toggle-rail-icon theme-toggle-rail-moon" />
        <span className="theme-toggle-thumb">
          {isDark ? <Moon size={11} strokeWidth={2.4} /> : <Sun size={11} strokeWidth={2.4} />}
        </span>
      </span>
    </Switch>
  );
}
