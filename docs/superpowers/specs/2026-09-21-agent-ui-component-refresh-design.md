# Agent UI component refresh — design spec

Date: 2026-09-21

## Purpose

Re-skin the visualization-type surfaces of the app — the assistant chat
experience plus a handful of dashboard/records/diary widgets — using
structural and interaction patterns from five external React component
references the user pointed at, while keeping Sentinel's own Linear-derived
visual tokens (`DESIGN-linear.app.md`, `frontend/src/index.css`). Also
relocates the light/dark toggle from the sidebar footer into the top nav,
and adds a reusable "action swap" button state (label/icon morphs on click,
reverts after ~2s) for confirmable actions across the touched surfaces.

Not in scope: a full-app sweep of every button/tooltip/table in the
codebase — only the pages listed below. Not in scope: adopting the source
sites' own Tailwind styling or copying their code verbatim — every
primitive is rebuilt against our CSS custom properties.

## Inspiration and deviation

Nine external doc pages were fetched and confirmed live/real before this
spec was written (not blindly trusted from the URLs alone):

| Source | Components |
|---|---|
| `ui.spectrumhq.in` (Spectrum UI) | Data Table |
| `beautifului.dev` (Beautiful UI) | Prompt Bar (#08), Context Cards (#10), Insight Cards (#17), Loading State (#01) |
| `libraries.dev` (Jakub Antalik) | Border Beam, Voice-glow |
| `beui.dev` | Message Scroller, Citations, Animated Toast Stack |
| `boardui.com` (BoardUI) | Stat Cards, Tooltip, Tabs, Segmented Control, File Upload, Date Picker |

All are real, React-based, mostly shadcn-CLI-installable, several built on
React Aria (`react-aria-components`) for accessibility. Sentinel has no
Tailwind and is a plain-CSS CRA app, so none of these are installed
verbatim — each is reimplemented as a small component under
`frontend/src/components/ui/`, matching the documented behavior/props/a11y
contract but styled with the app's existing tokens.

Deliberate deviation: business logic in the surfaces being touched
(`SourceCitations.js` clearance/audit filtering, `Thinking.js`'s state
machine, `Reports.js`/`Records.js` data fetching) is preserved as-is — this
is a presentation-layer swap, not a rewrite of what those pages compute.

## New dependency

`react-aria-components` (+ `@internationalized/date` for the date picker) —
the one new npm dependency, justified because Tooltip/Tabs/SegmentedControl/
DatePicker/FileUpload all need correct keyboard nav and ARIA semantics that
CI's `scripts/a11y-check.js` gate will catch if hand-rolled wrong. `motion`
and `lucide-react` are already dependencies and cover every animation
(border beam, toast stack, message scroller, agent loader) and icon need —
no other additions.

## Component → target mapping

Build order runs simple/independent → complex/shared, so the new dependency
lands and gets exercised on low-traffic surfaces before it reaches
`Assistant.js` (1388 lines, the flagship surface). Each row is its own
commit, tested locally via `catalyst serve` before moving to the next.

| # | Component | New primitive | Wired into |
|---|---|---|---|
| 1 | Tooltip | `ui/Tooltip.jsx` | icon-only nav buttons (Sidebar/TopBar) only |
| 2 | Segmented Control | `ui/SegmentedControl.jsx` | existing light/dark toggle, moved to TopBar |
| 3 | Toast | `ui/Toast.jsx` + `useToast()` | replaces ad-hoc toast in Assistant.js |
| 4 | KPI stat cards | `ui/StatCard.jsx` | Dashboard.js |
| 5 | Tabs | `ui/Tabs.jsx` | InvestigationDiary.js |
| 6 | File upload | `ui/FileUpload.jsx` | Records.js |
| 7 | Date picker | `ui/DatePicker.jsx` | replaces DateRangeCalendar.js |
| 8 | Data table | `ui/DataTable.jsx` | Reports.js case list / Records.js table |
| 9 | Agent loading state | `ui/AgentLoader.jsx` | replaces Thinking.js in Assistant.js |
| 10 | Message scroller | `ui/MessageScroller.jsx` | Assistant.js chat viewport |
| 11 | Prompt bar + border beam | `ui/PromptBar.jsx` + `ui/BorderBeam.jsx` | Assistant.js composer, ChatWidget.js |
| 12 | Voice mode (mobile) | `ui/VoiceGlow.jsx` | Assistant mic button, mobile-only via media query |
| 13 | Context cards | `ui/ContextCard.jsx` | AguiRenderer.js retrieved-chunk blocks |
| 14 | Insight cards | `ui/InsightCard.jsx` | AguiRenderer.js analytics blocks |
| 15 | Citations | rebuild `SourceCitations.js` on the beUI pattern | same page, same clearance/audit logic |
| 16 | Action-swap buttons | `ui/ActionButton.jsx` | Copy/Save/Export-style buttons on the above pages, as touched |

## Architecture notes

- `frontend/src/components/ui/` is a new directory, one file per primitive,
  each with its own small CSS file (or a shared `ui/tokens.css` if repeated
  values pile up) — no CSS-in-JS, no Tailwind, consistent with the rest of
  the app.
- Primitives take plain props (value/onChange, items, etc.) — no global
  state library. `useToast()` is the one primitive that needs
  app-wide-singleton semantics (a toast can fire from any page); it's a
  small context provider mounted once near the app root, same shape as
  `LayoutContext`/`useThemeMode` already in the codebase.
- The dark-mode toggle move is a relocation of existing `useThemeMode()`
  logic (`context/LayoutContext`) into `TopBar.js`, re-skinned as
  `SegmentedControl` — no change to the theme mechanism itself.
- CSP stays intact: no inline scripts, no `eval`/`new Function` introduced by
  any primitive.
- `Reports.js` and `frontend/src/utils/assistant.js` currently carry
  unrelated uncommitted changes (pre-existing in the working tree, unrelated
  to this task) — edits here are scoped to the data-table/citation swap only
  and must not clobber that in-flight work.

## Testing

- `catalyst serve --http 3000` (node 20 on PATH) + manual click-through per
  primitive before moving to the next row in the build order.
- `cd frontend && npx eslint src --ext .js --ignore-pattern '__smoke__'`
  and `node scripts/a11y-check.test.js && node scripts/a11y-check.js` at the
  end of the pass, and again before the final build.
- `cd frontend && npm run build` (never bare `react-scripts build`) as the
  final check, per `CLAUDE.md`.
