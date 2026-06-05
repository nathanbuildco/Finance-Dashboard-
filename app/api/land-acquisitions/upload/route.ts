import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, isValidToken } from "@/app/lib/auth";
import { parseLandAcquisitionsImage } from "@/app/lib/land-parser";
import { replaceLandAcquisitions } from "@/app/lib/sheets";

export const maxDuration = 300;

const ACCEPTED: Record<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp"> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/gif": "image/gif",
  "image/webp": "image/webp",
};

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

  const mediaType = ACCEPTED[file.type.toLowerCase()];
  if (!mediaType) {
    return NextResponse.json(
      { error: `Unsupported image type: ${file.type}. Use PNG, JPEG, GIF, or WebP.` },
      { status: 400 },
    );
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: "Image exceeds 10 MB." }, { status: 413 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    const parsed = await parseLandAcquisitionsImage(bytes, mediaType);
    const sheetResult = await replaceLandAcquisitions(parsed.transactions);
    return NextResponse.json({
      transactions: parsed.transactions,
      sheet: sheetResult,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[land-acquisitions/upload]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
