import { ApiError } from "./errors";

const MAP: Record<string, string> = {
  "audio/webm": "webm",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
};

export function extFromContentType(ct?: string): string {
  const base = (ct ?? "").split(";")[0].trim().toLowerCase();
  const ext = MAP[base];
  if (!ext)
    throw new ApiError(422, "unsupported_audio_type", `content-type must be one of: ${Object.keys(MAP).join(", ")}`);
  return ext;
}
