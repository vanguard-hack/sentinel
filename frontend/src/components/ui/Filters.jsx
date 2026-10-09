// frontend/src/components/ui/Filters.jsx
//
// reUI-style filters: a "+ Filter" builder, one chip per active filter
// ([Field] [is ▾] [values ▾] [×]) and a Clear button — plus a header button
// that edits the same filter from its table column. One state, two entry
// points, so a filter set from the header shows up as a chip and vice versa.
//
// A filter is { field, op: 'is' | 'not', values: string[] }. Fields are
// { key, label, icon?, options: [{ value, label?, count? }] }.
import { useMemo, useState } from 'react';
import {
  DialogTrigger, Popover, Dialog, Button, ListBox, ListBoxItem,
  MenuTrigger, Menu, MenuItem,
} from 'react-aria-components';
import { Check, ChevronDown, ListFilter, Plus, Search, X } from 'lucide-react';
import './Filters.css';

// The predicate the table filters rows with. Empty value lists are inert, so
// a chip half-built in the UI never hides everything.
export function applyFilters(rows, filters, valueOf) {
  const live = filters.filter((f) => f.values.length);
  if (!live.length) return rows;
  return rows.filter((row) => live.every((f) => {
    // A multi-valued cell (tags, reasons) matches if any of its values does.
    const v = valueOf(row, f.field);
    const hit = Array.isArray(v)
      ? v.some((x) => f.values.includes(String(x)))
      : f.values.includes(String(v ?? ''));
    return f.op === 'not' ? !hit : hit;
  }));
}

// Field options with counts, from the rows actually loaded. Array cells count
// once per value. `order` pins a fixed sequence (bands); otherwise by count.
export function optionsFrom(rows, get, order) {
  const counts = new Map();
  for (const row of rows || []) {
    const v = get(row);
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x != null && x !== '') counts.set(String(x), (counts.get(String(x)) || 0) + 1);
    }
  }
  const list = [...counts].map(([value, count]) => ({ value, count }));
  return order
    ? list.sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value))
    : list.sort((a, b) => b.count - a.count);
}

// Rendering thousands of list items stalls the popover; search narrows.
const MAX_SHOWN = 200;

const opLabel = (f) => (f.op === 'not'
  ? (f.values.length > 1 ? 'is none of' : 'is not')
  : (f.values.length > 1 ? 'is any of' : 'is'));

// Search + multi-select list of one field's values.
function ValueList({ field, selected, onChange }) {
  const [q, setQ] = useState('');
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return field.options.filter((o) => !needle || String(o.label ?? o.value).toLowerCase().includes(needle));
  }, [field.options, q]);
  return (
    <div className="flt-values">
      <label className="flt-search">
        <Search size={13} aria-hidden="true" />
        <input
          autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder={`Search ${field.label.toLowerCase()}…`} aria-label={`Search ${field.label}`}
        />
      </label>
      <ListBox
        className="flt-list" aria-label={`${field.label} values`} selectionMode="multiple"
        selectedKeys={new Set(selected)} onSelectionChange={(keys) => onChange([...keys].map(String))}
        items={items.slice(0, MAX_SHOWN).map((o) => ({ id: String(o.value), ...o }))}
        renderEmptyState={() => <div className="flt-empty">No matches</div>}
      >
        {(o) => (
          <ListBoxItem id={o.id} className="flt-item" textValue={String(o.label ?? o.value)}>
            {({ isSelected }) => (
              <>
                <span className={`flt-check ${isSelected ? 'on' : ''}`} aria-hidden="true">{isSelected && <Check size={11} strokeWidth={3} />}</span>
                <span className="flt-item-label">{o.label ?? o.value}</span>
                {o.count != null && <span className="flt-count">{o.count}</span>}
              </>
            )}
          </ListBoxItem>
        )}
      </ListBox>
      {items.length > MAX_SHOWN && (
        <div className="flt-note flt-more">Showing {MAX_SHOWN} of {items.length.toLocaleString()} — search to narrow</div>
      )}
      {selected.length > 0 && (
        <button type="button" className="flt-reset" onClick={() => onChange([])}>Clear selection</button>
      )}
    </div>
  );
}

// Upsert/remove helpers shared by chips, builder and headers.
function setValues(filters, field, values) {
  const i = filters.findIndex((f) => f.field === field);
  if (i < 0) return values.length ? [...filters, { field, op: 'is', values }] : filters;
  const next = [...filters];
  next[i] = { ...next[i], values };
  return next;
}

export function FilterBar({ fields, filters, onChange }) {
  const [adding, setAdding] = useState(null); // field key picked in the builder
  const [addOpen, setAddOpen] = useState(false);
  const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
  const active = filters.filter((f) => byKey[f.field]);

  return (
    <div className="flt-bar">
      {active.map((f) => {
        const field = byKey[f.field];
        const Icon = field.icon;
        const names = f.values.map((v) => field.options.find((o) => String(o.value) === v)?.label ?? v);
        return (
          <div key={f.field} className="flt-chip">
            <span className="flt-seg flt-field">{Icon && <Icon size={13} aria-hidden="true" />}{field.label}</span>
            <MenuTrigger>
              <Button className="flt-seg flt-op" aria-label={`${field.label} operator: ${opLabel(f)}`}>{opLabel(f)}</Button>
              <Popover className="flt-pop" placement="bottom start" offset={6}>
                <Menu className="flt-menu" onAction={(op) => onChange(filters.map((x) => (x === f ? { ...x, op } : x)))}>
                  <MenuItem id="is" className="flt-menu-item">is</MenuItem>
                  <MenuItem id="not" className="flt-menu-item">is not</MenuItem>
                </Menu>
              </Popover>
            </MenuTrigger>
            <DialogTrigger>
              <Button className="flt-seg flt-val" aria-label={`${field.label} values`}>
                {names.length === 0 ? 'Select…' : names.length <= 2 ? names.join(', ') : `${names.length} selected`}
                <ChevronDown size={12} aria-hidden="true" />
              </Button>
              <Popover className="flt-pop" placement="bottom start" offset={6}>
                <Dialog className="flt-dialog" aria-label={`${field.label} values`}>
                  <ValueList field={field} selected={f.values} onChange={(v) => onChange(setValues(filters, f.field, v))} />
                </Dialog>
              </Popover>
            </DialogTrigger>
            <button
              type="button" className="flt-seg flt-x" aria-label={`Remove ${field.label} filter`}
              onClick={() => onChange(filters.filter((x) => x !== f))}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}

      <DialogTrigger isOpen={addOpen} onOpenChange={(o) => { setAddOpen(o); if (!o) setAdding(null); }}>
        <Button className="flt-add"><Plus size={14} aria-hidden="true" /> Filter</Button>
        <Popover className="flt-pop" placement="bottom start" offset={6}>
          <Dialog className="flt-dialog" aria-label="Add filter">
            {adding ? (
              <ValueList
                field={byKey[adding]}
                selected={filters.find((f) => f.field === adding)?.values || []}
                onChange={(v) => onChange(setValues(filters, adding, v))}
              />
            ) : (
              <Menu className="flt-menu" aria-label="Filter by" onAction={(k) => setAdding(String(k))}>
                {fields.map((f) => {
                  const Icon = f.icon;
                  return (
                    <MenuItem key={f.key} id={f.key} className="flt-menu-item" textValue={f.label}>
                      {Icon && <Icon size={14} aria-hidden="true" />}{f.label}
                    </MenuItem>
                  );
                })}
              </Menu>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>

      {active.length > 0 && (
        <button type="button" className="flt-clear" onClick={() => onChange([])}>Clear</button>
      )}
    </div>
  );
}

// The same filter, edited from its column header.
export function ColumnFilter({ field, filters, onChange }) {
  const f = filters.find((x) => x.field === field.key);
  const n = f?.values.length || 0;
  return (
    <DialogTrigger>
      <Button
        className={`flt-col ${n ? 'on' : ''}`}
        aria-label={n ? `Filter ${field.label}, ${n} selected` : `Filter ${field.label}`}
      >
        <ListFilter size={13} aria-hidden="true" />
        {n > 0 && <span className="flt-col-n">{n}</span>}
      </Button>
      <Popover className="flt-pop" placement="bottom start" offset={6}>
        <Dialog className="flt-dialog" aria-label={`Filter ${field.label}`}>
          {f?.op === 'not' && <div className="flt-note">Excluding the selected values</div>}
          <ValueList
            field={field} selected={f?.values || []}
            onChange={(v) => onChange(v.length ? setValues(filters, field.key, v) : filters.filter((x) => x.field !== field.key))}
          />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
