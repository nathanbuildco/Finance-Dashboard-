"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import {
  BarChart, Bar, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, Line, LabelList
} from "recharts";
import { logout } from "./actions/auth";

// ══════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlUqIymbq_OgJ70EoO2uARD86PqF5vKmG_CzYTyzSzxdEXGTtk3mgRf7NhecnaXjhdTpyor_e3-NJ5/pub?gid=634011599&single=true&output=csv";
const PLAN_CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vTlUqIymbq_OgJ70EoO2uARD86PqF5vKmG_CzYTyzSzxdEXGTtk3mgRf7NhecnaXjhdTpyor_e3-NJ5/pub?gid=1750179845&single=true&output=csv";

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
interface PlanMonth { month: string; overhead: number; corpDev: number; projDev: number; total: number }

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

  const planMonths: PlanMonth[] = [];
  for (const mc of monthCols) {
    const c = mc.col;
    const tot = toNum(totalRow?.[c]);
    const oh = toNum(overheadRow?.[c]);
    const cd = toNum(corpDevRow?.[c]);
    const pd = toNum(projDevRow?.[c]);
    if (tot === 0 && oh === 0 && cd === 0 && pd === 0) continue;
    planMonths.push({
      month: mc.label.replace(/[''`]/g, "'").replace(/\s+/g, " ").trim(),
      overhead: Math.round(oh), corpDev: Math.round(cd), projDev: Math.round(pd), total: Math.round(tot),
    });
  }
  return { planMonths };
}

function parseSheet(csv: string): { months: MonthData[]; reviewLabel: string; pitchDeck: PitchDeck | null; ntmProj: PitchDeck | null } {
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

  let corpDevRow: string[] | null = null;
  let projDevRow: string[] | null = null;
  for (const row of rows) {
    const t = row.slice(0, 4).join(" ").toLowerCase().replace(/\s+/g, " ");
    if (t.includes("corporate development costs") && !corpDevRow) corpDevRow = row;
    if (t.includes("project development costs") && !projDevRow) projDevRow = row;
  }

  const reviewRow = findRow(rows, "last day of month review");
  let lastReviewSerial = 46112;
  if (reviewRow) { for (const cell of reviewRow) { const v = parseFloat(cell); if (!isNaN(v) && v > 45000 && v < 50000) { lastReviewSerial = v; break; } } }
  const lastReviewDate = new Date(1899, 11, 30 + lastReviewSerial);
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
    if (tot === 0 && oh === 0 && cd === 0 && pd === 0) continue;
    const monthDate = parseMonthLabel(mc.label);
    const isActual = monthDate ? monthDate <= lastReviewDate : false;
    months.push({
      month: mc.label.replace(/[''`]/g, "'").replace(/\s+/g, " ").trim(),
      overhead: Math.round(oh), corpDev: Math.round(cd), projDev: Math.round(pd),
      total: Math.round(tot), headcount: Math.round(hc), actual: isActual,
      payroll: Math.round(pr),
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

  return { months: months.filter(m => m.total > 0), reviewLabel, pitchDeck, ntmProj };
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
};

// ══════════════════════════════════════════════
// SUB-COMPONENTS
// ══════════════════════════════════════════════
/* eslint-disable @typescript-eslint/no-explicit-any */
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#1a1f2e", border: "1px solid #2a3040", borderRadius: 8, padding: "12px 16px", boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}>
      <p style={{ color: C.text, fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{label}</p>
      {payload.map((p: any, i: number) => (
        <p key={i} style={{ color: p.color, fontSize: 12, margin: "3px 0", fontFamily: "monospace" }}>{p.name}: {p.dataKey === "headcount" || p.dataKey === "fte" ? p.value : fmtFull(p.value)}</p>
      ))}
    </div>
  );
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function KPI({ label, value, sub, color, good }: { label: string; value: string; sub?: string; color?: string; good?: boolean }) {
  return (
    <div style={{ background: C.card, border: `1px solid ${C.border}`, borderTop: `1px solid ${C.blue}`, borderRadius: 12, padding: "22px 24px", flex: 1, minWidth: 190, textAlign: "center", boxShadow: `inset 0 1px 0 ${C.blue}33` }}>
      <div style={{ fontSize: 32, fontWeight: 700, color: color || C.text, fontFamily: "monospace", lineHeight: 1.05 }}>{value}</div>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: C.muted, marginTop: 10, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: good === true ? C.green : good === false ? C.red : C.muted, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontSize: 16, fontWeight: 600, color: C.text, margin: "36px 0 16px", borderBottom: `1px solid ${C.border}`, paddingBottom: 10 }}>{children}</h2>;
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
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

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
      setErr(null);
    } catch (e: any) {
      console.error(e);
      setErr(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const iv = setInterval(load, 5 * 60 * 1000); return () => clearInterval(iv); }, [load]);

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
    const visible = [
      ...months.filter(m => m.actual),
      ...months.filter(m => !m.actual).slice(0, 12),
    ];
    let cum = 0;
    return visible.map(d => { cum += d.total; return { ...d, cumulative: Math.round(cum) }; });
  }, [months]);

  // ── Next 2 months data ──
  const next2 = projected.slice(0, 2);

  // ── Quarterly payroll data ──
  // Annualized & FTE are taken from the LAST month of each quarter (run-rate convention),
  // not averaged. Quarterly column stays as the sum of the months in the quarter.
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
    return Object.entries(qMap).map(([quarter, data]) => ({
      quarter,
      annualized: Math.round(data.lastPayroll * 12),
      quarterly: Math.round(data.payroll),
      fte: data.lastHc,
    })).filter(q => q.quarter !== "Q2 '25");
  }, [months]);

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
  ];

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, padding: "24px 28px", fontFamily: "system-ui, -apple-system, sans-serif" }}>

      {/* HEADER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 28, flexWrap: "wrap", gap: 16 }}>
        <div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/tbc-logo.svg" alt="The Building Company" style={{ height: 40, width: "auto", display: "block", marginBottom: 14 }} />
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em", color: C.blue, marginBottom: 4, fontWeight: 600 }}>Financial Projections</div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Finance Dashboard</h1>
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
            Actuals through {reviewLabel}
            <button onClick={load} style={{ marginLeft: 12, background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 11 }}>↻ Refresh</button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 2, background: C.card, borderRadius: 8, border: `1px solid ${C.border}`, padding: 3, flexWrap: "wrap" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "7px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 500,
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
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
            <ResponsiveContainer width="100%" height={380}>
              <ComposedChart data={overviewData} margin={{ top: 32, right: 20, left: 10, bottom: 0 }}>
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 11, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="overhead" name="Corp Overhead" stackId="a" fill={C.blue} />
                <Bar dataKey="corpDev" name="Corp Dev" stackId="a" fill={C.purple} />
                <Bar dataKey="projDev" name="Project Dev" stackId="a" fill={C.green} radius={[3, 3, 0, 0] as [number, number, number, number]}>
                  <LabelList dataKey="total" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.text, fontSize: 11, fontFamily: "monospace", fontWeight: 600 }} />
                </Bar>
                <Line type="monotone" dataKey="total" name="Total" stroke="#fff" strokeWidth={1.5} dot={false} strokeDasharray="4 3" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <Section>Cumulative Spend</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
            <ResponsiveContainer width="100%" height={320}>
              <AreaChart data={cumData} margin={{ top: 28, right: 20, left: 10, bottom: 0 }}>
                <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue} stopOpacity={0.3} /><stop offset="95%" stopColor={C.blue} stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 11, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Area type="monotone" dataKey="cumulative" name="Cumulative" stroke={C.blue} fill="url(#cg)" strokeWidth={2}>
                  <LabelList dataKey="cumulative" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.text, fontSize: 9, fontFamily: "monospace", fontWeight: 600 }} />
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
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, flex: "1 1 280px", minWidth: 280 }}>
              <ResponsiveContainer width="100%" height={320}>
                <PieChart>
                  <Pie data={[
                    { name: "Corp Overhead", value: ntmTotals.overhead, color: C.blue },
                    { name: "Corp Dev", value: ntmTotals.corpDev, color: C.purple },
                    { name: "Proj Dev", value: ntmTotals.projDev, color: C.green },
                  ]} cx="50%" cy="50%" innerRadius={60} outerRadius={100} paddingAngle={3} dataKey="value"
                    label={({ name, percent }: { name?: string; percent?: number }) => `${name ?? ""} ${((percent ?? 0) * 100).toFixed(0)}%`}
                    labelLine={{ stroke: C.muted }}>
                    <Cell fill={C.blue} /><Cell fill={C.purple} /><Cell fill={C.green} />
                  </Pie>
                  <Tooltip formatter={(v) => fmtFull(Number(v))} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ flex: "1 1 340px", minWidth: 340, display: "flex", flexDirection: "column", gap: 12 }}>
              {([
                { label: "Corporate Overhead", val: ntmTotals.overhead, plan: planMonths.filter(p => overviewData.some(o => fmtMonth(o.month) === fmtMonth(p.month))).reduce((s, m) => s + m.overhead, 0) || PITCH_DECK_FALLBACK.overhead, color: C.blue, desc: "Payroll, insurance, travel, admin, office, recruiting" },
                { label: "Corporate Development", val: ntmTotals.corpDev, plan: planMonths.filter(p => overviewData.some(o => fmtMonth(o.month) === fmtMonth(p.month))).reduce((s, m) => s + m.corpDev, 0) || PITCH_DECK_FALLBACK.corpDev, color: C.purple, desc: "Legal (fundraise), design & branding, SEO" },
                { label: "Project Development", val: ntmTotals.projDev, plan: planMonths.filter(p => overviewData.some(o => fmtMonth(o.month) === fmtMonth(p.month))).reduce((s, m) => s + m.projDev, 0) || PITCH_DECK_FALLBACK.projDev, color: C.green, desc: "Engineering, architect, legal, DD, broker, land carry" },
              ]).map((item, i) => {
                const v = item.val - item.plan;
                return (
                  <div key={i} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 10, padding: "16px 20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <div style={{ width: 10, height: 10, borderRadius: 3, background: item.color }} />
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{item.label}</span>
                        </div>
                        <div style={{ fontSize: 11, color: C.muted, marginTop: 2, marginLeft: 18 }}>{item.desc}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontFamily: "monospace", fontWeight: 600, fontSize: 16 }}>{fmt(item.val)}</div>
                        <div style={{ fontSize: 11, color: v <= 0 ? C.green : C.red, fontFamily: "monospace" }}>
                          {v <= 0 ? "▼" : "▲"} {fmt(Math.abs(v))} vs plan
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ═══════════ ITD VS PLAN ═══════════ */}
      {tab === "variance" && (
        <>
          <Section>ITD Actuals vs Plan</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={[
                { name: "Corp Overhead", itdActual: itd.overhead, itdPlan: itdPlan.overhead },
                { name: "Corp Dev", itdActual: itd.corpDev, itdPlan: itdPlan.corpDev },
                { name: "Proj Dev", itdActual: itd.projDev, itdPlan: itdPlan.projDev },
              ]} margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2430" />
                <XAxis dataKey="name" tick={{ fill: C.muted, fontSize: 11 }} axisLine={{ stroke: "#1e2430" }} />
                <YAxis tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="itdActual" name="ITD Actual" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={40} />
                <Bar dataKey="itdPlan" name="ITD Plan" fill="rgba(255,255,255,0.15)" radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={40} stroke="rgba(255,255,255,0.3)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Section>Variance Detail</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Category", "ITD Actual", "ITD Plan", "Variance"].map((h, i) => (
                    <th key={i} style={{ padding: "12px 16px", textAlign: i === 0 ? "left" : "right", color: C.muted, fontWeight: 500, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
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
                      <td style={{ padding: "12px 16px", fontWeight: r.b ? 700 : 400 }}>{r.n}</td>
                      <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "monospace", fontSize: 12 }}>{fmtFull(r.a)}</td>
                      <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: C.muted }}>{fmtFull(r.p)}</td>
                      <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: v >= 0 ? C.green : C.red }}>{v >= 0 ? "+" : ""}{fmtFull(v)}</td>
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
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={headcountData} margin={{ top: 32, right: 20, left: 10, bottom: 0 }}>
                <XAxis dataKey="month" tickFormatter={(v: string) => fmtMonth(v)} tick={{ fill: C.text, fontSize: 11, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={60} />
                <YAxis yAxisId="cost" tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} domain={[0, 30000]} />
                <YAxis yAxisId="hc" orientation="right" tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} axisLine={false} allowDecimals={false} domain={[0, 15]} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="cost" dataKey="avgCost" name="Avg Cost / Employee" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={24} opacity={0.7}>
                  <LabelList dataKey="avgCost" position="top" formatter={(v) => fmtLabel(Number(v))} style={{ fill: C.text, fontSize: 11, fontFamily: "monospace", fontWeight: 600 }} />
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

          {/* Cash Needs Cards */}
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 24 }}>
            {next2.map((m, idx) => (
              <div key={idx} style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "24px 28px", flex: "1 1 380px", minWidth: 380 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <div>
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: C.muted }}>{idx === 0 ? "Next Month" : "Month After"}</div>
                    <div style={{ fontSize: 22, fontWeight: 700 }}>{m.month}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", color: C.muted }}>Total Cash Need</div>
                    <div style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", color: C.orange }}>{fmt(m.total)}</div>
                  </div>
                </div>

                {/* Breakdown bars */}
                {([
                  { label: "Corporate Overhead", val: m.overhead, color: C.blue },
                  { label: "Corporate Development", val: m.corpDev, color: C.purple },
                  { label: "Project Development", val: m.projDev, color: C.green },
                ]).map((item, j) => (
                  <div key={j} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: 12, color: C.muted }}>{item.label}</span>
                      <span style={{ fontSize: 12, fontFamily: "monospace", fontWeight: 600 }}>{fmtFull(item.val)}</span>
                    </div>
                    <div style={{ height: 6, background: "#1e2430", borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", background: item.color, borderRadius: 3, width: `${Math.min((item.val / m.total) * 100, 100)}%`, transition: "width 0.4s" }} />
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Stacked bar comparison */}
          {next2.length === 2 && (
            <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={next2} margin={{ top: 10, right: 30, left: 10, bottom: 0 }}>
                  <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 12 }} axisLine={{ stroke: "#1e2430" }} />
                  <YAxis tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="overhead" name="Corp Overhead" stackId="a" fill={C.blue} />
                  <Bar dataKey="corpDev" name="Corp Dev" stackId="a" fill={C.purple} />
                  <Bar dataKey="projDev" name="Project Dev" stackId="a" fill={C.green} radius={[4, 4, 0, 0] as [number, number, number, number]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}

      {/* ═══════════ PAYROLL (NEW) ═══════════ */}
      {tab === "payroll" && (
        <>
          <Section>Quarterly Annualized Payroll + FTE</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={quarterlyPayroll} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2430" />
                <XAxis dataKey="quarter" tick={{ fill: C.muted, fontSize: 11 }} axisLine={{ stroke: "#1e2430" }} />
                <YAxis yAxisId="cost" tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <YAxis yAxisId="fte" orientation="right" tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} axisLine={false} domain={[0, 'auto']} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="cost" dataKey="annualized" name="Annualized Payroll" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={36} />
                <Line yAxisId="fte" type="monotone" dataKey="fte" name="FTE" stroke={C.orange} strokeWidth={3} dot={{ fill: C.orange, r: 5 }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <Section>Quarterly Detail</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Quarter", "Annualized Payroll", "Quarterly Actual", "FTE", "Cost per FTE (Ann.)"].map((h, i) => (
                    <th key={i} style={{ padding: "12px 16px", textAlign: i === 0 ? "left" : "right", color: C.muted, fontWeight: 500, fontSize: 11, textTransform: "uppercase" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quarterlyPayroll.map((q, i) => (
                  <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                    <td style={{ padding: "12px 16px", fontWeight: 600 }}>{q.quarter}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "monospace", fontSize: 12 }}>{fmtFull(q.annualized)}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: C.muted }}>{fmtFull(q.quarterly)}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "monospace", fontSize: 12 }}>{q.fte}</td>
                    <td style={{ padding: "12px 16px", textAlign: "right", fontFamily: "monospace", fontSize: 12, color: C.blue }}>{q.fte > 0 ? fmtFull(Math.round(q.annualized / q.fte)) : "—"}</td>
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
          <Section>Monthly Projected Spend vs Initial Plan</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={projVsPlanData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2430" />
                <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 9, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="projected" name="Projected Spend" fill={C.blue} radius={[4, 4, 0, 0] as [number, number, number, number]} barSize={20} />
                <Line type="monotone" dataKey="plan" name="Pitch Deck Plan" stroke={C.orange} strokeWidth={2} strokeDasharray="6 3" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <Section>Cumulative: Projected vs Plan</Section>
          <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 16px 8px" }}>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={projVsPlanData} margin={{ top: 10, right: 20, left: 10, bottom: 0 }}>
                <defs>
                  <linearGradient id="projG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.blue} stopOpacity={0.3} /><stop offset="95%" stopColor={C.blue} stopOpacity={0} /></linearGradient>
                  <linearGradient id="planG" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor={C.orange} stopOpacity={0.2} /><stop offset="95%" stopColor={C.orange} stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e2430" />
                <XAxis dataKey="month" tick={{ fill: C.muted, fontSize: 9, fontFamily: "monospace" }} axisLine={{ stroke: "#1e2430" }} angle={-45} textAnchor="end" height={60} />
                <YAxis tick={{ fill: C.muted, fontSize: 10, fontFamily: "monospace" }} tickFormatter={(v: number) => fmt(v)} axisLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
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
              <div style={{ marginTop: 16, display: "flex", gap: 16, flexWrap: "wrap" }}>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", color: C.muted, marginBottom: 6 }}>NTM Plan</div>
                  <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace" }}>{fmt(planTotal)}</div>
                </div>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", color: C.muted, marginBottom: 6 }}>NTM Projected</div>
                  <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: projTotal > planTotal ? C.red : C.green }}>{fmt(projTotal)}</div>
                </div>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 11, textTransform: "uppercase", color: C.muted, marginBottom: 6 }}>Variance</div>
                  <div style={{ fontSize: 24, fontWeight: 700, fontFamily: "monospace", color: variance >= 0 ? C.green : C.red }}>
                    {variance >= 0 ? "+" : ""}{fmt(variance)}
                  </div>
                  <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{variance >= 0 ? "Under plan" : "Over plan"}</div>
                </div>
              </div>
            );
          })()}
        </>
      )}

      {/* FOOTER */}
      <div style={{ marginTop: 40, paddingTop: 16, borderTop: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, fontSize: 11, color: C.muted, flexWrap: "wrap" }}>
        <span>Actuals through {reviewLabel}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span>Auto-refreshes every 5 min</span>
          <form action={logout}>
            <button type="submit" style={{ background: "none", border: `1px solid ${C.border}`, color: C.muted, borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
              Log out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
