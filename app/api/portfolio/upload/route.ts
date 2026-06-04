import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, isValidToken } from "@/app/lib/auth";
import { parsePortfolioPdf } from "@/app/lib/portfolio-parser";
import { replaceSnapshotForDate } from "@/app/lib/sheets";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  if (!isValidToken(cookieStore.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a 'file' field." },
      { status: 400 },
    );
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' field." }, { status: 400 });
  }
  if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
    return NextResponse.json({ error: "File must be a PDF." }, { status: 400 });
  }
  if (file.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "PDF exceeds 25 MB." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const parsed = await parsePortfolioPdf(bytes, file.name);
    const nav = parsed.holdings.reduce((s, h) => s + h.marketValue, 0);
    const sheetResult = await replaceSnapshotForDate(parsed);
    return NextResponse.json({
      statementDate: parsed.statementDate,
      holdings: parsed.holdings,
      nav,
      sheet: sheetResult,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[portfolio/upload]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
