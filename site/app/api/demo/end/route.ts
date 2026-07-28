import { DemoError, errorResponse, json } from "@/lib/demoError";
import { callUpstream } from "@/lib/upstream";

export const runtime = "nodejs";

// Deliberately uncapped: ending is how a session terminates, and blocking it
// would strand a visitor mid-demo with no summary.
export async function POST(req: Request): Promise<Response> {
  try {
    const sessId = new URL(req.url).searchParams.get("sessionId");
    if (!sessId) throw new DemoError(422, "missing_session_id", "Query must include sessionId");
    const out = await callUpstream(`/v1/sessions/${sessId}/end`, { method: "POST" });
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}
