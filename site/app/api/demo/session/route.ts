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
      body: JSON.stringify({ kind: "meeting", title: "Live demo" }),
    });
    return json(201, out);
  } catch (e) {
    return errorResponse(e);
  }
}
