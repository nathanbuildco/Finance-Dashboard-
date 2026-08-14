// Sample AcqCalendar fixture — hand-written data used to test the render surface
// without an actual screenshot upload. Includes both rolling-closing assemblages
// (North / South Entrance) so their band + tick + M/D-label rendering can be
// verified end-to-end. Standard-phase deals are placeholder values.

import type { AcqCalendar } from "../acq-calendar-model";

export const SAMPLE_CALENDAR: AcqCalendar = {
  title: "Master Acquisition Calendar",
  timelineStart: "2026-01",
  timelineEnd:   "2027-09",
  deals: [
    {
      name: "H&PB Basco",
      provisional: false,
      acres: 1200,
      price: 63_220_895,
      depositLabel: "$500K + $9.5M + $3.05M ext",
      depositNote: "($500K option money)",
      segments: [
        { phase: "contingency",     start: "2026-03-05", end: "2026-06-30", milestoneDate: "2026-06-30" },
        { phase: "extension",       start: "2026-06-30", end: "2026-08-28", milestoneDate: "2026-08-28" },
        { phase: "expectedClosing", start: "2026-08-28", end: "2026-12-10", milestoneDate: "2026-12-10" },
      ],
    },
    {
      name: "Tex Mix",
      provisional: false,
      acres: 800,
      price: 57_360_687,
      depositLabel: "$241K + $965K + $2.05M ext",
      depositNote: null,
      segments: [
        { phase: "contingency",     start: "2026-03-05", end: "2026-06-30", milestoneDate: "2026-06-30" },
        { phase: "extension",       start: "2026-06-30", end: "2026-08-28", milestoneDate: "2026-08-28" },
        { phase: "expectedClosing", start: "2026-08-28", end: "2026-12-10", milestoneDate: "2026-12-10" },
      ],
    },
    {
      name: "Sattar Land",
      provisional: true,
      acres: 210,
      price: 11_360_000,
      depositLabel: "$100K + $250K + $500K ext",
      depositNote: "($100K option money)",
      segments: [
        { phase: "contingency",     start: "2026-05-01", end: "2026-08-15", milestoneDate: "2026-08-15" },
        { phase: "expectedClosing", start: "2026-08-15", end: "2026-11-20", milestoneDate: "2026-11-20" },
      ],
    },
    {
      name: "North Entrance Assemblage",
      provisional: true,
      acres: 100,
      // Full acquisition amount = $15K deposit + 9 × $1.5M + $1.485M final = $15,000,000
      price: 15_000_000,
      depositLabel: "1% of purchase price",
      depositNote: "per parcel, at each closing",
      depositIsRate: true,
      segments: [
        {
          // Band starts at the FIRST CLOSING's month (Dec-26), not the deposit month (Nov-26).
          phase: "rolling",
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
    },
    {
      name: "South Entrance Assemblage",
      provisional: true,
      acres: 25,
      // Full acquisition amount = $7,575 deposit + 4 × $757,500 + $749,925 final = $3,787,500
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
    },
  ],
  // These are for reference — validateCalendar recomputes on load.
  //   acres  = 1200 + 800 + 210 + 100 + 25 = 2335
  //   price  = 63,220,895 + 57,360,687 + 11,360,000
  //          + (15,000  + 10 closings totalling 14,985,000)   ← 15,000,000
  //          + (7,575   + 5  closings totalling 3,779,925)    ← 3,787,500
  //          = 150,728,082    (placeholder standard deals; live totals will differ)
  totals: { acres: 2335, price: 150_728_082 },
  footnote: "*not yet under contract",
  warnings: [],
};
