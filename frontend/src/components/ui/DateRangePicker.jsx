// frontend/src/components/ui/DateRangePicker.jsx
//
// Presets + two-month range calendar + optional comparison period, in a
// popover. Built on react-aria-components, which supplies the hover preview
// while picking the second date, full keyboard control (arrows, PageUp/Down,
// Home/End, Enter, Esc) and focus management. Dates in and out are ISO
// 'YYYY-MM-DD'; nothing is applied until the officer presses Apply.
//
//   <DateRangePicker value={{ start, end }} compare="previous"
//     onChange={(range, compareRange, compareMode) => …} />
import { useState } from 'react';
import {
  DialogTrigger, Popover, Dialog, Button, Heading, RangeCalendar,
  CalendarGrid, CalendarGridHeader, CalendarHeaderCell, CalendarGridBody,
  CalendarCell, ToggleButtonGroup, ToggleButton,
} from 'react-aria-components';
import { parseDate, today, getLocalTimeZone, startOfMonth, endOfMonth } from '@internationalized/date';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import './DateRangePicker.css';

const tz = getLocalTimeZone();

const PRESETS = [
  ['Today', (t) => [t, t]],
  ['Yesterday', (t) => [t.subtract({ days: 1 }), t.subtract({ days: 1 })]],
  ['Last 7 days', (t) => [t.subtract({ days: 6 }), t]],
  ['Last 30 days', (t) => [t.subtract({ days: 29 }), t]],
  ['Last 90 days', (t) => [t.subtract({ days: 89 }), t]],
  ['This month', (t) => [startOfMonth(t), t]],
  ['Last month', (t) => { const m = t.subtract({ months: 1 }); return [startOfMonth(m), endOfMonth(m)]; }],
  ['This quarter', (t) => [t.set({ month: Math.floor((t.month - 1) / 3) * 3 + 1, day: 1 }), t]],
  ['Year to date', (t) => [t.set({ month: 1, day: 1 }), t]],
];

const COMPARE = [['off', 'Off'], ['previous', 'Previous period'], ['year', 'Previous year']];

const days = (r) => r.end.compare(r.start) + 1;

// The period a range is measured against: the same number of days ending the
// day before it, or the same dates a year earlier.
export function compareRange(r, mode) {
  if (!r || mode === 'off') return null;
  if (mode === 'year') return { start: r.start.subtract({ years: 1 }), end: r.end.subtract({ years: 1 }) };
  const end = r.start.subtract({ days: 1 });
  return { start: end.subtract({ days: days(r) - 1 }), end };
}

const fmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric' });
const label = (r) => r && fmt.formatRange(r.start.toDate(tz), r.end.toDate(tz));
const iso = (r) => r && { start: r.start.toString(), end: r.end.toString() };
const same = (a, b) => a && b && a.start.compare(b.start) === 0 && a.end.compare(b.end) === 0;

function Month({ offset }) {
  return (
    <CalendarGrid offset={offset ? { months: offset } : undefined} weekdayStyle="short">
      <CalendarGridHeader>
        {(day) => <CalendarHeaderCell>{day.slice(0, 2)}</CalendarHeaderCell>}
      </CalendarGridHeader>
      <CalendarGridBody>{(date) => <CalendarCell date={date} />}</CalendarGridBody>
    </CalendarGrid>
  );
}

export default function DateRangePicker({ value, compare = 'off', onChange, maxValue, label: aria = 'Date range' }) {
  const max = maxValue ? parseDate(maxValue) : undefined;
  const applied = value?.start && value?.end ? { start: parseDate(value.start), end: parseDate(value.end) } : null;

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(applied);
  const [mode, setMode] = useState(compare);
  // The right-hand month; the left shows the one before it.
  const [focused, setFocused] = useState(applied?.end || today(tz));

  const openChange = (o) => {
    if (o) { setDraft(applied); setMode(compare); setFocused(applied?.end || today(tz)); }
    setOpen(o);
  };
  const pickPreset = (fn) => {
    const [start, end] = fn(today(tz));
    setDraft({ start, end });
    setFocused(end);
  };
  const apply = () => {
    if (!draft) return;
    onChange(iso(draft), iso(compareRange(draft, mode)), mode);
    setOpen(false);
  };

  const activePreset = PRESETS.find(([, fn]) => { const [s, e] = fn(today(tz)); return same(draft, { start: s, end: e }); });
  const appliedCompare = compareRange(applied, compare);
  const draftCompare = compareRange(draft, mode);

  return (
    <DialogTrigger isOpen={open} onOpenChange={openChange}>
      <Button className="drp-trigger" aria-label={`${aria}: ${label(applied) || 'not set'}`}>
        <Calendar size={15} aria-hidden="true" />
        <span className="drp-trigger-text">
          <span className="drp-trigger-main">{label(applied) || 'Pick dates'}</span>
          {appliedCompare && <span className="drp-trigger-sub">vs. {label(appliedCompare)}</span>}
        </span>
        <ChevronDown size={14} className="drp-caret" aria-hidden="true" />
      </Button>
      <Popover className="drp-pop" placement="bottom start" offset={8}>
        <Dialog className="drp-dialog" aria-label={aria}>
          <div className="drp-body">
            <div className="drp-presets" role="group" aria-label="Presets">
              {PRESETS.map(([name, fn]) => (
                <button
                  key={name} type="button" aria-pressed={activePreset?.[0] === name}
                  className={activePreset?.[0] === name ? 'on' : ''}
                  onClick={() => pickPreset(fn)}
                >
                  {name}
                </button>
              ))}
              <span className={`drp-custom ${draft && !activePreset ? 'on' : ''}`}>Custom</span>
            </div>
            <RangeCalendar
              className="drp-cal" aria-label={aria}
              value={draft} onChange={setDraft} maxValue={max}
              focusedValue={focused} onFocusChange={setFocused}
              visibleDuration={{ months: 2 }} pageBehavior="single" firstDayOfWeek="mon"
            >
              {({ state }) => (
                <>
                  <Heading className="drp-sr" />
                  <Button slot="previous" className="drp-nav prev"><ChevronLeft size={16} /></Button>
                  <Button slot="next" className="drp-nav next"><ChevronRight size={16} /></Button>
                  <div className="drp-months">
                    {[0, 1].map((i) => (
                      <div key={i} className="drp-month">
                        <header className="drp-head">
                          <span className="drp-heading" aria-hidden="true">
                            {monthFmt.format(state.visibleRange.start.add({ months: i }).toDate(tz))}
                          </span>
                        </header>
                        <Month offset={i} />
                      </div>
                    ))}
                  </div>
                </>
              )}
            </RangeCalendar>
          </div>
          <footer className="drp-foot">
            <div className="drp-summary">
              <div>
                <strong>{label(draft) || 'Pick a start date'}</strong>
                {draft && <span className="drp-muted"> {days(draft)} {days(draft) === 1 ? 'day' : 'days'}</span>}
              </div>
              <div className="drp-compare">
                <span className="drp-muted">Compare</span>
                <ToggleButtonGroup
                  className="drp-seg" aria-label="Compare with"
                  selectionMode="single" disallowEmptySelection
                  selectedKeys={[mode]} onSelectionChange={(k) => setMode([...k][0])}
                >
                  {COMPARE.map(([k, l]) => <ToggleButton key={k} id={k}>{l}</ToggleButton>)}
                </ToggleButtonGroup>
              </div>
              {draftCompare && <div className="drp-muted drp-vs"><i className="drp-swatch" />vs. {label(draftCompare)}</div>}
            </div>
            <div className="drp-actions">
              <Button className="drp-btn" onPress={() => setOpen(false)}>Cancel</Button>
              <Button className="drp-btn primary" onPress={apply} isDisabled={!draft}>Apply</Button>
            </div>
          </footer>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
