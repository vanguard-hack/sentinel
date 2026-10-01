// Excel and Sheets treat a leading =, +, -, or @ as the start of a formula,
// so a free-text field pulled from case data (a name, a note) can execute
// code the moment someone opens an exported CSV. Prefixing those values with
// a single quote is the standard mitigation (OWASP CSV injection): Excel
// shows the quote-prefixed text as a literal, and CSV has no syntax meaning
// for a leading apostrophe, so nothing else about the file changes.
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

// For clipboard (TSV) content, where there's no surrounding quotes to add.
export function neutralizeFormula(value) {
  const s = value == null ? '' : String(value);
  return FORMULA_PREFIX.test(s) ? `'${s}` : s;
}

export function csvCell(value) {
  return `"${neutralizeFormula(value).replace(/"/g, '""')}"`;
}
