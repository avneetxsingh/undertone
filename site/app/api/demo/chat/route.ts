import { DemoError, errorResponse, json } from "@/lib/demoError";
import { guardChat } from "@/lib/guards";
import { callUpstream } from "@/lib/upstream";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  try {
    let body: { sessionId?: unknown; prompt?: unknown };
    try {
      body = await req.json();
    } catch {
      throw new DemoError(400, "invalid_json", "Request body is not valid JSON");
    }
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!sessionId) throw new DemoError(422, "missing_session_id", "Body must include sessionId");
    if (!prompt) throw new DemoError(422, "missing_prompt", "Body must include prompt");

    await guardChat(sessionId);

    const out = await callUpstream("/v1/chat", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({ sessionId, prompt }),
    });
    return json(200, out);
  } catch (e) {
    return errorResponse(e);
  }
}
