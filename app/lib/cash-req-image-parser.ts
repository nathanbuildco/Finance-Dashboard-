// Image-based parser for the "Cash Requirements" acquisition schedule.
// Takes a PNG/JPEG screenshot of the source spreadsheet and returns the same
// `Schedule` shape produced by cash-req-parser.ts.
//
// Mirrors the pattern used by land-parser.ts: Claude API with adaptive
// thinking and a JSON-schema constrained output.

import Anthropic from "@anthropic-ai/sdk";
import type { Schedule, MonthCol, DealRow, CashEvent } from "./cash-req-parser";

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

interface RawEvent {
  date: string;   // "YYYY-MM-DD"
  label: string;
  amount: number;
}
interface RawCell {
  monthLabel: string;
  events: RawEvent[];
}
interface RawDeal {
  name: string;
  cells: RawCell[];
}
interface RawSchedule {
  months: string[];          // ordered labels like "Jan-26"
  deals: RawDeal[];
  monthlyTotalsFromFile?: number[];
  cumulativeFromFile?: number[];
}

const SCHEDULE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    months: {
      type: "array",
      description:
        "The month-column headers as printed in the spreadsheet, left-to-right, chronological. Format 'MMM-YY' (e.g. 'Jan-26', 'Feb-26', 'Sep-27').",
      items: { type: "string" },
    },
    deals: {
      type: "array",
      description: "One entry per deal row (H&PB Basco, Tex Mix, Bar W Ranch, etc.). Skip blank / hidden rows and totals rows.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string", description: "Deal name exactly as printed in the first column." },
          cells: {
            type: "array",
            description:
              "Non-empty cells for this deal only. Each cell is one month with one or more events. Omit blank cells entirely.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                monthLabel: { type: "string", description: "The month header the events fall under, e.g. 'Mar-26'." },
                events: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      date: { type: "string", description: "Full ISO date 'YYYY-MM-DD'. Take the year from the column's month; M/D printed in the cell gives you the day and month." },
                      label: { type: "string", description: "Event label as printed, e.g. 'Initial Deposit', 'Closing', '2nd Close Extension'." },
                      amount: { type: "number", description: "Dollar amount as a plain number, no $ or commas. Preserve sign." },
                    },
                    required: ["date", "label", "amount"],
                  },
                },
              },
              required: ["monthLabel", "events"],
            },
          },
        },
        required: ["name", "cells"],
      },
    },
    monthlyTotalsFromFile: {
      type: "array",
      description: "Values from the file's own 'Monthly Totals' row, index-aligned with months[]. Omit if not present.",
      items: { type: "number" },
    },
    cumulativeFromFile: {
      type: "array",
      description: "Values from the file's own 'Cumulative' row, index-aligned with months[]. Omit if not present.",
      items: { type: "number" },
    },
  },
  required: ["months", "deals"],
};

const SYSTEM_PROMPT = `You extract an acquisitions "Cash Requirements" schedule from a screenshot of a spreadsheet.

Layout:
- A wide table with a "Deal Name" column on the left and one column per month across the top, labeled MMM-YY (e.g. "Jan-26", "Feb-26"), left-to-right in chronological order.
- One row per deal (H&PB Basco, Tex Mix, Bar W Ranch, Tito, Texas Aggregates, etc.).
- Each populated deal/month cell contains three stacked lines: (1) event date "M/D" (e.g. "3/5"), (2) event label as free text (e.g. "Initial Deposit", "Addl. Deposit", "Closing", "2nd Close Extension"), (3) dollar amount (e.g. "$258,749").
- Empty cells are blank.
- Bottom rows are "Monthly Totals" and "Cumulative" — treat as file-provided totals, not as deal rows.

Rules:
- Return months[] as the ordered list of column headers, exactly as printed.
- Return deals[] in top-to-bottom order.
- Omit blank cells; only include a cell entry when the cell has an amount.
- Compute each event's full ISO date by combining the column's year with the printed M/D. If the M/D month disagrees with the column month, still use the printed M/D month but the column year.
- Parse amounts as plain numbers (strip $ and commas). Preserve sign — parenthesized values are negative.
- If a cell holds multiple events, return them all.
- Skip subtotal rows, section header rows, blank rows, and any decorative rows.
- Do NOT invent deals or events. If a cell is unclear, omit it rather than guess.
- If the screenshot includes the "Monthly Totals" and/or "Cumulative" rows, return them under monthlyTotalsFromFile and cumulativeFromFile (index-aligned with months[]).`;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
  return new Anthropic({ apiKey });
}

const MONTH_ABBR: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function parseMonthLabel(raw: string): MonthCol | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
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

export async function parseCashRequirementsImage(
  imageBytes: Uint8Array,
  mediaType: ImageMediaType,
): Promise<Schedule> {
  const client = getClient();
  const base64 = Buffer.from(imageBytes).toString("base64");

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: SCHEDULE_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Extract the full Cash Requirements schedule from this screenshot." },
        ],
      },
    ],
  });

  const jsonBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!jsonBlock) throw new Error("Model returned no text block.");

  let raw: RawSchedule;
  try {
    raw = JSON.parse(jsonBlock.text);
  } catch {
    throw new Error(`Model returned non-JSON text: ${jsonBlock.text.slice(0, 200)}`);
  }

  return normalize(raw);
}

function normalize(raw: RawSchedule): Schedule {
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object") throw new Error("Empty parse result.");
  if (!Array.isArray(raw.months) || raw.months.length === 0) {
    throw new Error("No month columns extracted from screenshot.");
  }
  if (!Array.isArray(raw.deals) || raw.deals.length === 0) {
    throw new Error("No deal rows extracted from screenshot.");
  }

  const months: MonthCol[] = [];
  for (const label of raw.months) {
    const parsed = parseMonthLabel(String(label));
    if (!parsed) {
      warnings.push(`Ignored unrecognized month label "${label}".`);
      continue;
    }
    months.push(parsed);
  }
  if (months.length === 0) throw new Error("No valid month labels parsed from screenshot.");
  const monthIndexByLabel = new Map(months.map((m, i) => [m.label.toLowerCase(), i]));

  const deals: DealRow[] = [];
  for (const rd of raw.deals) {
    if (!rd || typeof rd !== "object") continue;
    const name = String(rd.name ?? "").trim();
    if (!name) continue;
    const cells: (CashEvent[] | null)[] = new Array(months.length).fill(null);
    let hasAny = false;
    for (const rc of rd.cells ?? []) {
      if (!rc || typeof rc !== "object") continue;
      const mi = monthIndexByLabel.get(String(rc.monthLabel ?? "").toLowerCase().trim());
      if (mi === undefined) {
        warnings.push(`Deal "${name}": cell references unknown month "${rc.monthLabel}"`);
        continue;
      }
      for (const ev of rc.events ?? []) {
        if (!ev || typeof ev !== "object") continue;
        const date = String(ev.date ?? "").trim();
        const label = String(ev.label ?? "").trim();
        const amount = Number(ev.amount);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          warnings.push(`Deal "${name}" ${rc.monthLabel}: bad date "${ev.date}"`);
          continue;
        }
        if (!Number.isFinite(amount)) {
          warnings.push(`Deal "${name}" ${rc.monthLabel}: non-numeric amount`);
          continue;
        }
        if (!cells[mi]) cells[mi] = [];
        cells[mi]!.push({ date, label, amount, rawAmount: `$${Math.round(amount).toLocaleString()}` });
        hasAny = true;
      }
    }
    if (hasAny) deals.push({ name, cells });
  }

  const monthlyTotalsComputed = months.map((_, mi) =>
    deals.reduce((sum, d) => sum + (d.cells[mi]?.reduce((s, e) => s + e.amount, 0) ?? 0), 0),
  );
  let running = 0;
  const cumulativeComputed = monthlyTotalsComputed.map((v) => (running += v));

  if (Array.isArray(raw.monthlyTotalsFromFile)) {
    for (let mi = 0; mi < months.length; mi++) {
      const file = raw.monthlyTotalsFromFile[mi];
      if (typeof file !== "number") continue;
      const diff = file - monthlyTotalsComputed[mi];
      if (Math.abs(diff) > 1) {
        warnings.push(
          `Monthly Totals for ${months[mi].label} disagree: file $${Math.round(file).toLocaleString()} vs computed $${Math.round(monthlyTotalsComputed[mi]).toLocaleString()} (Δ $${Math.round(diff).toLocaleString()})`,
        );
      }
    }
  }
  if (Array.isArray(raw.cumulativeFromFile)) {
    for (let mi = 0; mi < months.length; mi++) {
      const file = raw.cumulativeFromFile[mi];
      if (typeof file !== "number") continue;
      const diff = file - cumulativeComputed[mi];
      if (Math.abs(diff) > 1) {
        warnings.push(
          `Cumulative for ${months[mi].label} disagree: file $${Math.round(file).toLocaleString()} vs computed $${Math.round(cumulativeComputed[mi]).toLocaleString()} (Δ $${Math.round(diff).toLocaleString()})`,
        );
      }
    }
  }

  return {
    sheetName: "screenshot",
    months,
    deals,
    monthlyTotalsComputed,
    cumulativeComputed,
    monthlyTotalsFromFile: raw.monthlyTotalsFromFile,
    cumulativeFromFile: raw.cumulativeFromFile,
    warnings,
  };
}
