import { google, sheets_v4 } from "googleapis";
import type { Holding, ParsedStatement } from "./portfolio-parser";
import type { LandTxn } from "./land-parser";

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
