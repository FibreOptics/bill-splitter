// Vercel serverless function: receipt image → structured line items via Claude vision.
// Requires ANTHROPIC_API_KEY set in Vercel project environment variables.
import Anthropic from "@anthropic-ai/sdk";
import type { VercelRequest, VercelResponse } from "@vercel/node";

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

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== "POST") {
    return response.status(405).json({ error: "POST only" });
  }
  const { imageBase64, mediaType } = request.body ?? {};
  if (typeof imageBase64 !== "string" || !imageBase64 ||
      !ALLOWED_MEDIA_TYPES.includes(mediaType as AllowedMediaType)) {
    return response.status(400).json({ error: "Expected { imageBase64, mediaType }" });
  }

  const client = new Anthropic();
  try {
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 4096,
      output_config: { format: { type: "json_schema", schema: RECEIPT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType as AllowedMediaType, data: imageBase64 },
            },
            {
              type: "text",
              text: "Extract the purchasable line items from this receipt. " +
                "Include each item's name and its line total (after per-item discounts). " +
                "Exclude subtotal, tax/VAT, service charge, cash, change, and card lines. " +
                "If quantity lines exist (e.g. '2x Spring Roll'), keep them as one item with the line total. " +
                "If it is not a receipt or nothing is readable, return an empty items array.",
            },
          ],
        },
      ],
    });

    if (message.stop_reason === "refusal") {
      return response.status(422).json({ error: "Model declined to process this image." });
    }
    const textBlock = message.content.find((block) => block.type === "text");
    const parsed = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}");
    return response.status(200).json({ items: parsed.items ?? [] });
  } catch (error) {
    const detail = error instanceof Anthropic.APIError ? `${error.status}: ${error.message}` :
      error instanceof Error ? error.message : "unknown";
    return response.status(502).json({ error: "Scan failed (" + detail + ")" });
  }
}
