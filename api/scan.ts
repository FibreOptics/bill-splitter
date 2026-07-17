// Vercel serverless function: receipt image → structured line items.
// Primary: Gemini free tier (GEMINI_API_KEY). Fallback: Claude (ANTHROPIC_API_KEY).
// Set either or both in Vercel project environment variables.
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { VercelRequest, VercelResponse } from "@vercel/node";

const PROMPT =
  "Extract the purchasable line items from this receipt. " +
  "Include each item's name and its line total (after per-item discounts). " +
  "Exclude subtotal, tax/VAT, service charge, cash, change, and card lines. " +
  "If quantity lines exist (e.g. '2x Spring Roll'), keep them as one item with the line total. " +
  "If it is not a receipt or nothing is readable, return an empty items array.";

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Item name as printed, cleaned up" },
          price: { type: "number", description: "Line total for this item" },
        },
        required: ["name", "price"],
        additionalProperties: false,
      },
    },
  },
  required: ["items"],
  additionalProperties: false,
} as const;

const ALLOWED_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

interface ScannedItem { name: string; price: number }

async function scanWithGemini(imageBase64: string, mediaType: string): Promise<ScannedItem[]> {
  const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const response = await gemini.models.generateContent({
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { mimeType: mediaType, data: imageBase64 } },
          { text: PROMPT },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: RECEIPT_SCHEMA,
    },
  });
  return JSON.parse(response.text ?? "{}").items ?? [];
}

async function scanWithClaude(imageBase64: string, mediaType: AllowedMediaType): Promise<ScannedItem[]> {
  const claude = new Anthropic();
  const message = await claude.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    output_config: { format: { type: "json_schema", schema: RECEIPT_SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });
  if (message.stop_reason === "refusal") throw new Error("Model declined to process this image.");
  const textBlock = message.content.find((block) => block.type === "text");
  return JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}").items ?? [];
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "POST only" });
  }
  const { imageBase64, mediaType } = request.body ?? {};
  if (typeof imageBase64 !== "string" || !imageBase64 ||
      !ALLOWED_MEDIA_TYPES.includes(mediaType as AllowedMediaType)) {
    return response.status(400).json({ error: "Expected { imageBase64, mediaType }" });
  }

  const hasGemini = Boolean(process.env.GEMINI_API_KEY);
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  if (!hasGemini && !hasClaude) {
    return response.status(503).json({
      error: "No scan provider configured — set GEMINI_API_KEY (or ANTHROPIC_API_KEY) in Vercel env vars.",
    });
  }

  try {
    if (hasGemini) {
      try {
        return response.status(200).json({ items: await scanWithGemini(imageBase64, mediaType), provider: "gemini" });
      } catch (geminiError) {
        if (!hasClaude) throw geminiError;
        // Gemini down or rate-limited — fall through to Claude.
      }
    }
    return response.status(200).json({ items: await scanWithClaude(imageBase64, mediaType as AllowedMediaType), provider: "claude" });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown";
    return response.status(502).json({ error: "Scan failed (" + detail + ")" });
  }
}
