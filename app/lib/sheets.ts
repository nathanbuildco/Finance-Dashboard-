import { google, sheets_v4 } from "googleapis";
import type { Holding, ParsedStatement } from "./portfolio-parser";
import type { LandTxn } from "./land-parser";
import type { Schedule } from "./cash-req-parser";
import type { AcqCalendar, Phase } from "./acq-calendar-model";

export const PORTFOLIO_TAB = "Portfolio";
export const PORTFOLIO_HEADERS = [
  "Statement Date",
  "Account",
  "Account Name",
  "Ticker",
  "Description",
  "Shares",
  "Cost Basis",
  "Market Value",
  "Unrealized G/L",
  "Uploaded At",
] as const;

export const LAND_TAB = "Land Acquisitions";
export const LAND_HEADERS = [
  "Deal",
  "Date",
  "Type",
  "Amount",
  "Uploaded At",
] as const;

export const CLOSED_TAB = "Acquisitions Closed";

export const ACQ_CAL_TAB = "Acquisition Calendar";
export const ACQ_CAL_HEADERS = [
  "Deal",
  "Provisional",
  "Acres",
  "Price",
  "Deposit Label",
  "Deposit Note",
  "Deal Order",
  "Segment Order",
  "Phase",
  "Segment Start",
  "Segment End",
  "Milestone Date",
  "Title",
  "Timeline Start",
  "Timeline End",
  "Footnote",
  "Totals Acres From Image",
  "Totals Price From Image",
  "Uploaded At",
  "Closings JSON",
  "Segment Note",
  "Deposit Is Rate",
] as const;

export const CASH_REQ_TAB = "Cash Requirements";
export const CASH_REQ_HEADERS = [
  "Deal",
  "Month Label",
  "Month Year",
  "Month Index",
  "Event Date",
  "Event Label",
  "Amount",
  "Raw Amount",
  "Uploaded At",
] as const;

export interface ClosedAcquisitionRow {
  dealName: string;
  acreage: number;
  closingDate: string;
  lineItem: string;
  amount: number;
  notes: string;
}

export interface SnapshotRow {
  statementDate: string;
  account: string;
  accountName: string;
  ticker: string;
  description: string;
  shares: number;
  costBasis: number;
  marketValue: number;
  unrealized: number;
  uploadedAt: string;
}

export interface LandRow {
  deal: string;
  date: string;
  type: string;
  amount: number;
  uploadedAt: string;
}

function getSheetsClient(): { sheets: sheets_v4.Sheets; spreadsheetId: string } {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!spreadsheetId || !clientEmail || !privateKey) {
    throw new Error(
      "Google Sheets credentials missing: set GOOGLE_SHEETS_SPREADSHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY in .env.local.",
    );
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return { sheets: google.sheets({ version: "v4", auth }), spreadsheetId };
}

async function getTabSheetId(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
  title: string,
): Promise<number | null> {
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const tab = meta.data.sheets?.find((s) => s.properties?.title === title);
  return tab?.properties?.sheetId ?? null;
}

async function ensurePortfolioTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<number> {
  let sheetId = await getTabSheetId(sheets, spreadsheetId, PORTFOLIO_TAB);
  if (sheetId !== null) return sheetId;

  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: PORTFOLIO_TAB } } }],
    },
  });
  sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
  if (sheetId === null) throw new Error("Failed to create Portfolio tab.");

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${PORTFOLIO_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [PORTFOLIO_HEADERS as unknown as string[]] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(textFormat,horizontalAlignment)",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });

  return sheetId;
}

function holdingToRow(
  statementDate: string,
  h: Holding,
  uploadedAt: string,
): (string | number)[] {
  return [
    statementDate,
    h.account,
    h.accountName,
    h.ticker,
    h.description,
    h.shares,
    h.costBasis,
    h.marketValue,
    h.marketValue - h.costBasis,
    uploadedAt,
  ];
}

export async function replaceSnapshotForDate(
  statement: ParsedStatement,
): Promise<{ removed: number; appended: number }> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const sheetId = await ensurePortfolioTab(sheets, spreadsheetId);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${PORTFOLIO_TAB}!A2:A`,
  });
  const dateCol = existing.data.values ?? [];

  let removed = 0;
  // Walk bottom-up so row indexes stay valid as we delete.
  const requests: sheets_v4.Schema$Request[] = [];
  for (let i = dateCol.length - 1; i >= 0; i--) {
    if (dateCol[i]?.[0] === statement.statementDate) {
      const startRowIndex = i + 1; // +1 for header
      requests.push({
        deleteDimension: {
          range: {
            sheetId,
            dimension: "ROWS",
            startIndex: startRowIndex,
            endIndex: startRowIndex + 1,
          },
        },
      });
      removed++;
    }
  }
  if (requests.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests },
    });
  }

  const uploadedAt = new Date().toISOString();
  const rows = statement.holdings.map((h) =>
    holdingToRow(statement.statementDate, h, uploadedAt),
  );

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${PORTFOLIO_TAB}!A1`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });

  return { removed, appended: rows.length };
}

export async function listSnapshots(): Promise<SnapshotRow[]> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const tab = await getTabSheetId(sheets, spreadsheetId, PORTFOLIO_TAB);
  if (tab === null) return [];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${PORTFOLIO_TAB}!A2:J`,
  });
  const rows = res.data.values ?? [];
  return rows
    .filter((r) => r.length >= 9 && r[0])
    .map((r) => ({
      statementDate: String(r[0]),
      account: String(r[1] ?? ""),
      accountName: String(r[2] ?? ""),
      ticker: String(r[3] ?? ""),
      description: String(r[4] ?? ""),
      shares: Number(r[5] ?? 0),
      costBasis: Number(r[6] ?? 0),
      marketValue: Number(r[7] ?? 0),
      unrealized: Number(r[8] ?? 0),
      uploadedAt: String(r[9] ?? ""),
    }));
}

async function ensureLandTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<number> {
  let sheetId = await getTabSheetId(sheets, spreadsheetId, LAND_TAB);
  if (sheetId !== null) return sheetId;

  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: LAND_TAB } } }],
    },
  });
  sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
  if (sheetId === null) throw new Error("Failed to create Land Acquisitions tab.");

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${LAND_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [LAND_HEADERS as unknown as string[]] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(textFormat,horizontalAlignment)",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });

  return sheetId;
}

export async function replaceLandAcquisitions(
  txns: LandTxn[],
): Promise<{ cleared: number; appended: number }> {
  const { sheets, spreadsheetId } = getSheetsClient();
  await ensureLandTab(sheets, spreadsheetId);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${LAND_TAB}!A2:A`,
  });
  const cleared = (existing.data.values ?? []).length;

  if (cleared > 0) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${LAND_TAB}!A2:E`,
    });
  }

  const uploadedAt = new Date().toISOString();
  const rows: (string | number)[][] = txns.map((t) => [
    t.deal,
    t.date,
    t.type,
    t.amount,
    uploadedAt,
  ]);

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${LAND_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
  }

  return { cleared, appended: rows.length };
}

export async function listLandAcquisitions(): Promise<LandRow[]> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const tab = await getTabSheetId(sheets, spreadsheetId, LAND_TAB);
  if (tab === null) return [];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${LAND_TAB}!A2:E`,
  });
  const rows = res.data.values ?? [];
  return rows
    .filter((r) => r.length >= 4 && r[0] && r[1])
    .map((r) => ({
      deal: String(r[0]),
      date: String(r[1]),
      type: String(r[2] ?? ""),
      amount: Number(r[3] ?? 0),
      uploadedAt: String(r[4] ?? ""),
    }));
}

const CLOSED_HEADER_KEYS: Record<keyof ClosedAcquisitionRow, string[]> = {
  dealName: ["deal_name", "deal name", "deal"],
  acreage: ["acreage", "acres"],
  closingDate: ["closing_date", "closing date", "close_date", "close date"],
  lineItem: ["line_item", "line item"],
  amount: ["amount", "$", "value"],
  notes: ["notes", "note", "comments"],
};

function parseAmount(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const s = String(raw ?? "").trim();
  if (!s) return 0;
  // Sheets sometimes serializes negatives as parens, $/commas vary.
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[$,()\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return 0;
  return negative ? -Math.abs(n) : n;
}

export async function listClosedAcquisitions(): Promise<ClosedAcquisitionRow[]> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const tab = await getTabSheetId(sheets, spreadsheetId, CLOSED_TAB);
  if (tab === null) return [];

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${CLOSED_TAB}!A1:Z`,
  });
  const values = res.data.values ?? [];
  if (values.length < 2) return [];

  const headerRow = values[0].map((h) => String(h ?? "").trim().toLowerCase());
  const colIndex: Partial<Record<keyof ClosedAcquisitionRow, number>> = {};
  for (const key of Object.keys(CLOSED_HEADER_KEYS) as (keyof ClosedAcquisitionRow)[]) {
    const aliases = CLOSED_HEADER_KEYS[key];
    const idx = headerRow.findIndex((h) => aliases.includes(h));
    if (idx >= 0) colIndex[key] = idx;
  }
  if (colIndex.dealName === undefined || colIndex.amount === undefined) {
    return [];
  }

  const out: ClosedAcquisitionRow[] = [];
  for (let i = 1; i < values.length; i++) {
    const r = values[i] ?? [];
    const dealName = String(r[colIndex.dealName] ?? "").trim();
    if (!dealName) continue;
    out.push({
      dealName,
      acreage: parseAmount(r[colIndex.acreage ?? -1]),
      closingDate: String(r[colIndex.closingDate ?? -1] ?? "").trim(),
      lineItem: String(r[colIndex.lineItem ?? -1] ?? "").trim(),
      amount: parseAmount(r[colIndex.amount]),
      notes: String(r[colIndex.notes ?? -1] ?? "").trim(),
    });
  }
  return out;
}

async function ensureCashReqTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<number> {
  let sheetId = await getTabSheetId(sheets, spreadsheetId, CASH_REQ_TAB);
  if (sheetId !== null) return sheetId;

  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: CASH_REQ_TAB } } }],
    },
  });
  sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
  if (sheetId === null) throw new Error("Failed to create Cash Requirements tab.");

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${CASH_REQ_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [CASH_REQ_HEADERS as unknown as string[]] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(textFormat,horizontalAlignment)",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });

  return sheetId;
}

export async function replaceCashRequirements(
  schedule: Schedule,
): Promise<{ cleared: number; appended: number }> {
  const { sheets, spreadsheetId } = getSheetsClient();
  await ensureCashReqTab(sheets, spreadsheetId);

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${CASH_REQ_TAB}!A2:A`,
  });
  const cleared = (existing.data.values ?? []).length;
  if (cleared > 0) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${CASH_REQ_TAB}!A2:I`,
    });
  }

  const uploadedAt = new Date().toISOString();
  const rows: (string | number)[][] = [];
  for (const deal of schedule.deals) {
    for (let mi = 0; mi < schedule.months.length; mi++) {
      const events = deal.cells[mi];
      if (!events) continue;
      const m = schedule.months[mi];
      for (const ev of events) {
        rows.push([
          deal.name,
          m.label,
          m.year,
          m.month0,
          ev.date,
          ev.label,
          ev.amount,
          ev.rawAmount,
          uploadedAt,
        ]);
      }
    }
  }

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${CASH_REQ_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
  }

  return { cleared, appended: rows.length };
}

export async function listCashRequirements(): Promise<Schedule | null> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const tab = await getTabSheetId(sheets, spreadsheetId, CASH_REQ_TAB);
  if (tab === null) return null;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${CASH_REQ_TAB}!A2:I`,
  });
  const rows = res.data.values ?? [];
  if (rows.length === 0) return null;

  // Rebuild months in chronological order.
  const monthMap = new Map<string, { year: number; month0: number; label: string }>();
  for (const r of rows) {
    const label = String(r[1] ?? "").trim();
    const year = Number(r[2] ?? 0);
    const month0 = Number(r[3] ?? 0);
    if (!label || !Number.isFinite(year) || !Number.isFinite(month0)) continue;
    const key = `${year}-${month0}`;
    if (!monthMap.has(key)) monthMap.set(key, { year, month0, label });
  }
  const months = Array.from(monthMap.values()).sort(
    (a, b) => a.year - b.year || a.month0 - b.month0,
  );
  const monthIndexByKey = new Map(months.map((m, i) => [`${m.year}-${m.month0}`, i]));

  // Rebuild deals in first-seen order (preserve upload order).
  const dealMap = new Map<string, (({ date: string; label: string; amount: number; rawAmount: string }[]) | null)[]>();
  const dealOrder: string[] = [];
  for (const r of rows) {
    const name = String(r[0] ?? "").trim();
    if (!name) continue;
    const year = Number(r[2] ?? 0);
    const month0 = Number(r[3] ?? 0);
    const mi = monthIndexByKey.get(`${year}-${month0}`);
    if (mi === undefined) continue;
    if (!dealMap.has(name)) {
      dealMap.set(name, new Array(months.length).fill(null));
      dealOrder.push(name);
    }
    const cells = dealMap.get(name)!;
    if (!cells[mi]) cells[mi] = [];
    cells[mi]!.push({
      date: String(r[4] ?? ""),
      label: String(r[5] ?? ""),
      amount: Number(r[6] ?? 0),
      rawAmount: String(r[7] ?? ""),
    });
  }
  const deals = dealOrder.map((name) => ({ name, cells: dealMap.get(name)! }));

  const monthlyTotalsComputed = months.map((_, mi) =>
    deals.reduce((sum, d) => sum + (d.cells[mi]?.reduce((s, e) => s + e.amount, 0) ?? 0), 0),
  );
  let running = 0;
  const cumulativeComputed = monthlyTotalsComputed.map((v) => (running += v));

  return {
    sheetName: CASH_REQ_TAB,
    months,
    deals,
    monthlyTotalsComputed,
    cumulativeComputed,
    warnings: [],
  };
}

// ── Acquisition Calendar ──────────────────────────────────────────────────

async function ensureAcqCalTab(
  sheets: sheets_v4.Sheets,
  spreadsheetId: string,
): Promise<number> {
  let sheetId = await getTabSheetId(sheets, spreadsheetId, ACQ_CAL_TAB);
  if (sheetId !== null) return sheetId;

  const created = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: ACQ_CAL_TAB } } }],
    },
  });
  sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? null;
  if (sheetId === null) throw new Error("Failed to create Acquisition Calendar tab.");

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ACQ_CAL_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [ACQ_CAL_HEADERS as unknown as string[]] },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                textFormat: { bold: true },
                horizontalAlignment: "CENTER",
              },
            },
            fields: "userEnteredFormat(textFormat,horizontalAlignment)",
          },
        },
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount",
          },
        },
      ],
    },
  });

  return sheetId;
}

export async function replaceAcqCalendar(
  cal: AcqCalendar,
): Promise<{ cleared: number; appended: number }> {
  const { sheets, spreadsheetId } = getSheetsClient();
  await ensureAcqCalTab(sheets, spreadsheetId);

  // Keep the header row in sync with ACQ_CAL_HEADERS so schema evolution
  // (added columns) doesn't leave old sheets pointing at the wrong slots.
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${ACQ_CAL_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [ACQ_CAL_HEADERS as unknown as string[]] },
  });

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ACQ_CAL_TAB}!A2:A`,
  });
  const cleared = (existing.data.values ?? []).length;
  if (cleared > 0) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `${ACQ_CAL_TAB}!A2:V`,
    });
  }

  const uploadedAt = new Date().toISOString();
  const rows: (string | number)[][] = [];
  for (let di = 0; di < cal.deals.length; di++) {
    const d = cal.deals[di];
    // Emit at least one row per deal even if there are no segments, so the
    // deal survives the round trip.
    const segments = d.segments.length > 0 ? d.segments : [null];
    for (let si = 0; si < segments.length; si++) {
      const s = segments[si];
      rows.push([
        d.name,
        d.provisional ? "TRUE" : "",
        d.acres,
        d.price,
        d.depositLabel,
        d.depositNote ?? "",
        di,
        si,
        s?.phase ?? "",
        s?.start ?? "",
        s?.end ?? "",
        s?.milestoneDate ?? "",
        cal.title,
        cal.timelineStart,
        cal.timelineEnd,
        cal.footnote ?? "",
        cal.totalsFromImage?.acres ?? "",
        cal.totalsFromImage?.price ?? "",
        uploadedAt,
        s?.closings && s.closings.length > 0 ? JSON.stringify(s.closings) : "",
        s?.note ?? "",
        d.depositIsRate ? "TRUE" : "",
      ]);
    }
  }

  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${ACQ_CAL_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
  }

  return { cleared, appended: rows.length };
}

export async function listAcqCalendar(): Promise<AcqCalendar | null> {
  const { sheets, spreadsheetId } = getSheetsClient();
  const tab = await getTabSheetId(sheets, spreadsheetId, ACQ_CAL_TAB);
  if (tab === null) return null;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${ACQ_CAL_TAB}!A2:V`,
  });
  const rows = res.data.values ?? [];
  if (rows.length === 0) return null;

  // Calendar-level metadata comes from the first row.
  const first = rows[0];
  const title = String(first[12] ?? "").trim() || "Master Acquisition Calendar";
  const timelineStart = String(first[13] ?? "").trim();
  const timelineEnd = String(first[14] ?? "").trim();
  const footnote = String(first[15] ?? "").trim() || null;
  const totAcresRaw = first[16];
  const totPriceRaw = first[17];
  const totalsFromImage =
    totAcresRaw !== undefined && totAcresRaw !== "" &&
    totPriceRaw !== undefined && totPriceRaw !== ""
      ? { acres: Number(totAcresRaw), price: Number(totPriceRaw) }
      : undefined;

  // Rebuild deals in dealOrder, segments in segmentOrder.
  type SegAgg = {
    order: number; phase: Phase; start: string; end: string; milestoneDate: string | null;
    closings?: { date: string; amount: number }[]; note?: string;
  };
  type DealAgg = {
    name: string; provisional: boolean; acres: number; price: number;
    depositLabel: string; depositNote: string | null; depositIsRate: boolean;
    segments: SegAgg[];
  };
  const dealMap = new Map<number, DealAgg>();
  for (const r of rows) {
    const dealOrder = Number(r[6] ?? -1);
    if (!Number.isFinite(dealOrder) || dealOrder < 0) continue;
    if (!dealMap.has(dealOrder)) {
      dealMap.set(dealOrder, {
        name: String(r[0] ?? "").trim(),
        provisional: String(r[1] ?? "").toLowerCase() === "true",
        acres: Number(r[2] ?? 0),
        price: Number(r[3] ?? 0),
        depositLabel: String(r[4] ?? ""),
        depositNote: (String(r[5] ?? "").trim() || null),
        depositIsRate: String(r[21] ?? "").toLowerCase() === "true",
        segments: [],
      });
    }
    const phase = String(r[8] ?? "").trim();
    if (phase === "contingency" || phase === "expectedClosing" || phase === "extension" || phase === "rolling") {
      const start = String(r[9] ?? "").trim();
      const end = String(r[10] ?? "").trim();
      if (start && end) {
        const milestoneDate = String(r[11] ?? "").trim() || null;
        const seg: SegAgg = {
          order: Number(r[7] ?? 0),
          phase: phase as Phase,
          start, end, milestoneDate,
        };
        if (phase === "rolling") {
          const closingsRaw = String(r[19] ?? "").trim();
          if (closingsRaw) {
            try {
              const parsed = JSON.parse(closingsRaw);
              if (Array.isArray(parsed)) {
                seg.closings = parsed
                  .filter((c): c is { date: string; amount: number } =>
                    !!c && typeof c === "object" && typeof (c as { date?: unknown }).date === "string" &&
                    Number.isFinite(Number((c as { amount?: unknown }).amount)),
                  )
                  .map((c) => ({ date: c.date, amount: Number(c.amount) }));
              }
            } catch { /* leave undefined on parse failure */ }
          }
          const note = String(r[20] ?? "").trim();
          if (note) seg.note = note;
        }
        dealMap.get(dealOrder)!.segments.push(seg);
      }
    }
  }
  const deals = Array.from(dealMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, d]) => ({
      name: d.name,
      provisional: d.provisional,
      acres: d.acres,
      price: d.price,
      depositLabel: d.depositLabel,
      depositNote: d.depositNote,
      depositIsRate: d.depositIsRate,
      segments: d.segments
        .sort((a, b) => a.order - b.order)
        .map(({ phase, start, end, milestoneDate, closings, note }) => ({
          phase, start, end, milestoneDate,
          ...(closings ? { closings } : {}),
          ...(note ? { note } : {}),
        })),
    }));

  // Totals — `price` is the full acquisition amount (pre-summed for rolling
  // deals on write). Closings are display-only from here.
  const totals = deals.reduce(
    (acc, d) => ({ acres: acc.acres + d.acres, price: acc.price + d.price }),
    { acres: 0, price: 0 },
  );

  return {
    title,
    timelineStart,
    timelineEnd,
    deals,
    totals,
    totalsFromImage,
    footnote,
    warnings: [],
  };
}
