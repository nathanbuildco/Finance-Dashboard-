import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { config } from "dotenv";

config({ path: ".env.local" });

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";

function authCookie(): string {
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw) throw new Error("DASHBOARD_PASSWORD not set");
  const token = createHmac("sha256", pw).update("authed").digest("hex");
  return `dashboard_auth=${token}`;
}

async function main() {
  const cookie = authCookie();

  console.log(`[1/3] GET /api/portfolio/snapshots (auth check + read path)`);
  const snapsRes = await fetch(`${BASE}/api/portfolio/snapshots`, {
    headers: { cookie },
  });
  console.log(`      status: ${snapsRes.status}`);
  if (!snapsRes.ok) {
    console.error(await snapsRes.text());
    process.exit(1);
  }
  const snaps = await snapsRes.json();
  console.log(`      ${snaps.snapshots.length} rows returned`);

  console.log(`[2/3] GET /api/portfolio/snapshots without cookie (auth rejected?)`);
  const unauthRes = await fetch(`${BASE}/api/portfolio/snapshots`);
  console.log(`      status: ${unauthRes.status} (expect 401)`);
  if (unauthRes.status !== 401) {
    console.error("      ✗ expected 401");
    process.exit(1);
  }

  console.log(`[3/3] POST /api/portfolio/upload (full multipart upload)`);
  const pdfPath = join(
    process.cwd(),
    "samples",
    "2001-20260430-Combined Statement-005 (2).pdf",
  );
  const bytes = readFileSync(pdfPath);
  const blob = new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
  const fd = new FormData();
  fd.append("file", blob, "sample.pdf");

  const t0 = Date.now();
  const upRes = await fetch(`${BASE}/api/portfolio/upload`, {
    method: "POST",
    headers: { cookie },
    body: fd,
  });
  console.log(`      status: ${upRes.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const upBody = await upRes.json();
  if (!upRes.ok) {
    console.error("      ✗ upload failed:", upBody);
    process.exit(1);
  }
  console.log(`      statementDate=${upBody.statementDate}`);
  console.log(`      NAV=$${upBody.nav.toLocaleString()}`);
  console.log(`      sheet: ${upBody.sheet.appended} appended, ${upBody.sheet.removed} replaced`);
  console.log(`      holdings: ${upBody.holdings.map((h: { ticker: string }) => h.ticker).join(", ")}`);

  console.log("\nAll HTTP routes OK.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
