import { ApiError } from "./errors";

const base = () => process.env.GROQ_BASE_URL ?? "https://api.groq.com";

function checkStatus(status: number) {
  if (status === 401) throw new ApiError(402, "groq_key_invalid", "Groq rejected the stored key");
  if (status < 200 || status >= 300) throw new ApiError(502, "groq_upstream", `Groq returned ${status}`);
}

export async function transcribe(groqKey: string, audio: Buffer, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)]), filename);
  form.append("model", "whisper-large-v3");
  const res = await fetch(`${base()}/openai/v1/audio/transcriptions`, {
    method: "POST",
    headers: { authorization: `Bearer ${groqKey}` },
    body: form,
  });
  checkStatus(res.status);
  const data = await res.json();
  const text = (data as { text?: unknown }).text;
  if (typeof text !== "string") throw new ApiError(502, "groq_upstream", "Groq transcription returned no text");
  return text;
}

export async function chatText(groqKey: string, system: string, user: string): Promise<string> {
  const res = await fetch(`${base()}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${groqKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  checkStatus(res.status);
  const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new ApiError(502, "groq_upstream", "Groq chat returned no content");
  return content;
}

export async function chatJson(groqKey: string, system: string, user: string): Promise<unknown> {
  const res = await fetch(`${base()}/openai/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${groqKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  checkStatus(res.status);
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return JSON.parse(data.choices[0].message.content);
}
