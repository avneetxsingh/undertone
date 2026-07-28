export class DemoError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export const errorResponse = (e: unknown): Response => {
  if (e instanceof DemoError) return json(e.status, { error: { code: e.code, message: e.message } });
  console.error("unhandled error", e); // detail stays in server logs, never in the response
  return json(500, { error: { code: "internal", message: "Internal error" } });
};
