// Parser for the "Cash Requirements" acquisition schedule Excel.
//
// Layout (as of the sample file):
//   Row N   : title cell "Cash Requirements" somewhere in the top rows (informational only).
//   Row N+k : header row — first non-blank cell reads "Deal Name", followed by month
//             columns labeled "MMM-YY" (e.g. "Jan-26"). Number of month columns varies.
//   Rows below: one row per deal. First non-blank cell = deal name (e.g. "H&PB Basco").
//               Each deal/month cell is either blank, or a single Excel cell containing
//               three newline-separated lines:
//                   line 1: event date "M/D"
//                   line 2: event label (free text)
//                   line 3: dollar amount "$258,749"
//   Near bottom : "Monthly Totals" row (sum of each month column) and "Cumulative" row
//                 (running total left-to-right). Zeros may render as "-".
//
// Nothing about this module talks to a Sheet, an API, or React — it's a pure
// (workbook → Schedule) transform used by the /upload route and the tests.

import * as XLSX from "xlsx";

export interface MonthCol {
  /** 4-digit year, e.g. 2026 */
  year: number;
  /** 0-11 month index */
  month0: number;
  /** Raw label as printed on the sheet, e.g. "Jan-26". */
  label: string;
}

export interface CashEvent {
  /** ISO date "YYYY-MM-DD"; the year comes from the column's month. */
  date: string;
  /** Free-text label as printed. */
  label: string;
  /** Parsed dollar amount. */
  amount: number;
  /** Original cell text for the amount line, preserved for tooltips / debugging. */
  rawAmount: string;
}

export interface DealRow {
  name: string;
  /** Index-aligned with `months`. Each entry is the list of events in that cell
   * (0-3+ typical). `null` means blank cell. */
  cells: (CashEvent[] | null)[];
}

export interface Schedule {
  sheetName: string;
  months: MonthCol[];
  deals: DealRow[];
  /** Recomputed from `deals` — canonical for downstream renders. */
  monthlyTotalsComputed: number[];
  /** Recomputed running total across `monthlyTotalsComputed`. */
  cumulativeComputed: number[];
  /** Values found in the file's own "Monthly Totals" row, if present. */
  monthlyTotalsFromFile?: number[];
  /** Values found in the file's own "Cumulative" row, if present. */
  cumulativeFromFile?: number[];
  /** Non-fatal issues surfaced to the UI. */
  warnings: string[];
}

/** List every sheet name in the workbook, for the picker if more than one has content. */
export function listSheetNames(workbook: XLSX.WorkBook): string[] {
  return workbook.SheetNames.slice();
}

/** Convert a 0-indexed row/col to Excel-style cell ref (e.g. row=14, col=2 → "C15"). */
function cellRef(row: number, col: number): string {
  let s = "";
  let c = col;
  do {
    s = String.fromCharCode(65 + (c % 26)) + s;
    c = Math.floor(c / 26) - 1;
  } while (c >= 0);
  return `${s}${row + 1}`;
}

const MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function parseMonthHeader(raw: string): MonthCol | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // Accept "Jan-26", "Jan 26", "Jan-2026", "January 2026"
  const m = /^([A-Za-z]{3,9})[\s\-]+(\d{2,4})$/.exec(s);
  if (!m) return null;
  const monKey = m[1].toLowerCase().slice(0, 3);
  const month0 = MONTH_ABBR[monKey];
  if (month0 === undefined) return null;
  let year = parseInt(m[2], 10);
  if (isNaN(year)) return null;
  if (year < 100) year += 2000;
  return { year, month0, label: s };
}

function parseAmount(raw: unknown): { value: number; text: string; ok: boolean } {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { value: raw, text: String(raw), ok: true };
  }
  const text = String(raw ?? "").trim();
  if (!text || text === "-" || text === "—") return { value: 0, text, ok: true };
  const negative = /^\(.*\)$/.test(text);
  const cleaned = text.replace(/[$,\s()]/g, "").replace(/^-/, "");
  const n = parseFloat(cleaned);
  if (isNaN(n)) return { value: 0, text, ok: false };
  return { value: negative ? -n : n, text, ok: true };
}

function parseMDDate(raw: string, year: number, month0: number): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (!m) return null;
  const mo = parseInt(m[1], 10) - 1;
  const d = parseInt(m[2], 10);
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  // The event's month should be the column's month; use `year` for the column.
  // If the M/D month disagrees, honor the M/D since that's the "true" event date
  // (edge case: crossing a fiscal boundary). Use the same year as the column.
  return `${year.toString().padStart(4, "0")}-${(mo + 1).toString().padStart(2, "0")}-${d.toString().padStart(2, "0")}`;
}

/** Extract stacked lines from a cell (three-line pattern). Normalizes CRLF, drops
 * blanks, and returns whatever's there — a cell might have 1, 2, 3, or more lines. */
function splitCellLines(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const s = String(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return s.split("\n").map((x) => x.trim()).filter((x) => x.length > 0);
}

/**
 * Parse a sheet into a Schedule. Never throws for shape issues — records them
 * as `warnings`. Only throws when the sheet is fundamentally unusable
 * (no "Deal Name" header or no month columns).
 */
export function parseCashRequirementsSheet(
  workbook: XLSX.WorkBook,
  sheetName?: string,
): Schedule {
  const targetSheet = sheetName ?? workbook.SheetNames[0];
  const ws = workbook.Sheets[targetSheet];
  if (!ws) throw new Error(`Sheet "${targetSheet}" not found in workbook.`);

  // Grid of raw cell values, undefined for blanks.
  const grid: unknown[][] = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  }) as unknown[][];
  const warnings: string[] = [];

  // Locate header row by finding first cell that equals "Deal Name" (case-insensitive).
  let headerRow = -1;
  let dealNameCol = -1;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] ?? [];
    for (let c = 0; c < row.length; c++) {
      const v = String(row[c] ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (v === "deal name") {
        headerRow = r;
        dealNameCol = c;
        break;
      }
    }
    if (headerRow !== -1) break;
  }
  if (headerRow === -1) {
    throw new Error(`No "Deal Name" header cell found on sheet "${targetSheet}".`);
  }

  // Month columns = every non-empty header cell to the right of Deal Name that parses
  // as a MMM-YY label. Stop at first non-parseable non-empty cell (heuristic: sheets
  // sometimes trail with a "Comments" column etc.).
  const months: MonthCol[] = [];
  const monthCols: number[] = [];
  const headerCells = grid[headerRow] ?? [];
  for (let c = dealNameCol + 1; c < headerCells.length; c++) {
    const raw = headerCells[c];
    if (raw === null || raw === undefined || String(raw).trim() === "") {
      // Skip a single blank column but stop at two in a row (sheet ended).
      if (
        c + 1 < headerCells.length &&
        (headerCells[c + 1] === null || headerCells[c + 1] === undefined ||
          String(headerCells[c + 1]).trim() === "")
      ) {
        break;
      }
      continue;
    }
    const parsed = parseMonthHeader(String(raw));
    if (!parsed) {
      // If we've already collected months and hit an unrecognized header, stop —
      // that's probably a "Comments" or totals column past the schedule window.
      if (months.length > 0) break;
      continue;
    }
    months.push(parsed);
    monthCols.push(c);
  }
  if (months.length === 0) {
    throw new Error(
      `No month columns (MMM-YY) found to the right of "Deal Name" on sheet "${targetSheet}".`,
    );
  }

  // Walk deal rows from headerRow + 1 downward. Stop when we hit the file's own
  // totals rows OR run out of rows.
  const deals: DealRow[] = [];
  let monthlyTotalsFromFile: number[] | undefined;
  let cumulativeFromFile: number[] | undefined;

  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    // First non-blank cell in first 5 columns wins as the label.
    let label = "";
    for (let c = 0; c < Math.min(row.length, Math.max(5, dealNameCol + 1)); c++) {
      const v = String(row[c] ?? "").trim();
      if (v) { label = v; break; }
    }
    if (!label) continue; // truly blank row → skip
    const lower = label.toLowerCase();

    if (lower === "monthly totals" || lower.startsWith("monthly total")) {
      monthlyTotalsFromFile = monthCols.map((c) => parseAmount(row[c]).value);
      continue;
    }
    if (lower === "cumulative" || lower.startsWith("cumulative")) {
      cumulativeFromFile = monthCols.map((c) => parseAmount(row[c]).value);
      continue;
    }

    // Deal row. Build a cells[] index-aligned with months[].
    const cells: (CashEvent[] | null)[] = new Array(months.length).fill(null);
    let hasAnyEvent = false;
    for (let mi = 0; mi < months.length; mi++) {
      const cellRaw = row[monthCols[mi]];
      const lines = splitCellLines(cellRaw);
      if (lines.length === 0) continue;

      // Common patterns:
      //   3 lines: [date, label, amount]
      //   1 line where amount is a plain number (e.g. Excel numeric cell)
      // We don't hardcode — if we can find an amount (last numeric-looking line)
      // and a date (first M/D-looking line), we build an event.
      let dateStr: string | null = null;
      let eventLabel = "";
      let amountLine = "";

      // Detect the M/D date line: first line matching M/D
      for (const ln of lines) {
        if (/^\d{1,2}\/\d{1,2}$/.test(ln)) { dateStr = parseMDDate(ln, months[mi].year, months[mi].month0); break; }
      }
      // Detect the amount line: last line that looks like currency or a number
      for (let i = lines.length - 1; i >= 0; i--) {
        const ln = lines[i];
        if (/[$0-9]/.test(ln) && /\d/.test(ln) && !/^\d{1,2}\/\d{1,2}$/.test(ln)) {
          amountLine = ln;
          break;
        }
      }
      // Remaining line(s) → event label
      eventLabel = lines
        .filter((ln) => ln !== amountLine && !/^\d{1,2}\/\d{1,2}$/.test(ln))
        .join(" ")
        .trim();

      if (!amountLine) {
        warnings.push(
          `${targetSheet}!${cellRef(r, monthCols[mi])}: no amount found in cell "${lines.join(" | ")}"`,
        );
        continue;
      }
      const amt = parseAmount(amountLine);
      if (!amt.ok) {
        warnings.push(
          `${targetSheet}!${cellRef(r, monthCols[mi])}: unparseable amount "${amountLine}"`,
        );
        continue;
      }
      if (!dateStr) {
        // Assume the 1st of the month if no explicit M/D.
        dateStr = `${months[mi].year.toString().padStart(4, "0")}-${(months[mi].month0 + 1).toString().padStart(2, "0")}-01`;
      }
      if (!cells[mi]) cells[mi] = [];
      cells[mi]!.push({ date: dateStr, label: eventLabel, amount: amt.value, rawAmount: amt.text });
      hasAnyEvent = true;
    }
    if (hasAnyEvent) deals.push({ name: label, cells });
  }

  // Recompute totals + cumulative from deal events.
  const monthlyTotalsComputed = months.map((_, mi) =>
    deals.reduce((sum, d) => sum + (d.cells[mi]?.reduce((s, e) => s + e.amount, 0) ?? 0), 0),
  );
  let running = 0;
  const cumulativeComputed = monthlyTotalsComputed.map((v) => (running += v));

  // Reconciliation warnings ($1 tolerance).
  if (monthlyTotalsFromFile) {
    for (let mi = 0; mi < months.length; mi++) {
      const diff = monthlyTotalsFromFile[mi] - monthlyTotalsComputed[mi];
      if (Math.abs(diff) > 1) {
        warnings.push(
          `Monthly Totals for ${months[mi].label} disagree: file $${Math.round(monthlyTotalsFromFile[mi]).toLocaleString()} vs computed $${Math.round(monthlyTotalsComputed[mi]).toLocaleString()} (Δ $${Math.round(diff).toLocaleString()})`,
        );
      }
    }
  }
  if (cumulativeFromFile) {
    for (let mi = 0; mi < months.length; mi++) {
      const diff = cumulativeFromFile[mi] - cumulativeComputed[mi];
      if (Math.abs(diff) > 1) {
        warnings.push(
          `Cumulative for ${months[mi].label} disagree: file $${Math.round(cumulativeFromFile[mi]).toLocaleString()} vs computed $${Math.round(cumulativeComputed[mi]).toLocaleString()} (Δ $${Math.round(diff).toLocaleString()})`,
        );
      }
    }
  }

  return {
    sheetName: targetSheet,
    months,
    deals,
    monthlyTotalsComputed,
    cumulativeComputed,
    monthlyTotalsFromFile,
    cumulativeFromFile,
    warnings,
  };
}
