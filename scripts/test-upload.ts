import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

import { parsePortfolioPdf } from "../app/lib/portfolio-parser";
import { replaceSnapshotForDate, listSnapshots } from "../app/lib/sheets";

async function main() {
  const pdfPath = join(
    process.cwd(),
    "samples",
    "2001-20260430-Combined Statement-005 (2).pdf",
  );
  const bytes = readFileSync(pdfPath);

  console.log("[1/4] Parsing PDF…");
  const t0 = Date.now();
  const parsed = await parsePortfolioPdf(bytes, "sample.pdf");
  console.log(`      done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${parsed.holdings.length} holdings, date=${parsed.statementDate}`);
  const nav = parsed.holdings.reduce((s, h) => s + h.marketValue, 0);
  console.log(`      NAV = $${nav.toLocaleString()}`);

  console.log("[2/4] Writing to Sheets (ensure tab + replace snapshot)…");
  const result = await replaceSnapshotForDate(parsed);
  console.log(`      ${result.appended} rows appended, ${result.removed} prior rows replaced`);

  console.log("[3/4] Reading back snapshots…");
  const all = await listSnapshots();
  console.log(`      ${all.length} total rows in Portfolio tab`);
  const forThisDate = all.filter((s) => s.statementDate === parsed.statementDate);
  console.log(`      ${forThisDate.length} rows for ${parsed.statementDate}`);

  console.log("[4/4] Validating round-trip…");
  for (const h of parsed.holdings) {
    const match = forThisDate.find((s) => s.ticker === h.ticker);
    if (!match) {
      console.error(`      ✗ ${h.ticker}: not found in sheet`);
      process.exitCode = 1;
      continue;
    }
    const okShares = match.shares === h.shares;
    const okCost = Math.abs(match.costBasis - h.costBasis) < 0.01;
    const okMv = Math.abs(match.marketValue - h.marketValue) < 0.01;
    const okPL = Math.abs(match.unrealized - (h.marketValue - h.costBasis)) < 0.01;
    const ok = okShares && okCost && okMv && okPL;
    console.log(
      `      ${ok ? "✓" : "✗"} ${h.ticker}: shares=${match.shares} cost=$${match.costBasis.toLocaleString()} mv=$${match.marketValue.toLocaleString()} unrealized=$${match.unrealized.toLocaleString()}`,
    );
    if (!ok) process.exitCode = 1;
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
