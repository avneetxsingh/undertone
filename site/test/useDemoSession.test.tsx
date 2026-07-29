// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useDemoSession } from "@/hooks/useDemoSession";
import { REPLAY_SESSION } from "@/lib/replay";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  mimeType = "audio/webm;codecs=opus";
  constructor() {
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(500)], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const grantMic = () =>
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) },
  });

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("crypto", { randomUUID: () => Math.random().toString(36) });
  grantMic();
});
afterEach(() => vi.unstubAllGlobals());

describe("useDemoSession", () => {
  test("a denied microphone degrades to replay rather than erroring out", async () => {
    vi.stubGlobal("navigator", {
      mediaDevices: {
        // `name` is a getter on DOMException — it has to come from the constructor.
        getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
      },
    });
    const { result } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe("replay");
    expect(result.current.error).toMatch(/microphone/i);
    await waitFor(() => expect(result.current.chunks.length).toBeGreaterThan(0));
    expect(result.current.chunks[0].text).toBe(REPLAY_SESSION[0].transcript.trim());
  });

  test("a successful segment appends a transcript chunk and a suggestion batch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/api/demo/session")
          ? new Response(JSON.stringify({ id: "s1" }), { status: 201 })
          : new Response(
              JSON.stringify({
                seq: 1,
                transcript: "we should ship on friday",
                suggestions: [{ type: "TALKING_POINT", preview: "p", detail_prompt: "d" }],
              }),
              { status: 200 },
            ),
      ),
    );
    const { result } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      FakeMediaRecorder.instances[0].stop();
    });

    await waitFor(() => {
      expect(result.current.chunks.at(-1)?.text).toBe("we should ship on friday");
      expect(result.current.batches[0].suggestions).toHaveLength(1);
    });
  });

  test("demo_session_complete ends the session and stops recording", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/demo/session")) return new Response(JSON.stringify({ id: "s1" }), { status: 201 });
        if (url.includes("/api/demo/end"))
          return new Response(JSON.stringify({ status: "ended", summary: "s", actionItems: [] }), { status: 200 });
        return new Response(JSON.stringify({ error: { code: "demo_session_complete", message: "limit" } }), {
          status: 409,
        });
      }),
    );
    const { result } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      FakeMediaRecorder.instances[0].stop();
    });

    await waitFor(() => expect(result.current.status).toBe("complete"));
  });

  test("demo_capacity on session create switches to replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { code: "demo_capacity", message: "full" } }), { status: 503 }),
      ),
    );
    const { result } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe("replay");
  });
});
