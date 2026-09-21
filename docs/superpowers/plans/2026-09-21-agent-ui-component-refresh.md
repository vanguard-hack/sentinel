# Agent UI Component Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin 16 assistant/dashboard/records/diary UI surfaces using structural patterns from five external component references, move the dark-mode toggle into the top nav, and add a reusable action-swap button state — all rendered with Sentinel's own Linear-derived CSS tokens, no new visual language.

**Architecture:** One new directory, `frontend/src/components/ui/`, holds small presentational primitives (Tooltip, SegmentedControl, Toast, Tabs, FileUpload, DatePicker, DataTable helpers, AgentLoader helpers, MessageScroller, BorderBeam, VoiceGlow, ContextCard/InsightCard styling, ActionButton). Three already-good existing components (`StatTile.js`, `Thinking.js`, `AguiRenderer.js`'s internal `AguiTable`/`AguiCards`/`AguiStatTiles`) are extended in place rather than replaced, per the codebase's existing patterns. Each primitive is wired into exactly the page(s) named in the spec.

**Tech Stack:** React 19, plain CSS with existing custom-property tokens (no Tailwind), `motion/react` (already a dependency, import path confirmed in `StatTile.js`), `lucide-react` (already a dependency), new dependency `react-aria-components` + `@internationalized/date` for accessible Tooltip/Tabs/SegmentedControl(ToggleButtonGroup)/DatePicker/FileUpload(DropZone+FileTrigger). Frontend tests via `react-scripts test` + `@testing-library/react`, following the existing `frontend/src/__smoke__/*.test.js` convention (plain `test()`, no custom framework).

**Spec:** `docs/superpowers/specs/2026-09-21-agent-ui-component-refresh-design.md`

## Global Constraints

- `npm install` in `frontend/` needs `--legacy-peer-deps` (react-scripts 5 pins an older TypeScript range).
- Build with `cd frontend && npm run build`, never bare `react-scripts build` (the `postbuild` step copies `index.html → 404.html`, the SPA fallback).
- No inline scripts, no `eval`/`new Function` — the CSP's `script-src` is a real allowlist with neither.
- Run tests with `cd frontend && CI=true npm test -- --watchAll=false <path>` for a single file, or without a path for the full suite.
- Lint with `cd frontend && npx eslint src --ext .js --ignore-pattern '__smoke__'`.
- `catalyst serve --http 3000` (needs node 20 on PATH: `PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" catalyst serve --http 3000`) for manual verification in a real browser; local serve has no signed-in session so authenticated panels sit at "Checking access…" without signing in through the browser first.
- `frontend/src/pages/Reports.js` and `frontend/src/utils/assistant.js` carry unrelated, pre-existing uncommitted changes in the working tree — every edit to those two files in this plan is scoped to only the lines this plan specifies; do not touch anything else in them.
- Dark mode is `[data-theme="dark"]` on `<html>`, toggled by `useThemeMode()` in `frontend/src/context/LayoutContext.js` (unchanged by this plan — only *where* the toggle UI lives moves).
- Every new CSS file lives beside its component (`components/ui/Foo.jsx` + `components/ui/Foo.css`), imported directly by that component — this codebase's only existing stylesheet is the monolithic `frontend/src/index.css`, and new primitives should not grow it further.

---

### Task 1: Tooltip primitive + `react-aria-components` dependency

**Files:**
- Modify: `frontend/package.json` (add `react-aria-components`, `@internationalized/date`)
- Create: `frontend/src/components/ui/Tooltip.jsx`
- Create: `frontend/src/components/ui/Tooltip.css`
- Modify: `frontend/src/components/Sidebar.js:117-124` (collapse button)
- Modify: `frontend/src/components/TopBar.js:18-31` (menu button, Home crumb button)
- Test: `frontend/src/__smoke__/tooltip.test.js`

**Interfaces:**
- Produces: `export default function Tooltip({ label, className, onPress, children, placement = 'top', disabled = false, ...rest })` — renders a `react-aria-components` `<Button>` (so it accepts `onPress`, not `onClick`) wrapped in a `TooltipTrigger`. `label` sets both the tooltip text and the button's `aria-label`.

- [ ] **Step 1: Install the new dependency**

```bash
cd frontend && npm install --legacy-peer-deps react-aria-components @internationalized/date
```

- [ ] **Step 2: Write the failing test**

```jsx
// frontend/src/__smoke__/tooltip.test.js
//
// Tooltip wraps react-aria-components so every icon-only button gets correct
// keyboard/focus semantics for free. Two behaviors matter: it appears on
// focus (not just hover, which a keyboard user can't trigger) and it clears
// on blur — a tooltip stuck open after the officer tabs away is worse than
// no tooltip.
import React from 'react';
import { render, screen, fireEvent, waitForElementToBeRemoved } from '@testing-library/react';
import Tooltip from '../components/ui/Tooltip';

test('the label appears when the trigger receives focus', async () => {
  render(<Tooltip label="Collapse sidebar"><span>icon</span></Tooltip>);
  fireEvent.focus(screen.getByRole('button'));
  expect(await screen.findByRole('tooltip')).toHaveTextContent('Collapse sidebar');
});

test('the tooltip clears when the trigger blurs', async () => {
  render(<Tooltip label="Collapse sidebar"><span>icon</span></Tooltip>);
  fireEvent.focus(screen.getByRole('button'));
  await screen.findByRole('tooltip');
  fireEvent.blur(screen.getByRole('button'));
  await waitForElementToBeRemoved(() => screen.queryByRole('tooltip'));
});

test('clicking the trigger still fires onPress', async () => {
  const onPress = jest.fn();
  render(<Tooltip label="Collapse sidebar" onPress={onPress}><span>icon</span></Tooltip>);
  fireEvent.click(screen.getByRole('button'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/tooltip.test.js`
Expected: FAIL — `Cannot find module '../components/ui/Tooltip'`

- [ ] **Step 4: Implement `Tooltip.jsx`**

```jsx
// frontend/src/components/ui/Tooltip.jsx
import {
  Button, OverlayArrow, Tooltip as AriaTooltip, TooltipTrigger,
} from 'react-aria-components';
import './Tooltip.css';

export default function Tooltip({
  label, className, onPress, children, placement = 'top', disabled = false, ...rest
}) {
  if (disabled || !label) {
    return <>{children}</>;
  }
  return (
    <TooltipTrigger delay={300} closeDelay={0}>
      <Button className={className} onPress={onPress} aria-label={label} {...rest}>
        {children}
      </Button>
      <AriaTooltip className="ui-tooltip" placement={placement} offset={6}>
        <OverlayArrow>
          <svg width={8} height={8} viewBox="0 0 8 8" className="ui-tooltip-arrow">
            <path d="M0 0 L4 4 L8 0 Z" />
          </svg>
        </OverlayArrow>
        {label}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
```

```css
/* frontend/src/components/ui/Tooltip.css */
.ui-tooltip {
  background: var(--bg-4);
  color: var(--ink);
  font-size: var(--fs-caption);
  padding: 4px 8px;
  border-radius: var(--r-tag);
  border: 1px solid var(--hairline-strong);
  transform-origin: var(--trigger-anchor-point, center);
  animation: ui-tooltip-in 120ms ease-out;
}
.ui-tooltip[data-placement='top'] { margin-bottom: 4px; }
.ui-tooltip[data-placement='bottom'] { margin-top: 4px; }
.ui-tooltip-arrow path { fill: var(--bg-4); }
@keyframes ui-tooltip-in {
  from { opacity: 0; transform: scale(0.9); }
  to   { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .ui-tooltip { animation: none; }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/tooltip.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Wire it into the two always-icon-only nav buttons**

In `frontend/src/components/Sidebar.js`, replace the collapse button (currently lines 117-124):

```jsx
// before
<button
  className="sb-collapse"
  onClick={toggleCollapsed}
  title={collapsed ? 'Expand' : 'Collapse'}
  aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
>
  {collapsed ? <ChevronRight size={16} /> : <PanelLeftClose size={16} />}
</button>

// after
<Tooltip
  className="sb-collapse"
  onPress={toggleCollapsed}
  label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
>
  {collapsed ? <ChevronRight size={16} /> : <PanelLeftClose size={16} />}
</Tooltip>
```

Add `import Tooltip from './ui/Tooltip';` to Sidebar.js's import block.

In `frontend/src/components/TopBar.js`, replace the menu button and the Home crumb button:

```jsx
// before
<button className="topbar-menu" onClick={toggleMobile} aria-label="Open menu">
  <Menu size={19} />
</button>
...
<button
  className={`crumb-home ${isHome ? 'active' : ''}`}
  onClick={() => navigate('/reports')}
  title="Home"
  aria-label="Home"
>
  <Home size={16} />
</button>

// after
<Tooltip className="topbar-menu" onPress={toggleMobile} label="Open menu">
  <Menu size={19} />
</Tooltip>
...
<Tooltip
  className={`crumb-home ${isHome ? 'active' : ''}`}
  onPress={() => navigate('/reports')}
  label="Home"
>
  <Home size={16} />
</Tooltip>
```

Add `import Tooltip from './ui/Tooltip';` to TopBar.js's import block.

- [ ] **Step 7: Lint and commit**

```bash
cd frontend && npx eslint src/components/ui/Tooltip.jsx src/components/Sidebar.js src/components/TopBar.js --ext .js,.jsx
git add frontend/package.json frontend/package-lock.json frontend/src/components/ui/Tooltip.jsx frontend/src/components/ui/Tooltip.css frontend/src/components/Sidebar.js frontend/src/components/TopBar.js frontend/src/__smoke__/tooltip.test.js
git commit -m "feat: add accessible Tooltip primitive, apply to icon-only nav buttons"
```

---

### Task 2: SegmentedControl primitive + move the theme toggle to TopBar

**Files:**
- Create: `frontend/src/components/ui/SegmentedControl.jsx`
- Create: `frontend/src/components/ui/SegmentedControl.css`
- Modify: `frontend/src/components/Sidebar.js:49,167-195` (remove theme toggle + `useThemeMode` call)
- Modify: `frontend/src/components/TopBar.js` (add theme toggle)
- Test: `frontend/src/__smoke__/segmentedcontrol.test.js`

**Interfaces:**
- Produces: `export default function SegmentedControl({ items, selected, onChange, 'aria-label': ariaLabel })` where `items` is `[{ id, label, Icon? }]`. Built on `react-aria-components`' `ToggleButtonGroup`/`ToggleButton` in single-select mode.
- Consumes (Task 1): none directly, but sits beside `Tooltip` in `ui/`.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/segmentedcontrol.test.js
//
// The theme toggle used to be sidebar-only markup (`sb-theme-seg`); this is
// the same switcher pulled out into a reusable primitive so TopBar can host
// it too. Single-select, and the selected item is exposed for styling via
// aria-pressed rather than a hand-rolled `active` class.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SegmentedControl from '../components/ui/SegmentedControl';

const items = [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

test('the selected option is marked pressed', () => {
  render(<SegmentedControl items={items} selected="light" onChange={() => {}} aria-label="Theme" />);
  expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'false');
});

test('clicking an option calls onChange with its id', () => {
  const onChange = jest.fn();
  render(<SegmentedControl items={items} selected="light" onChange={onChange} aria-label="Theme" />);
  fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
  expect(onChange).toHaveBeenCalledWith('dark');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/segmentedcontrol.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `SegmentedControl.jsx`**

```jsx
// frontend/src/components/ui/SegmentedControl.jsx
import { ToggleButtonGroup, ToggleButton } from 'react-aria-components';
import './SegmentedControl.css';

export default function SegmentedControl({ items, selected, onChange, 'aria-label': ariaLabel }) {
  return (
    <ToggleButtonGroup
      className="ui-segmented"
      aria-label={ariaLabel}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[selected]}
      onSelectionChange={(keys) => {
        const next = [...keys][0];
        if (next != null) onChange(next);
      }}
    >
      {items.map(({ id, label, Icon }) => (
        <ToggleButton key={id} id={id} className="ui-segmented-item">
          {Icon && <Icon size={14} strokeWidth={1.8} />}
          {label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
```

```css
/* frontend/src/components/ui/SegmentedControl.css */
.ui-segmented {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg-3);
  border-radius: var(--r-pill);
}
.ui-segmented-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border: none;
  border-radius: var(--r-pill);
  background: transparent;
  color: var(--ink-subtle);
  font-size: var(--fs-caption);
  cursor: pointer;
}
.ui-segmented-item[aria-pressed='true'] {
  background: var(--bg-1);
  color: var(--ink);
}
.ui-segmented-item[data-focus-visible] {
  outline: 2px solid var(--primary-focus);
  outline-offset: 1px;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/segmentedcontrol.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Move the theme toggle from Sidebar.js to TopBar.js**

In `frontend/src/components/Sidebar.js`: delete the `sb-footer`'s theme block (lines 168-195, both the `collapsed` icon-only branch and the `sb-theme-seg` branch) and delete `const [isDark, setIsDark] = useThemeMode();` (line 49) and the now-unused `useThemeMode` import (keep `useLayout`), and the now-unused `Sun, Moon` icon imports if nothing else in the file uses them (grep first — `Sun`/`Moon` are only used in the block being deleted).

In `frontend/src/components/TopBar.js`, add the toggle to the actions cluster, right before `<LiveClock />`:

```jsx
import { useThemeMode } from '../context/LayoutContext';
import { Sun, Moon } from 'lucide-react';
import SegmentedControl from './ui/SegmentedControl';
// ...
export default function TopBar({ title, parent, parentTo, search, children }) {
  const { toggleMobile } = useLayout();
  const [isDark, setIsDark] = useThemeMode();
  // ...
  return (
    <header className="topbar">
      {/* ...unchanged... */}
      {search ? <div className="topbar-search">{search}</div> : <div className="topbar-spacer" />}
      <SegmentedControl
        aria-label="Theme"
        items={[
          { id: 'light', label: '', Icon: Sun },
          { id: 'dark', label: '', Icon: Moon },
        ]}
        selected={isDark ? 'dark' : 'light'}
        onChange={(id) => setIsDark(id === 'dark')}
      />
      <LiveClock />
      {/* ...unchanged... */}
```

- [ ] **Step 6: Manual check**

`PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" catalyst serve --http 3000`, open `/app/reports`, click the sun/moon toggle in the top nav, confirm the page switches theme and the sidebar footer no longer shows a theme control.

- [ ] **Step 7: Lint and commit**

```bash
cd frontend && npx eslint src/components/ui/SegmentedControl.jsx src/components/Sidebar.js src/components/TopBar.js --ext .js,.jsx
git add frontend/src/components/ui/SegmentedControl.jsx frontend/src/components/ui/SegmentedControl.css frontend/src/components/Sidebar.js frontend/src/components/TopBar.js frontend/src/__smoke__/segmentedcontrol.test.js
git commit -m "feat: move light/dark toggle into the top nav as a SegmentedControl"
```

---

### Task 3: Toast primitive, replace Assistant.js's ad-hoc export toasts

**Files:**
- Create: `frontend/src/components/ui/Toast.jsx`
- Create: `frontend/src/components/ui/Toast.css`
- Modify: `frontend/src/index.tsx` or app root (mount `<ToastProvider>` once) — verify exact root file first (see Step 5)
- Modify: `frontend/src/pages/Assistant.js` (the two `as-export-toast` blocks, ~lines 1366-1387)
- Test: `frontend/src/__smoke__/toast.test.js`

**Interfaces:**
- Produces: `export function ToastProvider({ children })`, `export function useToast()` returning `{ show(message, { tone = 'info', duration = 4000 } = {}) }`.
- Consumes (Task 3 wiring only): `exporting` (bool) and `exportError` (string|null) state already in `Assistant.js`.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/toast.test.js
//
// useToast() replaces the ad-hoc `as-export-toast` overlay markup that lived
// inline in Assistant.js — one shared stack, fired from anywhere via a hook,
// instead of a page owning its own overlay state.
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ToastProvider, useToast } from '../components/ui/Toast';

function Trigger() {
  const { show } = useToast();
  return <button onClick={() => show('Exported', { tone: 'success' })}>Fire</button>;
}

test('show() renders a toast with its message and tone', async () => {
  render(<ToastProvider><Trigger /></ToastProvider>);
  fireEvent.click(screen.getByText('Fire'));
  const toast = await screen.findByRole('status');
  expect(toast).toHaveTextContent('Exported');
  expect(toast).toHaveAttribute('data-tone', 'success');
});

test('a toast auto-dismisses after its duration', async () => {
  render(<ToastProvider><Trigger /></ToastProvider>);
  fireEvent.click(screen.getByText('Fire'));
  await screen.findByRole('status');
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), { timeout: 6000 });
}, 7000);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/toast.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `Toast.jsx`**

```jsx
// frontend/src/components/ui/Toast.jsx
import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { CheckCircle2, AlertTriangle, Info, Loader2, X } from 'lucide-react';
import './Toast.css';

const ToastContext = createContext(null);

const TONE_ICON = { success: CheckCircle2, error: AlertTriangle, info: Info, loading: Loader2 };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const show = useCallback((message, { tone = 'info', duration = 4000 } = {}) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, tone }]);
    if (duration > 0) setTimeout(() => dismiss(id), duration);
    return id;
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <div className="ui-toast-stack" aria-live="polite">
        <AnimatePresence>
          {toasts.map((toast) => {
            const Icon = TONE_ICON[toast.tone] || Info;
            return (
              <motion.div
                key={toast.id}
                role="status"
                data-tone={toast.tone}
                className="ui-toast"
                layout
                initial={{ opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, x: 80 }}
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                onDragEnd={(_, info) => { if (Math.abs(info.offset.x) > 80) dismiss(toast.id); }}
              >
                <Icon size={16} className={toast.tone === 'loading' ? 'ui-toast-spin' : undefined} />
                <span>{toast.message}</span>
                <button aria-label="Dismiss" onClick={() => dismiss(toast.id)}><X size={14} /></button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast() must be used inside <ToastProvider>');
  return ctx;
}
```

```css
/* frontend/src/components/ui/Toast.css */
.ui-toast-stack {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ui-toast {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--bg-3);
  border: 1px solid var(--hairline-strong);
  border-radius: var(--r-card);
  color: var(--ink);
  font-size: var(--fs-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.24);
}
.ui-toast[data-tone='success'] svg { color: var(--green, #27a644); }
.ui-toast[data-tone='error'] svg { color: var(--red, #e5484d); }
.ui-toast button { background: none; border: none; color: var(--ink-tertiary); cursor: pointer; margin-left: 4px; }
.ui-toast-spin { animation: ui-toast-spin 1s linear infinite; }
@keyframes ui-toast-spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/toast.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Mount `ToastProvider` once at the app root**

Read `frontend/src/App.js` (or `App.tsx`, whichever exists) to find the top-level component that renders `<LayoutProvider>`/the router. Wrap its children with `<ToastProvider>` alongside the existing providers, e.g.:

```jsx
import { ToastProvider } from './components/ui/Toast';
// ...
<AuthProvider>
  <LayoutProvider>
    <ToastProvider>
      {/* existing router/routes */}
    </ToastProvider>
  </LayoutProvider>
</AuthProvider>
```

- [ ] **Step 6: Replace the two `as-export-toast` blocks in Assistant.js**

Add `import { useToast } from '../components/ui/Toast';` and `const { show: showToast } = useToast();` near the top of the component. Find where `setExporting(true)` is called (the PDF export handler) and where `setExportError(...)` is set; replace the two render blocks:

```jsx
// remove
{exporting && (
  <div className="as-modal-overlay">
    <div className="as-modal as-export-toast">
      <span className="btn-spinner" /> Exporting conversation to PDF…
    </div>
  </div>
)}
// ...
{exportError && (
  <div className="as-modal-overlay" onMouseDown={() => setExportError(null)}>
    <div className="as-modal as-export-toast" onMouseDown={(e) => e.stopPropagation()}>
      {exportError}
    </div>
  </div>
)}
```

and call `showToast('Exporting conversation to PDF…', { tone: 'loading', duration: 0 })` where `setExporting(true)` currently runs, `showToast('Exported', { tone: 'success' })` on success, and `showToast(exportError, { tone: 'error' })` in the catch block, in place of `setExportError(...)`. Keep the `exporting`/`exportError` state variables only if other code still reads them (grep first); if the toast fully replaces their display purpose and nothing else reads them, remove them.

- [ ] **Step 7: Lint and commit**

```bash
cd frontend && npx eslint src/components/ui/Toast.jsx src/pages/Assistant.js src/App.js --ext .js,.jsx
git add frontend/src/components/ui/Toast.jsx frontend/src/components/ui/Toast.css frontend/src/App.js frontend/src/pages/Assistant.js frontend/src/__smoke__/toast.test.js
git commit -m "feat: add shared Toast/useToast, replace Assistant.js's ad-hoc export overlay"
```

---

### Task 4: KPI stat card footer variant (`StatTile.js`)

**Files:**
- Modify: `frontend/src/components/charts/StatTile.js`
- Modify: `frontend/src/pages/Reports.js` (only the `rp-kpi-row` call sites that should use the footer variant — see Step 5; scoped edit, do not touch anything else in this file)
- Test: `frontend/src/__smoke__/stattile.test.js`

**Interfaces:**
- Produces: `StatTile` gains one new prop, `variant = 'plain' | 'footer'`; all existing props (`Icon, label, value, format, sub, trend, share`) are unchanged, so every existing call site keeps working with no edits.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/stattile.test.js
//
// StatTile already had the compact "plain" look Reports.js uses everywhere.
// BoardUI's stat-cards doc adds a second look for header-of-section tiles: a
// gradient-tinted icon tile and a footer band for the comparison text. This
// only checks the new prop's effect — StatTile's existing count-up/share/
// trend behavior is untouched and already covered by using it in Reports.js.
import React from 'react';
import { render, screen } from '@testing-library/react';
import { LayoutGrid } from 'lucide-react';
import StatTile from '../components/charts/StatTile';

test('the plain variant is the default, no footer band', () => {
  render(<StatTile Icon={LayoutGrid} label="FIRs" value={120} sub="this month" />);
  expect(document.querySelector('.st-tile')).not.toHaveClass('st-tile-footer');
});

test('the footer variant renders the footer band with its comparison text', () => {
  render(
    <StatTile Icon={LayoutGrid} label="FIRs" value={120} variant="footer" footerText="+12% vs last month" />
  );
  expect(document.querySelector('.st-tile')).toHaveClass('st-tile-footer');
  expect(screen.getByText('+12% vs last month')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/stattile.test.js`
Expected: FAIL — footer variant markup/class absent

- [ ] **Step 3: Add the `variant`/`footerText` prop to `StatTile.js`**

```jsx
export default function StatTile({
  Icon,
  label,
  value,
  format = (v) => Math.round(v).toLocaleString(),
  sub,
  trend,
  share,
  variant = 'plain',
  footerText,
}) {
  const ref = useCountUp(value, format);
  return (
    <div className={`st-tile ${variant === 'footer' ? 'st-tile-footer' : ''}`}>
      <div className="st-head">
        {Icon && (
          <span className={`st-icon ${variant === 'footer' ? 'st-icon-tile' : ''}`}>
            <Icon size={17} strokeWidth={1.8} />
          </span>
        )}
        <span className="st-label">{label}</span>
        {trend && (
          <span className={`st-trend st-trend-${trend.dir}`}>
            {trend.dir === 'up' ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
            {trend.text}
          </span>
        )}
      </div>

      <span className={`st-value ${variant === 'footer' ? 'st-value-display' : ''}`} ref={ref}>
        {format(0)}
      </span>

      {share != null && (
        <div className="st-share" aria-hidden="true">
          <span className="st-share-fill" style={{ width: `${Math.max(2, Math.min(100, share))}%` }} />
        </div>
      )}

      {sub && <span className="st-sub">{sub}</span>}
      {variant === 'footer' && footerText && <div className="st-footer">{footerText}</div>}
    </div>
  );
}
```

- [ ] **Step 4: Add the footer-variant CSS**

Add to `frontend/src/index.css` (co-located with the rest of `.st-*` rules — grep `\.st-tile` to find them and append beside it, matching the existing selector style):

```css
.st-tile-footer .st-icon-tile {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--r-ctl);
  background: linear-gradient(135deg, var(--primary-tint), transparent);
  color: var(--primary);
}
.st-tile-footer .st-value-display { font-size: var(--fs-display, 28px); }
.st-tile-footer .st-footer {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--hairline);
  font-size: var(--fs-caption);
  color: var(--ink-subtle);
}
```

- [ ] **Step 5: Run the test to verify it passes, then use the footer variant on Reports.js's headline KPI row**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/stattile.test.js` — expect PASS (2 tests).

In `frontend/src/pages/Reports.js`, find the `rp-kpi-row` (around line 285) and its `<StatTile .../>` calls. Add `variant="footer"` and a `footerText` (built from the existing `trend`/`sub` data already passed to each tile — do not fetch new data, only pass through what's already computed) to the tiles that currently receive a `trend` prop; leave tiles with no trend data as `variant="plain"` (the default — no prop change needed).

- [ ] **Step 6: Manual check + lint + commit**

`catalyst serve`, open `/app/reports`, confirm the KPI row still renders the same eight figures with the new footer band on the ones with a trend.

```bash
cd frontend && npx eslint src/components/charts/StatTile.js src/pages/Reports.js --ext .js
git add frontend/src/components/charts/StatTile.js frontend/src/index.css frontend/src/pages/Reports.js frontend/src/__smoke__/stattile.test.js
git commit -m "feat: add StatTile footer variant, use it for the trended KPIs on Reports"
```

---

### Task 5: Tabs primitive, InvestigationCase.js tab bar

**Files:**
- Create: `frontend/src/components/ui/Tabs.jsx`
- Create: `frontend/src/components/ui/Tabs.css`
- Modify: `frontend/src/pages/InvestigationCase.js:1031,1051-1081` (tab bar + panel switch)
- Test: `frontend/src/__smoke__/uitabs.test.js`

**Interfaces:**
- Produces: `export default function Tabs({ items, selected, onChange, children })` where `items = [{ id, label, Icon? }]` and `children` is a function `(id) => node` OR — simpler for this call site — the caller renders `<Tabs.Panel id="...">...</Tabs.Panel>` children directly. This plan uses the render-prop-free composable form to match how `InvestigationCase.js` already lists eight panels as JSX:
  - `<Tabs items={TABS} selected={tab} onChange={setTab}>`
  - `<TabPanel id="overview"><OverviewTab .../></TabPanel>` ... (named export `TabPanel` alongside default `Tabs`)
- **Must preserve the mount-once/hide-on-leave contract already established for tab UIs in this codebase** (see `frontend/src/__smoke__/aitabs.test.js` for `AIAnalytics.js`'s version of the same rule) — a panel is mounted the first time its tab is opened and stays mounted, hidden rather than unmounted, when the officer switches away. This is a real perf requirement (some `InvestigationCase.js` tabs are expensive to build), not a nice-to-have.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/uitabs.test.js
//
// Same mount-once/hide-on-leave contract as AIAnalytics.js's tabs
// (see aitabs.test.js) — an unvisited panel costs nothing, a visited one is
// never rebuilt, and exactly one panel is visible at a time.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Tabs, { TabPanel } from '../components/ui/Tabs';

const mounts = { a: 0, b: 0 };
function Pane({ id }) {
  React.useEffect(() => { mounts[id] += 1; }, [id]);
  return <div data-testid={id}>{id} pane</div>;
}

const items = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }];

function Harness() {
  const [tab, setTab] = React.useState('a');
  return (
    <Tabs items={items} selected={tab} onChange={setTab}>
      <TabPanel id="a"><Pane id="a" /></TabPanel>
      <TabPanel id="b"><Pane id="b" /></TabPanel>
    </Tabs>
  );
}

const visible = (id) => {
  const el = screen.queryByTestId(id);
  return !!el && !el.closest('[hidden]');
};

beforeEach(() => { mounts.a = 0; mounts.b = 0; });

test('the unvisited tab is not mounted', () => {
  render(<Harness />);
  expect(mounts).toMatchObject({ a: 1, b: 0 });
});

test('switching tabs mounts the new one and hides, not unmounts, the old one', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('tab', { name: 'Beta' }));
  expect(mounts).toMatchObject({ a: 1, b: 1 });
  expect(visible('a')).toBe(false);
  expect(visible('b')).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: 'Alpha' }));
  expect(mounts.a).toBe(1); // not rebuilt
  expect(visible('a')).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uitabs.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `Tabs.jsx`**

```jsx
// frontend/src/components/ui/Tabs.jsx
import React, { createContext, useContext } from 'react';
import { Tabs as AriaTabs, TabList, Tab, TabPanel as AriaTabPanel } from 'react-aria-components';
import './Tabs.css';

const VisitedContext = createContext(null);

export default function Tabs({ items, selected, onChange, children, variant = 'underline' }) {
  const visitedRef = React.useRef(new Set([selected]));
  visitedRef.current.add(selected);

  return (
    <AriaTabs
      className={`ui-tabs ui-tabs-${variant}`}
      selectedKey={selected}
      onSelectionChange={(key) => onChange(String(key))}
    >
      <TabList aria-label="Sections" items={items}>
        {(item) => (
          <Tab id={item.id} className="ui-tab">
            {item.Icon && <item.Icon size={14} strokeWidth={1.8} />}
            {item.label}
          </Tab>
        )}
      </TabList>
      <VisitedContext.Provider value={visitedRef.current}>
        {children}
      </VisitedContext.Provider>
    </AriaTabs>
  );
}

// A panel mounts the first time its tab is visited and stays mounted (hidden
// via [hidden], not removed) from then on — matches the AIAnalytics.js tab
// contract so switching case-diary sections never re-pays the first build.
export function TabPanel({ id, children }) {
  const visited = useContext(VisitedContext);
  if (!visited || !visited.has(id)) {
    return <AriaTabPanel id={id} shouldForceMount />;
  }
  return <AriaTabPanel id={id} shouldForceMount>{children}</AriaTabPanel>;
}
```

```css
/* frontend/src/components/ui/Tabs.css */
.ui-tabs-underline [role='tablist'] {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--hairline);
}
.ui-tab {
  padding: 8px 12px;
  font-size: var(--fs-sm);
  color: var(--ink-subtle);
  border-bottom: 2px solid transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ui-tab[aria-selected='true'] { color: var(--ink); border-bottom-color: var(--primary); }
.ui-tab[data-focus-visible] { outline: 2px solid var(--primary-focus); outline-offset: -2px; }
[role='tabpanel'][hidden] { display: none; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uitabs.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into `InvestigationCase.js`**

Read `frontend/src/pages/InvestigationCase.js:960-1082` in full before editing (the `TABS` array definition, the `tab`/`setTab` state at line 970, and the `inv-tabbar`/`inv-tabbar-mobile` JSX at 1051-1081) to get the exact current `TABS` shape and every `{tab === 'x' && <XTab .../>}` line. Replace the `inv-tabbar` button row and the eight `{tab === '...' && ...}` conditionals with:

```jsx
<Tabs items={TABS} selected={tab} onChange={setTab}>
  <TabPanel id="overview"><OverviewTab rec={rec} /></TabPanel>
  <TabPanel id="diary"><DiaryTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} /></TabPanel>
  <TabPanel id="statements"><StatementsTab rec={rec} caseMasterId={rec.caseMasterId} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} /></TabPanel>
  <TabPanel id="evidence"><EvidenceTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} /></TabPanel>
  <TabPanel id="persons"><PersonsTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} /></TabPanel>
  <TabPanel id="timeline"><TimelineTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} /></TabPanel>
  <TabPanel id="findings"><FindingsTab rec={rec} onAdd={onAdd} onUpdate={onUpdate} onDelete={onDelete} /></TabPanel>
  <TabPanel id="reports"><ReportsTab caseMasterId={rec.caseMasterId} crimeNo={rec.crimeNo} /></TabPanel>
  <TabPanel id="summary"><SummaryTab caseMasterId={rec.caseMasterId} /></TabPanel>
</Tabs>
```

using whatever the real per-panel props turn out to be once the file is read (the props shown above are taken from the existing conditional-render lines found during codebase exploration for this plan — confirm they still match). Keep the existing `inv-tabbar-mobile` dropdown as-is (it already calls `setTab`, which still works unchanged) or fold it into `Tabs` only if it can be done without changing its current mobile behavior — if uncertain, leave `inv-tabbar-mobile` exactly as it is and only replace the desktop `inv-tabbar` button row. Add `import Tabs, { TabPanel } from '../components/ui/Tabs';`.

- [ ] **Step 6: Manual check + lint + commit**

`catalyst serve`, open a case's Investigation Diary detail page, click through every tab, confirm content still renders and switching tabs is instant on the second visit.

```bash
cd frontend && npx eslint src/components/ui/Tabs.jsx src/pages/InvestigationCase.js --ext .js,.jsx
git add frontend/src/components/ui/Tabs.jsx frontend/src/components/ui/Tabs.css frontend/src/pages/InvestigationCase.js frontend/src/__smoke__/uitabs.test.js
git commit -m "feat: rebuild the case-diary tab bar on an accessible Tabs primitive"
```

---

### Task 6: FileUpload primitive, Records.js drop zone

**Files:**
- Create: `frontend/src/components/ui/FileUpload.jsx`
- Create: `frontend/src/components/ui/FileUpload.css`
- Modify: `frontend/src/pages/Records.js:232-372` (drop zone JSX only — `onDrop`/`stage`/`fileReadable` business logic is unchanged)
- Test: `frontend/src/__smoke__/uifileupload.test.js`

**Interfaces:**
- Produces: `export default function FileUpload({ onFiles, accept, busy, progress, children })` — a presentational drop surface (`react-aria-components`' `DropZone` + `FileTrigger`) that calls `onFiles(FileList|File[])` on drop or on picker selection, and shows an animated perimeter ring when `busy` is true, filled to `progress` (0-100) if given, else an indeterminate sweep. It does NOT validate extensions/size itself — Records.js already has `detectKind`/`isPageKind` filtering in `stage()`, so validation stays there (no duplicate logic).
- Consumes: Records.js's existing `stage` function as `onFiles`, existing `dragging`/`preparing` state for `busy`.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/uifileupload.test.js
//
// A thin presentational shell around react-aria-components' DropZone —
// Records.js keeps owning what counts as a valid file (stage()/detectKind);
// this only has to get the files out of a drop or a click-to-browse.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import FileUpload from '../components/ui/FileUpload';

test('dropping files calls onFiles with the dropped items', async () => {
  const onFiles = jest.fn();
  render(<FileUpload onFiles={onFiles}>Drop here</FileUpload>);
  const zone = screen.getByText('Drop here').closest('[role="button"], div');
  const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
  fireEvent.drop(zone, {
    dataTransfer: {
      files: [file],
      items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => file }],
      types: ['Files'],
    },
  });
  await screen.findByText('Drop here');
  expect(onFiles).toHaveBeenCalled();
});

test('a busy upload shows the progress ring', () => {
  render(<FileUpload onFiles={() => {}} busy progress={40}>Drop here</FileUpload>);
  const ring = document.querySelector('.ui-upload-ring');
  expect(ring).toHaveAttribute('data-progress', '40');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uifileupload.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `FileUpload.jsx`**

```jsx
// frontend/src/components/ui/FileUpload.jsx
import { DropZone, FileTrigger } from 'react-aria-components';
import './FileUpload.css';

export default function FileUpload({ onFiles, accept, busy, progress, children, className, ...rest }) {
  const toArray = (items) =>
    Array.from(items || []).map((it) => (typeof it.getFile === 'function' ? it.getFile() : it)).filter(Boolean);

  return (
    <DropZone
      className={`ui-upload ${className || ''} ${busy ? 'busy' : ''}`}
      onDrop={async (e) => {
        const files = await Promise.all(
          e.items.filter((it) => it.kind === 'file').map((it) => it.getFile())
        );
        if (files.length) onFiles(files);
      }}
      {...rest}
    >
      <FileTrigger acceptedFileTypes={accept} allowsMultiple onSelect={(files) => onFiles(toArray(files))}>
        <button type="button" className="ui-upload-trigger">{children}</button>
      </FileTrigger>
      {busy && (
        <span
          className="ui-upload-ring"
          data-progress={progress ?? ''}
          style={progress != null ? { '--ui-upload-pct': `${progress}%` } : undefined}
        />
      )}
    </DropZone>
  );
}
```

```css
/* frontend/src/components/ui/FileUpload.css */
.ui-upload { position: relative; }
.ui-upload-trigger { all: unset; display: contents; cursor: pointer; }
.ui-upload-ring {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  border: 2px solid transparent;
  background:
    conic-gradient(var(--primary) var(--ui-upload-pct, 0%), transparent 0) border-box;
  -webkit-mask: linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
}
.ui-upload-ring:not([style]) { animation: ui-upload-sweep 1.4s linear infinite; }
@keyframes ui-upload-sweep { to { transform: rotate(360deg); } }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uifileupload.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into Records.js**

Read `frontend/src/pages/Records.js:220-373` in full first (the `onDrop`, `dragging`, `preparing`, `stage`, `cameraRef`, `fileRef` definitions and the drop-zone JSX). Replace only the outer `<div className={`dg-drop...`} onDragOver=... onDrop=... role="button" ...>` wrapper with `<FileUpload onFiles={stage} accept={ACCEPT_LIST} busy={!!preparing} className="dg-drop">`, keeping the existing inner content (icon, copy, the camera button with its `stopPropagation`) as `FileUpload`'s children exactly as they are today, and keeping the existing hidden `<input>` elements and `cameraRef`/`fileRef` untouched (`FileUpload`'s own `FileTrigger` becomes the new click-to-browse path, so the manual `onClick={() => fileRef.current?.click()}` / `onKeyDown` handlers on the wrapper div are removed — `FileUpload` already provides click-to-browse and keyboard access via `FileTrigger`'s internal button). Keep the existing `fileRef`/hidden `<input>` only if `cameraRef`'s photo capture still needs its own separate hidden input (it does — `FileUpload`'s trigger doesn't cover `capture="environment"`); only the general "browse files" hidden input becomes redundant and can be removed once `FileUpload` owns that path, along with `dragging` state if nothing else reads it.

Define `ACCEPT_LIST` as the same extension list already inline in the current file-input's `accept="..."` attribute (copy it verbatim into a constant near the top of `Records.js` rather than duplicating the long string inline again).

- [ ] **Step 6: Manual check + lint + commit**

`catalyst serve`, open `/app/records`, drag a file onto the drop zone and confirm it stages, click the zone to open the file picker, confirm the camera button still works independently.

```bash
cd frontend && npx eslint src/components/ui/FileUpload.jsx src/pages/Records.js --ext .js,.jsx
git add frontend/src/components/ui/FileUpload.jsx frontend/src/components/ui/FileUpload.css frontend/src/pages/Records.js frontend/src/__smoke__/uifileupload.test.js
git commit -m "feat: rebuild the Records drop zone on an accessible FileUpload primitive"
```

---

### Task 7: DatePicker primitive, replaces `DateRangeCalendar.js`

**Files:**
- Create: `frontend/src/components/ui/DatePicker.jsx`
- Create: `frontend/src/components/ui/DatePicker.css`
- Delete: `frontend/src/components/DateRangeCalendar.js`
- Modify: `frontend/src/pages/Reports.js` (swap the import and the `<DateRangeCalendar .../>` call site only — the surrounding `calOpen`/`customRange`/Apply/Clear logic is unchanged)
- Test: `frontend/src/__smoke__/uidatepicker.test.js`

**Interfaces:**
- Produces: `export default function DateRangePicker({ from, to, onSelect })` — same contract `DateRangeCalendar` already had (`from`/`to` as `'YYYY-MM-DD'` strings or null, `onSelect({ from, to })` called once the officer confirms a range), so nothing outside this task needs to change how it's called.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/uidatepicker.test.js
//
// DateRangeCalendar was a hand-rolled month grid; this replaces it with
// react-aria-components' RangeCalendar plus a quick-select preset list, kept
// behind the exact same from/to/onSelect contract so Reports.js's Apply/
// Clear/calOpen state doesn't have to change.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import DatePicker from '../components/ui/DatePicker';

test('picking the "Today" preset calls onSelect with today as both ends', () => {
  const onSelect = jest.fn();
  render(<DatePicker from={null} to={null} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole('button', { name: /today/i }));
  const today = new Date().toISOString().slice(0, 10);
  expect(onSelect).toHaveBeenCalledWith({ from: today, to: today });
});

test('an existing range is reflected in the calendar selection', () => {
  render(<DatePicker from="2026-01-01" to="2026-01-05" onSelect={() => {}} />);
  // The grid renders at least the start date's cell as selected.
  expect(document.querySelector('[aria-selected="true"]')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uidatepicker.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `DatePicker.jsx`**

```jsx
// frontend/src/components/ui/DatePicker.jsx
import { RangeCalendar } from 'react-aria-components';
import { parseDate, today, getLocalTimeZone } from '@internationalized/date';
import './DatePicker.css';

const tz = getLocalTimeZone();
const toIso = (calDate) => calDate.toString(); // @internationalized/date already formats as YYYY-MM-DD

const PRESETS = [
  { label: 'Today', range: () => { const d = today(tz); return { from: d, to: d }; } },
  { label: 'Last 7 days', range: () => ({ from: today(tz).subtract({ days: 6 }), to: today(tz) }) },
  { label: 'This month', range: () => ({ from: today(tz).set({ day: 1 }), to: today(tz) }) },
];

export default function DatePicker({ from, to, onSelect }) {
  const value = from && to ? { start: parseDate(from), end: parseDate(to) } : null;

  const commit = (range) => onSelect({ from: toIso(range.start ?? range.from), to: toIso(range.end ?? range.to) });

  return (
    <div className="ui-datepicker">
      <div className="ui-datepicker-presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" onClick={() => commit(p.range())}>
            {p.label}
          </button>
        ))}
      </div>
      <RangeCalendar
        className="ui-datepicker-calendar"
        value={value}
        onChange={(range) => range?.start && range?.end && commit(range)}
      />
    </div>
  );
}
```

```css
/* frontend/src/components/ui/DatePicker.css */
.ui-datepicker { display: flex; gap: 16px; padding: 12px; background: var(--bg-1); border: 1px solid var(--hairline); border-radius: var(--r-card); }
.ui-datepicker-presets { display: flex; flex-direction: column; gap: 4px; min-width: 120px; border-right: 1px solid var(--hairline); padding-right: 12px; }
.ui-datepicker-presets button { text-align: left; padding: 6px 8px; border: none; background: none; color: var(--ink-muted); border-radius: var(--r-ctl); cursor: pointer; font-size: var(--fs-sm); }
.ui-datepicker-presets button:hover { background: var(--bg-3); color: var(--ink); }
[data-theme='dark'] .ui-datepicker { background: var(--bg-1); }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uidatepicker.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Swap Reports.js's call site, delete `DateRangeCalendar.js`**

In `frontend/src/pages/Reports.js`, change `import DateRangeCalendar from '../components/DateRangeCalendar';` to `import DatePicker from '../components/ui/DatePicker';` and rename the `<DateRangeCalendar from={...} to={...} onSelect={...} />` JSX tag to `<DatePicker from={...} to={...} onSelect={...} />` (same props, so only the two identifiers change — confirm the exact prop names Reports.js passes by reading the current call site first, in case it uses different local variable names than `from`/`to`).

```bash
rm frontend/src/components/DateRangeCalendar.js
```

- [ ] **Step 6: Manual check + lint + commit**

`catalyst serve`, open `/app/reports`, open the custom date-range picker, confirm the presets and manual range selection both drive the KPI row/charts as before.

```bash
cd frontend && npx eslint src/components/ui/DatePicker.jsx src/pages/Reports.js --ext .js,.jsx
git add frontend/src/components/ui/DatePicker.jsx frontend/src/components/ui/DatePicker.css frontend/src/pages/Reports.js frontend/src/__smoke__/uidatepicker.test.js
git rm frontend/src/components/DateRangeCalendar.js
git commit -m "feat: replace the hand-rolled date range calendar with an accessible DatePicker"
```

---

### Task 8: Data table — sorting + search on `AguiTable` (AguiRenderer.js)

**Files:**
- Modify: `frontend/src/components/AguiRenderer.js:64-118` (`AguiTable` function only)
- Test: `frontend/src/__smoke__/aguidatatable.test.js`

**Interfaces:**
- `AguiTable`'s external contract (`spec.columns`, `spec.rows`, `pageSize`) is unchanged — this task only adds internal sort/search state. No other file calls `AguiTable` directly (it's only reached via `AguiComponent`'s `spec.type === 'table'` branch), so no other call site changes.
- Deliberately NOT ported from Spectrum UI: drag-to-resize columns, pinned columns, row selection, bulk actions. These assume a table the user acts on; an assistant-rendered table is read-only answer content, so that surface would be speculative. Sorting and search are the two behaviors that make a long LLM-generated table actually usable, so those are the ones added.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/aguidatatable.test.js
//
// AguiTable already paginated; this adds the two things a long assistant-
// generated table actually needs to be useful — sort a column, search across
// all of them — without touching its columns/rows/pageSize contract.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AguiRenderer from '../components/AguiRenderer';

const spec = {
  type: 'table',
  title: 'Cases',
  columns: ['District', 'Count'],
  rows: [['Bengaluru', '40'], ['Mysuru', '15'], ['Hubballi', '25']],
};

test('clicking a column header sorts by that column', () => {
  render(<AguiRenderer components={[spec]} />);
  fireEvent.click(screen.getByText('District'));
  const cells = screen.getAllByRole('cell').filter((_, i) => i % 2 === 0).map((c) => c.textContent);
  expect(cells).toEqual(['Bengaluru', 'Hubballi', 'Mysuru']);
});

test('typing in the search box filters rows across all columns', () => {
  render(<AguiRenderer components={[spec]} />);
  fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'mysuru' } });
  expect(screen.queryByText('Bengaluru')).toBeNull();
  expect(screen.getByText('Mysuru')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/aguidatatable.test.js`
Expected: FAIL — no search box, header click does nothing

- [ ] **Step 3: Add sort + search to `AguiTable`**

Replace the existing `AguiTable` function (lines 64-118) with:

```jsx
function AguiTable({ spec, pageSize = 8 }) {
  const [page, setPage] = useState(0);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState(null); // { col: number, dir: 1 | -1 }

  const columns = Array.isArray(spec.columns) ? spec.columns : [];
  const allRows = (Array.isArray(spec.rows) ? spec.rows : []).filter(Array.isArray);
  if (!columns.length || !allRows.length) return null;

  const filtered = q.trim()
    ? allRows.filter((r) => r.some((cell) => String(cell ?? '').toLowerCase().includes(q.trim().toLowerCase())))
    : allRows;

  const rows = sort
    ? [...filtered].sort((a, b) => {
        const av = a[sort.col], bv = b[sort.col];
        const an = Number(av), bn = Number(bv);
        const cmp = Number.isFinite(an) && Number.isFinite(bn)
          ? an - bn
          : String(av ?? '').localeCompare(String(bv ?? ''));
        return cmp * sort.dir;
      })
    : filtered;

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const slice = rows.slice(cur * pageSize, cur * pageSize + pageSize);

  const cycleSort = (col) => {
    setPage(0);
    setSort((s) => {
      if (!s || s.col !== col) return { col, dir: 1 };
      if (s.dir === 1) return { col, dir: -1 };
      return null; // third click clears the sort
    });
  };

  return (
    <div>
      {allRows.length > pageSize && (
        <input
          type="search"
          className="agui-table-search"
          placeholder="Search table…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(0); }}
        />
      )}
      <div className="cf-table-wrap">
        <table className="cf-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i}>
                  <button type="button" className="agui-table-sort" onClick={() => cycleSort(i)}>
                    {renderInline(normaliseText(c), `th${i}`)}
                    {sort?.col === i && (sort.dir === 1 ? ' ↑' : ' ↓')}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i}>
                {columns.map((_, j) => <td key={j}>{renderCell(r[j])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="cf-pager">
          <span className="cf-pager-info">
            {cur * pageSize + 1}–{Math.min(rows.length, (cur + 1) * pageSize)} of {rows.length}
          </span>
          <div className="cf-pager-controls">
            <button className="cf-page-btn" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Previous page">
              <ChevronLeft size={15} />
            </button>
            <span className="cf-page-num">{cur + 1} / {pages}</span>
            <button className="cf-page-btn" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Next page">
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

Add to `frontend/src/index.css` beside the existing `.cf-table` rules:

```css
.agui-table-search {
  display: block;
  margin-bottom: 8px;
  padding: 6px 10px;
  border: 1px solid var(--hairline);
  border-radius: var(--r-ctl);
  background: var(--bg-1);
  color: var(--ink);
  font-size: var(--fs-sm);
  width: 220px;
}
.agui-table-sort { all: unset; cursor: pointer; display: inline-flex; align-items: center; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/aguidatatable.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Manual check + lint + commit**

`catalyst serve`, open `/app/assistant`, ask a question that yields a table answer (e.g. "top 10 districts by FIR count"), confirm sorting and search work and pagination still does.

```bash
cd frontend && npx eslint src/components/AguiRenderer.js --ext .js
git add frontend/src/components/AguiRenderer.js frontend/src/index.css frontend/src/__smoke__/aguidatatable.test.js
git commit -m "feat: add sort and search to assistant-rendered data tables"
```

---

### Task 9: Agent loading state — pixel-grid shimmer + elapsed time (`Thinking.js`)

**Files:**
- Modify: `frontend/src/components/Thinking.js`
- Test: `frontend/src/__smoke__/thinking.test.js`

**Interfaces:**
- `Thinking`'s external contract is unchanged: `<Thinking label={optionalFixedLabel} />`. `Assistant.js:1171` and `ChatWidget.js` call sites need no edits.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/thinking.test.js
//
// Beautiful UI's loading state pairs a shimmer with an elapsed-time readout
// so a long answer (a Sherlock run can take 60-110s) never looks stalled —
// the existing cycling-phrase text stays, this adds the timer beside it.
import React from 'react';
import { render, screen, act } from '@testing-library/react';
import Thinking from '../components/Thinking';

jest.useFakeTimers();

test('the elapsed time counts up while the indicator is shown', () => {
  render(<Thinking />);
  expect(screen.getByText('0s')).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(3000); });
  expect(screen.getByText('3s')).toBeInTheDocument();
});

test('a fixed label is still shown unchanged', () => {
  render(<Thinking label="Running Sherlock…" />);
  expect(screen.getByText('Running Sherlock…')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/thinking.test.js`
Expected: FAIL — no elapsed-time text

- [ ] **Step 3: Implement**

```jsx
// frontend/src/components/Thinking.js
import React, { useState, useEffect } from 'react';

const PHRASES = [
  'Working…', 'Collating records…', 'Querying the Data Store…', 'Cross-checking sources…',
  'Reading the case files…', 'Unfurling patterns…', 'Weighing the evidence…', 'Assembling the answer…',
];

const GRID = Array.from({ length: 9 });

export default function Thinking({ label } = {}) {
  const [i, setI] = useState(() => Math.floor(Math.random() * PHRASES.length));
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (label) return undefined;
    const id = setInterval(() => setI((n) => (n + 1) % PHRASES.length), 1800);
    return () => clearInterval(id);
  }, [label]);

  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <span className="as-thinking">
      <span className="as-thinking-grid" aria-hidden="true">
        {GRID.map((_, idx) => <span key={idx} style={{ animationDelay: `${(idx % 3) * 120}ms` }} />)}
      </span>
      <span className="as-thinking-phrase" key={label ? 'fixed' : i}>{label || PHRASES[i]}</span>
      <span className="as-thinking-elapsed">{elapsed}s</span>
    </span>
  );
}
```

Add to `frontend/src/index.css` beside the existing `.as-thinking`/`.as-typing` rules (grep to find them and append there):

```css
.as-thinking-grid {
  display: inline-grid;
  grid-template-columns: repeat(3, 4px);
  grid-template-rows: repeat(3, 4px);
  gap: 2px;
}
.as-thinking-grid span {
  background: var(--primary);
  border-radius: 1px;
  animation: as-thinking-shimmer 1.2s ease-in-out infinite;
}
@keyframes as-thinking-shimmer { 0%, 100% { opacity: 0.25; } 50% { opacity: 1; } }
.as-thinking-elapsed { color: var(--ink-tertiary); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { .as-thinking-grid span { animation: none; opacity: 0.6; } }
```

(Keep the existing `.as-typing` dots CSS as-is — this replaces the grid visual, but if `.as-typing`'s three-dot markup is still referenced elsewhere, leave that CSS rule in place even though `Thinking.js` no longer renders `.as-typing` itself; grep `as-typing` first to confirm nothing else depends on the exact markup before deciding whether to remove the now-unused `.as-typing` rule.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/thinking.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Manual check + lint + commit**

`catalyst serve`, ask the assistant a question, confirm the shimmer grid animates and the elapsed-time counter ticks up while waiting.

```bash
cd frontend && npx eslint src/components/Thinking.js --ext .js
git add frontend/src/components/Thinking.js frontend/src/index.css frontend/src/__smoke__/thinking.test.js
git commit -m "feat: pixel-grid shimmer + elapsed time on the agent loading indicator"
```

---

### Task 10: MessageScroller primitive, Assistant.js + ChatWidget.js thread

**Files:**
- Create: `frontend/src/components/ui/MessageScroller.jsx`
- Create: `frontend/src/components/ui/MessageScroller.css`
- Modify: `frontend/src/pages/Assistant.js:367-371` (autoscroll effect) and the `as-thread` JSX wrapper (~line 1077)
- Modify: `frontend/src/components/ChatWidget.js` (its own thread container/autoscroll effect — find via `threadRef`)
- Test: `frontend/src/__smoke__/messagescroller.test.js`

**Interfaces:**
- Produces: `export default function MessageScroller({ children, dependency, followThreshold = 56, className })` — a `<div>` that auto-scrolls to bottom when `dependency` changes (new message / streaming update) **only if the reader was already within `followThreshold`px of the bottom**; if they've scrolled up to read earlier messages, new content no longer yanks them back down. Exposes the underlying scroll node via a forwarded ref so callers that need `.scrollTop` elsewhere (none currently do, once this task lands) still could.
- Consumes: replaces Assistant.js's manual `useEffect(() => { threadRef.current.scrollTop = ... }, [messages, sending])` and ChatWidget.js's equivalent.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/messagescroller.test.js
//
// The old behavior always snapped to the bottom on every new message — if an
// officer scrolled up mid-stream to reread something, the next token yanked
// them back down. This only auto-follows when they were already at the live
// edge; scrolled away, new content arrives without moving their view.
import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import MessageScroller from '../components/ui/MessageScroller';

function setScrollState(el, { scrollTop, scrollHeight, clientHeight }) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  el.scrollTop = scrollTop;
}

test('auto-scrolls to the bottom when the reader is already at the live edge', () => {
  const { container, rerender } = render(<MessageScroller dependency={1}>msg1</MessageScroller>);
  const el = container.firstChild;
  setScrollState(el, { scrollTop: 0, scrollHeight: 100, clientHeight: 100 }); // already at bottom
  rerender(<MessageScroller dependency={2}>msg1 msg2</MessageScroller>);
  expect(el.scrollTop).toBe(el.scrollHeight);
});

test('does not yank the reader back down when they scrolled away from the edge', () => {
  const { container, rerender } = render(<MessageScroller dependency={1}>msg1</MessageScroller>);
  const el = container.firstChild;
  setScrollState(el, { scrollTop: 0, scrollHeight: 500, clientHeight: 100 }); // far from bottom
  fireEvent.scroll(el);
  rerender(<MessageScroller dependency={2}>msg1 msg2</MessageScroller>);
  expect(el.scrollTop).toBe(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/messagescroller.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```jsx
// frontend/src/components/ui/MessageScroller.jsx
import React, { useEffect, useRef } from 'react';
import './MessageScroller.css';

export default function MessageScroller({ children, dependency, followThreshold = 56, className }) {
  const ref = useRef(null);
  const followRef = useRef(true);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followRef.current = distanceFromBottom <= followThreshold;
  };

  useEffect(() => {
    const el = ref.current;
    if (el && followRef.current) el.scrollTop = el.scrollHeight;
  }, [dependency]);

  return (
    <div ref={ref} className={`ui-message-scroller ${className || ''}`} onScroll={onScroll}>
      {children}
    </div>
  );
}
```

```css
/* frontend/src/components/ui/MessageScroller.css */
.ui-message-scroller { overflow-y: auto; scroll-behavior: smooth; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/messagescroller.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into Assistant.js**

Remove the effect at lines 367-371:

```jsx
// remove
useEffect(() => {
  const el = threadRef.current;
  if (el) el.scrollTop = el.scrollHeight;
}, [messages, sending]);
```

Change the thread wrapper from `<div className="as-thread" ref={threadRef}>` to:

```jsx
<MessageScroller className="as-thread" dependency={`${messages.length}-${sending}`} ref={threadRef}>
```

Since `MessageScroller` needs to forward its internal ref to match the existing `threadRef.current` usages elsewhere in the file (grep `threadRef` in `Assistant.js` — it's referenced only inside the removed effect and the JSX attachment; if nothing else reads `threadRef.current`, drop the `ref={threadRef}` prop and the `threadRef` variable entirely rather than adding `forwardRef` for an unused ref). Add `import MessageScroller from '../components/ui/MessageScroller';`.

- [ ] **Step 6: Wire into ChatWidget.js**

Read `frontend/src/components/ChatWidget.js`'s thread section (find `threadRef` and its scroll effect) and apply the same swap: remove the manual scrollTop effect, wrap the thread container in `<MessageScroller className="..." dependency={...}>` using whatever the existing thread `className` and dependency array already are in that file.

- [ ] **Step 7: Manual check + lint + commit**

`catalyst serve`, open `/app/assistant`, ask a multi-paragraph question, scroll up mid-stream, confirm the view stays put; scroll back to the bottom and confirm new tokens resume auto-following. Repeat in the floating widget.

```bash
cd frontend && npx eslint src/components/ui/MessageScroller.jsx src/pages/Assistant.js src/components/ChatWidget.js --ext .js,.jsx
git add frontend/src/components/ui/MessageScroller.jsx frontend/src/components/ui/MessageScroller.css frontend/src/pages/Assistant.js frontend/src/components/ChatWidget.js frontend/src/__smoke__/messagescroller.test.js
git commit -m "feat: reader-aware auto-scroll for the assistant thread and chat widget"
```

---

### Task 11: BorderBeam primitive, applied to the composer

**Files:**
- Create: `frontend/src/components/ui/BorderBeam.jsx`
- Create: `frontend/src/components/ui/BorderBeam.css`
- Modify: `frontend/src/pages/Assistant.js` (`as-composer` wrapper, ~line 1198)
- Modify: `frontend/src/components/ChatWidget.js` (its own composer wrapper)
- Test: `frontend/src/__smoke__/borderbeam.test.js`

**Interfaces:**
- Produces: `export default function BorderBeam({ active, children, className })` — wraps `children` (the existing composer markup, untouched) in a positioned container; when `active` is true (composer focused or the assistant is streaming a reply) an animated gradient sweeps the border via `motion/react`; `prefers-reduced-motion` disables the sweep and shows a static highlighted border instead.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/borderbeam.test.js
//
// Purely decorative — the only behavior worth locking down is that it does
// not swallow or alter its children, and that the animated layer only
// mounts when active (so an idle composer isn't burning a rAF loop).
import React from 'react';
import { render } from '@testing-library/react';
import BorderBeam from '../components/ui/BorderBeam';

test('renders its children unchanged', () => {
  const { getByText } = render(<BorderBeam active={false}><button>Send</button></BorderBeam>);
  expect(getByText('Send')).toBeInTheDocument();
});

test('the animated beam layer only mounts when active', () => {
  const { container, rerender } = render(<BorderBeam active={false}><div /></BorderBeam>);
  expect(container.querySelector('.ui-border-beam-glow')).toBeNull();
  rerender(<BorderBeam active><div /></BorderBeam>);
  expect(container.querySelector('.ui-border-beam-glow')).not.toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/borderbeam.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```jsx
// frontend/src/components/ui/BorderBeam.jsx
import { motion } from 'motion/react';
import './BorderBeam.css';

export default function BorderBeam({ active, children, className }) {
  return (
    <div className={`ui-border-beam ${className || ''} ${active ? 'active' : ''}`}>
      {active && (
        <motion.span
          className="ui-border-beam-glow"
          aria-hidden="true"
          animate={{ '--beam-angle': ['0deg', '360deg'] }}
          transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
        />
      )}
      {children}
    </div>
  );
}
```

```css
/* frontend/src/components/ui/BorderBeam.css */
.ui-border-beam { position: relative; border-radius: inherit; }
.ui-border-beam-glow {
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  padding: 1px;
  background: conic-gradient(from var(--beam-angle, 0deg), transparent 0deg 300deg, var(--primary) 330deg, var(--primary-hover) 345deg, transparent 360deg);
  -webkit-mask: linear-gradient(#000 0 0) padding-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .ui-border-beam.active { box-shadow: 0 0 0 1px var(--primary-focus); }
  .ui-border-beam-glow { display: none; }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/borderbeam.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into Assistant.js's composer**

Add local state (or reuse existing `sending`/a new `composerFocused` state) so `active` is true while the composer's textarea has focus or while `sending` is true. In `frontend/src/pages/Assistant.js`, wrap the `<div className="as-composer">...</div>` block:

```jsx
<BorderBeam active={composerFocused || sending} className="as-composer-beam">
  <div className="as-composer">
    {/* unchanged contents */}
  </div>
</BorderBeam>
```

Add `onFocus={() => setComposerFocused(true)}` / `onBlur={() => setComposerFocused(false)}` to the existing `<textarea ref={textareaRef} className="as-input" ...>`, and `const [composerFocused, setComposerFocused] = useState(false);` near the other composer state. Add `import BorderBeam from '../components/ui/BorderBeam';`.

- [ ] **Step 6: Wire into ChatWidget.js's composer the same way**

Same pattern: wrap its composer div, drive `active` off its own textarea focus/`sending` state.

- [ ] **Step 7: Manual check + lint + commit**

`catalyst serve`, focus the composer on `/app/assistant`, confirm the beam sweeps; blur it, confirm it stops; send a message and confirm it re-activates while the reply streams.

```bash
cd frontend && npx eslint src/components/ui/BorderBeam.jsx src/pages/Assistant.js src/components/ChatWidget.js --ext .js,.jsx
git add frontend/src/components/ui/BorderBeam.jsx frontend/src/components/ui/BorderBeam.css frontend/src/pages/Assistant.js frontend/src/components/ChatWidget.js frontend/src/__smoke__/borderbeam.test.js
git commit -m "feat: animated border beam on the assistant composer while active"
```

---

### Task 12: VoiceGlow primitive (mobile-only), Assistant.js mic button

**Files:**
- Create: `frontend/src/components/ui/VoiceGlow.jsx`
- Create: `frontend/src/components/ui/VoiceGlow.css`
- Modify: `frontend/src/pages/Assistant.js` (mic button area, ~lines 1291-1308)
- Test: `frontend/src/__smoke__/voiceglow.test.js`

**Interfaces:**
- Produces: `export default function VoiceGlow({ listening, thinking })` — a decorative absolutely-positioned glow, rendered next to the mic button, CSS-media-gated to mobile viewports only (`display: none` above the breakpoint — no JS viewport branching needed, matches "native platform feature covers it" over a `useMediaQuery` hook). Pulses while `listening`, sweeps side-to-side while `thinking` (waiting for the reply). **Deliberately does not analyze live microphone amplitude** — libraries.dev's voice-glow reacts to real audio level, but Assistant.js has no existing audio-level pipeline (only a boolean `listening` state from `MediaRecorder`), and wiring a Web Audio `AnalyserNode` just for a decorative glow is more than this needs; the glow instead pulses at a fixed rhythm while `listening` is true. Documented cut, not a silent gap.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/voiceglow.test.js
import React from 'react';
import { render } from '@testing-library/react';
import VoiceGlow from '../components/ui/VoiceGlow';

test('carries a data-state of "listening" while listening', () => {
  const { container } = render(<VoiceGlow listening thinking={false} />);
  expect(container.firstChild).toHaveAttribute('data-state', 'listening');
});

test('carries a data-state of "thinking" while the reply is pending', () => {
  const { container } = render(<VoiceGlow listening={false} thinking />);
  expect(container.firstChild).toHaveAttribute('data-state', 'thinking');
});

test('carries a data-state of "idle" otherwise', () => {
  const { container } = render(<VoiceGlow listening={false} thinking={false} />);
  expect(container.firstChild).toHaveAttribute('data-state', 'idle');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/voiceglow.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```jsx
// frontend/src/components/ui/VoiceGlow.jsx
import './VoiceGlow.css';

export default function VoiceGlow({ listening, thinking }) {
  const state = listening ? 'listening' : thinking ? 'thinking' : 'idle';
  return <span className="ui-voice-glow" data-state={state} aria-hidden="true" />;
}
```

```css
/* frontend/src/components/ui/VoiceGlow.css */
.ui-voice-glow { display: none; }

@media (max-width: 640px) {
  .ui-voice-glow {
    display: block;
    position: absolute;
    inset: -6px;
    border-radius: inherit;
    pointer-events: none;
  }
  .ui-voice-glow[data-state='listening'] {
    box-shadow: 0 0 0 0 var(--primary);
    animation: ui-voice-pulse 1.2s ease-out infinite;
  }
  .ui-voice-glow[data-state='thinking'] {
    background: linear-gradient(90deg, transparent, var(--primary-hover), transparent);
    background-size: 200% 100%;
    animation: ui-voice-sweep 1.6s ease-in-out infinite;
  }
  @keyframes ui-voice-pulse {
    0% { box-shadow: 0 0 0 0 rgba(94, 106, 210, 0.5); }
    100% { box-shadow: 0 0 0 10px rgba(94, 106, 210, 0); }
  }
  @keyframes ui-voice-sweep {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .ui-voice-glow { animation: none !important; }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/voiceglow.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Wire into Assistant.js's mic button**

In `frontend/src/pages/Assistant.js`, wrap the existing mic `<button className={`as-comp-btn ${listening ...}`} ...>` (around line 1295) so it can host the absolutely-positioned glow:

```jsx
{canRecord && (
  <span className="as-mic-wrap">
    <VoiceGlow listening={listening} thinking={sending} />
    <button
      className={`as-comp-btn ${listening ? 'listening' : ''} ${transcribing ? 'transcribing' : ''}`}
      onClick={toggleMic}
      disabled={transcribing}
      title={/* unchanged */}
    >
      <Mic size={18} />
    </button>
  </span>
)}
```

Add `.as-mic-wrap { position: relative; display: inline-flex; }` to `frontend/src/index.css` beside the other `.as-comp-btn`/`.as-mic-*` rules. Add `import VoiceGlow from '../components/ui/VoiceGlow';`.

- [ ] **Step 6: Manual check + lint + commit**

`catalyst serve`, resize the browser (or use device emulation) below 640px width, open `/app/assistant`, tap the mic, confirm the glow pulses; confirm it's invisible at desktop width.

```bash
cd frontend && npx eslint src/components/ui/VoiceGlow.jsx src/pages/Assistant.js --ext .js,.jsx
git add frontend/src/components/ui/VoiceGlow.jsx frontend/src/components/ui/VoiceGlow.css frontend/src/pages/Assistant.js frontend/src/index.css frontend/src/__smoke__/voiceglow.test.js
git commit -m "feat: mobile-only voice glow around the assistant mic button"
```

---

### Task 13: Context Cards — restyle `AguiCards` (AguiRenderer.js)

**Files:**
- Modify: `frontend/src/components/AguiRenderer.js:120-157` (`AguiCards` function only)
- Test: `frontend/src/__smoke__/aguicontextcards.test.js`

**Interfaces:**
- `AguiCards`'s contract (`spec.items: [{ title, subtitle, body, badge, to }]`) is unchanged. Only its CSS classes/markup structure change to match Beautiful UI's Context Card layout (icon-less source-style header, clearer body/footer separation).
- **Deviation, documented:** Beautiful UI's Context Cards are specifically "retrieved knowledge chunks with their sources" — this codebase's `cards` AGUI spec type is a more general title/subtitle/body/badge block (also used for non-retrieval answers), so the restyle borrows the *layout* (compact header, source-style badge placement, clamped body text) without requiring every card to carry a literal citation — that stays `SourceCitations`' job (Task 15).

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/aguicontextcards.test.js
import React from 'react';
import { render, screen } from '@testing-library/react';
import AguiRenderer from '../components/AguiRenderer';

const spec = {
  type: 'cards',
  items: [{ title: 'Section 302 IPC', subtitle: 'Murder', body: 'Whoever commits murder…', badge: 'Statute' }],
};

test('a context card shows its badge as a source-style tag', () => {
  render(<AguiRenderer components={[spec]} />);
  const card = screen.getByText('Section 302 IPC').closest('.agui-card');
  expect(card.querySelector('.agui-card-badge')).toHaveTextContent('Statute');
  expect(card).toHaveClass('agui-card-context');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/aguicontextcards.test.js`
Expected: FAIL — no `agui-card-context` class

- [ ] **Step 3: Restyle `AguiCards`**

In the existing `AguiCards` function, change the card `className` from `` `agui-card ${nav ? 'agui-card-nav' : ''}` `` to `` `agui-card agui-card-context ${nav ? 'agui-card-nav' : ''}` `` — logic and every other prop/handler stays identical.

Add to `frontend/src/index.css` beside the existing `.agui-card` rules (grep to find them):

```css
.agui-card-context { border-left: 2px solid var(--primary); }
.agui-card-context .agui-card-badge {
  font-size: var(--fs-caption);
  color: var(--ink-subtle);
  background: var(--bg-3);
  padding: 1px 6px;
  border-radius: var(--r-chip);
}
.agui-card-context .agui-card-body {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/aguicontextcards.test.js`
Expected: PASS (1 test)

- [ ] **Step 5: Manual check + lint + commit**

`catalyst serve`, ask the assistant a question that yields a `cards`-type answer, confirm the new left-accent/clamped-body styling.

```bash
cd frontend && npx eslint src/components/AguiRenderer.js --ext .js
git add frontend/src/components/AguiRenderer.js frontend/src/index.css frontend/src/__smoke__/aguicontextcards.test.js
git commit -m "feat: restyle assistant card blocks as context cards"
```

---

### Task 14: Insight Cards — paging on `AguiStatTiles` (AguiRenderer.js)

**Files:**
- Modify: `frontend/src/components/AguiRenderer.js:264-276` (`AguiStatTiles` function only)
- Test: `frontend/src/__smoke__/aguiinsightcards.test.js`

**Interfaces:**
- `AguiStatTiles`'s contract (`items: [{ label, value, hint, tone }]`) is unchanged; it gains internal paging (4 tiles per page) to match Beautiful UI's "Paged agent insights" description.
- **Deliberately not built:** "scrub-ready live charts" inside each tile — these tiles carry a single value, not a series (see `StatTile.js`'s own header comment on the same tradeoff: no sparkline without real history behind it). Paging is the part of the reference that's a genuine, cheap usability win here; per-tile scrubbable charts would need data this spec type doesn't carry.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/aguiinsightcards.test.js
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AguiRenderer from '../components/AguiRenderer';

const spec = {
  type: 'stat-tiles',
  items: Array.from({ length: 6 }, (_, i) => ({ label: `Metric ${i}`, value: i })),
};

test('only the first page of tiles is shown, with a next-page control', () => {
  render(<AguiRenderer components={[spec]} />);
  expect(screen.getByText('Metric 0')).toBeInTheDocument();
  expect(screen.queryByText('Metric 4')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /next/i }));
  expect(screen.getByText('Metric 4')).toBeInTheDocument();
  expect(screen.queryByText('Metric 0')).toBeNull();
});

test('fewer than a page of tiles renders with no pager', () => {
  render(<AguiRenderer components={[{ type: 'stat-tiles', items: [{ label: 'Solo', value: 1 }] }]} />);
  expect(screen.queryByRole('button', { name: /next/i })).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/aguiinsightcards.test.js`
Expected: FAIL — all 6 tiles render at once, no pager

- [ ] **Step 3: Implement paging**

```jsx
function AguiStatTiles({ items }) {
  const [page, setPage] = useState(0);
  const perPage = 4;
  const pages = Math.max(1, Math.ceil(items.length / perPage));
  const cur = Math.min(page, pages - 1);
  const slice = items.slice(cur * perPage, cur * perPage + perPage);

  return (
    <div>
      <div className="agui-stat-tiles">
        {slice.map((it, i) => (
          <div className={`agui-stat-tile tone-${it.tone}`} key={cur * perPage + i}>
            <span className="agui-stat-tile-value">{it.value}</span>
            <span className="agui-stat-tile-label">{normaliseText(it.label)}</span>
            {it.hint && <span className="agui-stat-tile-hint">{normaliseText(it.hint)}</span>}
          </div>
        ))}
      </div>
      {pages > 1 && (
        <div className="cf-pager">
          <span className="cf-pager-info">{cur + 1} / {pages}</span>
          <div className="cf-pager-controls">
            <button className="cf-page-btn" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Previous">
              <ChevronLeft size={15} />
            </button>
            <button className="cf-page-btn" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Next">
              <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

(`ChevronLeft`/`ChevronRight` are already imported at the top of `AguiRenderer.js` — reuse them, no new import.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/aguiinsightcards.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Manual check + lint + commit**

`catalyst serve`, ask a question that yields more than 4 stat tiles, confirm paging works.

```bash
cd frontend && npx eslint src/components/AguiRenderer.js --ext .js
git add frontend/src/components/AguiRenderer.js frontend/src/__smoke__/aguiinsightcards.test.js
git commit -m "feat: page assistant insight tiles past the first four"
```

---

### Task 15: Citations — restyle `SourceCitations.js` chip row

**Files:**
- Modify: `frontend/src/components/SourceCitations.js` (the `SourceCitations` exported function's render only — the popup viewer / provenance-fetching logic elsewhere in the 605-line file is untouched)
- Test: `frontend/src/__smoke__/uicitations.test.js`

**Interfaces:**
- `SourceCitations`'s contract (`sources`, `onOpen`) is unchanged; `SourceViewer` (the popup opened on click) is untouched. Only the chip-row markup/classes change, matching beUI's "numbered marker + collapsible stack" look: chips beyond the first 4 collapse behind a "+N more" control instead of always showing every chip inline.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/uicitations.test.js
//
// Existing behavior (clearance filtering, audit logging, click-to-open) lives
// upstream of this component and is untouched. This only checks the new
// "+N more" collapse once a message cites more than 4 sources.
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import SourceCitations from '../components/SourceCitations';

const sources = Array.from({ length: 6 }, (_, i) => ({
  source_id: `s${i}`, n: i + 1, display_name: `Source ${i}`, source_type: 'rag_document',
}));

test('only the first 4 citation chips show by default, with a "+N more" control', () => {
  render(<SourceCitations sources={sources} onOpen={() => {}} />);
  expect(screen.getByText('Source 0')).toBeInTheDocument();
  expect(screen.queryByText('Source 5')).toBeNull();
  expect(screen.getByText('+2 more')).toBeInTheDocument();
});

test('clicking "+N more" reveals the rest', () => {
  render(<SourceCitations sources={sources} onOpen={() => {}} />);
  fireEvent.click(screen.getByText('+2 more'));
  expect(screen.getByText('Source 5')).toBeInTheDocument();
});

test('4 or fewer sources show with no collapse control', () => {
  render(<SourceCitations sources={sources.slice(0, 3)} onOpen={() => {}} />);
  expect(screen.queryByText(/more$/)).toBeNull();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uicitations.test.js`
Expected: FAIL — all 6 chips render, no collapse control

- [ ] **Step 3: Add the collapse to `SourceCitations`**

Read `frontend/src/components/SourceCitations.js` lines 48-115 in full first (the exact chip-rendering JSX, including the web-link branch already seen during exploration) before editing, since the chip body differs between the web-link (`<a>`) and popup (`<button>`) cases and both need to respect the same visible/collapsed split. Add `const [expanded, setExpanded] = useState(false);` at the top of `SourceCitations`, compute `const visible = expanded ? sources : sources.slice(0, 4);` and map over `visible` instead of `sources` in the existing `.map((s) => {...})`, and after the mapped chips, add:

```jsx
{!expanded && sources.length > 4 && (
  <button type="button" className="as-cite-more" onClick={() => setExpanded(true)}>
    +{sources.length - 4} more
  </button>
)}
```

- [ ] **Step 4: Add the CSS**

Add to `frontend/src/index.css` beside the existing `.as-cite-*` rules:

```css
.as-cite-more {
  border: 1px dashed var(--hairline-strong);
  background: none;
  color: var(--ink-subtle);
  font-size: var(--fs-caption);
  padding: 3px 8px;
  border-radius: var(--r-pill);
  cursor: pointer;
}
.as-cite-more:hover { color: var(--ink); border-color: var(--primary); }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/uicitations.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Run the existing citations test to confirm no regression**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/citations.test.js`
Expected: PASS (this file already exercises `SourceCitations`' other behavior — it must stay green)

- [ ] **Step 7: Manual check + lint + commit**

`catalyst serve`, ask a question that returns more than 4 sources, confirm the collapse/expand control.

```bash
cd frontend && npx eslint src/components/SourceCitations.js --ext .js
git add frontend/src/components/SourceCitations.js frontend/src/index.css frontend/src/__smoke__/uicitations.test.js
git commit -m "feat: collapse citation chips past 4 behind a '+N more' control"
```

---

### Task 16: ActionButton primitive — label/icon swap on click

**Files:**
- Create: `frontend/src/components/ui/ActionButton.jsx`
- Create: `frontend/src/components/ui/ActionButton.css`
- Modify: `frontend/src/pages/Assistant.js:1141-1143` (the message Copy button, using the existing `copiedId`/`copyMessage` state — no new state introduced, just moved into the primitive)
- Test: `frontend/src/__smoke__/actionbutton.test.js`

**Interfaces:**
- Produces: `export default function ActionButton({ icon: Icon, doneIcon: DoneIcon, label, doneLabel, onAction, revertAfter = 2000, className })` — calls `onAction()` on click; if `onAction()` (or its resolved promise) doesn't throw, swaps to `doneIcon`/`doneLabel` for `revertAfter`ms then swaps back. This generalizes the exact pattern already hand-rolled in `Assistant.js` (`copiedId` state + `Copy`/`Check` icon swap) into a reusable primitive, and that call site becomes its first consumer.

- [ ] **Step 1: Write the failing test**

```jsx
// frontend/src/__smoke__/actionbutton.test.js
//
// Generalizes the Copy/Check swap that was already hand-rolled per-message
// in Assistant.js (`copiedId` state) into one reusable primitive.
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import ActionButton from '../components/ui/ActionButton';

const Icon = () => <span>icon</span>;
const Done = () => <span>done</span>;

jest.useFakeTimers();

test('shows the done state after a successful action, then reverts', async () => {
  render(
    <ActionButton icon={Icon} doneIcon={Done} label="Copy" doneLabel="Copied"
      onAction={() => {}} revertAfter={2000} />
  );
  expect(screen.getByText('icon')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button')); });
  expect(screen.getByText('done')).toBeInTheDocument();
  act(() => { jest.advanceTimersByTime(2000); });
  expect(screen.getByText('icon')).toBeInTheDocument();
});

test('a rejected action does not swap to the done state', async () => {
  render(
    <ActionButton icon={Icon} doneIcon={Done} label="Copy" doneLabel="Copied"
      onAction={() => Promise.reject(new Error('nope'))} />
  );
  await act(async () => { fireEvent.click(screen.getByRole('button')); });
  expect(screen.getByText('icon')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/actionbutton.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```jsx
// frontend/src/components/ui/ActionButton.jsx
import { useRef, useState } from 'react';
import './ActionButton.css';

export default function ActionButton({
  icon: Icon, doneIcon: DoneIcon, label, doneLabel, onAction, revertAfter = 2000, className,
}) {
  const [done, setDone] = useState(false);
  const timerRef = useRef(null);

  const handleClick = async () => {
    try {
      await onAction();
      setDone(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setDone(false), revertAfter);
    } catch {
      // Swallowed intentionally: a failed action stays in its normal state
      // rather than falsely claiming success — the caller is responsible for
      // surfacing the failure (e.g. via useToast).
    }
  };

  const ShownIcon = done ? DoneIcon : Icon;
  return (
    <button type="button" className={`ui-action-btn ${className || ''}`} onClick={handleClick} title={done ? doneLabel : label} aria-label={done ? doneLabel : label}>
      <ShownIcon size={15} />
    </button>
  );
}
```

```css
/* frontend/src/components/ui/ActionButton.css */
.ui-action-btn { transition: color 150ms ease; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false src/__smoke__/actionbutton.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Wire into Assistant.js's message Copy button**

Read the exact current line first (`frontend/src/pages/Assistant.js:1141-1143` from exploration: `<button onClick={() => copyMessage(m)} title="Copy" aria-label="Copy response">{copiedId === m.id ? <Check size={15} /> : <Copy size={15} />}</button>`). Replace it with:

```jsx
<ActionButton
  icon={Copy}
  doneIcon={Check}
  label="Copy"
  doneLabel="Copied"
  onAction={() => copyMessage(m)}
/>
```

If `copiedId` state and its setter are now unused anywhere else in the file (grep `copiedId` — it's currently also read at the button's inline ternary, which this replaces; check `copyMessage`'s own body doesn't separately set `copiedId` for some other purpose before removing the state declaration), remove the now-dead `copiedId` state. Add `import ActionButton from '../components/ui/ActionButton';`.

- [ ] **Step 6: Manual check + lint + commit**

`catalyst serve`, send a message, click Copy on the reply, confirm it swaps to a checkmark and reverts after ~2s.

```bash
cd frontend && npx eslint src/components/ui/ActionButton.jsx src/pages/Assistant.js --ext .js,.jsx
git add frontend/src/components/ui/ActionButton.jsx frontend/src/components/ui/ActionButton.css frontend/src/pages/Assistant.js frontend/src/__smoke__/actionbutton.test.js
git commit -m "feat: add reusable ActionButton, use it for the message copy action"
```

---

### Task 17: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete frontend suite**

Run: `cd frontend && CI=true npm test -- --watchAll=false`
Expected: PASS, including every `*.test.js` this plan added and every pre-existing one (especially `citations.test.js`, `aitabs.test.js`, `sidebaraccount.test.js` — nothing in this plan should have broken them).

- [ ] **Step 2: Run the full lint pass**

Run: `cd frontend && npx eslint src --ext .js --ignore-pattern '__smoke__'`
Expected: no errors.

- [ ] **Step 3: Run the accessibility gate**

Run: `node scripts/a11y-check.test.js && node scripts/a11y-check.js`
Expected: PASS — this is the gate that would catch a hand-rolled Tooltip/Tabs/DatePicker missing correct ARIA semantics, which is exactly why Tasks 1/5/6/7 used `react-aria-components` instead of building those from scratch.

- [ ] **Step 4: Production build**

Run: `cd frontend && npm run build`
Expected: builds cleanly; confirm `build/404.html` exists (the `postbuild` copy) before considering this done.

- [ ] **Step 5: Manual pass through every touched page**

`PATH="$HOME/.nvm/versions/node/v20.20.2/bin:$PATH" catalyst serve --http 3000`, sign in through the browser, and click through: TopBar theme toggle, Sidebar tooltips, Reports.js KPI row + date picker, Investigation Diary case tabs, Records drop zone, the assistant page (composer beam, mic glow on a narrow viewport, a table/cards/stat-tiles answer, citations, copy button, PDF export toast), and the floating chat widget.

- [ ] **Step 6: Final commit (if any cleanup surfaced during verification)**

```bash
git status
# only if verification turned up small fixes:
git add -A
git commit -m "chore: fix issues found in full-suite verification of the UI component refresh"
```
