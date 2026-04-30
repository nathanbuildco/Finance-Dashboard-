import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, isValidToken } from "@/app/lib/auth";

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlUqIymbq_OgJ70EoO2uARD86PqF5vKmG_CzYTyzSzxdEXGTtk3mgRf7NhecnaXjhdTpyor_e3-NJ5/pub?gid=634011599&single=true&output=csv";
const VENDOR_MAP_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlUqIymbq_OgJ70EoO2uARD86PqF5vKmG_CzYTyzSzxdEXGTtk3mgRf7NhecnaXjhdTpyor_e3-NJ5/pub?gid=678572461&single=true&output=csv";

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current = ""; let inQ = false; let row: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQ = true; }
      else if (ch === ",") { row.push(current.trim()); current = ""; }
      else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        row.push(current.trim()); rows.push(row); row = []; current = "";
        if (ch === "\r") i++;
      } else { current += ch; }
    }
  }
  if (current || row.length) { row.push(current.trim()); rows.push(row); }
  return rows;
}

function toNum(val: string | undefined): number {
  if (!val) return 0;
  const cleaned = val.replace(/[$,\s"]/g, "").replace(/[()]/g, "");
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

const MONTH_HEADER_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*[''`']?\s*\d{2,4}/i;

function parseAllLineItems(csvText: string): { monthLabels: string[]; lineItems: { label: string; values: number[] }[] } {
  const rows = parseCSV(csvText);

  let monthCols: { col: number; label: string }[] = [];
  for (const row of rows) {
    const temp: { col: number; label: string }[] = [];
    for (let c = 0; c < row.length; c++) {
      const cell = (row[c] || "").trim();
      if (MONTH_HEADER_RE.test(cell)) temp.push({ col: c, label: cell.replace(/\s+/g, " ") });
    }
    if (temp.length >= 10) { monthCols = temp; break; }
  }
  if (monthCols.length === 0) return { monthLabels: [], lineItems: [] };

  const monthLabels = monthCols.map(mc => mc.label);
  const lineItems: { label: string; values: number[] }[] = [];

  for (const row of rows) {
    // First non-empty cell in the label area becomes the row label.
    let label = "";
    for (let c = 0; c < Math.min(row.length, 5); c++) {
      const cell = (row[c] || "").trim();
      if (cell) { label = cell; break; }
    }
    if (!label) continue;
    if (MONTH_HEADER_RE.test(label)) continue;          // skip the header row itself
    if (label.toLowerCase().startsWith("ntm")) continue; // skip "NTM Projected"/"NTM Pitch Deck" summary col headers

    const values = monthCols.map(mc => toNum(row[mc.col]));
    if (values.every(v => v === 0)) continue;            // skip empty / pure-section-header rows

    lineItems.push({ label, values });
  }

  return { monthLabels, lineItems };
}

// Parse a generic CSV table where the first row is headers. Skips rows that are entirely empty.
function parseTable(csvText: string): { headers: string[]; rows: Record<string, string>[] } {
  const raw = parseCSV(csvText);
  if (raw.length === 0) return { headers: [], rows: [] };

  // First non-empty row becomes the header row.
  let headerIdx = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].some(c => c.trim())) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { headers: [], rows: [] };

  const headers = raw[headerIdx].map(h => h.trim());
  const rows: Record<string, string>[] = [];
  for (let i = headerIdx + 1; i < raw.length; i++) {
    const r = raw[i];
    const obj: Record<string, string> = {};
    let hasValue = false;
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const val = (r[c] || "").trim();
      obj[key] = val;
      if (val) hasValue = true;
    }
    if (hasValue) rows.push(obj);
  }
  return { headers: headers.filter(Boolean), rows };
}

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured on the server." }, { status: 500 });
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  if (!isValidToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { question?: unknown; financialData?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "Question is required." }, { status: 400 });
  }

  // Fetch both source CSVs in parallel, server-side, with 5-min Next fetch caching.
  let lineItemBlock = "(line item detail unavailable)";
  let vendorMapBlock = "(vendor mapping unavailable)";
  try {
    const [csvRes, vendorRes] = await Promise.all([
      fetch(SHEET_CSV_URL, { next: { revalidate: 300 } }),
      fetch(VENDOR_MAP_CSV_URL, { next: { revalidate: 300 } }),
    ]);

    if (csvRes.ok) {
      const csv = await csvRes.text();
      const { monthLabels, lineItems } = parseAllLineItems(csv);
      lineItemBlock =
        `Month columns (in order, applies to every row's "values" array):\n${JSON.stringify(monthLabels)}\n\n` +
        `Line items (${lineItems.length} populated rows):\n${JSON.stringify(lineItems)}`;
    } else {
      console.error("[chat] actuals CSV fetch returned", csvRes.status);
    }

    if (vendorRes.ok) {
      const vendorCsv = await vendorRes.text();
      const { headers, rows } = parseTable(vendorCsv);
      vendorMapBlock =
        `Columns: ${JSON.stringify(headers)}\n` +
        `Mappings (${rows.length} entries):\n${JSON.stringify(rows)}`;
    } else {
      console.error("[chat] vendor map CSV fetch returned", vendorRes.status);
    }
  } catch (e) {
    console.error("[chat] Failed to fetch source CSVs:", e);
  }

  const systemPrompt = `You are a financial analyst assistant for The Building Company. You have access to:
1. Vendor-level line item detail from the actuals/projections sheet — every populated row with its monthly values.
2. A vendor mapping table that maps the abbreviations/codes used in the line items to full vendor names, categories, and subcategories.

Answer questions concisely about spending, costs, headcount, projections, and specific vendors. Use specific numbers from the data provided.

When the user asks about a vendor by their full name (e.g. "Dover Kohl"), use the vendor mapping table to find the corresponding label/abbreviation in the line item data (e.g. "DK&P"), then quote the exact monthly amount(s) for the month(s) they asked about. If a vendor doesn't appear in the mapping, do a fuzzy/substring match on the line item labels and explain your match.

Vendor mapping table:
${vendorMapBlock}

Vendor-level line item detail (from the actuals + projections sheet):
${lineItemBlock}

Summary rollups (computed by the dashboard, useful for NTM totals, ITD, plan variance):
${JSON.stringify(body.financialData ?? {}, null, 2)}`;

  const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: question }],
    }),
  });

  if (!apiResponse.ok) {
    const errText = await apiResponse.text();
    console.error("[chat] Anthropic API error:", apiResponse.status, errText);
    return NextResponse.json({ error: `Anthropic API error (${apiResponse.status}): ${errText}` }, { status: apiResponse.status });
  }

  const data = await apiResponse.json();
  const answer = data?.content?.[0]?.text ?? "(no response)";
  return NextResponse.json({ answer });
}
