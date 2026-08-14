import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { listAcqCalendar, replaceAcqCalendar } from "@/app/lib/sheets";
import type { AcqCalendar, Deal } from "@/app/lib/acq-calendar-model";

const NORTH: Deal = {
  name: "North Entrance Assemblage",
  provisional: true,
  acres: 100,
  // Full acquisition = $15K initial deposit + 9 × $1.5M + $1.485M final = $15,000,000
  price: 15_000_000,
  depositLabel: "1% of purchase price",
  depositNote: "per parcel, at each closing",
  depositIsRate: true,
  segments: [
    {
      phase: "rolling",
      // Band starts at the first CLOSING'S month (Dec-26), not the deposit month (Nov-26).
      start: "2026-12-01",
      end:   "2027-09-30",
      milestoneDate: null,
      closings: [
        { date: "2026-12-31", amount: 1_500_000 },
        { date: "2027-01-31", amount: 1_500_000 },
        { date: "2027-02-28", amount: 1_500_000 },
        { date: "2027-03-31", amount: 1_500_000 },
        { date: "2027-04-30", amount: 1_500_000 },
        { date: "2027-05-31", amount: 1_500_000 },
        { date: "2027-06-30", amount: 1_500_000 },
        { date: "2027-07-31", amount: 1_500_000 },
        { date: "2027-08-31", amount: 1_500_000 },
        { date: "2027-09-30", amount: 1_485_000 },
      ],
      note: "Initial deposit 11/30/26 $15,000 — deposit column only, not on the bar.",
    },
  ],
};

const SOUTH: Deal = {
  name: "South Entrance Assemblage",
  provisional: true,
  acres: 25,
  // Full acquisition = $7,575 initial + 4 × $757.5K + $749,925 final = $3,787,500
  price: 3_787_500,
  depositLabel: "1% of purchase price",
  depositNote: "per parcel, at each closing",
  depositIsRate: true,
  segments: [
    {
      phase: "rolling",
      start: "2027-03-01",
      end:   "2027-07-31",
      milestoneDate: null,
      closings: [
        { date: "2027-03-31", amount: 757_500 },
        { date: "2027-04-30", amount: 757_500 },
        { date: "2027-05-31", amount: 757_500 },
        { date: "2027-06-30", amount: 757_500 },
        { date: "2027-07-31", amount: 749_925 },
      ],
      note: "Initial deposit 2/28/27 $7,575 — deposit column only, not on the bar.",
    },
  ],
};

function toMonthKey(iso: string) { return iso.slice(0, 7); }
function minMonth(a: string, b: string) { return a < b ? a : b; }
function maxMonth(a: string, b: string) { return a > b ? a : b; }

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const existing = await listAcqCalendar();

  // Merge, dedupe on deal name (case-insensitive) so re-running the seed
  // replaces rather than duplicates.
  const priorDeals = (existing?.deals ?? []).filter(
    (d) => d.name.toLowerCase() !== NORTH.name.toLowerCase() &&
           d.name.toLowerCase() !== SOUTH.name.toLowerCase(),
  );
  const deals: Deal[] = [...priorDeals, NORTH, SOUTH];

  // Timeline derives from CLOSINGS (rolling) or segment start/end (standard).
  // A deposit that falls outside the closing range must NOT stretch the timeline.
  const allDates: string[] = [];
  for (const d of deals) {
    for (const s of d.segments) {
      if (s.phase === "rolling" && s.closings) {
        for (const c of s.closings) allDates.push(c.date);
      } else {
        allDates.push(s.start, s.end);
      }
    }
  }
  // Recompute the timeline strictly from current deals — don't inherit an
  // older extended `timelineEnd` from the sheet, or Oct-27 lingers as an
  // empty column past North's last closing.
  let timelineStart = "";
  let timelineEnd = "";
  for (const iso of allDates) {
    const m = toMonthKey(iso);
    timelineStart = timelineStart ? minMonth(timelineStart, m) : m;
    timelineEnd   = timelineEnd   ? maxMonth(timelineEnd,   m) : m;
  }

  // Recompute totals (informational — server side of replaceAcqCalendar recomputes anyway).
  // `price` is the full acquisition amount per deal, so no need to add closings.
  const totals = deals.reduce(
    (acc, d) => ({ acres: acc.acres + d.acres, price: acc.price + d.price }),
    { acres: 0, price: 0 },
  );

  const cal: AcqCalendar = {
    title: existing?.title ?? "Master Acquisition Calendar",
    timelineStart,
    timelineEnd,
    deals,
    totals,
    totalsFromImage: existing?.totalsFromImage,
    // Overriding whatever's in the sheet — the entrance assemblages need this
    // wording specifically, and it should apply to every provisional row.
    footnote: "*not yet under contract",
    warnings: [],
  };

  console.log(`Plan: ${deals.length} deals total (${priorDeals.length} kept + North + South).`);
  console.log(`Timeline: ${timelineStart} → ${timelineEnd}`);
  console.log(`Totals: acres=${totals.acres.toLocaleString()}  price=$${Math.round(totals.price).toLocaleString()}`);

  if (dryRun) { console.log("\n(DRY RUN — re-run with --apply to persist.)"); return; }

  const result = await replaceAcqCalendar(cal);
  console.log(`✓ Wrote ${result.appended} rows (cleared ${result.cleared} prior rows).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
