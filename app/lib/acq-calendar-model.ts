// Data model for the "Acquisition Calendar" Gantt view.
//
// A calendar is a title + timeline window + a list of deals. Each deal has
// static columns (name, acres, price, deposit lines) and an ordered list of
// segments that lay out on the timeline as colored bars. Milestone dates
// float above the right edge of each segment.

export type Phase = "contingency" | "expectedClosing" | "extension" | "rolling";

export interface RollingClosing {
  /** ISO date "YYYY-MM-DD" of the closing. */
  date: string;
  /** Dollar amount closing on that date. */
  amount: number;
}

export interface Segment {
  phase: Phase;
  /** ISO date "YYYY-MM-DD" at the left edge of the segment. For rolling
   * segments this is the first day of the FIRST CLOSING'S month (not the
   * deposit date). */
  start: string;
  /** ISO date "YYYY-MM-DD" at the right edge (inclusive). For rolling
   * segments this is the last day of the LAST CLOSING'S month. */
  end: string;
  /** Small "M/D" label drawn above the segment's right edge, or null. Rolling
   * segments never carry this — the bar shows per-closing dates instead. */
  milestoneDate: string | null;
  /** Rolling segments only: ordered list of closings. Each renders as a
   * tick on the bar with its M/D date labeled above. */
  closings?: RollingClosing[];
  /** Optional per-segment note (e.g. rolling terms, "per parcel, at each
   * closing"). Not currently rendered as a caption on the bar — reserved for
   * downstream tooltips. */
  note?: string;
}

export interface Deal {
  name: string;
  /** True when the source name carried a trailing asterisk (subject to PSA). */
  provisional: boolean;
  acres: number;
  price: number;
  /** First line of the DEPOSIT column, free text. May be a sum like
   * "$250K + $250K + $500K ext" or a rate expression when depositIsRate. */
  depositLabel: string;
  /** Optional parenthetical shown beneath depositLabel, e.g. "($100K option money)". */
  depositNote: string | null;
  /** When true, depositLabel is a rate expression (e.g. "1.5% of purchase
   * price") and is rendered in italic muted blue-gray instead of the
   * standard dollar-sum treatment. */
  depositIsRate?: boolean;
  segments: Segment[];
}

export interface AcqCalendar {
  title: string;
  /** ISO "YYYY-MM" — first month rendered on the timeline (day 1). */
  timelineStart: string;
  /** ISO "YYYY-MM" — last month rendered on the timeline (inclusive). */
  timelineEnd: string;
  deals: Deal[];
  /** Recomputed from deals — canonical for the TOTAL row. */
  totals: { acres: number; price: number };
  /** Values the extractor read from the image's TOTAL row, for reconciliation. */
  totalsFromImage?: { acres: number; price: number };
  footnote: string | null;
  /** Non-fatal issues surfaced to the UI (missing fields, tolerance breaches). */
  warnings: string[];
}

// ── Date helpers ─────────────────────────────────────────────────────────

function isISODate(s: string): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function isISOMonth(s: string): boolean {
  return typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
}

function ymTotal(iso: string): number {
  // "YYYY-MM..." → year*12 + month0
  const y = parseInt(iso.slice(0, 4), 10);
  const m = parseInt(iso.slice(5, 7), 10) - 1;
  return y * 12 + m;
}

/** Compare two dates, returns negative if a < b, positive if a > b, 0 if equal. */
function cmpDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Validate a raw extracted object. Returns the normalized `AcqCalendar` when
 * the shape is usable, or an `issues` list describing what failed. Non-fatal
 * problems (totals reconciliation, missing footnote, etc.) go into
 * `warnings` on the returned calendar rather than blocking the render.
 */
export function validateCalendar(raw: unknown): { data: AcqCalendar } | { issues: string[] } {
  const issues: string[] = [];
  if (!raw || typeof raw !== "object") return { issues: ["Extraction result is not an object."] };
  const r = raw as Record<string, unknown>;

  const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : "Master Acquisition Calendar";
  const timelineStart = String(r.timelineStart ?? "").trim();
  const timelineEnd   = String(r.timelineEnd   ?? "").trim();
  if (!isISOMonth(timelineStart)) issues.push(`timelineStart must be "YYYY-MM" — got "${timelineStart}".`);
  if (!isISOMonth(timelineEnd))   issues.push(`timelineEnd must be "YYYY-MM" — got "${timelineEnd}".`);
  if (issues.length === 0 && ymTotal(timelineEnd) < ymTotal(timelineStart)) {
    issues.push(`timelineEnd (${timelineEnd}) is before timelineStart (${timelineStart}).`);
  }

  const rawDeals = Array.isArray(r.deals) ? r.deals : [];
  if (rawDeals.length === 0) issues.push("deals[] is empty — nothing to render.");

  const startBound = timelineStart + "-01"; // "YYYY-MM-01"
  // For endBound, use the last day of the timelineEnd month.
  const endYear = parseInt(timelineEnd.slice(0, 4), 10);
  const endMonth = parseInt(timelineEnd.slice(5, 7), 10);
  const endBoundDate = new Date(endYear, endMonth, 0); // day 0 = last of prev month, which is last day of endMonth
  const endBound = `${endBoundDate.getFullYear().toString().padStart(4, "0")}-${(endBoundDate.getMonth() + 1).toString().padStart(2, "0")}-${endBoundDate.getDate().toString().padStart(2, "0")}`;

  const warnings: string[] = [];
  const deals: Deal[] = [];

  for (let di = 0; di < rawDeals.length; di++) {
    const rd = rawDeals[di] as Record<string, unknown>;
    const rawName = String(rd?.name ?? "").trim();
    if (!rawName) { issues.push(`deals[${di}]: missing name.`); continue; }
    const provisional = /\*\s*$/.test(rawName);
    const name = rawName.replace(/\*\s*$/, "").trim();

    const acres = Number(rd?.acres);
    const price = Number(rd?.price);
    if (!Number.isFinite(acres)) issues.push(`deals[${di}] "${name}": acres is not a number.`);
    if (!Number.isFinite(price)) issues.push(`deals[${di}] "${name}": price is not a number.`);

    const depositLabel = String(rd?.depositLabel ?? "").trim();
    const depositNoteRaw = rd?.depositNote;
    const depositNote =
      depositNoteRaw === null || depositNoteRaw === undefined || String(depositNoteRaw).trim() === ""
        ? null
        : String(depositNoteRaw).trim();

    const rawSegments = Array.isArray(rd?.segments) ? (rd.segments as unknown[]) : [];
    if (rawSegments.length === 0) warnings.push(`Deal "${name}": no segments extracted.`);

    const depositIsRate = rd?.depositIsRate === true;

    const segments: Segment[] = [];
    let prevEnd: string | null = null;
    for (let si = 0; si < rawSegments.length; si++) {
      const rs = rawSegments[si] as Record<string, unknown>;
      const phaseRaw = String(rs?.phase ?? "").trim();
      const phase: Phase | null =
        phaseRaw === "contingency" || phaseRaw === "expectedClosing" ||
        phaseRaw === "extension"  || phaseRaw === "rolling"
          ? (phaseRaw as Phase) : null;
      if (!phase) {
        warnings.push(`Deal "${name}" segment ${si}: unknown phase "${phaseRaw}" — dropped.`);
        continue;
      }
      const start = String(rs?.start ?? "").trim();
      const end   = String(rs?.end   ?? "").trim();
      if (!isISODate(start) || !isISODate(end)) {
        warnings.push(`Deal "${name}" segment ${si}: bad start/end date — dropped.`);
        continue;
      }
      if (cmpDate(start, end) > 0) {
        warnings.push(`Deal "${name}" segment ${si}: start (${start}) after end (${end}) — dropped.`);
        continue;
      }
      if (cmpDate(end, startBound) < 0 || cmpDate(start, endBound) > 0) {
        warnings.push(`Deal "${name}" segment ${si}: outside timeline window — dropped.`);
        continue;
      }
      if (prevEnd && cmpDate(start, prevEnd) < 0) {
        warnings.push(`Deal "${name}" segment ${si}: starts before previous segment's end — kept but chart may misalign.`);
      }
      prevEnd = end;

      const md = rs?.milestoneDate;
      const milestoneDate =
        typeof md === "string" && md.trim() ? md.trim() : null;

      const seg: Segment = { phase, start, end, milestoneDate };

      if (phase === "rolling") {
        const rawClosings = Array.isArray(rs?.closings) ? (rs.closings as unknown[]) : [];
        const closings: RollingClosing[] = [];
        for (let ci = 0; ci < rawClosings.length; ci++) {
          const rc = rawClosings[ci] as Record<string, unknown>;
          const date = String(rc?.date ?? "").trim();
          const amount = Number(rc?.amount);
          if (!isISODate(date)) {
            warnings.push(`Deal "${name}" segment ${si} closing ${ci}: bad date "${rc?.date}" — dropped.`);
            continue;
          }
          if (!Number.isFinite(amount)) {
            warnings.push(`Deal "${name}" segment ${si} closing ${ci}: bad amount — dropped.`);
            continue;
          }
          closings.push({ date, amount });
        }
        if (closings.length === 0) {
          warnings.push(`Deal "${name}" segment ${si}: rolling segment has no closings — won't contribute to totals.`);
        }
        seg.closings = closings;
        if (milestoneDate) {
          warnings.push(`Deal "${name}" segment ${si}: rolling segment carries a milestoneDate — ignored.`);
          seg.milestoneDate = null;
        }
        const note = rs?.note;
        if (typeof note === "string" && note.trim()) seg.note = note.trim();
      }

      segments.push(seg);
    }

    deals.push({
      name,
      provisional,
      acres: Number.isFinite(acres) ? acres : 0,
      price: Number.isFinite(price) ? price : 0,
      depositLabel,
      depositNote,
      depositIsRate,
      segments,
    });
  }

  if (issues.length > 0) return { issues };

  // Totals — `price` is treated as the full acquisition amount for every
  // deal (for rolling deals: deposit + all closings pre-summed on write).
  // Closings are display-only from here down; they do not add to totals.
  const totals = deals.reduce(
    (acc, d) => ({ acres: acc.acres + d.acres, price: acc.price + d.price }),
    { acres: 0, price: 0 },
  );
  let totalsFromImage: { acres: number; price: number } | undefined;
  if (r.totalsFromImage && typeof r.totalsFromImage === "object") {
    const t = r.totalsFromImage as Record<string, unknown>;
    const acresFile = Number(t.acres);
    const priceFile = Number(t.price);
    if (Number.isFinite(acresFile) && Number.isFinite(priceFile)) {
      totalsFromImage = { acres: acresFile, price: priceFile };
      if (Math.abs(acresFile - totals.acres) > 1) {
        warnings.push(
          `Total acres disagree: image ${acresFile.toLocaleString()} vs computed ${totals.acres.toLocaleString()} (Δ ${(acresFile - totals.acres).toLocaleString()}).`,
        );
      }
      if (Math.abs(priceFile - totals.price) > 100_000) {
        warnings.push(
          `Total price disagree: image $${Math.round(priceFile).toLocaleString()} vs computed $${Math.round(totals.price).toLocaleString()} (Δ $${Math.round(priceFile - totals.price).toLocaleString()}).`,
        );
      }
    }
  }

  const footnote =
    typeof r.footnote === "string" && r.footnote.trim() ? r.footnote.trim() : null;

  return {
    data: {
      title,
      timelineStart,
      timelineEnd,
      deals,
      totals,
      totalsFromImage,
      footnote,
      warnings,
    },
  };
}
