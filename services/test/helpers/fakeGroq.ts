import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeGroqRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export function startFakeGroq(responses: { transcript?: string | null; chat?: unknown; chatRaw?: string | null; status?: number }) {
  const requests: FakeGroqRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const status = responses.status ?? 200;
      if (status !== 200) {
        res.writeHead(status);
        return res.end(JSON.stringify({ error: { message: "fake failure" } }));
      }
      if (req.url?.includes("/audio/transcriptions")) {
        res.writeHead(200, { "content-type": "application/json" });
        // transcript: null means "omit the text field" — simulates a malformed upstream response.
        res.end(JSON.stringify(responses.transcript === null ? {} : { text: responses.transcript ?? "hello world" }));
      } else if (req.url?.includes("/chat/completions")) {
        res.writeHead(200, { "content-type": "application/json" });
        // chatRaw: null means "omit the content field" — simulates a malformed upstream response.
        if (responses.chatRaw === null) {
          res.end(JSON.stringify({ choices: [{ message: {} }] }));
        } else {
          const content = responses.chatRaw ?? JSON.stringify(responses.chat ?? {});
          res.end(JSON.stringify({ choices: [{ message: { content } }] }));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise<{ url: string; close(): void; requests: FakeGroqRequest[] }>((resolve) =>
    server.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () => server.close(),
        requests,
      }),
    ),
  );
}
