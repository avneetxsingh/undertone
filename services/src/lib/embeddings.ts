import { ApiError } from "./errors";

// Embeddings run through Google's Gemini API (gemini-embedding-001). Bedrock
// Titan was the original choice, but that account's on-demand Titan quota is 0
// in every region and non-adjustable via Service Quotas, so it could never
// serve a request. Gemini's free tier does, with no per-region gating.
// GEMINI_BASE_URL is overridable so unit tests never hit the network.
export const EMBED_DIM = 768;
const MODEL_ID = "gemini-embedding-001";
const base = () => process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com";

export async function embedText(text: string): Promise<number[]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new ApiError(502, "embed_failed", "GEMINI_API_KEY is not configured");

  const res = await fetch(`${base()}/v1beta/models/${MODEL_ID}:embedContent?key=${key}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: text.slice(0, 8000) }] },
      outputDimensionality: EMBED_DIM,
    }),
  });
  if (!res.ok) throw new ApiError(502, "embed_failed", `Gemini embeddings returned ${res.status}`);

  const data = (await res.json()) as { embedding?: { values?: unknown } };
  const values = data.embedding?.values;
  if (!Array.isArray(values)) throw new ApiError(502, "embed_failed", "Gemini returned no embedding");
  return values as number[];
}
