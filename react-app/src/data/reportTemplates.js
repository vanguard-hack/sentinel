// Report Studio — statutory & administrative report templates.
//
// Field structures follow the CCTNS Integrated Investigation Forms (IIF-1 to
// IIF-5) as prescribed for police stations (verified against the published
// IF1/IF3/IF4/IF5 forms of the Police Manual), the Case Diary requirements of
// S.192 BNSS / S.172 CrPC, inquest requirements of S.194 BNSS / S.174 CrPC and
// the D.K. Basu arrest-memo safeguards. Management reports (law & order, crime
// analysis, performance, case status) are non-statutory and use structured
// review formats common in Karnataka district offices.
//
// Template model:
//   sheet  = one A4 page definition: { id, title, subtitle?, blocks: [...] }
//   block  = { kind: 'fields', columns?, fields: [{ id, label, type?, span?, options?, hint? }] }
//          | { kind: 'table', id, label?, columns: [{ id, label, width? }], rows }
//          | { kind: 'narrative', id, label, lines, hint? }
//          | { kind: 'signatures', blocks: [{ label, fields: [...] }] }
//          | { kind: 'note', text }
//   field types: text (default) | date | time | datetime | select | number
//   span: 1..12 (grid of 12; default 12)
//
// Each template lists its initial sheets plus `extraSheets` the officer can
// append (e.g. "separate sheet for each accused" per IIF-5 item 11).

const SIGN_IO = {
  kind: 'signatures',
  blocks: [
    { label: 'Signature of the Investigating Officer', fields: ['Name', 'Rank', 'No.', 'Date'] },
  ],
};

const CONTINUATION_SHEET = {
  id: 'continuation',
  label: 'Continuation sheet',
  title: 'Continuation Sheet',
  blocks: [{ kind: 'narrative', id: 'contd', label: 'Continued…', lines: 34 }],
};

// Resolve a template's addable extra sheets into { sheet, label } pairs —
// an entry is either a full sheet object or { idFrom, label } referencing one
// of the template's own sheets (e.g. "separate sheet for each accused").
export function extraSheetDefs(type) {
  return (type.extraSheets || []).map((e) => {
    if (e.idFrom) {
      const sheet = type.sheets.find((s) => s.id === e.idFrom);
      return sheet ? { sheet, label: e.label || sheet.title } : null;
    }
    return { sheet: e, label: e.label || e.title };
  }).filter(Boolean);
}

// Blank per-page values for a sheet: tables get their fixed/blank starter
// rows, everything else starts empty.
export function initSheetValues(sheet) {
  const values = {};
  (sheet.blocks || []).forEach((b) => {
    if (b.kind === 'table') {
      values[b.id] = b.fixedRows
        ? b.fixedRows.map((r) => [...r])
        : Array.from({ length: b.rows || 3 }, () => b.columns.map(() => ''));
    }
  });
  return values;
}

export const REPORT_TYPES = [
  // ── 1. FIR / Crime Report — IIF-1 ────────────────────────────────────────
  {
    id: 'fir',
    name: 'FIR',
    form: 'Form IIF-1',
    law: 'u/s 173 BNSS (154 CrPC)',
    preparedBy: 'Officer receiving / registering the complaint',
    blurb: 'First Information Report — the earliest record of a cognizable offence.',
    icon: 'fir',
    accent: '#2563eb',
    sheets: [
      {
        id: 'fir-main',
        title: 'FIRST INFORMATION REPORT',
        subtitle: '(Under Section 173 BNSS / 154 Cr.P.C.) — Form IIF-1 (Integrated Form)',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: '1. District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'year', label: 'Year', span: 2 },
              { id: 'firNo', label: 'F.I.R. No.', span: 2 },
              { id: 'date', label: 'Date', type: 'date', span: 2 },
            ],
          },
          {
            kind: 'table',
            id: 'acts',
            label: '2. Acts & Sections',
            columns: [
              { id: 'act', label: 'Act', width: 55 },
              { id: 'sections', label: 'Sections', width: 45 },
            ],
            rows: 3,
          },
          {
            kind: 'fields',
            fields: [
              { id: 'otherActs', label: 'Other Acts & Sections', span: 12 },
              { id: 'occDay', label: '3(a). Occurrence of Offence — Day', span: 3 },
              { id: 'occDate', label: 'Date', type: 'date', span: 3 },
              { id: 'occTime', label: 'Time', type: 'time', span: 3 },
              { id: 'infoDate', label: '3(b). Information received at P.S. — Date', type: 'date', span: 5 },
              { id: 'infoTime', label: 'Time', type: 'time', span: 3 },
              { id: 'gdEntry', label: '3(c). General Diary Reference — Entry No(s)', span: 5 },
              { id: 'gdTime', label: 'Time', type: 'time', span: 3 },
              { id: 'infoType', label: '4. Type of information', type: 'select', options: ['Written', 'Oral'], span: 4 },
              { id: 'poDistance', label: '5(a). Place of occurrence — Direction & distance from P.S.', span: 6 },
              { id: 'beatNo', label: 'Beat No.', span: 2 },
              { id: 'poAddress', label: '5(b). Address', span: 12 },
              { id: 'outsidePs', label: '5(c). If outside this P.S. — name of P.S. & District', span: 12 },
            ],
          },
          {
            kind: 'fields',
            legend: '6. Complainant / Informant',
            fields: [
              { id: 'cName', label: '(a) Name', span: 6 },
              { id: 'cFather', label: "(b) Father's / Husband's Name", span: 6 },
              { id: 'cDob', label: '(c) Date / Year of Birth', span: 3 },
              { id: 'cNationality', label: '(d) Nationality', span: 3 },
              { id: 'cPassport', label: '(e) Passport No. / Date & Place of Issue', span: 6 },
              { id: 'cOccupation', label: '(f) Occupation', span: 4 },
              { id: 'cAddress', label: '(g) Address', span: 8 },
            ],
          },
          { kind: 'narrative', id: 'accusedDetails', label: '7. Details of known / suspected / unknown accused with full particulars', lines: 3, hint: 'Attach separate sheet if necessary' },
          { kind: 'narrative', id: 'delayReasons', label: '8. Reasons for delay in reporting by the complainant / informant', lines: 2 },
        ],
      },
      {
        id: 'fir-contents',
        title: 'FIRST INFORMATION REPORT — contd.',
        blocks: [
          { kind: 'narrative', id: 'properties', label: '9. Particulars of properties stolen / involved', lines: 3, hint: 'Attach separate sheet if necessary' },
          {
            kind: 'fields',
            fields: [
              { id: 'totalValue', label: '10. Total value of properties stolen / involved (₹)', span: 6 },
              { id: 'udCaseNo', label: '11. Inquest Report / U.D. Case No., if any', span: 6 },
            ],
          },
          { kind: 'narrative', id: 'firContents', label: '12. F.I.R. Contents', lines: 14, hint: 'Attach separate sheets if required' },
          { kind: 'narrative', id: 'actionTaken', label: '13. Action taken', lines: 3, hint: 'Registration / investigation taken up or transferred on point of jurisdiction; FIR read over to complainant, admitted correct, copy given free of cost' },
          {
            kind: 'signatures',
            blocks: [
              { label: '14. Signature / Thumb-impression of the complainant / informant', fields: [] },
              { label: 'Signature of the Officer-in-charge, Police Station', fields: ['Name', 'Rank', 'No.'] },
            ],
          },
          {
            kind: 'fields',
            fields: [{ id: 'despatch', label: '15. Date & time of despatch to the Court', span: 8 }],
          },
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },

  // ── 2. Investigation Report / Case Diary — S.192 BNSS ───────────────────
  {
    id: 'case-diary',
    name: 'Case Diary',
    form: 'Case Diary',
    law: 'u/s 192 BNSS (172 CrPC)',
    preparedBy: 'Investigating Officer',
    blurb: 'Day-by-day diary of investigation proceedings — duly paginated.',
    icon: 'diary',
    accent: '#7c3aed',
    sheets: [
      {
        id: 'cd-day',
        title: 'CASE DIARY',
        subtitle: 'Diary of proceedings in investigation (S.192 BNSS / S.172 CrPC)',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: 'District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'crimeNo', label: 'Crime No.', span: 3 },
              { id: 'cdNo', label: 'C.D. Part / Serial No.', span: 3 },
              { id: 'sections', label: 'Acts & Sections', span: 8 },
              { id: 'diaryDate', label: 'Date of diary', type: 'date', span: 4 },
              { id: 'infoTime', label: 'Time at which information reached the I.O.', span: 6 },
              { id: 'beganTime', label: 'Time investigation begun', type: 'time', span: 3 },
              { id: 'closedTime', label: 'Time investigation closed', type: 'time', span: 3 },
              { id: 'placesVisited', label: 'Place(s) visited', span: 12 },
            ],
          },
          { kind: 'narrative', id: 'proceedings', label: 'Statement of circumstances ascertained through the investigation', lines: 16, hint: 'Chronological, prompt, objective; PO=Place of Occurrence, DO=Date of Occurrence, DR=Date FIR recorded, DD=Departure to PO' },
          { kind: 'narrative', id: 'witnesses161', label: 'Witnesses examined u/s 180 BNSS (161 CrPC) today', lines: 3 },
          { kind: 'narrative', id: 'nextSteps', label: 'Steps proposed / investigation remaining', lines: 3 },
          SIGN_IO,
        ],
      },
    ],
    extraSheets: [
      { idFrom: 'cd-day', label: 'Next day’s diary (new dated sheet)' },
      CONTINUATION_SHEET,
    ],
  },

  // ── 3. Arrest & Accused Report — IIF-3 ───────────────────────────────────
  {
    id: 'arrest',
    name: 'Arrest Report',
    form: 'Form IIF-3',
    law: 'u/s 35 BNSS · D.K. Basu safeguards',
    preparedBy: 'Investigating / arresting officer',
    blurb: 'Arrest / Court Surrender Memo — separate memo for each accused.',
    icon: 'arrest',
    accent: '#dc2626',
    sheets: [
      {
        id: 'arrest-main',
        title: 'ARREST / COURT SURRENDER MEMO',
        subtitle: '(Separate memo for each accused) — Form IIF-3 (Integrated Form)',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: '1. District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'year', label: 'Year', span: 2 },
              { id: 'firNo', label: 'FIR No. / Proceeding No.', span: 2 },
              { id: 'date', label: 'Date', type: 'date', span: 2 },
              { id: 'accCode', label: 'Alphanumeric code of the accused', span: 4, hint: 'A1–A9 for first 9 persons, B1 for 10th and so on' },
              { id: 'arrDate', label: '2. Date of Arrest / Surrender', type: 'date', span: 3 },
              { id: 'arrTime', label: 'Time', type: 'time', span: 2 },
              { id: 'gdNo', label: 'G.D. No.', span: 3 },
              { id: 'court', label: '3. Name of the Court (if surrendered)', span: 7 },
              { id: 'sections', label: '4. Acts and Sections', span: 5 },
              { id: 'mode', label: '5. Mode', type: 'select', span: 12, options: ['Arrested and sent up', 'Arrested and released on bail', 'Surrendered in court and bailed out', 'Surrendered in court and sent to judicial custody', 'Surrendered in court and remanded to police custody'] },
            ],
          },
          {
            kind: 'fields',
            legend: '6. Particulars of the Accused',
            fields: [
              { id: 'aName', label: '(i) Name', span: 6 },
              { id: 'aFather', label: "(ii) Father's / Husband's Name", span: 6 },
              { id: 'aAlias', label: '(iii–v) Aliases', span: 6 },
              { id: 'aNationality', label: '(vi) Nationality', span: 3 },
              { id: 'aPassport', label: '(vii) Passport No. / Issue', span: 3 },
              { id: 'aReligion', label: '(viii) Religion', span: 3 },
              { id: 'aCaste', label: '(ix) Caste / Tribe', span: 3 },
              { id: 'aScSt', label: '(x) SC / ST', span: 3 },
              { id: 'aOccupation', label: '(xi) Occupation', span: 3 },
              { id: 'aPermAddress', label: '(xii) Permanent address (with Distt. & P.S.)', span: 12 },
              { id: 'aPresAddress', label: '(xiii) Present address (with Distt. & P.S.)', span: 12 },
            ],
          },
          { kind: 'narrative', id: 'injuries', label: '7. Injuries, cause of injuries and physical condition of the accused (indicate if medically examined)', lines: 3, hint: 'D.K. Basu: arrestee may request medical examination; record in Inspection Memo' },
          { kind: 'narrative', id: 'search', label: '8. Custody & personal search', lines: 4, hint: 'Grounds of arrest and legal rights informed; articles found on search & receipt given; intimation given to relative/friend (name & relationship)' },
        ],
      },
      {
        id: 'arrest-features',
        title: 'ARREST MEMO — contd.',
        blocks: [
          {
            kind: 'table',
            id: 'physical',
            label: '9. Physical features, deformities and other details',
            columns: [
              { id: 'sex', label: 'Sex' }, { id: 'dob', label: 'Date/Year of Birth' },
              { id: 'build', label: 'Build' }, { id: 'height', label: 'Height (cms)' },
              { id: 'complexion', label: 'Complexion' }, { id: 'idMarks', label: 'Identification marks' },
            ],
            rows: 2,
          },
          {
            kind: 'table',
            id: 'moFeatures',
            label: 'For Modus Operandi offences — features',
            columns: [
              { id: 'deformities', label: 'Deformities / peculiarities' }, { id: 'hair', label: 'Hair' },
              { id: 'eye', label: 'Eye' }, { id: 'habits', label: 'Habit(s)' },
              { id: 'dress', label: 'Dress habits' }, { id: 'lang', label: 'Languages / dialect' },
              { id: 'marks', label: 'Burn mark / leucoderma / mole / scar / tattoo (place of)' },
            ],
            rows: 2,
          },
          {
            kind: 'fields',
            fields: [
              { id: 'fingerprint', label: '10. Whether finger-print taken', type: 'select', options: ['Yes', 'No'], span: 4 },
              { id: 'livingStatus', label: '11(a). Living status', span: 8 },
              { id: 'education', label: '11(b). Educational qualification(s)', span: 6 },
              { id: 'occupation2', label: '11(c). Occupation', span: 6 },
              { id: 'income', label: '11(d). Income group', span: 6 },
            ],
          },
          {
            kind: 'table',
            id: 'observations',
            label: '12. As per observations and known police records, whether the accused:',
            columns: [{ id: 'q', label: 'Observation', width: 75 }, { id: 'yn', label: 'Yes / No', width: 25 }],
            rows: 0,
            fixedRows: [
              ['(a) Is dangerous', ''], ['(b) Previously escaped any bail', ''],
              ['(c) Is generally armed', ''], ['(d) Operates with accomplices', ''],
              ['(e) Has past criminal records', ''], ['(f) Is recidivist', ''],
              ['(g) Is likely to escape bail', ''],
              ['(h) If released on bail, likely to commit another crime / threaten victims or witnesses', ''],
              ['(i) Is wanted in any other case', ''],
            ],
          },
          {
            kind: 'signatures',
            blocks: [
              { label: 'Signature of witness to arrest (family member / respectable local person)', fields: ['Name', 'Address'] },
              { label: 'Signature of the Investigating Officer', fields: ['Name', 'Rank', 'No.', 'Place', 'Date'] },
            ],
          },
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },

  // ── 4. Charge Sheet / Final Report — IIF-5 ───────────────────────────────
  {
    id: 'charge-sheet',
    name: 'Charge Sheet',
    form: 'Form IIF-5',
    law: 'u/s 193 BNSS (173 CrPC)',
    preparedBy: 'Investigating Officer — submitted to court',
    blurb: 'Final Form / Report on completion of investigation.',
    icon: 'chargesheet',
    accent: '#0f766e',
    sheets: [
      {
        id: 'cs-main',
        title: 'FINAL FORM / REPORT',
        subtitle: '(Under Section 193 BNSS / 173 Cr.P.C.) — Form IIF-5',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'court', label: 'In the Court of', span: 12 },
              { id: 'dist', label: '1. District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'year', label: 'Year', span: 2 },
              { id: 'firNo', label: 'FIR No.', span: 2 },
              { id: 'firDate', label: 'Date', type: 'date', span: 2 },
              { id: 'csNo', label: '2. Final Report / Charge-Sheet No.', span: 6 },
              { id: 'csDate', label: '3. Date', type: 'date', span: 3 },
            ],
          },
          {
            kind: 'table',
            id: 'acts',
            label: '4. Acts & Sections',
            columns: [{ id: 'act', label: 'Act', width: 55 }, { id: 'sections', label: 'Section', width: 45 }],
            rows: 3,
          },
          {
            kind: 'fields',
            fields: [
              { id: 'otherActs', label: 'Other Acts & Sections', span: 12 },
              { id: 'frType', label: '5. Type of Final Report', type: 'select', span: 6, options: ['Charge-Sheet', 'Untraced', 'Unoccurred', 'Not Charge-Sheet for want of evidence'] },
              { id: 'unoccurred', label: '6. If F.R. unoccurred', type: 'select', span: 6, options: ['False', 'Mistake of fact', 'Mistake of law', 'Non-cognizable', 'Civil nature'] },
              { id: 'suppl', label: '7. Supplementary or Original', type: 'select', options: ['Original', 'Supplementary'], span: 4 },
              { id: 'ioName', label: '8. Name of the I.O.', span: 5 },
              { id: 'ioRank', label: 'Rank', span: 3 },
              { id: 'complainant', label: '9(a). Name of Complainant / Informant', span: 6 },
              { id: 'complainantFather', label: "9(b). Father's / Husband's Name", span: 6 },
            ],
          },
          {
            kind: 'table',
            id: 'properties',
            label: '10. Properties / articles / documents recovered / seized during investigation and relied upon',
            columns: [
              { id: 'sl', label: 'Sl. No.', width: 6 },
              { id: 'desc', label: 'Property description', width: 30 },
              { id: 'value', label: 'Estimated value (₹)', width: 14 },
              { id: 'regNo', label: 'P.S. property register No.', width: 16 },
              { id: 'from', label: 'From whom / where recovered or seized', width: 22 },
              { id: 'disposal', label: 'Disposal', width: 12 },
            ],
            rows: 4,
          },
        ],
      },
      {
        id: 'cs-accused',
        title: 'PARTICULARS OF ACCUSED PERSONS CHARGE-SHEETED',
        subtitle: '11. Use a separate sheet for each accused',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'slNo', label: 'Sl. No.', span: 2 },
              { id: 'name', label: '(i) Name (whether verified)', span: 10 },
              { id: 'father', label: "(ii) Father's / Husband's Name", span: 6 },
              { id: 'dob', label: '(iii) Date / Year of Birth', span: 3 },
              { id: 'sex', label: '(iv) Sex', span: 3 },
              { id: 'nationality', label: '(v) Nationality', span: 4 },
              { id: 'passport', label: '(vi) Passport No. / Date & Place of Issue', span: 8 },
              { id: 'religion', label: '(vii) Religion', span: 4 },
              { id: 'scst', label: '(viii) Whether SC/ST', span: 4 },
              { id: 'occupation', label: '(ix) Occupation', span: 4 },
              { id: 'address', label: '(x) Address (whether verified)', span: 12 },
              { id: 'provCrimNo', label: '(xi) Provisional Criminal No.', span: 6 },
              { id: 'regCrimNo', label: '(xii) Regular Criminal No. (if known)', span: 6 },
              { id: 'arrestDate', label: '(xiii) Date of arrest', type: 'date', span: 4 },
              { id: 'bailDate', label: '(xiv) Date of release on bail', type: 'date', span: 4 },
              { id: 'fwdDate', label: '(xv) Date forwarded to Court', type: 'date', span: 4 },
              { id: 'sections', label: '(xvi) Under Acts & Sections', span: 12 },
              { id: 'sureties', label: '(xvii) Name(s) and address(es) of sureties', span: 12 },
              { id: 'previous', label: '(xviii) Previous convictions with case references', span: 12 },
              { id: 'status', label: '(xix) Status of the accused', type: 'select', span: 12, options: ['Forwarded', 'Bailed by Police', 'Under Police Custody', 'Bailed by Court', 'In Judicial Custody', 'Absconding', 'Proclaimed Offender'] },
            ],
          },
        ],
      },
      {
        id: 'cs-witnesses',
        title: 'WITNESSES & CASE FACTS',
        blocks: [
          {
            kind: 'table',
            id: 'witnesses',
            label: '13. Particulars of witnesses to be examined',
            columns: [
              { id: 'sl', label: 'Sl. No.', width: 6 },
              { id: 'name', label: 'Name', width: 20 },
              { id: 'father', label: "Father's/Husband's Name", width: 18 },
              { id: 'dob', label: 'Date/Year of birth', width: 12 },
              { id: 'occupation', label: 'Occupation', width: 12 },
              { id: 'address', label: 'Address', width: 20 },
              { id: 'evidence', label: 'Type of evidence to be tendered', width: 12 },
            ],
            rows: 6,
          },
          {
            kind: 'fields',
            fields: [
              { id: 'frFalse', label: '14. If F.R. is false — action taken / proposed u/s 217/248 BNS (182/211 IPC)', span: 12 },
            ],
          },
          { kind: 'narrative', id: 'labResult', label: '15. Result of laboratory analysis', lines: 2 },
          { kind: 'narrative', id: 'briefFacts', label: '16. Brief facts of the case', lines: 12, hint: 'Add separate sheet if necessary' },
          {
            kind: 'fields',
            fields: [
              { id: 'referNotice', label: '17. Refer notice served', type: 'select', options: ['Yes', 'No'], span: 4 },
              { id: 'referDate', label: 'Date', type: 'date', span: 4 },
              { id: 'despatched', label: '18. Despatched on', type: 'date', span: 4 },
            ],
          },
          {
            kind: 'signatures',
            blocks: [
              { label: 'Forwarded by Station House Officer / Officer in-charge', fields: ['Name', 'Rank', 'No.'] },
              { label: 'Signature of the I.O. submitting the Final Report / Charge Sheet', fields: ['Name', 'Rank', 'No.'] },
            ],
          },
        ],
      },
    ],
    extraSheets: [
      { idFrom: 'cs-accused', label: 'Additional accused sheet (item 11/12)' },
      CONTINUATION_SHEET,
    ],
  },

  // ── 5. UDR / Death Report — S.194 BNSS ───────────────────────────────────
  {
    id: 'udr',
    name: 'Death Report',
    form: 'UDR & Inquest',
    law: 'u/s 194 BNSS (174 CrPC)',
    preparedBy: 'Police / Investigating Officer',
    blurb: 'Unnatural Death Report with inquest particulars.',
    icon: 'udr',
    accent: '#475569',
    sheets: [
      {
        id: 'udr-main',
        title: 'UNNATURAL DEATH REPORT (U.D.R.)',
        subtitle: 'Report & inquest u/s 194 BNSS / 174 CrPC',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: 'District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'udrNo', label: 'U.D.R. No. / Year', span: 3 },
              { id: 'date', label: 'Date of report', type: 'date', span: 3 },
              { id: 'gdEntry', label: 'G.D. Entry No. & time', span: 6 },
              { id: 'infoBy', label: 'Information received from (name & address)', span: 6 },
              { id: 'deceasedName', label: 'Name of the deceased (if known)', span: 6 },
              { id: 'deceasedAge', label: 'Age / Sex', span: 3 },
              { id: 'deceasedOcc', label: 'Occupation', span: 3 },
              { id: 'deceasedAddress', label: 'Address of the deceased', span: 12 },
              { id: 'placeOfDeath', label: 'Place where body found / death occurred', span: 8 },
              { id: 'dateOfDeath', label: 'Probable date & time of death', span: 4 },
              { id: 'apparentCause', label: 'Apparent cause of death', type: 'select', span: 6, options: ['Suicide', 'Accident', 'Drowning', 'Poisoning', 'Burns', 'Animal / machinery', 'Suspicious — foul play suspected', 'Sudden death — cause unknown', 'Other'] },
              { id: 'identifiedBy', label: 'Body identified by', span: 6 },
            ],
          },
          { kind: 'narrative', id: 'circumstances', label: 'Circumstances in which the death occurred', lines: 6 },
        ],
      },
      {
        id: 'udr-inquest',
        title: 'INQUEST PARTICULARS',
        blocks: [
          { kind: 'narrative', id: 'scene', label: 'Description of the scene and position of the body', lines: 4 },
          { kind: 'narrative', id: 'injuries', label: 'Wounds, fractures, bruises and marks of injury on the body; how they appear to have been inflicted; weapons or instruments found', lines: 6 },
          { kind: 'narrative', id: 'articles', label: 'Articles found on / near the body (clothing, valuables, notes)', lines: 3 },
          {
            kind: 'table',
            id: 'panchas',
            label: 'Panchas / witnesses to the inquest',
            columns: [
              { id: 'sl', label: 'Sl. No.', width: 8 },
              { id: 'name', label: 'Name', width: 30 },
              { id: 'address', label: 'Address', width: 42 },
              { id: 'signature', label: 'Signature', width: 20 },
            ],
            rows: 3,
          },
          {
            kind: 'fields',
            fields: [
              { id: 'pmSent', label: 'Body forwarded for post-mortem to', span: 8 },
              { id: 'pmDate', label: 'Date & time', span: 4 },
              { id: 'magistrate', label: 'Executive Magistrate informed (name / designation)', span: 12 },
            ],
          },
          { kind: 'narrative', id: 'opinion', label: 'Opinion of the officer holding the inquest', lines: 3 },
          SIGN_IO,
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },

  // ── 6. Missing Person Report ─────────────────────────────────────────────
  {
    id: 'missing-person',
    name: 'Missing Person Report',
    form: 'MP Register',
    law: 'GD entry & inquiry',
    preparedBy: 'Police station',
    blurb: 'Intake form with descriptors for tracing a missing person.',
    icon: 'missing',
    accent: '#d97706',
    sheets: [
      {
        id: 'mp-main',
        title: 'MISSING PERSON REPORT',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: 'District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'mpNo', label: 'M.P. No. / Year', span: 3 },
              { id: 'date', label: 'Date of report', type: 'date', span: 3 },
              { id: 'gdEntry', label: 'G.D. Entry No. & time', span: 6 },
              { id: 'informantName', label: 'Informant — Name & mobile number', span: 6 },
              { id: 'informantRelation', label: 'Relationship with missing person', span: 6 },
              { id: 'informantAddress', label: 'Informant address', span: 6 },
            ],
          },
          {
            kind: 'fields',
            legend: 'Missing person particulars',
            fields: [
              { id: 'mName', label: 'Name', span: 6 },
              { id: 'mFather', label: "Father's / Husband's Name", span: 6 },
              { id: 'mAge', label: 'Age', span: 2 },
              { id: 'mSex', label: 'Sex', span: 2 },
              { id: 'mDob', label: 'Date of birth', type: 'date', span: 4 },
              { id: 'mLanguages', label: 'Languages spoken', span: 4 },
              { id: 'mAddress', label: 'Address', span: 12 },
              { id: 'lastSeenAt', label: 'Last seen at (place)', span: 6 },
              { id: 'lastSeenOn', label: 'Last seen on (date & time)', span: 6 },
            ],
          },
          {
            kind: 'fields',
            legend: 'Physical description',
            fields: [
              { id: 'height', label: 'Height (cms)', span: 3 },
              { id: 'build', label: 'Build', span: 3 },
              { id: 'complexion', label: 'Complexion', span: 3 },
              { id: 'hair', label: 'Hair', span: 3 },
              { id: 'eyes', label: 'Eyes', span: 3 },
              { id: 'idMarks', label: 'Identification marks (moles, scars, tattoos, deformities)', span: 9 },
              { id: 'clothing', label: 'Clothing & accessories worn when last seen', span: 12 },
              { id: 'medical', label: 'Medical conditions / medication / mental state', span: 12 },
            ],
          },
          { kind: 'narrative', id: 'circumstances', label: 'Circumstances of disappearance', lines: 5 },
        ],
      },
      {
        id: 'mp-action',
        title: 'MISSING PERSON — ACTION TAKEN',
        blocks: [
          { kind: 'narrative', id: 'priorHistory', label: 'Previous instances of going missing / places likely to visit / persons likely to accompany', lines: 4 },
          { kind: 'narrative', id: 'actionTaken', label: 'Action taken (wireless message, neighbouring PS alert, publication of photo, checks at hospitals / railway stations / bus stands)', lines: 6 },
          {
            kind: 'fields',
            fields: [
              { id: 'photoAttached', label: 'Recent photograph attached', type: 'select', options: ['Yes', 'No'], span: 4 },
              { id: 'tracedOn', label: 'Traced on (date, if traced)', type: 'date', span: 4 },
              { id: 'tracedAt', label: 'Traced at / condition', span: 4 },
            ],
          },
          {
            kind: 'signatures',
            blocks: [
              { label: 'Signature of the informant', fields: [] },
              { label: 'Signature of the Officer-in-charge', fields: ['Name', 'Rank', 'No.'] },
            ],
          },
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },

  // ── 7. Evidence & Seizure Report — IIF-4 ─────────────────────────────────
  {
    id: 'seizure',
    name: 'Seizure Report',
    form: 'Form IIF-4',
    law: 'Seizure mahazar / panchnama',
    preparedBy: 'Investigating / scene-of-crime officers',
    blurb: 'Property Seizure Memo (search / production / recovery).',
    icon: 'seizure',
    accent: '#0891b2',
    sheets: [
      {
        id: 'sz-main',
        title: 'PROPERTY SEIZURE MEMO',
        subtitle: '(search / production / recovery) — Form IIF-4 (Integrated Form)',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: '1. District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'year', label: 'Year', span: 2 },
              { id: 'firNo', label: 'FIR No. / GD No.', span: 2 },
              { id: 'date', label: 'Date', type: 'date', span: 2 },
              { id: 'sections', label: '2. Acts and sections', span: 12 },
              { id: 'propNature', label: '3. Nature of property seized / received', type: 'select', span: 6, options: ['Stolen', 'Unclaimed', 'Unlawful possession', 'Others'] },
              { id: 'szDate', label: '4(a). Seized / received — Date', type: 'date', span: 3 },
              { id: 'szTime', label: '(b) Time', type: 'time', span: 3 },
              { id: 'szAddress', label: '4(c). Address of place from where seized / recovered', span: 12 },
              { id: 'szPlaceDesc', label: '4(d). Description of the place of seizure / recovery', span: 12 },
            ],
          },
          {
            kind: 'fields',
            legend: '5. Person from whom seized / recovered',
            fields: [
              { id: 'pName', label: 'Name', span: 4 },
              { id: 'pFather', label: "Father's / Husband's Name", span: 4 },
              { id: 'pAge', label: 'Age', span: 2 },
              { id: 'pOccupation', label: 'Occupation', span: 2 },
              { id: 'pAddress', label: 'Address', span: 12 },
            ],
          },
          {
            kind: 'table',
            id: 'witnesses',
            label: '6. Witnesses (panchas)',
            columns: [
              { id: 'name', label: 'Name', width: 25 },
              { id: 'father', label: "Father's/Husband's Name", width: 25 },
              { id: 'age', label: 'Age', width: 8 },
              { id: 'occupation', label: 'Occupation', width: 15 },
              { id: 'address', label: 'Address', width: 27 },
            ],
            rows: 2,
          },
          {
            kind: 'fields',
            fields: [
              { id: 'perishable', label: '7. Action taken / recommended for disposal of perishable property', span: 12 },
              { id: 'valuable', label: '8. Action taken / recommended for keeping of valuable property', span: 12 },
              { id: 'identification', label: '9. Identification required', type: 'select', options: ['Yes', 'No'], span: 4 },
            ],
          },
        ],
      },
      {
        id: 'sz-details',
        title: 'DETAILS OF PROPERTIES SEIZED / RECOVERED',
        blocks: [
          {
            kind: 'table',
            id: 'items',
            label: '10. Properties seized / recovered',
            columns: [
              { id: 'sl', label: 'Sl. No.', width: 6 },
              { id: 'type', label: 'Type', width: 14 },
              { id: 'desc', label: 'Description / nomenclature / marks', width: 34 },
              { id: 'qty', label: 'Qty / weight', width: 12 },
              { id: 'value', label: 'Estimated value (₹)', width: 14 },
              { id: 'status', label: 'STO/REC/SEI/INV', width: 10 },
              { id: 'photo', label: 'Photographed', width: 10 },
            ],
            rows: 6,
            footnote: 'STO – Stolen, REC – Recovered, SEI – Seized, INV – Involved. Use prescribed annexures for automobiles, currency, cultural property and narcotics.',
          },
          { kind: 'narrative', id: 'grounds', label: '11. Circumstances / grounds for seizure', lines: 4 },
          { kind: 'note', text: '12. The above-mentioned properties were seized in accordance with the provisions of law in the presence of the said witnesses, and a copy of the seizure memo was given to the person / occupant of the place from whom seized.' },
          {
            kind: 'table',
            id: 'sealed',
            label: '13. Properties packed and/or sealed with witness signatures',
            columns: [
              { id: 'sl', label: 'Sl. No.', width: 8 },
              { id: 'property', label: 'Property', width: 46 },
              { id: 'sig', label: 'Signature obtained on the packet / body of the property', width: 46 },
            ],
            rows: 3,
          },
          {
            kind: 'signatures',
            blocks: [
              { label: 'Witness 1 — Signature', fields: [] },
              { label: 'Witness 2 — Signature', fields: [] },
              { label: 'Signature of the Investigating Officer', fields: ['Name', 'Rank', 'No.', 'Place', 'Date'] },
              { label: 'Signature of Magistrate (when present)', fields: [] },
            ],
          },
        ],
      },
    ],
    extraSheets: [
      { idFrom: 'sz-details', label: 'Additional property details sheet' },
      CONTINUATION_SHEET,
    ],
  },

  // ── 8. Daily Station Report / General Diary ──────────────────────────────
  {
    id: 'station-gd',
    name: 'General Diary',
    form: 'General Diary',
    law: 'S.44 Police Act · Stn. House Report',
    preparedBy: 'Station duty / diary officer',
    blurb: 'Chronological record of everything transacted at the station.',
    icon: 'gd',
    accent: '#65a30d',
    sheets: [
      {
        id: 'gd-main',
        title: 'GENERAL DIARY / DAILY STATION REPORT',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: 'District', span: 3 },
              { id: 'circle', label: 'Circle / Sub-Division', span: 3 },
              { id: 'ps', label: 'Police Station', span: 3 },
              { id: 'date', label: 'For the day of', type: 'date', span: 3 },
              { id: 'shoName', label: 'Station House Officer', span: 6 },
              { id: 'dutyOfficer', label: 'Duty / diary officer', span: 6 },
            ],
          },
          {
            kind: 'table',
            id: 'entries',
            label: 'Diary entries (chronological)',
            columns: [
              { id: 'no', label: 'Entry No.', width: 8 },
              { id: 'time', label: 'Time', width: 10 },
              { id: 'nature', label: 'Nature of entry', width: 22 },
              { id: 'particulars', label: 'Particulars (persons, property, action)', width: 44 },
              { id: 'officer', label: 'Officer (name & rank)', width: 16 },
            ],
            rows: 10,
            footnote: 'Record FIRs registered, arrests, movements of officers, receipt/despatch of property, visits of superior officers, bandobast duties, lock-up visits and all other station transactions.',
          },
          {
            kind: 'table',
            id: 'strength',
            label: 'Duty strength for the day',
            columns: [
              { id: 'sl', label: 'Sl. No.', width: 8 },
              { id: 'rank', label: 'Rank', width: 26 },
              { id: 'number', label: 'Number', width: 20 },
              { id: 'duty', label: 'Nature of duty performed', width: 46 },
            ],
            rows: 4,
          },
          {
            kind: 'signatures',
            blocks: [{ label: 'Station House Officer', fields: ['Name', 'Rank', 'P.S.'] }],
          },
        ],
      },
    ],
    extraSheets: [
      { idFrom: 'gd-main', label: 'Additional GD sheet' },
      CONTINUATION_SHEET,
    ],
  },

  // ── 9. Law & Order Report ────────────────────────────────────────────────
  {
    id: 'law-order',
    name: 'Law & Order Report',
    form: 'L&O Situation Report',
    law: 'Administrative',
    preparedBy: 'Police station / district officers',
    blurb: 'Situation report on public order, bandobast and preventive action.',
    icon: 'laworder',
    accent: '#9333ea',
    sheets: [
      {
        id: 'lo-main',
        title: 'LAW & ORDER SITUATION REPORT',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'unit', label: 'Unit (P.S. / Sub-Division / District)', span: 6 },
              { id: 'period', label: 'Period of report', span: 3 },
              { id: 'date', label: 'Date of report', type: 'date', span: 3 },
              { id: 'officer', label: 'Reporting officer (name, rank & designation)', span: 12 },
            ],
          },
          { kind: 'narrative', id: 'situation', label: '1. General law & order situation', lines: 4 },
          {
            kind: 'table',
            id: 'incidents',
            label: '2. Incidents affecting public order during the period',
            columns: [
              { id: 'sl', label: 'Sl. No.', width: 6 },
              { id: 'dateTime', label: 'Date & time', width: 14 },
              { id: 'place', label: 'Place', width: 16 },
              { id: 'nature', label: 'Nature (procession, dispute, agitation, communal, other)', width: 34 },
              { id: 'action', label: 'Police action taken', width: 30 },
            ],
            rows: 5,
          },
          { kind: 'narrative', id: 'preventive', label: '3. Preventive action (S.126–135 BNSS / 107–110, 144, 151 CrPC bind-overs, prohibitory orders, preventive arrests, externments)', lines: 4 },
          { kind: 'narrative', id: 'bandobast', label: '4. Bandobast arrangements (festivals, rallies, VIP visits, examinations) & force deployed', lines: 4 },
          { kind: 'narrative', id: 'intelligence', label: '5. Intelligence inputs / anticipated flashpoints & communal or inter-group tensions', lines: 3 },
          { kind: 'narrative', id: 'recommendations', label: '6. Assessment & requirements (additional force, orders sought)', lines: 3 },
          { kind: 'signatures', blocks: [{ label: 'Signature of the reporting officer', fields: ['Name', 'Rank', 'Designation', 'Date'] }] },
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },

  // ── 10. Crime Analysis Report ────────────────────────────────────────────
  {
    id: 'crime-analysis',
    name: 'Crime Analysis Report',
    form: 'Crime Review',
    law: 'Administrative',
    preparedBy: 'Police analysts / senior officers',
    blurb: 'Periodical crime review with head-wise statistics and trends.',
    icon: 'analysis',
    accent: '#e11d48',
    sheets: [
      {
        id: 'ca-main',
        title: 'CRIME ANALYSIS REPORT',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'unit', label: 'Unit (P.S. / Sub-Division / District)', span: 6 },
              { id: 'period', label: 'Review period', span: 3 },
              { id: 'compare', label: 'Compared with (period)', span: 3 },
              { id: 'analyst', label: 'Prepared by (name, rank & designation)', span: 12 },
            ],
          },
          {
            kind: 'table',
            id: 'headwise',
            label: '1. Head-wise crime statistics',
            columns: [
              { id: 'head', label: 'Crime head', width: 28 },
              { id: 'current', label: 'Reported (current)', width: 14 },
              { id: 'previous', label: 'Reported (previous)', width: 14 },
              { id: 'detected', label: 'Detected', width: 12 },
              { id: 'pending', label: 'Under investigation', width: 14 },
              { id: 'variation', label: '% variation', width: 10 },
              { id: 'remarks', label: 'Remarks', width: 8 },
            ],
            rows: 0,
            fixedRows: [
              ['Murder', '', '', '', '', '', ''],
              ['Attempt to murder', '', '', '', '', '', ''],
              ['Rape / POCSO', '', '', '', '', '', ''],
              ['Kidnapping & abduction', '', '', '', '', '', ''],
              ['Dacoity / Robbery', '', '', '', '', '', ''],
              ['Burglary (HB day / night)', '', '', '', '', '', ''],
              ['Theft (incl. vehicle theft)', '', '', '', '', '', ''],
              ['Cheating / economic offences', '', '', '', '', '', ''],
              ['Cyber crime', '', '', '', '', '', ''],
              ['Crimes against women', '', '', '', '', '', ''],
              ['Road accidents (fatal / non-fatal)', '', '', '', '', '', ''],
              ['Others', '', '', '', '', '', ''],
            ],
          },
          { kind: 'narrative', id: 'trends', label: '2. Trend analysis — rising / declining heads, seasonality, comparison with corresponding period', lines: 4 },
        ],
      },
      {
        id: 'ca-patterns',
        title: 'CRIME ANALYSIS — PATTERNS & STRATEGY',
        blocks: [
          { kind: 'narrative', id: 'hotspots', label: '3. Hotspot analysis — beats / localities / stretches with concentration of offences; time-of-day patterns', lines: 5 },
          { kind: 'narrative', id: 'mo', label: '4. Modus operandi patterns & suspected gangs / repeat offenders', lines: 5 },
          { kind: 'narrative', id: 'detection', label: '5. Detection & recovery performance — significant detections, property recovered vs stolen', lines: 4 },
          { kind: 'narrative', id: 'strategy', label: '6. Preventive strategy & recommendations — beat deployment, patrolling plan, surveillance of history-sheeters, community measures', lines: 5 },
          { kind: 'signatures', blocks: [{ label: 'Prepared / analysed by', fields: ['Name', 'Rank', 'Designation', 'Date'] }] },
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },

  // ── 11. Police Performance Report ────────────────────────────────────────
  {
    id: 'performance',
    name: 'Performance Report',
    form: 'Performance Review',
    law: 'Administrative',
    preparedBy: 'Department / senior command',
    blurb: 'Unit performance across registration, detection, disposal & discipline.',
    icon: 'performance',
    accent: '#0d9488',
    sheets: [
      {
        id: 'pp-main',
        title: 'POLICE PERFORMANCE REPORT',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'unit', label: 'Unit (P.S. / Sub-Division / District)', span: 6 },
              { id: 'period', label: 'Review period', span: 3 },
              { id: 'date', label: 'Date of report', type: 'date', span: 3 },
              { id: 'officer', label: 'Reviewing officer (name, rank & designation)', span: 12 },
            ],
          },
          {
            kind: 'table',
            id: 'kpis',
            label: '1. Key performance indicators',
            columns: [
              { id: 'indicator', label: 'Indicator', width: 40 },
              { id: 'target', label: 'Target / norm', width: 15 },
              { id: 'achieved', label: 'Achieved', width: 15 },
              { id: 'previous', label: 'Previous period', width: 15 },
              { id: 'remarks', label: 'Remarks', width: 15 },
            ],
            rows: 0,
            fixedRows: [
              ['FIRs registered', '', '', '', ''],
              ['Cases detected / detection rate (%)', '', '', '', ''],
              ['Charge sheets filed within 60/90 days', '', '', '', ''],
              ['Cases pending investigation > 6 months', '', '', '', ''],
              ['Convictions secured / conviction rate (%)', '', '', '', ''],
              ['Property stolen vs recovered (₹)', '', '', '', ''],
              ['Absconders / POs arrested', '', '', '', ''],
              ['Preventive actions (BNSS security proceedings)', '', '', '', ''],
              ['Petitions / complaints disposed', '', '', '', ''],
              ['Passport / service verifications completed', '', '', '', ''],
            ],
          },
          { kind: 'narrative', id: 'achievements', label: '2. Notable achievements — significant detections, operations, awards', lines: 4 },
        ],
      },
      {
        id: 'pp-review',
        title: 'PERFORMANCE — REVIEW & DIRECTION',
        blocks: [
          { kind: 'narrative', id: 'shortfalls', label: '3. Shortfalls & reasons — heads where performance lagged', lines: 4 },
          { kind: 'narrative', id: 'personnel', label: '4. Personnel & discipline — strength vs sanctioned, training, commendations, departmental enquiries', lines: 4 },
          { kind: 'narrative', id: 'welfare', label: '5. Community policing & public interface — beat meetings, grievance redressal, response times', lines: 3 },
          { kind: 'narrative', id: 'directions', label: '6. Directions of the reviewing officer & targets for next period', lines: 4 },
          { kind: 'signatures', blocks: [{ label: 'Signature of the reviewing officer', fields: ['Name', 'Rank', 'Designation', 'Date'] }] },
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },

  // ── 12. Court / Case Status Report ───────────────────────────────────────
  {
    id: 'case-status',
    name: 'Case Status Report',
    form: 'Case Status',
    law: 'Police–prosecution interface',
    preparedBy: 'Police / prosecution wing',
    blurb: 'Status of cases pending trial — hearings, witnesses, custody.',
    icon: 'court',
    accent: '#b45309',
    sheets: [
      {
        id: 'st-main',
        title: 'COURT / CASE STATUS REPORT',
        blocks: [
          {
            kind: 'fields',
            fields: [
              { id: 'dist', label: 'District', span: 3 },
              { id: 'ps', label: 'P.S.', span: 3 },
              { id: 'crimeNo', label: 'Crime No. / Year', span: 3 },
              { id: 'date', label: 'Date of report', type: 'date', span: 3 },
              { id: 'sections', label: 'Acts & Sections', span: 6 },
              { id: 'court', label: 'Court & C.C. / S.C. No.', span: 6 },
              { id: 'stage', label: 'Present stage', type: 'select', span: 6, options: ['Pending investigation', 'Charge sheet filed — cognizance awaited', 'Committed to Sessions', 'Charges framed', 'Prosecution evidence', 'Defence evidence', 'Arguments', 'Judgment reserved', 'Disposed — convicted', 'Disposed — acquitted', 'Appeal pending'] },
              { id: 'nextHearing', label: 'Next date of hearing', type: 'date', span: 3 },
              { id: 'pp', label: 'Public Prosecutor / APP in charge', span: 3 },
              { id: 'ioName', label: 'I.O. / Court PC responsible', span: 6 },
              { id: 'accusedStatus', label: 'Custody status of accused (bail / JC / absconding)', span: 6 },
            ],
          },
          {
            kind: 'table',
            id: 'hearings',
            label: '1. Proceedings during the period',
            columns: [
              { id: 'date', label: 'Hearing date', width: 14 },
              { id: 'purpose', label: 'Purpose', width: 24 },
              { id: 'outcome', label: 'What transpired', width: 42 },
              { id: 'next', label: 'Next step', width: 20 },
            ],
            rows: 4,
          },
          {
            kind: 'table',
            id: 'witnesses',
            label: '2. Witness attendance',
            columns: [
              { id: 'name', label: 'Witness', width: 24 },
              { id: 'summoned', label: 'Summoned for', width: 18 },
              { id: 'served', label: 'Summons served?', width: 16 },
              { id: 'examined', label: 'Examined?', width: 14 },
              { id: 'remarks', label: 'Remarks (hostile / awaited)', width: 28 },
            ],
            rows: 4,
          },
          { kind: 'narrative', id: 'pending', label: '3. Pending compliances (FSL reports, documents, further evidence, NBWs to execute)', lines: 3 },
          { kind: 'narrative', id: 'remarks', label: '4. Remarks of the I.O. / prosecution', lines: 3 },
          SIGN_IO,
        ],
      },
    ],
    extraSheets: [CONTINUATION_SHEET],
  },
];

export const reportTypeById = (id) => REPORT_TYPES.find((t) => t.id === id) || null;
