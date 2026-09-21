import React, { createContext, useContext } from 'react';
import {
  Tabs as AriaTabs, TabList, Tab, TabPanel as AriaTabPanel, TabListStateContext,
} from 'react-aria-components';
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
  const state = useContext(TabListStateContext);
  // react-aria-components hides an unselected forced-mount panel with the
  // `inert` attribute, not `hidden` — jsdom (and this app's own CSS) only
  // hide on `[hidden]`, so hidden is set explicitly to match that contract.
  const hidden = state ? state.selectedKey !== id : false;
  if (!visited || !visited.has(id)) {
    return <AriaTabPanel id={id} shouldForceMount hidden={hidden} />;
  }
  return <AriaTabPanel id={id} shouldForceMount hidden={hidden}>{children}</AriaTabPanel>;
}
