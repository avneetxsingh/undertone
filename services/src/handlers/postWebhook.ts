// Deploy placeholder — replaced with the real implementation in Task 8. It
// exists so the route, IAM grants and function wiring can be deployed and
// verified independently of the handler logic.
export const handler = async () => ({
  statusCode: 501,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ error: { code: "not_implemented", message: "coming soon" } }),
});
