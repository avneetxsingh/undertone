import { errorResponse, json } from "@/lib/demoError";
import { guardSessionCreate } from "@/lib/guards";
import { callUpstream } from "@/lib/upstream";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    await guardSessionCreate(req);
    const out = await callUpstream("/v1/sessions", {
      method: "POST",
      contentType: "application/json",
      // Every visitor shares this one platform account, so cross-session
      // memory would let one person's suggestions cite another's meeting.
      // Isolated sessions still get their own transcript as context.
      body: JSON.stringify({ kind: "meeting", title: "Live demo", isolateMemory: true }),
    });
    return json(201, out);
  } catch (e) {
    return errorResponse(e);
  }
}
