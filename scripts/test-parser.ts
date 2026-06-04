import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "dotenv";
import { parsePortfolioPdf } from "../app/lib/portfolio-parser";

config({ path: ".env.local" });

async function main() {
  const pdfPath = join(
    process.cwd(),
    "samples",
    "2001-20260430-Combined Statement-005 (2).pdf",
  );
  const bytes = readFileSync(pdfPath);
  console.log(`Parsing ${bytes.length} bytes from ${pdfPath}…`);
  const t0 = Date.now();
  const result = await parsePortfolioPdf(bytes, "sample.pdf");
  console.log(`Done in ${(Date.now() - t0) / 1000}s.`);
  console.log(JSON.stringify(result, null, 2));

  const nav = result.holdings.reduce((s, h) => s + h.marketValue, 0);
  console.log(`\nStatement date: ${result.statementDate}`);
  console.log(`Holdings: ${result.holdings.length}`);
  console.log(`NAV (sum of marketValue): $${nav.toLocaleString()}`);

  const ibit = result.holdings.find((h) => h.ticker === "IBIT");
  const mstr = result.holdings.find((h) => h.ticker === "MSTR");
  console.log("\n--- Validation ---");
  console.log(`IBIT: shares=${ibit?.shares} cost=${ibit?.costBasis} mv=${ibit?.marketValue}`);
  console.log(`  expect: shares=175000 cost=11863337.5 mv=7581000`);
  console.log(`MSTR: shares=${mstr?.shares} cost=${mstr?.costBasis} mv=${mstr?.marketValue}`);
  console.log(`  expect: shares=12000 cost=2395952.24 mv=1985400`);
  console.log(`NAV: ${nav.toFixed(2)}  expect: 9566400.00`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
