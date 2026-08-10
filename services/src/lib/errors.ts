import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const json = (status: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode: status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const errorResponse = (e: unknown): APIGatewayProxyStructuredResultV2 => {
  if (e instanceof ApiError) return json(e.status, { error: { code: e.code, message: e.message } });
  console.error("unhandled error", e); // full detail goes to CloudWatch, not the caller
  return json(500, { error: { code: "internal", message: "Internal error" } });
};
