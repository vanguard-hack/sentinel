import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ALL_TABLES, fetchAllRows } from '../utils/datastore';

// The Data Store -> Excel export used to live entirely inside CaseFiles.js.
// Switching pages mid-export unmounted the component, the progress readout
// vanished, and there was no way to tell whether the export was still
// running or abandoned (the fetch loop itself kept going — there was just
// no UI evidence of that). Moved to a provider above the router so the
// export is a background job the whole app can see progress on.
// `startExport` guards against a second concurrent run.
const ExportContext = createContext(null);

export function ExportProvider({ children }) {
  const [exporting, setExporting] = useState(null); // null | { done, total, table }
  const runningRef = useRef(false);

  const startExport = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const wb = XLSX.utils.book_new();
    try {
      for (let i = 0; i < ALL_TABLES.length; i++) {
        const t = ALL_TABLES[i];
        setExporting({ done: i, total: ALL_TABLES.length, table: t.label });
        let rows = [];
        try {
          rows = await fetchAllRows(t.name);
        } catch {
          rows = [{ error: 'export failed for this table' }];
        }
        // Sheet names cap at 31 chars and forbid : \ / ? * [ ]
        const sheet = t.name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(rows.length ? rows : [{}]),
          sheet
        );
      }
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `sentinel-datastore-${stamp}.xlsx`);
    } finally {
      runningRef.current = false;
      setExporting(null);
    }
  }, []);

  return (
    <ExportContext.Provider value={{ exporting, startExport }}>
      {children}
    </ExportContext.Provider>
  );
}

export function useExport() {
  const ctx = useContext(ExportContext);
  return ctx || { exporting: null, startExport: async () => {} };
}
