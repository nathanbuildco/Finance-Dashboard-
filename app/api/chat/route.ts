import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { AUTH_COOKIE, isValidToken } from "@/app/lib/auth";

export async function POST(request: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY is not configured on the server." }, { status: 500 });
  }

  // Reuse the dashboard's cookie auth so the chat endpoint isn't open to the internet.
  const cookieStore = await cookies();
  const token = cookieStore.get(AUTH_COOKIE)?.value;
  if (!isValidToken(token)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { question?: unknown; financialData?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "Question is required." }, { status: 400 });
  }

  const systemPrompt = `You are a financial analyst assistant for The Building Company. You have access to their financial projections data. Answer questions concisely about spending, costs, headcount, and projections. Use specific numbers from the data provided.

Current financial data (JSON):
${JSON.stringify(body.financialData ?? {}, null, 2)}`;

  const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      // System prompt is cacheable — financial data doesn't change between most requests,
      // so subsequent questions in the same 5-min window hit the cache.
      system: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [{ role: "user", content: question }],
    }),
  });

  if (!apiResponse.ok) {
    const errText = await apiResponse.text();
    console.error("[chat] Anthropic API error:", apiResponse.status, errText);
    return NextResponse.json({ error: `Anthropic API error (${apiResponse.status}): ${errText}` }, { status: apiResponse.status });
  }

  const data = await apiResponse.json();
  const answer = data?.content?.[0]?.text ?? "(no response)";
  return NextResponse.json({ answer });
}
