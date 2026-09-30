import React from 'react';
import { Inbox, Search, CircleAlert } from 'lucide-react';
import './EmptyState.css';

// Reusable empty/error content for tables, lists, and cards.
//   no-data    — nothing exists yet, so the useful action is to create something
//   no-results — things exist but the current filter hides them, relax the filter
//   error      — the request failed, the action is to retry
const DEFAULTS = {
  'no-data': {
    icon: <Inbox size={18} strokeWidth={1.75} />,
    title: 'No data yet',
    description: 'Records will appear here once they are added.',
  },
  'no-results': {
    icon: <Search size={18} strokeWidth={1.75} />,
    title: 'No results found',
    description: 'Try adjusting your search or removing filters.',
  },
  error: {
    icon: <CircleAlert size={18} strokeWidth={1.75} />,
    title: "Couldn't load data",
    description: 'Something went wrong while fetching records.',
  },
};

export default function EmptyState({
  type = 'no-data', title, description, actionLabel, onAction, icon, className = '',
}) {
  const d = DEFAULTS[type];
  return (
    <div className={`ui-empty${className ? ` ${className}` : ''}`} role="status">
      <span className={`ui-empty-chip${type === 'error' ? ' ui-empty-chip-error' : ''}`} aria-hidden="true">
        {icon ?? d.icon}
      </span>
      <p className="ui-empty-title">{title ?? d.title}</p>
      <p className="ui-empty-desc">{description ?? d.description}</p>
      {actionLabel && (
        <button type="button" className="ui-empty-action" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
