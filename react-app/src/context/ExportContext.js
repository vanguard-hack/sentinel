import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { ALL_TABLES, fetchAllRows } from '../utils/datastore';

// The Data Store → Excel export used to live entirely inside CaseFiles.js:
// its progress lived in that page's own useState, and the loop that walked
// every table ran inside a callback owned by that component. Both looked
// fine until an officer switched pages mid-export — React unmounted
// CaseFiles, the progress readout vanished, and there was no way to tell
// whether the export was still happening or had been abandoned. (In practice
// the fetch loop itself does not get cancelled by an unmount — nothing here
// ties it to a component — but there was no evidence of that from the UI,
// which reads as "it stopped".)
//
// Moving the state and the loop up to a provider mounted once above the
// router fixes that: the export is now a background job the whole app can
// see progress on, and switching pages no longer touches it. `startExport`
// is guarded against a second concurrent run the same way the old local
// state was.
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
