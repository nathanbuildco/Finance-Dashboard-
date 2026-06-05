import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, isValidToken } from "@/app/lib/auth";
import { listClosedAcquisitions } from "@/app/lib/sheets";

export async function GET() {
  const cookieStore = await cookies();
  if (!isValidToken(cookieStore.get(AUTH_COOKIE)?.value)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const rows = await listClosedAcquisitions();
    return NextResponse.json({ rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error("[closed-acquisitions/list]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
