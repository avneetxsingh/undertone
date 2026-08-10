import { DemoError, errorResponse, json } from "@/lib/demoError";
import { guardChunk } from "@/lib/guards";
import { callUpstream } from "@/lib/upstream";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    const sessId = new URL(req.url).searchParams.get("sessionId");
    if (!sessId) throw new DemoError(422, "missing_session_id", "Query must include sessionId");

    const audio = new Uint8Array(await req.arrayBuffer());
    // Validated before the guard so a silent or truncated segment does not burn
    // a cap slot; the platform rejects anything under 100 bytes anyway.
    if (audio.byteLength < 100) throw new DemoError(422, "empty_audio", "Audio payload too small to transcribe");

    await guardChunk(sessId);

    const out = await callUpstream(`/v1/sessions/${sessId}/chunks`, {
      method: "POST",
      body: audio,
      contentType: req.headers.get("content-type") ?? "audio/webm",
    });
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}
