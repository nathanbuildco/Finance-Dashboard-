import Anthropic from "@anthropic-ai/sdk";

export interface LandTxn {
  deal: string;
  type: string;
  amount: number;
  date: string;
}

export interface ParsedLandAcquisitions {
  transactions: LandTxn[];
}

const LAND_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    transactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          deal: {
            type: "string",
            description:
              "Deal / property name as printed (e.g. 'Snider', 'Lockwood', 'H&PB Basco').",
          },
          type: {
            type: "string",
            description:
              "Milestone or line-item label as printed (e.g. 'Initial Deposit', 'Contingency Ext.', 'Addl. Deposit', 'Close Extension', 'Closing Cost', 'Closing').",
          },
          amount: {
            type: "number",
            description:
              "Cash requirement in USD as a plain number — no $ or commas. Preserve the sign exactly as shown: credits/offsets (e.g. a 'Closing Cost' line that reduces the cash due) are negative; inflows/payments are positive.",
          },
          date: {
            type: "string",
            description:
              "Due date in ISO format YYYY-MM-DD. Convert any printed date (e.g. '3/26/26', 'Mar 26, 2026') to this format.",
          },
        },
        required: ["deal", "type", "amount", "date"],
      },
    },
  },
  required: ["transactions"],
};

const SYSTEM_PROMPT = `You extract land-deal cash requirements from screenshots of an internal spreadsheet.

Each row in the screenshot represents one cash event for one deal — an initial deposit, an additional deposit, a contingency extension, a close extension, a closing cost, or a closing payment.

For every row return:
- deal: the deal / property name as printed
- type: the milestone label as printed
- amount: the dollar amount in USD as a plain number (no $ or commas). Preserve the sign exactly as shown — if a value is parenthesized or shown in red as a credit/offset, return it as a negative number.
- date: the due date in YYYY-MM-DD

Rules:
- Skip header rows, subtotal rows, total rows, and any "Grand Total" / per-deal subtotal.
- Skip blank rows.
- Do not invent values. If any of deal, type, amount, or date is unreadable for a row, omit that row entirely rather than guess.
- If the screenshot shows years in 2-digit form (e.g. '26'), interpret as 20YY.`;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
  return new Anthropic({ apiKey });
}

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export async function parseLandAcquisitionsImage(
  imageBytes: Uint8Array,
  mediaType: ImageMediaType,
): Promise<ParsedLandAcquisitions> {
  const client = getClient();

  const base64 = Buffer.from(imageBytes).toString("base64");

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: LAND_SCHEMA,
      },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: base64 },
          },
          {
            type: "text",
            text: "Extract every land-deal cash requirement row from this screenshot.",
          },
        ],
      },
    ],
  });

  const jsonBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!jsonBlock) throw new Error("Model returned no text block.");

  let parsed: ParsedLandAcquisitions;
  try {
    parsed = JSON.parse(jsonBlock.text);
  } catch {
    throw new Error(
      `Model returned non-JSON text: ${jsonBlock.text.slice(0, 200)}`,
    );
  }

  return sanitize(parsed);
}

function sanitize(raw: ParsedLandAcquisitions): ParsedLandAcquisitions {
  if (!raw || typeof raw !== "object") throw new Error("Empty parse result.");
  if (!Array.isArray(raw.transactions))
    throw new Error("transactions is not an array.");

  const cleaned: LandTxn[] = [];
  for (const t of raw.transactions) {
    if (!t || typeof t !== "object") continue;
    if (!t.deal || !t.type || !t.date) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) continue;
    if (typeof t.amount !== "number" || !Number.isFinite(t.amount)) continue;
    cleaned.push({
      deal: String(t.deal).trim(),
      type: String(t.type).trim(),
      amount: Number(t.amount),
      date: t.date,
    });
  }
  if (cleaned.length === 0) {
    throw new Error("No land-acquisition rows extracted from image.");
  }
  return { transactions: cleaned };
}
