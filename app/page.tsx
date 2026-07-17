"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, Line, LabelList, Customized
} from "recharts";
import { logout } from "./actions/auth";
import ChatWidget from "./chat-widget";

// ══════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlUqIymbq_OgJ70EoO2uARD86PqF5vKmG_CzYTyzSzxdEXGTtk3mgRf7NhecnaXjhdTpyor_e3-NJ5/pub?gid=634011599&single=true&output=csv";
const PLAN_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlUqIymbq_OgJ70EoO2uARD86PqF5vKmG_CzYTyzSzxdEXGTtk3mgRf7NhecnaXjhdTpyor_e3-NJ5/pub?gid=1750179845&single=true&output=csv";
const OPERATING_CASH_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlUqIymbq_OgJ70EoO2uARD86PqF5vKmG_CzYTyzSzxdEXGTtk3mgRf7NhecnaXjhdTpyor_e3-NJ5/pub?gid=1657849898&single=true&output=csv";

// ── Cash Needs tab overrides (this tab only) ──────────────────────────────
// The Cash Needs tab is meant to be a "live as of today" view — payments
// already made are backed out here. Overrides for other tabs live elsewhere;
// this map applies exclusively inside the Cash Needs render block.
//
//   overheadDelta / corpDevDelta / projDevDelta : signed adjustments applied
//     to the parsed monthly values (negative to reduce).
//   corpDevSet / overheadSet / projDevSet        : force the value (deltas ignored).
//   excludeLandDeals                             : deal names to drop from the
//     month's Land Acquisitions detail (case-insensitive substring match).
interface CashNeedsOverride {
  overheadDelta?: number;
  corpDevDelta?: number;
  projDevDelta?: number;
  overheadSet?: number;
  corpDevSet?: number;
  projDevSet?: number;
  excludeLandDeals?: string[];
}
const CASH_NEEDS_OVERRIDES: Record<string, CashNeedsOverride> = {
  "July 2026": {
    overheadSet: 65_569,
    corpDevSet: 0,
    projDevSet: 152_461,
    excludeLandDeals: ["Bar W"],
  },
};

// ── Manual Fixed Expenses overrides ───────────────────────────────────────
// The sheet's Admin row rolls up variable items like Recruiter and AI Engineer,
// which we don't consider "fixed". Rather than re-derive the formula, projected
// fixed expenses for these months are pinned to values agreed with finance.
// Keys are full-name month labels as parsed from the actuals sheet.
const MANUAL_FIXED_EXPENSES: Record<string, number> = {
  "July 2026":      113_169,
  "August 2026":    152_389,
  "September 2026": 212_264,
  "October 2026":   211_264,
  "November 2026":  265_970,
  "December 2026":  266_120,
  "January 2027":   266_120,
  "February 2027":  266_120,
  "March 2027":     333_114,
  "April 2027":     333_114,
  "May 2027":       333_114,
  "June 2027":      333_114,
};

// ── Land Acquisitions ─────────────────────────────────────────────────────
// Data lives in the "Land Acquisitions" tab of the linked Google Sheet.
// Upload a screenshot of the deal sheet on the Cash Needs tab to refresh it.
interface LandTxn { deal: string; date: string; type: string; amount: number; uploadedAt?: string }

function getLandForMonth(monthLabel: string, txns: LandTxn[]): LandTxn[] {
  const d = parseMonthLabel(monthLabel);
  if (!d) return [];
  const yr = d.getFullYear();
  const mo = d.getMonth();
  return txns.filter(t => {
    const parts = t.date.split("-").map(Number);
    return parts[0] === yr && (parts[1] - 1) === mo;
  });
}

// Summary/rollup row labels excluded when computing top line-item expenses.
const SUMMARY_ROW_LABELS = new Set([
  // Category rollups
  "total costs",
  "corporate overhead costs",
  "corporate development costs",
  "project development costs",
  "architect fees",
  // Job titles / roles in the Employee Payroll Table
  "managing director",
  "director of partnerships",
  "associate",
  "director of construction",
  "analyst",
  "project manager",
  "head of ops",
  "ea",
  "controller",
  "cfo",
  "md of acq",
  // Specific people
  "lisa surnow",
  // Payroll table headers / section labels
  "employee payroll table",
  "total headcount",
  "average cost",
  "payroll",
  "total insurance",
  "recruiting",
  "role",
  "start date",
  "salary",
  "insurance cost",
  "bonus",
  "1st bonus date",
  // Config / meta rows
  "go forward spend",
  "projected cash",
  "last day of month review",
  "ntm end",
  "number of months",
]);

// Common business words that must NOT be flagged as a person's name (so "Land Carry",
// "Travel Cost", etc. survive the name pattern filter).
const BUSINESS_TERMS = new Set([
  "land", "carry", "carrying", "travel", "office", "admin", "legal", "engineering",
  "insurance", "lease", "rent", "cost", "costs", "fee", "fees", "tax", "taxes",
  "marketing", "subscription", "subscriptions", "software", "hardware", "equipment",
  "supplies", "utilities", "depreciation", "amortization", "interest", "principal",
  "loan", "debt", "equity", "salary", "payroll", "bonus", "benefits", "holding",
  "deposit", "deposits", "permit", "permits", "construction", "contract", "service",
  "services", "consulting", "accounting", "architecture", "planning", "brokerage",
  "recruiting", "total", "subtotal", "sum", "expense", "expenses", "development",
  "corporate", "project", "headcount",
]);

function isPersonName(label: string): boolean {
  const parts = label.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 3) return false;
  if (!parts.every(p => /^[A-Z][a-z]+$/.test(p))) return false;
  if (parts.some(p => BUSINESS_TERMS.has(p.toLowerCase()))) return false;
  return true;
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Pre-tokenize the exclude set once at module load.
const SUMMARY_ROW_TOKENS = Array.from(SUMMARY_ROW_LABELS).map(tokenize);

function isExcludedLabel(label: string): boolean {
  const lower = label.toLowerCase().trim();
  if (lower.includes("replaced")) return true;
  if (isPersonName(label)) return true;
  const labelTokens = tokenize(label);
  if (labelTokens.length === 0) return true;
  for (const excludedTokens of SUMMARY_ROW_TOKENS) {
    if (excludedTokens.length === 0) continue;
    if (excludedTokens.length > labelTokens.length) continue;
    if (excludedTokens.every((t, i) => labelTokens[i] === t)) return true;
  }
  return false;
}

const PLAN = {
  overhead: 2633667, corpDev: 416667, projDev: 6687500, total: 9737833,
};
const PITCH_DECK_FALLBACK = {
  overhead: 2509867, corpDev: 316667, projDev: 5350000, total: 2509867 + 316667 + 5350000,
};

// ══════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════
interface MonthData {
  month: string; overhead: number; corpDev: number; projDev: number;
  total: number; headcount: number; actual: boolean;
  payroll: number;
  fixedExpenses: number;
}

// ══════════════════════════════════════════════
// CSV PARSER
// ══════════════════════════════════════════════
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

// Parses dollar amounts that may carry magnitude suffixes (mm, m, b, k) — e.g. "$1.88mm" → 1880000.
function toNumWithSuffix(val: string | undefined): number {
  if (!val) return 0;
  const s = String(val).trim();
  if (!s) return 0;
  const isNeg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const stripped = s.replace(/^\(|\)$/g, "").replace(/^-/, "").replace(/[$,\s"]/g, "");
  const suffixMatch = stripped.match(/(mm|bn|m|b|k)$/i);
  let numStr = stripped;
  let multiplier = 1;
  if (suffixMatch) {
    numStr = stripped.slice(0, -suffixMatch[0].length);
    const sfx = suffixMatch[1].toLowerCase();
    multiplier =
      sfx === "mm" || sfx === "m" ? 1_000_000 :
      sfx === "bn" || sfx === "b" ? 1_000_000_000 :
      sfx === "k" ? 1_000 : 1;
  }
  const n = parseFloat(numStr);
  if (isNaN(n)) return 0;
  return (isNeg ? -1 : 1) * n * multiplier;
}

function findRow(rows: string[][], label: string): string[] | null {
  const target = label.toLowerCase().trim();
  for (const row of rows) {
    for (let c = 0; c < Math.min(row.length, 4); c++) {
      const cell = (row[c] || "").toLowerCase().replace(/\s+/g, " ").trim();
      if (cell === target || cell.startsWith(target)) return row;
    }
  }
  return null;
}

function parseMonthLabel(label: string): Date | null {
  const match = label.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*[''`]?\s*(\d{2,4})/i);
  if (!match) return null;
  const map: Record<string, number> = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  const mo = map[match[1].toLowerCase().slice(0, 3)];
  let yr = parseInt(match[2]); if (yr < 100) yr += 2000;
  return new Date(yr, mo, 28);
}

interface PitchDeck { overhead: number; corpDev: number; projDev: number; total: number }
interface PlanMonth { month: string; overhead: number; corpDev: number; projDev: number; total: number; fixedExpenses: number }
interface LineItem { label: string; monthly: Record<string, number>; bucket: string | null }

const SECTION_BUCKETS: Record<string, string> = {
  "corporate overhead costs": "Corp Overhead",
  "corporate development costs": "Corp Dev",
  "project development costs": "Proj Dev",
};

function parsePlanSheet(csv: string): { planMonths: PlanMonth[] } {
  const rows = parseCSV(csv);

  let monthLabelRow: string[] | null = null;
  const monthCols: { col: number; label: string }[] = [];
  for (const row of rows) {
    const tempCols: { col: number; label: string }[] = [];
    for (let c = 0; c < row.length; c++) {
      const cell = (row[c] || "").trim();
      if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*[''`']?\s*\d{2,4}/i.test(cell)) {
        tempCols.push({ col: c, label: cell.replace(/\s+/g, " ") });
      }
    }
    if (tempCols.length >= 6) { monthLabelRow = row; monthCols.push(...tempCols); break; }
  }
  if (!monthLabelRow) return { planMonths: [] };

  let totalRow: string[] | null = null;
  let overheadRow: string[] | null = null;
  let corpDevRow: string[] | null = null;
  let projDevRow: string[] | null = null;
  for (const row of rows) {
    const t = row.slice(0, 4).join(" ").toLowerCase().replace(/\s+/g, " ").trim();
    if (!totalRow && t.includes("total costs")) totalRow = row;
    if (!overheadRow && t.includes("corporate overhead costs")) overheadRow = row;
    if (!corpDevRow && t.includes("corporate development costs")) corpDevRow = row;
    if (!projDevRow && t.includes("project development costs")) projDevRow = row;
  }

  // Fixed expense sub-rows in the pitch deck plan tab — pinned to specific row indices.
  const planPayrollRow   = rows[32] ?? null;  // sheet row 33
  const planAdminRow     = rows[34] ?? null;  // sheet row 35
  const planOfficeRow    = rows[35] ?? null;  // sheet row 36
  const planLandCarryRow = rows[49] ?? null;  // sheet row 50

  const planMonths: PlanMonth[] = [];
  for (const mc of monthCols) {
    const c = mc.col;
    const tot = toNum(totalRow?.[c]);
    const oh = toNum(overheadRow?.[c]);
    const cd = toNum(corpDevRow?.[c]);
    const pd = toNum(projDevRow?.[c]);
    const pr = toNum(planPayrollRow?.[c]);
    const adm = toNum(planAdminRow?.[c]);
    const off = toNum(planOfficeRow?.[c]);
    const land = toNum(planLandCarryRow?.[c]);
    if (tot === 0 && oh === 0 && cd === 0 && pd === 0) continue;
    planMonths.push({
      month: mc.label.replace(/[''`]/g, "'").replace(/\s+/g, " ").trim(),
      overhead: Math.round(oh), corpDev: Math.round(cd), projDev: Math.round(pd), total: Math.round(tot),
      fixedExpenses: Math.round(pr + adm + off + land),
    });
  }
  return { planMonths };
}

function parseSheet(csv: string): { months: MonthData[]; reviewLabel: string; pitchDeck: PitchDeck | null; ntmProj: PitchDeck | null; lineItems: LineItem[] } {
  const rows = parseCSV(csv);

  // Find month label row
  let monthLabelRow: string[] | null = null;
  const monthCols: { col: number; label: string }[] = [];
  for (const row of rows) {
    const tempCols: { col: number; label: string }[] = [];
    for (let c = 0; c < row.length; c++) {
      const cell = (row[c] || "").trim();
      if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*[''`']?\s*\d{2,4}/i.test(cell)) {
        tempCols.push({ col: c, label: cell.replace(/\s+/g, " ") });
      }
    }
    if (tempCols.length >= 10) { monthLabelRow = row; monthCols.push(...tempCols); break; }
  }
  if (!monthLabelRow || monthCols.length === 0) throw new Error("Could not find month header row");

  const totalRow = findRow(rows, "total costs");
  const overheadRow = findRow(rows, "corporate overhead costs");
  const headcountRow = findRow(rows, "total headcount");
  const payrollRow = findRow(rows, "payroll");

  // Fixed expense sub-rows — located by label (rows shift when the sheet is edited).
  const adminRow     = findRow(rows, "admin");
  const officeRow    = findRow(rows, "office");
  const landCarryRow = findRow(rows, "land carry");

  let corpDevRow: string[] | null = null;
  let projDevRow: string[] | null = null;
  for (const row of rows) {
    const t = row.slice(0, 4).join(" ").toLowerCase().replace(/\s+/g, " ");
    if (t.includes("corporate development costs") && !corpDevRow) corpDevRow = row;
    if (t.includes("project development costs") && !projDevRow) projDevRow = row;
  }

  const reviewRow = findRow(rows, "last day of month review");
  // Default fallback if the row is missing entirely.
  let lastReviewDate = new Date(1899, 11, 30 + 46112);
  if (reviewRow) {
    for (const rawCell of reviewRow) {
      const cell = (rawCell || "").trim();
      if (!cell) continue;
      // 1) Excel serial number (e.g. 46112).
      const v = parseFloat(cell);
      if (!isNaN(v) && v >= 45000 && v < 50000) {
        lastReviewDate = new Date(1899, 11, 30 + v);
        break;
      }
      // 2) Text date string (M/D/YYYY, MM/DD/YYYY, "Month DD, YYYY", etc.).
      const parsed = new Date(cell);
      if (!isNaN(parsed.getTime()) && parsed.getFullYear() >= 2020 && parsed.getFullYear() <= 2050) {
        lastReviewDate = parsed;
        break;
      }
    }
  }
  const reviewLabel = lastReviewDate.toLocaleString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

  const months: MonthData[] = [];
  for (const mc of monthCols) {
    const c = mc.col;
    const tot = toNum(totalRow?.[c]);
    const oh = toNum(overheadRow?.[c]);
    const cd = toNum(corpDevRow?.[c]);
    const pd = toNum(projDevRow?.[c]);
    const hc = toNum(headcountRow?.[c]);
    const pr = toNum(payrollRow?.[c]);
    const adm = toNum(adminRow?.[c]);
    const off = toNum(officeRow?.[c]);
    const land = toNum(landCarryRow?.[c]);
    if (tot === 0 && oh === 0 && cd === 0 && pd === 0) continue;
    const monthDate = parseMonthLabel(mc.label);
    const isActual = monthDate ? monthDate <= lastReviewDate : false;
    months.push({
      month: mc.label.replace(/[''`]/g, "'").replace(/\s+/g, " ").trim(),
      overhead: Math.round(oh), corpDev: Math.round(cd), projDev: Math.round(pd),
      total: Math.round(tot), headcount: Math.round(hc), actual: isActual,
      payroll: Math.round(pr),
      fixedExpenses: Math.round(pr + adm + off + land),
    });
  }
  // Find "NTM Projected" and "NTM Pitch Deck" summary columns — scan ALL rows in case the
  // labels live in a different row than the month labels (merged cells, multi-row headers).
  let pitchCol: number | null = null;
  let projCol: number | null = null;
  let pitchHeaderRaw = "";
  let projHeaderRaw = "";
  for (const row of rows) {
    for (let c = 0; c < row.length; c++) {
      const raw = row[c] || "";
      const cell = raw.toLowerCase().replace(/\s+/g, " ").trim();
      if (pitchCol === null && (cell.includes("pitch deck") || cell.includes("ntm pitch"))) {
        pitchCol = c;
        pitchHeaderRaw = raw;
      }
      if (projCol === null && cell.includes("ntm projected")) {
        projCol = c;
        projHeaderRaw = raw;
      }
    }
  }
  console.log("[parseSheet] columns located:", {
    pitchDeck: { col: pitchCol, header: pitchHeaderRaw },
    ntmProjected: { col: projCol, header: projHeaderRaw },
  });
  console.log("[parseSheet] cost rows located:", {
    overheadRow: !!overheadRow,
    corpDevRow: !!corpDevRow,
    projDevRow: !!projDevRow,
    totalRow: !!totalRow,
  });

  const readCol = (col: number | null, label: string): PitchDeck | null => {
    if (col === null) {
      console.warn(`[parseSheet] ${label}: column not found in CSV`);
      return null;
    }
    const oh = toNum(overheadRow?.[col]);
    const cd = toNum(corpDevRow?.[col]);
    const pd = toNum(projDevRow?.[col]);
    const tot = toNum(totalRow?.[col]);
    console.log(`[parseSheet] ${label} (col ${col}):`, {
      overhead: oh, corpDev: cd, projDev: pd, total: tot,
      rawCells: {
        overhead: overheadRow?.[col],
        corpDev: corpDevRow?.[col],
        projDev: projDevRow?.[col],
        total: totalRow?.[col],
      },
    });
    if (!oh && !cd && !pd && !tot) return null;
    return { overhead: oh, corpDev: cd, projDev: pd, total: tot };
  };
  const pitchDeck = readCol(pitchCol, "Pitch Deck");
  const ntmProj = readCol(projCol, "NTM Projected");

  // Capture every populated row as a line item so we can rank top expenses.
  // Track the most recent category-header row so each line item knows its bucket
  // (Corp Overhead / Corp Dev / Proj Dev). Month keys are normalized the same way
  // MonthData.month is, so they line up later.
  const lineItems: LineItem[] = [];
  let currentBucket: string | null = null;
  for (const row of rows) {
    let label = "";
    for (let c = 0; c < Math.min(row.length, 5); c++) {
      const cell = (row[c] || "").trim();
      if (cell) { label = cell; break; }
    }
    if (!label) continue;
    const sectionKey = label.toLowerCase().trim();
    if (sectionKey in SECTION_BUCKETS) {
      currentBucket = SECTION_BUCKETS[sectionKey];
      // section header row itself is excluded later via SUMMARY_ROW_LABELS
    }
    if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s*[''`']?\s*\d{2,4}/i.test(label)) continue;
    if (label.toLowerCase().startsWith("ntm")) continue;
    const monthly: Record<string, number> = {};
    let hasValue = false;
    for (const mc of monthCols) {
      const v = toNum(row[mc.col]);
      if (v !== 0) hasValue = true;
      monthly[mc.label.replace(/[''`]/g, "'").replace(/\s+/g, " ").trim()] = v;
    }
    if (!hasValue) continue;
    lineItems.push({ label, monthly, bucket: currentBucket });
  }

  return { months: months.filter(m => m.total > 0), reviewLabel, pitchDeck, ntmProj, lineItems };
}

// ══════════════════════════════════════════════
// FORMATTING & COLORS
// ══════════════════════════════════════════════
const fmt = (v: number | null | undefined): string => {
  if (v === null || v === undefined || v === 0) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000000) return `$${(v / 1000000).toFixed(1)}M`;
  if (abs >= 1000) return `$${(v / 1000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};
const fmtFull = (v: number): string => `$${Math.round(v).toLocaleString()}`;
const fmtLabel = (v: number): string => {
  if (!v) return "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(v / 1_000)}k`;
  return `$${Math.round(v)}`;
};
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMonth = (s: string): string => {
  const d = parseMonthLabel(s);
  if (!d) return s;
  return `${MONTHS_SHORT[d.getMonth()]} '${String(d.getFullYear()).slice(2)}`;
};

const C = {
  bg: "#0c0f14", card: "#141820", border: "#1e2430",
  text: "#e8eaed", muted: "#7a8194",
  blue: "#4fc3f7", purple: "#ab47bc", green: "#66bb6a",
  red: "#ef5350", orange: "#ffa726", yellow: "#ffee58",
  gold: "#d4a574",
};

// ══════════════════════════════════════════════
// SUB-COMPONENTS
// ══════════════════════════════════════════════
/* eslint-disable @typescript-eslint/no-explicit-any */
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  // Hide the split helper series used to render solid/dashed cumulative line segments —
  // the underlying "Cumulative" Area carries the value and stays in the tooltip.
  const HIDDEN_KEYS = new Set(["cumActual", "cumProj"]);
  // Surface plan/baseline rows first (any dataKey containing "plan") so they read above
  // the projected/actual rows in tooltips.
  const isPlan = (k: string) => typeof k === "string" && k.toLowerCase().includes("plan");
  const sorted = [...payload]
    .filter((p: any) => !HIDDEN_KEYS.has(p.dataKey))
    .sort((a, b) => Number(isPlan(b.dataKey)) - Number(isPlan(a.dataKey)));
  return (
    <div style={{ background: "#1a1f2e", border: "1px solid #2a3040", borderRadius: 10, padding: "18px 22px", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
      <p style={{ color: C.text, fontWeight: 700, marginBottom: 12, fontSize: 20 }}>{label}</p>
      {sorted.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color, fontSize: 17, margin: "6px 0", fontFamily: "monospace" }}>{p.name}: {p.dataKey === "headcount" || p.dataKey === "fte" ? p.value : fmtFull(p.value)}</p>
      ))}
    </div>
  );
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function KPI({ label, value, sub, color, good }: { label: string; value: string; sub?: string; color?: string; good?: boolean }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `1px solid ${C.blue}`, borderRadius: 12, padding: "22px 24px", flex: 1, minWidth: 190, textAlign: "center", boxShadow: `inset 0 1px 0 ${C.blue}33` }}>
      <div style={{ fontSize: 52, fontWeight: 700, color: color || C.text, fontFamily: "monospace", lineHeight: 1.05 }}>{value}</div>
      <div style={{ fontSize: 18, textTransform: "uppercase", letterSpacing: "0.1em", color: C.text, marginTop: 16, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 16, color: good === true ? C.green : good === false ? C.red : C.muted, marginTop: 8 }}>{sub}</div>}
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 32, fontWeight: 700, color: C.text, margin: "44px 0 20px", borderBottom: `1px solid ${C.border}`, paddingBottom: 14 }}>{children}</h2>;
}

// ══════════════════════════════════════════════
// PORTFOLIO TAB
// ══════════════════════════════════════════════
interface PortfolioSnapshot {
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

interface WaterfallBar {
  name: string;
  base: number;
  delta: number;
  signed: number;
  color: string;
  isPillar: boolean;
}

function buildWaterfall(rows: PortfolioSnapshot[]): { bars: WaterfallBar[]; nav: number } {
  const sorted = [...rows].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const nav = sorted.reduce((s, h) => s + h.marketValue, 0);
  const bars: WaterfallBar[] = [];
  let running = 0;
  for (const h of sorted) {
    bars.push({
      name: `${h.ticker} cost`,
      base: running,
      delta: h.costBasis,
      signed: h.costBasis,
      color: C.blue,
      isPillar: false,
    });
    running += h.costBasis;
    const pl = h.marketValue - h.costBasis;
    const next = running + pl;
    bars.push({
      name: `${h.ticker} P&L`,
      base: Math.min(running, next),
      delta: Math.abs(pl),
      signed: pl,
      color: pl >= 0 ? C.green : C.red,
      isPillar: false,
    });
    running = next;
  }
  bars.push({ name: "Total NAV", base: 0, delta: nav, signed: nav, color: C.purple, isPillar: true });
  return { bars, nav };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const WaterfallTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const bar: WaterfallBar = payload[0].payload;
  const sign = bar.signed >= 0 ? "+" : "−";
  return (
    <div style={{ background: "#1a1f2e", border: "1px solid #2a3040", borderRadius: 10, padding: "14px 18px", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 18, marginBottom: 8 }}>{bar.name}</div>
      <div style={{ color: bar.color, fontSize: 16, fontFamily: "monospace" }}>
        {bar.isPillar ? fmt(bar.signed) : `${sign}${fmt(Math.abs(bar.signed))}`}
      </div>
    </div>
  );
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ══════════════════════════════════════════════
// PROJECTED SPEND TAB
// ══════════════════════════════════════════════
const SPEND_NAVY = "#1e3a8a";
const SPEND_MSTR_GRAY = "#9ca3af";

interface SpendBarRow {
  name: string;
  // Invisible floor that floats the spend bars to their running cumulative position.
  base: number;
  opTreas: number;
  ibit: number;
  mstr: number;
  // Drop magnitude (positive); rendered as a floating red bar from `base` to `base + spend`.
  spend: number;
  // Display total: bopTotal/eopTotal on the stacked endpoints, negative drop on spend rows.
  total: number;
  // Per-bar breakdown stash for the tooltip (operating cash and treasury split out).
  operating: number;
  treasury: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const SpendTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null;
  const row: SpendBarRow = payload[0].payload;
  const lines: { label: string; val: number; color: string }[] = [];
  if (row.operating) lines.push({ label: "Operating Cash", val: row.operating, color: SPEND_NAVY });
  if (row.treasury) lines.push({ label: "Treasury Ladder", val: row.treasury, color: SPEND_NAVY });
  if (row.ibit) lines.push({ label: "Bitcoin ETF", val: row.ibit, color: C.orange });
  if (row.mstr) lines.push({ label: "MSTR", val: row.mstr, color: SPEND_MSTR_GRAY });
  if (row.spend) lines.push({ label: row.name, val: -row.spend, color: C.red });
  return (
    <div style={{ background: "#1a1f2e", border: "1px solid #2a3040", borderRadius: 10, padding: "14px 18px", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
      <div style={{ color: C.text, fontWeight: 700, fontSize: 17, marginBottom: 8 }}>{row.name}</div>
      {lines.map((l, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 18, fontSize: 15, color: l.color, fontFamily: "monospace" }}>
          <span>{l.label}</span>
          <span>{l.val < 0 ? `(${fmt(Math.abs(l.val))})` : fmt(l.val)}</span>
        </div>
      ))}
      <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 8, paddingTop: 6, display: "flex", justifyContent: "space-between", gap: 18, fontSize: 16, color: C.text, fontWeight: 700, fontFamily: "monospace" }}>
        <span>Total</span>
        <span>{row.total < 0 ? `(${fmt(Math.abs(row.total))})` : fmt(row.total)}</span>
      </div>
    </div>
  );
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function ProjectedSpendTab({ months }: { months: MonthData[] }) {
  const [operatingCash, setOperatingCash] = useState(0);
  const [ibitValue, setIbitValue] = useState(0);
  const [mstrValue, setMstrValue] = useState(0);
  const [treasuryValue, setTreasuryValue] = useState(0);
  const [latestPortfolioDate, setLatestPortfolioDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const [opRes, snapRes] = await Promise.all([
          fetch(OPERATING_CASH_CSV_URL),
          fetch("/api/portfolio/snapshots", { cache: "no-store" }),
        ]);

        if (opRes.ok) {
          const csv = await opRes.text();
          const opRows = parseCSV(csv);
          // Cell F11 = column F (index 5), row 11 (index 10). Accepts magnitude suffixes
          // (e.g. "$1.88mm" → 1,880,000) for hand-typed values.
          const rawF11 = opRows[10]?.[5] ?? "";
          setOperatingCash(toNumWithSuffix(rawF11));
        }

        if (snapRes.ok) {
          const data = await snapRes.json();
          const snaps: PortfolioSnapshot[] = data.snapshots || [];
          const dates = Array.from(new Set(snaps.map((s) => s.statementDate))).sort();
          const latest = dates[dates.length - 1] || "";
          setLatestPortfolioDate(latest);
          const latestSnaps = snaps.filter((s) => s.statementDate === latest);
          const sumTickers = (...ts: string[]) => {
            const set = new Set(ts.map((t) => t.toUpperCase()));
            return latestSnaps.filter((s) => set.has(s.ticker.toUpperCase())).reduce((sum, s) => sum + s.marketValue, 0);
          };
          // Bitcoin ETF exposure — either IBIT (iShares) or MSBT (Morgan Stanley) counts.
          setIbitValue(sumTickers("IBIT", "MSBT"));
          setMstrValue(sumTickers("MSTR"));
          setTreasuryValue(sumTickers("TREASURY"));
        }
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const ntm = useMemo(() => months.filter((m) => !m.actual).slice(0, 12), [months]);
  const overhead = ntm.reduce((s, m) => s + m.overhead, 0);
  const corpDev = ntm.reduce((s, m) => s + m.corpDev, 0);
  const projDev = ntm.reduce((s, m) => s + m.projDev, 0);
  const totalSpend = overhead + corpDev + projDev;

  const bopOpTreas = operatingCash + treasuryValue;
  const eopOpTreas = bopOpTreas - totalSpend;
  const bopTotal = bopOpTreas + ibitValue + mstrValue;
  const eopTotal = eopOpTreas + ibitValue + mstrValue;

  // Running cumulative at each waterfall step — used both for the floating spend bars (their `base`)
  // and for the dashed connector heights between adjacent bars.
  const cumAfterOH = bopTotal - overhead;
  const cumAfterCD = cumAfterOH - corpDev;
  const cumAfterPD = cumAfterCD - projDev; // == eopTotal

  const chartData: SpendBarRow[] = [
    { name: "BOP Total Cash", base: 0, operating: operatingCash, treasury: treasuryValue, opTreas: bopOpTreas, ibit: ibitValue, mstr: mstrValue, spend: 0, total: bopTotal },
    { name: "Corporate Overhead", base: cumAfterOH, operating: 0, treasury: 0, opTreas: 0, ibit: 0, mstr: 0, spend: overhead, total: -overhead },
    { name: "Corporate Development", base: cumAfterCD, operating: 0, treasury: 0, opTreas: 0, ibit: 0, mstr: 0, spend: corpDev, total: -corpDev },
    { name: "Project Development", base: cumAfterPD, operating: 0, treasury: 0, opTreas: 0, ibit: 0, mstr: 0, spend: projDev, total: -projDev },
    { name: "EOP Total Cash", base: 0, operating: eopOpTreas - treasuryValue, treasury: treasuryValue, opTreas: eopOpTreas, ibit: ibitValue, mstr: mstrValue, spend: 0, total: eopTotal },
  ];

  // Heights (in chart units) of the dashed connectors between adjacent bars.
  const connectorJoins = [bopTotal, cumAfterOH, cumAfterCD, cumAfterPD];

  const ntmRange = ntm.length === 12 ? `${ntm[0].month} – ${ntm[11].month}` : "";

  return (
    <>
      <Section>Projected Spend — Next 12 Months</Section>

      {loading && <div style={{ color: C.muted, marginTop: 24 }}>Loading…</div>}
      {err && <div style={{ color: C.red, marginTop: 24 }}>{err}</div>}

      {!loading && (
        <>
          <div style={{ display: "flex", gap: 14, marginBottom: 18, flexWrap: "wrap" }}>
            <KPI label="BOP Total" value={fmt(bopTotal)} sub={ntmRange ? `Start: ${ntm[0]?.month ?? ""}` : undefined} />
            <KPI label="NTM Spend" value={fmt(totalSpend)} color={C.red} />
            <KPI label="EOP Total" value={fmt(eopTotal)} sub={ntmRange ? `End: ${ntm[11]?.month ?? ""}` : undefined} />
          </div>

          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(60vh, 720px)", minHeight: 460 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 24, right: 30, left: 10, bottom: 20 }}>
                <XAxis dataKey="name" tick={{ fill: C.text, fontSize: 16 }} axisLine={{ stroke: "#1e2430" }} interval={0} />
                <YAxis tick={{ fill: C.muted, fontSize: 15, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<SpendTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Legend
                  wrapperStyle={{ fontSize: 18 }}
                  content={() => (
                    <ul style={{ display: "flex", justifyContent: "center", gap: 28, listStyle: "none", padding: 0, margin: "12px 0 0", flexWrap: "wrap" }}>
                      {[
                        { label: "Operating + Treasury", color: SPEND_NAVY },
                        { label: "Bitcoin ETF", color: C.orange },
                        { label: "MSTR", color: SPEND_MSTR_GRAY },
                        { label: "Spending", color: C.red },
                      ].map((k, i) => (
                        <li key={i} style={{ display: "flex", alignItems: "center", gap: 10, color: k.color, fontSize: 16 }}>
                          <span style={{ display: "inline-block", width: 14, height: 14, background: k.color, borderRadius: 3 }} />
                          {k.label}
                        </li>
                      ))}
                    </ul>
                  )}
                />
                {/* Invisible spacer that floats the spend bars to their cumulative position. */}
                <Bar dataKey="base" stackId="a" fill="transparent" isAnimationActive={false} />
                <Bar dataKey="opTreas" stackId="a" fill={SPEND_NAVY} />
                <Bar dataKey="ibit" stackId="a" fill={C.orange} />
                <Bar dataKey="mstr" stackId="a" fill={SPEND_MSTR_GRAY} radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="total" position="top" formatter={(v) => { const n = Number(v); return n > 0 ? fmt(n) : ""; }} fill={C.text} fontSize={16} fontWeight={700} />
                </Bar>
                <Bar dataKey="spend" stackId="a" fill={C.red} radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="total" position="top" formatter={(v) => { const n = Number(v); return n < 0 ? `(${fmt(Math.abs(n))})` : ""; }} fill={C.red} fontSize={16} fontWeight={700} />
                </Bar>
                {/* Dashed connectors at each cumulative running total, drawn between adjacent bar tops. */}
                <Customized component={(p: any) => {
                  const xAxis = p?.xAxisMap ? (Object.values(p.xAxisMap)[0] as any) : null;
                  const yAxis = p?.yAxisMap ? (Object.values(p.yAxisMap)[0] as any) : null;
                  if (!xAxis?.scale || !yAxis?.scale) return null;
                  const bw = xAxis.scale.bandwidth?.() ?? 0;
                  return (
                    <g>
                      {connectorJoins.map((y, i) => {
                        const xFromBase = xAxis.scale(chartData[i].name);
                        const xToBase = xAxis.scale(chartData[i + 1].name);
                        if (xFromBase === undefined || xToBase === undefined) return null;
                        const yPx = yAxis.scale(y);
                        return (
                          <line
                            key={i}
                            x1={xFromBase + bw * 0.85}
                            y1={yPx}
                            x2={xToBase + bw * 0.15}
                            y2={yPx}
                            stroke={C.muted}
                            strokeWidth={1.5}
                            strokeDasharray="6 4"
                          />
                        );
                      })}
                    </g>
                  );
                }} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Breakdown table */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", marginTop: 20 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 16 }}>
              <tbody>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 8px", color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 13 }}>BOP Total Cash</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", color: C.text, fontFamily: "monospace", fontWeight: 700 }}>{fmt(bopTotal)}</td>
                  <td style={{ padding: "10px 8px", color: C.muted, fontSize: 14, textAlign: "right", whiteSpace: "nowrap" }}>
                    Operating {fmt(operatingCash)} · Treasury {fmt(treasuryValue)} · Bitcoin ETF {fmt(ibitValue)} · MSTR {fmt(mstrValue)}
                  </td>
                </tr>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 8px", color: C.red }}>Corporate Overhead</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", color: C.red, fontFamily: "monospace", fontWeight: 600 }}>({fmt(overhead)})</td>
                  <td />
                </tr>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 8px", color: C.red }}>Corporate Development</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", color: C.red, fontFamily: "monospace", fontWeight: 600 }}>({fmt(corpDev)})</td>
                  <td />
                </tr>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={{ padding: "10px 8px", color: C.red }}>Project Development</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", color: C.red, fontFamily: "monospace", fontWeight: 600 }}>({fmt(projDev)})</td>
                  <td />
                </tr>
                <tr>
                  <td style={{ padding: "10px 8px", color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 13 }}>EOP Total Cash</td>
                  <td style={{ padding: "10px 8px", textAlign: "right", color: C.text, fontFamily: "monospace", fontWeight: 700 }}>{fmt(eopTotal)}</td>
                  <td style={{ padding: "10px 8px", color: C.muted, fontSize: 14, textAlign: "right", whiteSpace: "nowrap" }}>
                    Operating + Treasury {fmt(eopOpTreas)} · Bitcoin ETF {fmt(ibitValue)} · MSTR {fmt(mstrValue)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16, fontSize: 14, color: C.muted, fontStyle: "italic" }}>
            Assumes 0% Bitcoin ETF and MSTR value appreciation.
            {latestPortfolioDate && ` Investment values from portfolio snapshot dated ${latestPortfolioDate}.`}
            {treasuryValue === 0 && " Treasury value will appear here after the next portfolio statement upload."}
          </div>
        </>
      )}
    </>
  );
}

// ══════════════════════════════════════════════
// ACQUISITIONS CLOSED TAB
// ══════════════════════════════════════════════
interface ClosedAcquisitionRow {
  dealName: string;
  acreage: number;
  closingDate: string;
  lineItem: string;
  amount: number;
  notes: string;
}

interface ClosedDeal {
  dealName: string;
  acreage: number;
  closingDate: string;
  notes: string;
  lineItems: { lineItem: string; amount: number }[];
  allIn: number;
  perAcre: number;
}

function parseClosingDate(s: string): number {
  if (!s) return Number.POSITIVE_INFINITY;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3]);
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s);
  if (us) {
    const y = +us[3];
    return Date.UTC(y < 100 ? 2000 + y : y, +us[1] - 1, +us[2]);
  }
  return Number.POSITIVE_INFINITY;
}

function groupClosedDeals(rows: ClosedAcquisitionRow[]): ClosedDeal[] {
  const groups = new Map<string, ClosedDeal>();
  for (const r of rows) {
    let g = groups.get(r.dealName);
    if (!g) {
      g = { dealName: r.dealName, acreage: 0, closingDate: "", notes: "", lineItems: [], allIn: 0, perAcre: 0 };
      groups.set(r.dealName, g);
    }
    if (!g.acreage && r.acreage) g.acreage = r.acreage;
    if (!g.closingDate && r.closingDate) g.closingDate = r.closingDate;
    if (!g.notes && r.notes) g.notes = r.notes;
    g.lineItems.push({ lineItem: r.lineItem || "—", amount: r.amount });
    g.allIn += r.amount;
  }
  for (const g of groups.values()) {
    g.perAcre = g.acreage > 0 ? g.allIn / g.acreage : 0;
  }
  return Array.from(groups.values());
}

function fmtSignedParens(v: number): string {
  const abs = Math.abs(Math.round(v));
  const formatted = `$${abs.toLocaleString()}`;
  return v < 0 ? `(${formatted})` : formatted;
}

const CLOSED_CARD_BG = "#10192a";
const CLOSED_CARD_BORDER = "#1d2b44";

function AcquisitionsClosedTab() {
  const [rows, setRows] = useState<ClosedAcquisitionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await fetch("/api/closed-acquisitions/list", { cache: "no-store" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        setRows(data.rows || []);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const deals = useMemo(
    () =>
      groupClosedDeals(rows).sort(
        (a, b) => parseClosingDate(a.closingDate) - parseClosingDate(b.closingDate),
      ),
    [rows],
  );

  return (
    <>
      <Section>Acquisitions Closed</Section>

      {loading && <div style={{ color: C.muted, marginTop: 24 }}>Loading…</div>}
      {err && <div style={{ color: C.red, marginTop: 24 }}>{err}</div>}

      {!loading && !err && deals.length === 0 && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "32px 28px", marginTop: 24, color: C.muted, fontSize: 16 }}>
          No closed acquisitions yet. Add rows to the &quot;Closed Acquisitions&quot; tab in the linked Google Sheet to populate this view.
        </div>
      )}

      {deals.length > 0 && (() => {
        const totalAcres = deals.reduce((s, d) => s + d.acreage, 0);
        const totalAllIn = deals.reduce((s, d) => s + d.allIn, 0);
        const blendedPerAcre = totalAcres > 0 ? totalAllIn / totalAcres : 0;
        return (
          <>
            <div style={{ display: "flex", gap: 14, marginBottom: 24, flexWrap: "wrap" }}>
              <KPI
                label="Total Acres"
                value={totalAcres.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                sub={`${deals.length} deal${deals.length === 1 ? "" : "s"}`}
              />
              <KPI label="Total All-In" value={fmtFull(totalAllIn)} />
              <KPI label="All-In / Acre" value={fmtFull(blendedPerAcre)} color={C.blue} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(420px, 1fr))", gap: 20 }}>
              {deals.map((deal, i) => (
            <div key={i} style={{ background: CLOSED_CARD_BG, border: `1px solid ${CLOSED_CARD_BORDER}`, borderRadius: 14, padding: "26px 28px", display: "flex", flexDirection: "column", gap: 18 }}>
              {/* Header */}
              <div>
                <div style={{ fontSize: 30, fontWeight: 700, color: C.text, lineHeight: 1.15 }}>{deal.dealName}</div>
                <div style={{ marginTop: 6, fontSize: 15, color: C.muted, display: "flex", gap: 14, flexWrap: "wrap" }}>
                  {deal.acreage > 0 && <span>{deal.acreage.toLocaleString(undefined, { maximumFractionDigits: 2 })} acres</span>}
                  {deal.closingDate && <span>Closed {deal.closingDate}</span>}
                </div>
              </div>

              {/* Headline + per-acre */}
              <div>
                <div style={{ fontSize: 13, textTransform: "uppercase", letterSpacing: "0.08em", color: C.muted, fontWeight: 600 }}>All-In Cost</div>
                <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "monospace", color: C.text, marginTop: 4, lineHeight: 1.1 }}>{fmtFull(deal.allIn)}</div>
                {deal.acreage > 0 && (
                  <div style={{ fontSize: 17, color: C.blue, fontFamily: "monospace", marginTop: 4 }}>
                    {fmtFull(deal.perAcre)} / acre
                  </div>
                )}
              </div>

              {/* Divider */}
              <div style={{ height: 1, background: CLOSED_CARD_BORDER }} />

              {/* Line items */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {deal.lineItems.map((li, j) => {
                  const negative = li.amount < 0;
                  return (
                    <div key={j} style={{ display: "flex", justifyContent: "space-between", gap: 16, fontSize: 16 }}>
                      <span style={{ color: negative ? C.gold : C.text }}>{li.lineItem}</span>
                      <span style={{ color: negative ? C.gold : C.text, fontFamily: "monospace", fontWeight: 600, whiteSpace: "nowrap" }}>
                        {fmtSignedParens(li.amount)}
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Notes */}
              {deal.notes && (
                <div style={{ marginTop: 4, paddingTop: 14, borderTop: `1px solid ${CLOSED_CARD_BORDER}`, fontSize: 14, color: C.muted, fontStyle: "italic", lineHeight: 1.5 }}>
                  {deal.notes}
                </div>
              )}
            </div>
          ))}
            </div>
          </>
        );
      })()}
    </>
  );
}

function PortfolioTab() {
  const [snapshots, setSnapshots] = useState<PortfolioSnapshot[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/portfolio/snapshots", { cache: "no-store" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const rows: PortfolioSnapshot[] = data.snapshots || [];
      setSnapshots(rows);
      const dates = Array.from(new Set(rows.map(r => r.statementDate))).sort();
      if (dates.length > 0 && !selectedDate) setSelectedDate(dates[dates.length - 1]);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  useEffect(() => { load(); }, [load]);

  const dates = useMemo(
    () => Array.from(new Set(snapshots.map(s => s.statementDate))).sort(),
    [snapshots],
  );
  const activeDate = selectedDate || dates[dates.length - 1] || "";
  const currentRows = useMemo(
    () => snapshots.filter(s => s.statementDate === activeDate),
    [snapshots, activeDate],
  );
  const { bars, nav } = useMemo(() => buildWaterfall(currentRows), [currentRows]);
  const totalCost = currentRows.reduce((s, h) => s + h.costBasis, 0);
  const totalPL = nav - totalCost;

  async function handleUpload(file: File) {
    setUploading(true);
    setUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/portfolio/upload", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const removed = body.sheet?.removed ?? 0;
      const appended = body.sheet?.appended ?? 0;
      setUploadMsg(
        `Saved ${appended} holdings for ${body.statementDate} (NAV ${fmtFull(body.nav)})${
          removed > 0 ? ` — replaced ${removed} prior row${removed === 1 ? "" : "s"}` : ""
        }.`,
      );
      setSelectedDate(body.statementDate);
      await load();
    } catch (e) {
      setUploadMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <Section>Investment Portfolio</Section>

      {/* Upload control */}
      <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 12, cursor: uploading ? "wait" : "pointer", background: uploading ? C.border : C.blue, color: C.bg, padding: "10px 22px", borderRadius: 8, fontWeight: 600, fontSize: 16 }}>
          {uploading ? "Parsing…" : "Upload J.P. Morgan statement"}
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={uploading}
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleUpload(f);
              e.target.value = "";
            }}
          />
        </label>
        {dates.length > 0 && (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 10, color: C.muted, fontSize: 15 }}>
            Statement date:
            <select
              value={activeDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              style={{ background: C.bg, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, padding: "6px 10px", fontSize: 15, fontFamily: "monospace" }}
            >
              {dates.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </label>
        )}
        {uploadMsg && (
          <span style={{ color: uploadMsg.startsWith("Error") ? C.red : C.green, fontSize: 15 }}>{uploadMsg}</span>
        )}
      </div>

      {loading && <div style={{ color: C.muted, marginTop: 24 }}>Loading snapshots…</div>}
      {err && <div style={{ color: C.red, marginTop: 24 }}>{err}</div>}

      {!loading && !err && currentRows.length === 0 && (
        <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "32px 28px", marginTop: 24, color: C.muted, fontSize: 16 }}>
          No portfolio snapshots yet. Upload a statement PDF above to create the first one.
        </div>
      )}

      {currentRows.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 14, marginTop: 18, flexWrap: "wrap" }}>
            <KPI label="NAV" value={fmt(nav)} sub={activeDate} />
            <KPI label="Cost Basis" value={fmt(totalCost)} />
            <KPI label="Unrealized G/L" value={fmt(totalPL)} color={totalPL >= 0 ? C.green : C.red} />
          </div>

          <Section>Cost → Market Value Bridge</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(60vh, 720px)", minHeight: 420 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars} margin={{ top: 48, right: 30, left: 10, bottom: 30 }}>
                <CartesianGrid stroke="#1e2430" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: C.text, fontSize: 16 }} axisLine={{ stroke: "#1e2430" }} angle={-25} textAnchor="end" height={70} interval={0} />
                <YAxis tick={{ fill: C.muted, fontSize: 15, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<WaterfallTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
                <Bar dataKey="delta" stackId="w" isAnimationActive={false}>
                  {bars.map((b, i) => <Cell key={i} fill={b.color} />)}
                  <LabelList
                    dataKey="signed"
                    position="top"
                    formatter={(v) => (typeof v === "number" ? fmtLabel(v) : "")}
                    fill={C.text}
                    fontSize={22}
                    fontWeight={700}
                    fontFamily="monospace"
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <Section>Holdings</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "16px 24px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 17 }}>
              <thead>
                <tr style={{ color: C.muted, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>
                  <th style={{ padding: "10px 8px" }}>Ticker</th>
                  <th style={{ padding: "10px 8px" }}>Description</th>
                  <th style={{ padding: "10px 8px" }}>Account</th>
                  <th style={{ padding: "10px 8px", textAlign: "right" }}>Shares</th>
                  <th style={{ padding: "10px 8px", textAlign: "right" }}>Cost</th>
                  <th style={{ padding: "10px 8px", textAlign: "right" }}>Market Value</th>
                  <th style={{ padding: "10px 8px", textAlign: "right" }}>Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {[...currentRows].sort((a, b) => b.marketValue - a.marketValue).map((h, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, fontFamily: "monospace" }}>
                    <td style={{ padding: "10px 8px", fontWeight: 700, color: C.text }}>{h.ticker}</td>
                    <td style={{ padding: "10px 8px", color: C.muted, fontFamily: "inherit" }}>{h.description}</td>
                    <td style={{ padding: "10px 8px", color: C.muted, fontFamily: "inherit" }}>{h.accountName}</td>
                    <td style={{ padding: "10px 8px", textAlign: "right", color: C.text }}>{h.shares.toLocaleString()}</td>
                    <td style={{ padding: "10px 8px", textAlign: "right", color: C.text }}>{fmt(h.costBasis)}</td>
                    <td style={{ padding: "10px 8px", textAlign: "right", color: C.text }}>{fmt(h.marketValue)}</td>
                    <td style={{ padding: "10px 8px", textAlign: "right", color: h.unrealized >= 0 ? C.green : C.red }}>
                      {h.unrealized >= 0 ? "+" : "−"}{fmt(Math.abs(h.unrealized))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

// ══════════════════════════════════════════════
// MAIN DASHBOARD
// ══════════════════════════════════════════════
export default function Dashboard() {
  const [tab, setTab] = useState("overview");
  const [months, setMonths] = useState<MonthData[]>([]);
  const [reviewLabel, setReviewLabel] = useState("");
  const [pitchDeck, setPitchDeck] = useState<PitchDeck | null>(null);
  const [ntmProj, setNtmProj] = useState<PitchDeck | null>(null);
  const [planMonths, setPlanMonths] = useState<PlanMonth[]>([]);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [landTxns, setLandTxns] = useState<LandTxn[]>([]);
  const [landUploading, setLandUploading] = useState(false);
  const [landUploadMsg, setLandUploadMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const loadLand = useCallback(async () => {
    try {
      const res = await fetch("/api/land-acquisitions/list", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setLandTxns(data.transactions || []);
    } catch (e) {
      console.error("[land/list]", e);
    }
  }, []);

  const handleLandUpload = useCallback(async (file: File) => {
    setLandUploading(true);
    setLandUploadMsg(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/land-acquisitions/upload", { method: "POST", body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      await loadLand();
    } catch (e) {
      setLandUploadMsg(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLandUploading(false);
    }
  }, [loadLand]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [actualsRes, planRes] = await Promise.all([
        fetch(SHEET_CSV_URL),
        fetch(PLAN_CSV_URL),
      ]);
      if (!actualsRes.ok) throw new Error(`HTTP ${actualsRes.status} (actuals)`);
      if (!planRes.ok) throw new Error(`HTTP ${planRes.status} (plan)`);
      const [actualsText, planText] = await Promise.all([actualsRes.text(), planRes.text()]);
      const parsed = parseSheet(actualsText);
      const planParsed = parsePlanSheet(planText);
      setMonths(parsed.months);
      setReviewLabel(parsed.reviewLabel);
      setPitchDeck(parsed.pitchDeck);
      setNtmProj(parsed.ntmProj);
      setPlanMonths(planParsed.planMonths);
      setLineItems(parsed.lineItems);
      setErr(null);
    } catch (e: any) {
      console.error(e);
      setErr(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 5 * 60 * 1000); return () => clearInterval(iv); }, [load]);
  useEffect(() => { loadLand(); }, [loadLand]);

  // ── Derived data ──
  const actuals = months.filter(m => m.actual);
  const projected = months.filter(m => !m.actual);
  const itd = {
    overhead: actuals.reduce((s, m) => s + m.overhead, 0),
    corpDev: actuals.reduce((s, m) => s + m.corpDev, 0),
    projDev: actuals.reduce((s, m) => s + m.projDev, 0),
    total: actuals.reduce((s, m) => s + m.total, 0),
  };
  // Operations started July '25 — June '25 expenses are lumped into July, so the actuals
  // array has one extra month vs. real months of operation. Subtract one for plan scaling.
  const opsMonths = Math.max(actuals.length - 1, 0);
  const itdPlan = {
    overhead: (planMonths[0]?.overhead ?? 0) * opsMonths,
    corpDev: (planMonths[0]?.corpDev ?? 0) * opsMonths,
    projDev: (planMonths[0]?.projDev ?? 0) * opsMonths,
    total: (planMonths[0]?.total ?? 0) * opsMonths,
  };
  // ── Overview: next 12 projected months (after last actual) ──
  const overviewData = useMemo(() => {
    return months.filter(m => !m.actual).slice(0, 12);
  }, [months]);
  const ntmTotals = useMemo(() => ({
    overhead: overviewData.reduce((s, m) => s + m.overhead, 0),
    corpDev:  overviewData.reduce((s, m) => s + m.corpDev,  0),
    projDev:  overviewData.reduce((s, m) => s + m.projDev,  0),
    total:    overviewData.reduce((s, m) => s + m.total,    0),
  }), [overviewData]);
  const headcountData = useMemo(() =>
    overviewData.map(m => ({
      ...m,
      avgCost: m.headcount > 0 ? Math.round(m.payroll / m.headcount) : 0,
    })),
  [overviewData]);

  const cumData = useMemo(() => {
    // X axis is the NTM window (matches the bar chart above), but cumulative starts
    // from inception-to-date so April '26 = inception spend + April's spend.
    const inceptionTotal = months.filter(m => m.actual).reduce((s, m) => s + m.total, 0);
    let cum = inceptionTotal;
    return overviewData.map(d => {
      cum += d.total;
      return { ...d, cumulative: Math.round(cum) };
    });
  }, [overviewData, months]);

  // ── Next 2 months data ──
  const next2 = projected.slice(0, 2);

  // ── Cash Needs tab: apply live-as-of-today overrides (this tab only) ──
  const next2CN = next2.map((m) => {
    const o = CASH_NEEDS_OVERRIDES[m.month];
    if (!o) return m;
    const overhead = o.overheadSet !== undefined ? o.overheadSet : Math.max(0, m.overhead + (o.overheadDelta ?? 0));
    const corpDev  = o.corpDevSet  !== undefined ? o.corpDevSet  : Math.max(0, m.corpDev  + (o.corpDevDelta  ?? 0));
    const projDev  = o.projDevSet  !== undefined ? o.projDevSet  : Math.max(0, m.projDev  + (o.projDevDelta  ?? 0));
    return { ...m, overhead, corpDev, projDev, total: overhead + corpDev + projDev };
  });
  const cashNeedsLand = (monthLabel: string): LandTxn[] => {
    const excluded = CASH_NEEDS_OVERRIDES[monthLabel]?.excludeLandDeals ?? [];
    const raw = getLandForMonth(monthLabel, landTxns);
    if (excluded.length === 0) return raw;
    const lc = excluded.map((s) => s.toLowerCase());
    return raw.filter((t) => !lc.some((needle) => t.deal.toLowerCase().includes(needle)));
  };

  // ── Quarterly payroll data ──
  // Annualized & FTE are taken from the LAST month of each quarter (run-rate convention),
  // not averaged. Quarterly column stays as the sum of the months in the quarter.
  // Capped at the quarter containing the last NTM month so we don't show quarters past Mar '27.
  const quarterlyPayroll = useMemo(() => {
    const qMap: Record<string, {
      payroll: number;
      months: number;
      lastDate: Date | null;
      lastPayroll: number;
      lastHc: number;
    }> = {};
    for (const m of months) {
      const d = parseMonthLabel(m.month);
      if (!d) continue;
      const q = Math.floor(d.getMonth() / 3) + 1;
      const yr = d.getFullYear();
      const key = `Q${q} '${String(yr).slice(2)}`;
      if (!qMap[key]) qMap[key] = { payroll: 0, months: 0, lastDate: null, lastPayroll: 0, lastHc: 0 };
      const monthPayroll = m.payroll || m.overhead;
      qMap[key].payroll += monthPayroll;
      qMap[key].months++;
      if (!qMap[key].lastDate || d > qMap[key].lastDate) {
        qMap[key].lastDate = d;
        qMap[key].lastPayroll = monthPayroll;
        qMap[key].lastHc = m.headcount;
      }
    }
    const lastNtm = overviewData.length > 0 ? parseMonthLabel(overviewData[overviewData.length - 1].month) : null;
    return Object.entries(qMap)
      .filter(([, data]) => !lastNtm || (data.lastDate !== null && data.lastDate <= lastNtm))
      .map(([quarter, data]) => ({
        quarter,
        annualized: Math.round(data.lastPayroll * 12),
        quarterly: Math.round(data.payroll),
        fte: data.lastHc,
      }))
      .filter(q => q.quarter !== "Q2 '25");
  }, [months, overviewData]);

  // ── Payroll tab view: current quarter + next 3 (4 quarters total) ──
  const displayedQuarterlyPayroll = useMemo(() => {
    const now = new Date();
    const currentQ = Math.floor(now.getMonth() / 3) + 1;
    const currentYr = now.getFullYear();
    const currentKey = `Q${currentQ} '${String(currentYr).slice(2)}`;
    const startIdx = quarterlyPayroll.findIndex(q => q.quarter === currentKey);
    return startIdx >= 0 ? quarterlyPayroll.slice(startIdx, startIdx + 4) : quarterlyPayroll.slice(-4);
  }, [quarterlyPayroll]);

  // ── Next fully-projected quarter's annualized payroll ──
  const nextQuarterPayroll = useMemo(() => {
    const firstProjected = projected[0];
    if (!firstProjected) return null;
    const d = parseMonthLabel(firstProjected.month);
    if (!d) return null;
    const q = Math.floor(d.getMonth() / 3) + 1;
    const yr = d.getFullYear();
    const key = `Q${q} '${String(yr).slice(2)}`;
    return quarterlyPayroll.find(qp => qp.quarter === key) ?? null;
  }, [projected, quarterlyPayroll]);

  // ── Projected vs Plan monthly ──
  const projVsPlanData = useMemo(() => {
    const planMap = new Map<string, PlanMonth>();
    for (const p of planMonths) {
      const d = parseMonthLabel(p.month);
      if (d) planMap.set(`${d.getFullYear()}-${d.getMonth()}`, p);
    }
    let cumProjected = 0;
    let cumPlan = 0;
    return overviewData.map(m => {
      const d = parseMonthLabel(m.month);
      const key = d ? `${d.getFullYear()}-${d.getMonth()}` : "";
      const plan = planMap.get(key)?.total ?? 0;
      cumProjected += m.total;
      cumPlan += plan;
      return {
        month: m.month,
        projected: m.total,
        plan,
        cumProjected: Math.round(cumProjected),
        cumPlan: Math.round(cumPlan),
        variance: Math.round(plan - m.total),
      };
    });
  }, [overviewData, planMonths]);

  // ── Top 3 line-item expenses by NTM spend ──
  // Skips category rollup rows (Total Costs, Corp Overhead Costs, Corp Dev Costs, Project Dev Costs).
  // Captures monthly trend across the NTM window for the per-card sparkline.
  const topExpenses = useMemo(() => {
    if (overviewData.length === 0) return [];
    return lineItems
      .filter(li => !isExcludedLabel(li.label))
      .map(li => {
        const monthly = overviewData.map(m => li.monthly[m.month] || 0);
        const ntmTotal = monthly.reduce((s, v) => s + v, 0);
        return { label: li.label, bucket: li.bucket, ntmTotal, monthly };
      })
      .filter(v => v.ntmTotal > 0)
      .sort((a, b) => b.ntmTotal - a.ntmTotal)
      .slice(0, 3);
  }, [lineItems, overviewData]);

  // ── Fixed Expenses (NTM): Projected vs Initial Plan ──
  const fixedExpensesData = useMemo(() => {
    const planMap = new Map<string, PlanMonth>();
    for (const p of planMonths) {
      const d = parseMonthLabel(p.month);
      if (d) planMap.set(`${d.getFullYear()}-${d.getMonth()}`, p);
    }
    return overviewData.map(m => {
      const d = parseMonthLabel(m.month);
      const key = d ? `${d.getFullYear()}-${d.getMonth()}` : "";
      const plan = planMap.get(key)?.fixedExpenses ?? 0;
      const projected = MANUAL_FIXED_EXPENSES[m.month] ?? m.fixedExpenses;
      return {
        month: m.month,
        projected,
        plan,
      };
    });
  }, [overviewData, planMonths]);

  // ── Loading / Error ──
  if (loading) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: C.text }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 32, marginBottom: 16, animation: "spin 1s linear infinite" }}>⟳</div>
        <div style={{ fontSize: 14, color: C.muted }}>Loading from Google Sheets...</div>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );

  if (err || months.length === 0) return (
    <div style={{ background: C.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: C.text, padding: 40 }}>
      <div style={{ textAlign: "center", maxWidth: 500 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>⚠</div>
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>Unable to Load Data</div>
        <div style={{ fontSize: 14, color: C.muted, marginBottom: 20 }}>{err || "No data found"}</div>
        <button onClick={load} style={{ padding: "10px 24px", background: C.blue, color: C.bg, border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>Retry</button>
      </div>
    </div>
  );

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "costs", label: "Cost Breakdown" },
    { id: "variance", label: "ITD vs Plan" },
    { id: "headcount", label: "Headcount" },
    { id: "cashneeds", label: "Cash Needs" },
    { id: "payroll", label: "Payroll" },
    { id: "projvsplan", label: "Proj vs Plan" },
    { id: "fixed", label: "Fixed Expenses" },
    { id: "portfolio", label: "Investment Portfolio" },
    { id: "closed", label: "Acquisitions Closed" },
    { id: "projspend", label: "Projected Spend" },
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, padding: "24px 28px", fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* HEADER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tbc-logo.svg" alt="The Building Company" style={{ height: 40, width: "auto", display: "block", marginBottom: 14 }} />
          <div style={{ fontSize: 14, textTransform: "uppercase", letterSpacing: "0.12em", color: C.blue, marginBottom: 6, fontWeight: 600 }}>Financial Projections</div>
          <h1 style={{ fontSize: 44, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Finance Dashboard</h1>
          <div style={{ fontSize: 20, color: C.muted, marginTop: 10 }}>
            {tab !== "cashneeds" && <>Actuals through {reviewLabel}</>}
            <button onClick={load} style={{ marginLeft: tab !== "cashneeds" ? 16 : 0, background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontSize: 16 }}>↻ Refresh</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, padding: 3, flexWrap: "wrap" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "12px 20px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 18, fontWeight: 600,
              background: tab === t.id ? C.blue : "transparent", color: tab === t.id ? C.bg : C.muted,
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      {tab === "overview" && (
        <div style={{ display: "flex", gap: 14, marginBottom: 8, flexWrap: "wrap" }}>
          <KPI label="Spend Since Inception" value={fmt(itd.total)} />
          <KPI label="NTM Projected Spend" value={fmt(ntmTotals.total)} />
          <KPI label="Avg Monthly Burn (NTM)" value={fmt(ntmTotals.total / Math.max(overviewData.length, 1))} />
          <KPI label={`Annualized Payroll${nextQuarterPayroll ? ` (${nextQuarterPayroll.quarter})` : ""}`} value={nextQuarterPayroll ? fmt(nextQuarterPayroll.annualized) : "—"} />
        </div>
      )}

      {/* ═══════════ OVERVIEW ═══════════ */}
      {tab === "overview" && (
        <>
          <Section>NTM Spend Projections</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(50vh, 720px)", minHeight: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={overviewData} margin={{ top: 48, right: 20, left: 10, bottom: 0 }}>
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 20, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={90} />
                <YAxis tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend verticalAlign="top" wrapperStyle={{ fontSize: 20, paddingBottom: 12 }} />
                <Bar dataKey="overhead" name="Corp Overhead" stackId="a" fill={C.blue} />
                <Bar dataKey="corpDev" name="Corp Dev" stackId="a" fill={C.purple} />
                <Bar dataKey="projDev" name="Project Dev" stackId="a" fill={C.green} radius={[3, 3, 0, 0] as [number, number, number, number]}>
                  <LabelList dataKey="total" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.text, fontSize: 20, fontFamily: "monospace", fontWeight: 600 }} />
                </Bar>
                <Line type="monotone" dataKey="total" name="Total" stroke="#fff" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <Section>Cumulative Spend (Inception → NTM End)</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(40vh, 600px)", minHeight: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cumData} margin={{ top: 44, right: 20, left: 10, bottom: 0 }}>
                <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue} stopOpacity={0.3} /><stop offset="95%" stopColor={C.blue} stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 20, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={90} />
                <YAxis tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="cumulative" name="Cumulative" stroke={C.blue} strokeWidth={2} strokeDasharray="6 3" fill="url(#cg)">
                  <LabelList dataKey="cumulative" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.text, fontSize: 20, fontFamily: "monospace", fontWeight: 600 }} />
                </Area>
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* ═══════════ COST BREAKDOWN ═══════════ */}
      {tab === "costs" && (
        <>
          <Section>Cost Mix — NTM</Section>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, flex: "1 1 280px", minWidth: 280, height: "min(50vh, 600px)", minHeight: 380 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={[
                    { name: "Corp Overhead", value: ntmTotals.overhead, color: C.blue },
                    { name: "Corp Dev", value: ntmTotals.corpDev, color: C.purple },
                    { name: "Proj Dev", value: ntmTotals.projDev, color: C.green },
                  ]} cx="50%" cy="50%" innerRadius="48%" outerRadius="78%" paddingAngle={3} dataKey="value"
                    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
                    label={(props: any) => {
                      const { cx, cy, midAngle, outerRadius, name, percent, fill } = props;
                      const RADIAN = Math.PI / 180;
                      const r = outerRadius + 28;
                      const x = cx + r * Math.cos(-midAngle * RADIAN);
                      const y = cy + r * Math.sin(-midAngle * RADIAN);
                      return (
                        <text
                          x={x}
                          y={y}
                          fill={fill}
                          fontSize={28}
                          fontWeight={700}
                          textAnchor={x > cx ? "start" : "end"}
                          dominantBaseline="central"
                        >
                          {`${name ?? ""} ${((percent ?? 0) * 100).toFixed(0)}%`}
                        </text>
                      );
                    }}
                    labelLine={{ stroke: C.muted }}>
                    <Cell fill={C.blue} /><Cell fill={C.purple} /><Cell fill={C.green} />
                  </Pie>
                  <Tooltip
                    formatter={(v) => fmtFull(Number(v))}
                    contentStyle={{ background: "#1a1f2e", border: "1px solid #2a3040", borderRadius: 8, padding: "10px 14px" }}
                    labelStyle={{ color: C.text, fontSize: 16, fontWeight: 700, marginBottom: 4 }}
                    itemStyle={{ fontSize: 14, fontFamily: "monospace", padding: "2px 0" }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ flex: "1 1 340px", minWidth: 340, display: "flex", flexDirection: "column", gap: 16, height: "min(50vh, 600px)", minHeight: 380 }}>
              {([
                { label: "Corporate Overhead", val: ntmTotals.overhead, plan: planMonths.filter(p => overviewData.some(o => fmtMonth(o.month) === fmtMonth(p.month))).reduce((s, m) => s + m.overhead, 0) || PITCH_DECK_FALLBACK.overhead, color: C.blue, desc: "Payroll, insurance, travel, admin, office, recruiting" },
                { label: "Corporate Development", val: ntmTotals.corpDev, plan: planMonths.filter(p => overviewData.some(o => fmtMonth(o.month) === fmtMonth(p.month))).reduce((s, m) => s + m.corpDev, 0) || PITCH_DECK_FALLBACK.corpDev, color: C.purple, desc: "Legal (fundraise), design & branding, SEO" },
                { label: "Project Development", val: ntmTotals.projDev, plan: planMonths.filter(p => overviewData.some(o => fmtMonth(o.month) === fmtMonth(p.month))).reduce((s, m) => s + m.projDev, 0) || PITCH_DECK_FALLBACK.projDev, color: C.green, desc: "Engineering, architect, legal, DD, broker, land carry" },
              ]).map((item, i) => {
                const v = item.val - item.plan;
                return (
                  <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "28px 36px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                          <div style={{ width: 22, height: 22, borderRadius: 6, background: item.color }} />
                          <span style={{ fontWeight: 700, fontSize: 32 }}>{item.label}</span>
                        </div>
                        <div style={{ fontSize: 19, color: C.muted, marginTop: 10, marginLeft: 36 }}>{item.desc}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: 44, color: C.text }}>{fmt(item.val)}</div>
                        <div style={{ fontSize: 22, color: v <= 0 ? C.green : C.red, fontFamily: "monospace", fontWeight: 600, marginTop: 8 }}>
                          {v <= 0 ? "▼" : "▲"} {fmt(Math.abs(v))} vs plan
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {topExpenses.length > 0 && (
            <>
              <Section>Top 3 Expenses — NTM</Section>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {topExpenses.map((e, i) => {
                  const pct = ntmTotals.total > 0 ? (e.ntmTotal / ntmTotals.total) * 100 : 0;
                  const colors = [C.blue, C.orange, C.purple];
                  const color = colors[i] ?? C.blue;
                  const sparkData = e.monthly.map((v, j) => ({ month: overviewData[j]?.month || "", value: v }));
                  const gradId = `topExpGrad-${i}`;
                  return (
                    <div
                      key={e.label}
                      style={{
                        position: "relative",
                        background: C.card,
                        border: `1px solid ${C.border}`,
                        borderTop: `1px solid ${color}`,
                        borderRadius: 12,
                        padding: "20px 24px 16px",
                        flex: "1 1 240px",
                        minWidth: 240,
                        boxShadow: `inset 0 1px 0 ${color}33`,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <div style={{
                        position: "absolute",
                        top: -1,
                        right: 20,
                        background: color,
                        color: C.bg,
                        fontSize: 18,
                        fontWeight: 700,
                        padding: "8px 16px",
                        borderRadius: "0 0 8px 8px",
                      }}>
                        #{i + 1}
                      </div>
                      <div style={{ fontSize: 32, fontWeight: 700, color: C.text, marginBottom: 14, paddingRight: 56 }}>{e.label}</div>
                      {e.bucket && (
                        <div style={{
                          alignSelf: "flex-start",
                          fontSize: 16,
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          background: "rgba(255,255,255,0.05)",
                          border: `1px solid ${C.border}`,
                          borderRadius: 6,
                          padding: "6px 14px",
                          color: C.muted,
                          marginBottom: 18,
                          fontWeight: 600,
                        }}>
                          {e.bucket}
                        </div>
                      )}
                      <div style={{ fontSize: 48, fontWeight: 700, fontFamily: "monospace", color, lineHeight: 1.1 }}>{fmt(e.ntmTotal)}</div>
                      <div style={{ fontSize: 20, color: C.muted, marginTop: 10 }}>{pct.toFixed(1)}% of NTM spend</div>
                      <div style={{ marginTop: 14, marginLeft: -10, marginRight: -10, height: 64, overflow: "visible" }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={sparkData} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
                            <defs>
                              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                                <stop offset="100%" stopColor={color} stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} hide />
                            <YAxis hide domain={[0, "dataMax"]} />
                            <Tooltip
                              cursor={{ stroke: color, strokeWidth: 1, strokeDasharray: "3 3" }}
                              allowEscapeViewBox={{ x: false, y: true }}
                              wrapperStyle={{ outline: "none" }}
                              content={({ active, payload, label }) => {
                                if (!active || !payload?.length) return null;
                                const v = Number(payload[0].value);
                                return (
                                  <div style={{
                                    background: "#1a1f2e",
                                    border: "1px solid #2a3040",
                                    borderRadius: 6,
                                    padding: "8px 12px",
                                    fontFamily: "monospace",
                                    boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
                                  }}>
                                    <div style={{ color: C.muted, fontSize: 12, marginBottom: 3 }}>{fmtMonth(String(label))}</div>
                                    <div style={{ color, fontSize: 14, fontWeight: 600 }}>{fmtFull(v)}</div>
                                  </div>
                                );
                              }}
                            />
                            <Area
                              type="monotone"
                              dataKey="value"
                              stroke={color}
                              fill={`url(#${gradId})`}
                              strokeWidth={2}
                              activeDot={{ r: 4, fill: color, stroke: C.card, strokeWidth: 2 }}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* ═══════════ ITD VS PLAN ═══════════ */}
      {tab === "variance" && (
        <>
          <Section>ITD Actuals vs Plan</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(50vh, 720px)", minHeight: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[
                { name: "Corp Overhead", itdActual: itd.overhead, itdPlan: itdPlan.overhead },
                { name: "Corp Dev", itdActual: itd.corpDev, itdPlan: itdPlan.corpDev },
                { name: "Proj Dev", itdActual: itd.projDev, itdPlan: itdPlan.projDev },
              ]} margin={{ top: 10, right: 30, left: 10, bottom: 0 }} barCategoryGap="20%" barGap={6}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2430" />
                <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 20 }} axisLine={{ stroke: "#1e2430" }} />
                <YAxis tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 20 }} />
                <Bar dataKey="itdActual" name="ITD Actual" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} />
                <Bar dataKey="itdPlan" name="ITD Plan" fill="rgba(255,255,255,0.15)" radius={[4, 4, 0, 0] as [number, number, number, number]} stroke="rgba(255,255,255,0.3)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Section>Variance Detail</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 22 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Category", "ITD Actual", "ITD Plan", "Variance"].map((h, i) => (
                    <th key={i} style={{ padding: "22px 28px", textAlign: i === 0 ? "left" : "right", color: C.muted, fontWeight: 600, fontSize: 17, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  { n: "Corp Overhead", a: itd.overhead, p: itdPlan.overhead, b: false },
                  { n: "Corp Dev", a: itd.corpDev, p: itdPlan.corpDev, b: false },
                  { n: "Project Dev", a: itd.projDev, p: itdPlan.projDev, b: false },
                  { n: "TOTAL", a: itd.total, p: itdPlan.total, b: true },
                ]).map((r, i) => {
                  const v = r.p - r.a;
                  return (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}`, background: r.b ? "rgba(79,195,247,0.05)" : "transparent" }}>
                      <td style={{ padding: "22px 28px", fontWeight: r.b ? 700 : 500, fontSize: 22 }}>{r.n}</td>
                      <td style={{ padding: "22px 28px", textAlign: "right", fontFamily: "monospace", fontSize: 22 }}>{fmtFull(r.a)}</td>
                      <td style={{ padding: "22px 28px", textAlign: "right", fontFamily: "monospace", fontSize: 22, color: C.muted }}>{fmtFull(r.p)}</td>
                      <td style={{ padding: "22px 28px", textAlign: "right", fontFamily: "monospace", fontSize: 22, fontWeight: 700, color: v >= 0 ? C.green : C.red }}>{v >= 0 ? "+" : ""}{fmtFull(v)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ═══════════ HEADCOUNT ═══════════ */}
      {tab === "headcount" && (
        <>
          <Section>NTM Monthly Payroll Cost/Headcount</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(55vh, 720px)", minHeight: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={headcountData} margin={{ top: 56, right: 20, left: 10, bottom: 0 }}>
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 20, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={90} />
                <YAxis yAxisId="cost" tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} domain={[0, 30000]} />
                <YAxis yAxisId="hc" orientation="right" tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} axisLine={false} allowDecimals={false} domain={[0, 20]} />
                <Tooltip content={<ChartTooltip />} />
                <Legend verticalAlign="top" wrapperStyle={{ fontSize: 20, paddingBottom: 12 }} />
                <Bar yAxisId="cost" dataKey="avgCost" name="Avg Cost / Employee" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={60} opacity={0.7}>
                  <LabelList dataKey="avgCost" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.text, fontSize: 18, fontFamily: "monospace", fontWeight: 600 }} />
                </Bar>
                <Line yAxisId="hc" type="monotone" dataKey="headcount" name="Headcount" stroke={C.orange} strokeWidth={2} dot={{ fill: C.orange, r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* ═══════════ CASH NEEDS (NEW) ═══════════ */}
      {tab === "cashneeds" && (
        <>
          <Section>Next 2 Months — Projected Cash Needs</Section>

          {/* Land Acquisitions Upload */}
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", marginBottom: 24 }}>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 12, cursor: landUploading ? "wait" : "pointer", background: landUploading ? C.border : C.orange, color: C.bg, padding: "10px 22px", borderRadius: 8, fontWeight: 600, fontSize: 16 }}>
              {landUploading ? "Extracting…" : "Upload Land Acquisitions screenshot"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                disabled={landUploading}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleLandUpload(f);
                  e.target.value = "";
                }}
              />
            </label>
            {landTxns.length === 0 && (
              <span style={{ color: C.muted, fontSize: 15 }}>
                No data — upload a screenshot of the Cash Requirements table
              </span>
            )}
            {landUploadMsg && (
              <span style={{ color: landUploadMsg.startsWith("Error") ? C.red : C.green, fontSize: 15 }}>{landUploadMsg}</span>
            )}
          </div>

          <div style={{ color: C.muted, fontSize: 16, marginBottom: 10, fontStyle: "italic" }}>As of 7/17/26</div>

          {/* Cash Needs Cards */}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
            {next2CN.map((m, idx) => {
              const monthLand = cashNeedsLand(m.month);
              const landTotal = monthLand.reduce((s, t) => s + t.amount, 0);
              const totalCashNeed = m.total + landTotal;
              return (
                <div key={idx} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "24px 28px", flex: "1 1 380px", minWidth: 380 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <div>
                      <div style={{ fontSize: 36, fontWeight: 700 }}>{m.month}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 16, textTransform: "uppercase", color: C.muted, fontWeight: 600 }}>Total Cash Need</div>
                      <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "monospace", color: C.text, marginTop: 8 }}>{fmt(totalCashNeed)}</div>
                    </div>
                  </div>

                  {/* Breakdown bars */}
                  {([
                    { label: "Corporate Overhead", val: m.overhead, color: C.blue },
                    { label: "Corporate Development", val: m.corpDev, color: C.purple },
                    { label: "Project Development", val: m.projDev, color: C.green },
                    { label: "Land Acquisitions", val: landTotal, color: C.orange },
                  ]).map((item, j) => (
                    <div key={j} style={{ marginBottom: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                        <span style={{ fontSize: 19, color: C.muted }}>{item.label}</span>
                        <span style={{ fontSize: 19, fontFamily: "monospace", fontWeight: 600 }}>{fmtFull(item.val)}</span>
                      </div>
                      <div style={{ height: 8, background: "#1e2430", borderRadius: 4, overflow: "hidden" }}>
                        <div style={{ height: "100%", background: item.color, borderRadius: 4, width: `${totalCashNeed > 0 ? Math.min((item.val / totalCashNeed) * 100, 100) : 0}%`, transition: "width 0.4s" }} />
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* Stacked bar comparison */}
          {next2CN.length === 2 && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(45vh, 600px)", minHeight: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={next2CN.map(m => ({
                    ...m,
                    land: cashNeedsLand(m.month).reduce((s, t) => s + t.amount, 0),
                  }))}
                  margin={{ top: 10, right: 30, left: 10, bottom: 0 }}
                >
                  <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 20 }} axisLine={{ stroke: "#1e2430" }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend
                    wrapperStyle={{ fontSize: 20 }}
                    content={() => (
                      <ul style={{ display: "flex", justifyContent: "center", gap: 28, listStyle: "none", padding: 0, margin: "12px 0 0" }}>
                        {[
                          { label: "Corp Overhead", color: C.blue },
                          { label: "Corp Dev", color: C.purple },
                          { label: "Project Dev", color: C.green },
                          { label: "Land Acquisitions", color: C.orange },
                        ].map((k, i) => (
                          <li key={i} style={{ display: "flex", alignItems: "center", gap: 10, color: k.color, fontSize: 20 }}>
                            <span style={{ display: "inline-block", width: 16, height: 16, background: k.color, borderRadius: 3 }} />
                            {k.label}
                          </li>
                        ))}
                      </ul>
                    )}
                  />
                  <Bar dataKey="overhead" name="Corp Overhead" stackId="a" fill={C.blue} />
                  <Bar dataKey="corpDev" name="Corp Dev" stackId="a" fill={C.purple} />
                  <Bar dataKey="projDev" name="Project Dev" stackId="a" fill={C.green} />
                  <Bar dataKey="land" name="Land Acquisitions" stackId="a" fill={C.orange} radius={[4, 4, 0, 0] as [number, number, number, number]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Land Acquisitions deal-level detail for the same 2 months */}
          {next2CN.some(m => cashNeedsLand(m.month).length > 0) && (
            <>
              <Section>Land Acquisitions — Detail</Section>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {next2CN.map((m, idx) => {
                  const txns = cashNeedsLand(m.month).slice().sort((a, b) => a.date.localeCompare(b.date));
                  // Empty slot keeps the column aligned with its Cash Needs card above.
                  if (txns.length === 0) return <div key={idx} style={{ flex: "1 1 380px", minWidth: 380 }} aria-hidden="true" />;
                  const monthTotal = txns.reduce((s, t) => s + t.amount, 0);
                  return (
                    <div key={idx} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "24px 28px", flex: "1 1 380px", minWidth: 380 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                        <div style={{ fontSize: 28, fontWeight: 700 }}>{m.month}</div>
                        <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", color: C.orange }}>{fmt(monthTotal)}</div>
                      </div>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 18 }}>
                        <thead>
                          <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                            {["Deal", "Estimated Date", "Type", "Amount"].map((h, i) => (
                              <th key={i} style={{ padding: "10px 8px", textAlign: i === 3 ? "right" : "left", color: C.muted, fontWeight: 600, fontSize: 13, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {txns.map((t, i) => {
                            const [y, mo, d] = t.date.split("-").map(Number);
                            const dateLabel = `${mo}/${d}/${String(y).slice(2)}`;
                            return (
                              <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                                <td style={{ padding: "10px 8px", fontWeight: 600 }}>{t.deal}</td>
                                <td style={{ padding: "10px 8px", color: C.muted, fontFamily: "monospace" }}>{dateLabel}</td>
                                <td style={{ padding: "10px 8px", color: C.muted }}>{t.type}</td>
                                <td style={{ padding: "10px 8px", textAlign: "right", fontFamily: "monospace", fontWeight: 600 }}>{fmtFull(t.amount)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      )}

      {/* ═══════════ PAYROLL (NEW) ═══════════ */}
      {tab === "payroll" && (
        <>
          <Section>Quarterly Annualized Payroll + FTE</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(55vh, 720px)", minHeight: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={displayedQuarterlyPayroll} margin={{ top: 72, right: 20, left: 10, bottom: 0 }}>
                <XAxis dataKey="quarter" tick={{ fill: C.text, fontSize: 20 }} axisLine={{ stroke: "#1e2430" }} />
                <YAxis yAxisId="cost" tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <YAxis yAxisId="fte" orientation="right" tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} axisLine={false} domain={[0, 14]} ticks={[0, 2, 4, 6, 8, 10, 12, 14]} />
                <Tooltip content={<ChartTooltip />} />
                <Legend verticalAlign="top" wrapperStyle={{ fontSize: 20, paddingBottom: 12 }} />
                <Bar yAxisId="cost" dataKey="annualized" name="Annualized Payroll" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={70}>
                  <LabelList dataKey="annualized" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.text, fontSize: 24, fontFamily: "monospace", fontWeight: 700 }} />
                </Bar>
                <Line yAxisId="fte" type="monotone" dataKey="fte" name="FTE" stroke={C.orange} strokeWidth={3} dot={{ fill: C.orange, r: 5 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <Section>Quarterly Detail</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 22 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Quarter", "Annualized Payroll", "Quarterly Actual", "FTE", "Cost per FTE (Ann.)"].map((h, i) => (
                    <th key={i} style={{ padding: "22px 28px", textAlign: i === 0 ? "left" : "right", color: C.muted, fontWeight: 600, fontSize: 17, textTransform: "uppercase", letterSpacing: "0.06em" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayedQuarterlyPayroll.map((q, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "22px 28px", fontWeight: 700, fontSize: 22 }}>{q.quarter}</td>
                    <td style={{ padding: "22px 28px", textAlign: "right", fontFamily: "monospace", fontSize: 22 }}>{fmtFull(q.annualized)}</td>
                    <td style={{ padding: "22px 28px", textAlign: "right", fontFamily: "monospace", fontSize: 22, color: C.muted }}>{fmtFull(q.quarterly)}</td>
                    <td style={{ padding: "22px 28px", textAlign: "right", fontFamily: "monospace", fontSize: 22 }}>{q.fte}</td>
                    <td style={{ padding: "22px 28px", textAlign: "right", fontFamily: "monospace", fontSize: 22, color: C.blue }}>{q.fte > 0 ? fmtFull(Math.round(q.annualized / q.fte)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ═══════════ PROJECTED VS PLAN (NEW) ═══════════ */}
      {tab === "projvsplan" && (
        <>
          <Section>NTM Monthly Spend: Projected vs. Plan</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(50vh, 720px)", minHeight: 380 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={projVsPlanData} margin={{ top: 90, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2430" />
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 20, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={90} />
                <YAxis tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend verticalAlign="top" wrapperStyle={{ fontSize: 20, paddingBottom: 12 }} />
                <Bar dataKey="projected" name="Projected Spend" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={50}>
                  <LabelList dataKey="projected" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.blue, fontSize: 22, fontFamily: "monospace", fontWeight: 700 }} />
                </Bar>
                <Line type="monotone" dataKey="plan" name="Plan" stroke={C.orange} strokeWidth={2} strokeDasharray="6 3" dot={false}>
                  <LabelList dataKey="plan" position="top" offset={28} formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.orange, fontSize: 22, fontFamily: "monospace", fontWeight: 700 }} />
                </Line>
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <Section>NTM Cumulative Spend: Projected vs. Plan</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(40vh, 600px)", minHeight: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={projVsPlanData} margin={{ top: 16, right: 20, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="projG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue} stopOpacity={0.3} /><stop offset="95%" stopColor={C.blue} stopOpacity={0} /></linearGradient>
                  <linearGradient id="planG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.orange} stopOpacity={0.2} /><stop offset="95%" stopColor={C.orange} stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2430" />
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 20, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={90} />
                <YAxis tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend verticalAlign="top" wrapperStyle={{ fontSize: 20, paddingBottom: 12 }} />
                <Area type="monotone" dataKey="cumProjected" name="Cum. Projected" stroke={C.blue} fill="url(#projG)" strokeWidth={2} />
                <Area type="monotone" dataKey="cumPlan" name="Cum. Plan" stroke={C.orange} fill="url(#planG)" strokeWidth={2} strokeDasharray="6 3" />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Summary card (NTM window) */}
          {(() => {
            const last = projVsPlanData[projVsPlanData.length - 1];
            const planTotal = last?.cumPlan ?? 0;
            const projTotal = last?.cumProjected ?? 0;
            const variance = planTotal - projTotal;
            return (
              <div style={{ marginTop: 20, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "26px 30px", flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 17, textTransform: "uppercase", color: C.muted, marginBottom: 12, fontWeight: 600, letterSpacing: "0.06em" }}>NTM Spend: Plan</div>
                  <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "monospace" }}>{fmt(planTotal)}</div>
                </div>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "26px 30px", flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 17, textTransform: "uppercase", color: C.muted, marginBottom: 12, fontWeight: 600, letterSpacing: "0.06em" }}>NTM Spend: Projected</div>
                  <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "monospace", color: projTotal > planTotal ? C.red : C.green }}>{fmt(projTotal)}</div>
                </div>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "26px 30px", flex: 1, minWidth: 220 }}>
                  <div style={{ fontSize: 17, textTransform: "uppercase", color: C.muted, marginBottom: 12, fontWeight: 600, letterSpacing: "0.06em" }}>Variance</div>
                  <div style={{ fontSize: 44, fontWeight: 700, fontFamily: "monospace", color: variance >= 0 ? C.green : C.red }}>
                    {variance >= 0 ? "+" : ""}{fmt(variance)}
                  </div>
                  <div style={{ fontSize: 19, color: C.muted, marginTop: 8 }}>{variance >= 0 ? "Under plan" : "Over plan"}</div>
                </div>
              </div>
            );
          })()}
        </>
      )}

      {/* ═══════════ FIXED EXPENSES (NEW) ═══════════ */}
      {tab === "fixed" && (() => {
        const ntmProjFixed = fixedExpensesData.reduce((s, m) => s + m.projected, 0);
        const ntmPlanFixed = fixedExpensesData.reduce((s, m) => s + m.plan, 0);
        const variance = ntmProjFixed - ntmPlanFixed;
        const sub = ntmPlanFixed > 0
          ? (variance <= 0 ? `${fmt(Math.abs(variance))} under plan` : `${fmt(variance)} over plan`)
          : undefined;
        return (
          <>
            <Section>Run Rate: Fixed Expenses vs. Initial Plan (NTM)</Section>
            <div style={{ display: "flex", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
              <KPI label="NTM Projected Fixed Expenses" value={fmt(ntmProjFixed)} sub={sub} good={variance <= 0} />
            </div>
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px", height: "min(55vh, 720px)", minHeight: 380 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={fixedExpensesData} margin={{ top: 56, right: 20, left: 10, bottom: 0 }} barCategoryGap="20%" barGap={4}>
                  <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 20, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 17, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend verticalAlign="top" wrapperStyle={{ fontSize: 20, paddingBottom: 12 }} />
                  <Bar dataKey="projected" name="Projected Fixed Expenses" fill={C.blue} radius={[3, 3, 0, 0] as [number, number, number, number]}>
                    <LabelList dataKey="projected" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.blue, fontSize: 16, fontFamily: "monospace", fontWeight: 600 }} />
                  </Bar>
                  <Bar dataKey="plan" name="Initial Plan Fixed Expenses" fill="rgba(255,255,255,0.25)" radius={[3, 3, 0, 0] as [number, number, number, number]}>
                    <LabelList dataKey="plan" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.muted, fontSize: 16, fontFamily: "monospace", fontWeight: 600 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ marginTop: 14, fontSize: 14, color: C.muted, fontStyle: "italic" }}>
              * Fixed expenses includes: payroll, admin, office, and land carry.
            </div>
          </>
        );
      })()}

      {tab === "portfolio" && <PortfolioTab />}

      {tab === "closed" && <AcquisitionsClosedTab />}

      {tab === "projspend" && <ProjectedSpendTab months={months} />}

      {/* FOOTER */}
      <div style={{ marginTop: 40, paddingTop: 16, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, fontSize: 14, color: C.muted, flexWrap: "wrap" }}>
        <span>Actuals through {reviewLabel}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span>Auto-refreshes every 5 min</span>
          <form action={logout}>
            <button type="submit" style={{ background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 14, fontFamily: "inherit" }}>
              Log out
            </button>
          </form>
        </div>
      </div>

      <ChatWidget financialData={{
        reviewLabel,
        months,
        planMonths,
        ntmTotals,
        pitchDeck,
        itd,
        itdPlan,
        nextQuarterPayroll,
        quarterlyPayroll,
        fixedExpensesData,
      }} />
    </div>
  );
}
