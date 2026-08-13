import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import * as XLSX from "xlsx";
import { AUTH_COOKIE, isValidToken } from "@/app/lib/auth";
import { parseCashRequirementsSheet, listSheetNames } from "@/app/lib/cash-req-parser";
import { parseCashRequirementsImage } from "@/app/lib/cash-req-image-parser";
import { replaceCashRequirements } from "@/app/lib/sheets";

export const maxDuration = 300;

const XLSX_EXTS = /\.(xlsx|xlsm)$/i;
const XLSX_MIME = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel.sheet.macroEnabled.12",
  "application/vnd.ms-excel",
]);
const IMAGE_MIME: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};
const IMAGE_EXT_TO_MIME: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function detectKind(file: File): "image" | "xlsx" | "unknown" {
  const type = (file.type || "").toLowerCase();
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop() ?? "";
  if (IMAGE_MIME[type] || IMAGE_EXT_TO_MIME[ext]) return "image";
  if (XLSX_MIME.has(type) || XLSX_EXTS.test(name)) return "xlsx";
  return "unknown";
}

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
  const kind = detectKind(file);
  if (kind === "unknown") {
    return NextResponse.json(
      { error: `Unsupported file type: ${file.type || "(none)"}. Use a screenshot (PNG/JPEG) or .xlsx.` },
      { status: 400 },
    );
  }
  if (file.size > 25 * 1024 * 1024) {
    return NextResponse.json({ error: "File exceeds 25 MB." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const persistParam = String(formData.get("persist") ?? "1").toLowerCase();
  const persist = persistParam !== "0" && persistParam !== "false" && persistParam !== "no";

  try {
    if (kind === "image") {
      const type = (file.type || "").toLowerCase();
      const ext = file.name.toLowerCase().split(".").pop() ?? "";
      const mediaType = IMAGE_MIME[type] || IMAGE_EXT_TO_MIME[ext] || "image/png";
      const schedule = await parseCashRequirementsImage(bytes, mediaType);
      let sheet: { cleared: number; appended: number } | undefined;
      if (persist) sheet = await replaceCashRequirements(schedule);
      return NextResponse.json({ schedule, sheet, persisted: persist, mode: "image" });
    }

    // xlsx path
    const sheetParam = (formData.get("sheet") ?? "").toString().trim() || undefined;
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(bytes, { type: "array", cellDates: false, cellNF: false });
    } catch (e) {
      return NextResponse.json(
        { error: `Failed to parse workbook: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      );
    }
    const sheetNames = listSheetNames(workbook);
    if (sheetNames.length === 0) {
      return NextResponse.json({ error: "Workbook has no sheets." }, { status: 400 });
    }
    const schedule = parseCashRequirementsSheet(workbook, sheetParam);
    let sheet: { cleared: number; appended: number } | undefined;
    if (persist) sheet = await replaceCashRequirements(schedule);
    return NextResponse.json({ schedule, sheetNames, sheet, persisted: persist, mode: "xlsx" });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[cash-requirements/upload]", e);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
