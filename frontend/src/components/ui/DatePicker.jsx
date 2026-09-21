// frontend/src/components/ui/DatePicker.jsx
//
// Replaces the hand-rolled DateRangeCalendar month grid with react-aria-
// components' RangeCalendar plus a quick-select preset list. Same from/to/
// onSelect({from,to}) contract callers migrate to (DateRangeCalendar's old
// onSelect(from, to) positional signature is NOT the same shape).
import { RangeCalendar, CalendarGrid, CalendarCell, Heading, Button } from 'react-aria-components';
import { parseDate, today, getLocalTimeZone } from '@internationalized/date';
import './DatePicker.css';

const tz = getLocalTimeZone();
const toIso = (calDate) => calDate.toString(); // @internationalized/date already formats as YYYY-MM-DD

const PRESETS = [
  { label: 'Today', range: () => { const d = today(tz); return { from: d, to: d }; } },
  { label: 'Last 7 days', range: () => ({ from: today(tz).subtract({ days: 6 }), to: today(tz) }) },
  { label: 'This month', range: () => ({ from: today(tz).set({ day: 1 }), to: today(tz) }) },
  { label: 'This year', range: () => ({ from: today(tz).set({ month: 1, day: 1 }), to: today(tz) }) },
  {
    label: 'Last year',
    range: () => {
      const lastYear = today(tz).subtract({ years: 1 });
      return { from: lastYear.set({ month: 1, day: 1 }), to: lastYear.set({ month: 12, day: 31 }) };
    },
  },
  { label: 'Last 12 months', range: () => ({ from: today(tz).subtract({ months: 12 }), to: today(tz) }) },
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
      >
        <header className="ui-datepicker-nav">
          <Button slot="previous" aria-label="Previous month">‹</Button>
          <Heading />
          <Button slot="next" aria-label="Next month">›</Button>
        </header>
        <CalendarGrid>
          {(date) => <CalendarCell date={date} />}
        </CalendarGrid>
      </RangeCalendar>
    </div>
  );
}
