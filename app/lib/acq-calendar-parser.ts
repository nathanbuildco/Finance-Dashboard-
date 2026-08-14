// Image → AcqCalendar via Claude vision + JSON-schema constrained output.
// Mirrors the pattern in cash-req-image-parser.ts and land-parser.ts.

import Anthropic from "@anthropic-ai/sdk";
import { validateCalendar, type AcqCalendar } from "./acq-calendar-model";
import { ACQ_CALENDAR_SYSTEM_PROMPT } from "./acq-calendar-prompt";

type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const CALENDAR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    timelineStart: {
      type: "string",
      description: "First month rendered on the timeline header, format 'YYYY-MM'.",
    },
    timelineEnd: {
      type: "string",
      description: "Last month rendered on the timeline header, format 'YYYY-MM'.",
    },
    deals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            description:
              "Deal name exactly as printed. Preserve any trailing asterisk that marks provisional / subject-to-PSA deals.",
          },
          acres: { type: "number", description: "Full number of acres (no thousands separator)." },
          price: {
            type: "number",
            description:
              "Full dollar price. E.g. $11.36M in the source → 11360000.",
          },
          depositLabel: {
            type: "string",
            description:
              "First DEPOSIT line as printed, e.g. '$250K + $250K + $500K ext'. Do NOT sum.",
          },
          depositNote: {
            type: ["string", "null"],
            description:
              "Optional parenthetical shown beneath depositLabel (e.g. '($100K option money)'), or null.",
          },
          depositIsRate: {
            type: ["boolean", "null"],
            description:
              "True when depositLabel is a rate expression like '1.5% of purchase price'. Reserved for rolling deals; extractors will usually leave this null.",
          },
          segments: {
            type: "array",
            description:
              "Bar segments in left-to-right (chronological) order along the timeline.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                phase: {
                  type: "string",
                  enum: ["contingency", "expectedClosing", "extension", "rolling"],
                  description:
                    "'contingency' = saturated blue; 'expectedClosing' = lighter blue tint; 'extension' = neutral gray; 'rolling' = single continuous band representing a monthly rolling-closing schedule. Rolling deals have exactly one segment and never a contingency/closing/extension pattern.",
                },
                start: {
                  type: "string",
                  description:
                    "ISO date 'YYYY-MM-DD' at the segment's left edge. For rolling: first day of the FIRST CLOSING'S month (not the deposit month).",
                },
                end: {
                  type: "string",
                  description:
                    "ISO date 'YYYY-MM-DD' at the segment's right edge (inclusive). For rolling: last day of the LAST CLOSING'S month.",
                },
                milestoneDate: {
                  type: ["string", "null"],
                  description:
                    "Full ISO 'YYYY-MM-DD' for the small M/D label drawn above the segment's right edge, or null. Rolling segments never carry one.",
                },
                closings: {
                  type: ["array", "null"],
                  description:
                    "Rolling segments only: ordered list of closings, chronological. Each carries the closing date and the dollar amount closing on that date.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      date: { type: "string", description: "ISO 'YYYY-MM-DD'." },
                      amount: { type: "number", description: "Dollar amount closing on that date." },
                    },
                    required: ["date", "amount"],
                  },
                },
                note: {
                  type: ["string", "null"],
                  description:
                    "Optional per-segment note (e.g. rolling terms like 'per parcel, at each closing'). Rolling segments only.",
                },
              },
              required: ["phase", "start", "end", "milestoneDate"],
            },
          },
        },
        required: ["name", "acres", "price", "depositLabel", "depositNote", "segments"],
      },
    },
    totalsFromImage: {
      type: ["object", "null"],
      description: "Values from the image's TOTAL row, if present; otherwise null.",
      additionalProperties: false,
      properties: {
        acres: { type: "number" },
        price: { type: "number" },
      },
      required: ["acres", "price"],
    },
    footnote: {
      type: ["string", "null"],
      description: "Small text at the bottom of the chart, e.g. '*subject to PSA execution'.",
    },
  },
  required: ["title", "timelineStart", "timelineEnd", "deals", "footnote"],
};

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured on the server.");
  return new Anthropic({ apiKey });
}

export async function parseAcqCalendarImage(
  imageBytes: Uint8Array,
  mediaType: ImageMediaType,
): Promise<AcqCalendar> {
  const client = getClient();
  const base64 = Buffer.from(imageBytes).toString("base64");

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: { type: "json_schema", schema: CALENDAR_SCHEMA },
    },
    system: ACQ_CALENDAR_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: "Extract the full acquisition calendar from this screenshot." },
        ],
      },
    ],
  });

  const jsonBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!jsonBlock) throw new Error("Model returned no text block.");

  let raw: unknown;
  try {
    raw = JSON.parse(jsonBlock.text);
  } catch {
    throw new Error(`Model returned non-JSON text: ${jsonBlock.text.slice(0, 200)}`);
  }

  const result = validateCalendar(raw);
  if ("issues" in result) {
    throw new Error(`Extracted calendar failed validation: ${result.issues.join("; ")}`);
  }
  return result.data;
}
