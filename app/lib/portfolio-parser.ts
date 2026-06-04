import Anthropic, { toFile } from "@anthropic-ai/sdk";

export const INCLUDED_ACCOUNTS: Record<string, string> = {
  D47912001: "Alternative Assets",
  "41031274": "Margin equity",
};
export const EXCLUDED_ACCOUNTS = new Set(["T48879008"]);

export interface Holding {
  account: string;
  accountName: string;
  ticker: string;
  description: string;
  shares: number;
  costBasis: number;
  marketValue: number;
}

export interface ParsedStatement {
  statementDate: string;
  holdings: Holding[];
}

const HOLDINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    statementDate: {
      type: "string",
      description:
        "Statement 'as of' / period-end date in ISO format YYYY-MM-DD.",
    },
    holdings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          account: {
            type: "string",
            enum: Object.keys(INCLUDED_ACCOUNTS),
            description: "Account number — must be D47912001 or 41031274.",
          },
          accountName: {
            type: "string",
            enum: Object.values(INCLUDED_ACCOUNTS),
          },
          ticker: { type: "string", description: "Security ticker symbol." },
          description: {
            type: "string",
            description: "Full security name as printed on the statement.",
          },
          shares: { type: "number", description: "Shares / units held." },
          costBasis: {
            type: "number",
            description: "Total cost basis in USD.",
          },
          marketValue: {
            type: "number",
            description: "Current market value in USD on the statement date.",
          },
        },
        required: [
          "account",
          "accountName",
          "ticker",
          "description",
          "shares",
          "costBasis",
          "marketValue",
        ],
      },
    },
  },
  required: ["statementDate", "holdings"],
};

const SYSTEM_PROMPT = `You extract equity & fund holdings from J.P. Morgan consolidated investment statement PDFs.

INCLUDE only holdings from these accounts:
- D47912001 (Alternative Assets)
- 41031274 (Margin equity)

EXCLUDE entirely:
- Account T48879008 (Treasury ladder) and every position inside it
- Any consolidated / "all accounts" / "total portfolio" rollup rows
- Cash, money market sweeps, accrued interest, dividends receivable
- Any duplicate rollup that already appears as line items

For every included holding return:
- account: "D47912001" or "41031274"
- accountName: "Alternative Assets" or "Margin equity" — match the account
- ticker: the security symbol exactly as printed
- description: the full security name as printed
- shares: the share/unit quantity (number, no thousands separators)
- costBasis: total cost basis in USD (number, no $ or commas)
- marketValue: market value in USD on the statement date (number)

Set statementDate to the statement's "as of" / period-end date in YYYY-MM-DD.

Do not invent positions. If a value is unreadable, omit that holding rather than guess.`;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured.");
  return new Anthropic({ apiKey });
}

export async function parsePortfolioPdf(
  pdfBytes: Uint8Array,
  filename = "statement.pdf",
): Promise<ParsedStatement> {
  const client = getClient();

  const uploaded = await client.beta.files.upload({
    file: await toFile(pdfBytes, filename, { type: "application/pdf" }),
    betas: ["files-api-2025-04-14"],
  });

  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: HOLDINGS_SCHEMA,
        },
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: { type: "file", file_id: uploaded.id },
              title: filename,
            },
            {
              type: "text",
              text: "Extract all holdings from accounts D47912001 and 41031274 only. Do not include T48879008 or any consolidated rollup.",
            },
          ],
        },
      ],
      betas: ["files-api-2025-04-14"],
    });

    const jsonBlock = response.content.find(
      (b): b is Anthropic.Beta.BetaTextBlock => b.type === "text",
    );
    if (!jsonBlock) throw new Error("Model returned no text block.");

    let parsed: ParsedStatement;
    try {
      parsed = JSON.parse(jsonBlock.text);
    } catch {
      throw new Error(
        `Model returned non-JSON text: ${jsonBlock.text.slice(0, 200)}`,
      );
    }

    return sanitize(parsed);
  } finally {
    await client.beta.files
      .delete(uploaded.id, { betas: ["files-api-2025-04-14"] })
      .catch(() => {});
  }
}

function sanitize(raw: ParsedStatement): ParsedStatement {
  if (!raw || typeof raw !== "object") throw new Error("Empty parse result.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.statementDate || "")) {
    throw new Error(`Bad statementDate: ${raw.statementDate}`);
  }
  if (!Array.isArray(raw.holdings)) throw new Error("holdings is not an array.");

  const cleaned: Holding[] = [];
  for (const h of raw.holdings) {
    if (!h || typeof h !== "object") continue;
    if (EXCLUDED_ACCOUNTS.has(h.account)) continue;
    if (!(h.account in INCLUDED_ACCOUNTS)) continue;
    if (!h.ticker || !h.description) continue;
    if (!isFiniteNumber(h.shares) || !isFiniteNumber(h.costBasis) || !isFiniteNumber(h.marketValue)) continue;
    cleaned.push({
      account: h.account,
      accountName: INCLUDED_ACCOUNTS[h.account],
      ticker: String(h.ticker).trim(),
      description: String(h.description).trim(),
      shares: Number(h.shares),
      costBasis: Number(h.costBasis),
      marketValue: Number(h.marketValue),
    });
  }
  if (cleaned.length === 0) {
    throw new Error("No holdings extracted for included accounts.");
  }
  return { statementDate: raw.statementDate, holdings: cleaned };
}

function isFiniteNumber(n: unknown): boolean {
  return typeof n === "number" && Number.isFinite(n);
}
