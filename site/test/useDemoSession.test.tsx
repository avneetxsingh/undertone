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

  test("stop() during a replay halts further appends", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
        },
      });
      const { result } = renderHook(() => useDemoSession());

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.status).toBe("replay");

      // Let the (deferred) first replay chunk land before we stop.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.chunks.length).toBeGreaterThan(0);

      await act(async () => {
        await result.current.stop();
      });
      expect(result.current.status).toBe("complete");
      const countAfterStop = result.current.chunks.length;

      // Advance past the entire remaining replay schedule — nothing should append.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000 * REPLAY_SESSION.length);
      });

      expect(result.current.chunks.length).toBe(countAfterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  test("two overlapping replay triggers do not double the appended chunks", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.includes("/api/demo/session")
            ? new Response(JSON.stringify({ id: "s1" }), { status: 201 })
            : new Response(JSON.stringify({ transcript: "", suggestions: [] }), { status: 200 }),
        ),
      );
      const { result } = renderHook(() => useDemoSession());

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.status).toBe("recording");

      const recorder = FakeMediaRecorder.instances[0];
      const onError = recorder.onerror;

      // Two failure signals landing back-to-back in the same tick — e.g. a
      // recorder error racing an in-flight sendSegment failure — must not
      // start two overlapping replay loops.
      await act(async () => {
        onError?.();
        onError?.();
        await vi.advanceTimersByTimeAsync(15000 * REPLAY_SESSION.length);
      });

      expect(result.current.status).toBe("replay");
      expect(result.current.chunks.length).toBe(REPLAY_SESSION.length);
      expect(result.current.batches.length).toBe(REPLAY_SESSION.length);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a successful start() cancels a replay chain instead of interleaving fixture text", async () => {
    vi.useFakeTimers();
    try {
      // First click: the mic is denied, so the canned session starts playing.
      vi.stubGlobal("navigator", {
        mediaDevices: {
          getUserMedia: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          String(url).includes("/api/demo/session")
            ? new Response(JSON.stringify({ id: "s1" }), { status: 201 })
            : new Response(JSON.stringify({ transcript: "", suggestions: [] }), { status: 200 }),
        ),
      );
      const { result } = renderHook(() => useDemoSession());

      await act(async () => {
        await result.current.start();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.status).toBe("replay");
      expect(result.current.chunks.length).toBe(1);

      // The visitor grants permission in the browser and clicks the mic again.
      grantMic();
      const fixtureText = new Set(REPLAY_SESSION.map((c) => c.transcript.trim()));
      const fixtureChunks = () => result.current.chunks.filter((c) => fixtureText.has(c.text)).length;

      await act(async () => {
        await result.current.start();
      });
      expect(result.current.status).toBe("recording");
      const fixturesAtStart = fixtureChunks();

      // Nothing more from the fixture may land now that the banner is gone:
      // the status is "recording", so a canned line would read as the
      // visitor's own audio.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000 * REPLAY_SESSION.length);
      });

      expect(fixtureChunks()).toBe(fixturesAtStart);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a failed start() releases the re-entry guard so the visitor can retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "demo_capacity", message: "full" } }), { status: 503 }),
      )
      .mockResolvedValue(new Response(JSON.stringify({ id: "s2" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("replay");

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe("recording");
    await act(async () => {
      await result.current.stop();
    });
  });

  test("a second live session starts from a clean pane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/api/demo/session")) return new Response(JSON.stringify({ id: "s1" }), { status: 201 });
        if (u.includes("/api/demo/end")) return new Response(JSON.stringify({ status: "ended" }), { status: 200 });
        if (u.includes("/api/demo/chat")) return new Response(JSON.stringify({ reply: "because" }), { status: 200 });
        return new Response(
          JSON.stringify({
            seq: 1,
            transcript: "we should ship on friday",
            suggestions: [{ type: "TALKING_POINT", preview: "p", detail_prompt: "d" }],
          }),
          { status: 200 },
        );
      }),
    );
    const { result } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      FakeMediaRecorder.instances[0].stop();
    });
    await act(async () => {
      await result.current.ask("why friday?");
    });
    await waitFor(() => {
      expect(result.current.chunks.length).toBe(1);
      expect(result.current.batches.length).toBe(1);
      expect(result.current.messages.length).toBe(2);
    });

    await act(async () => {
      await result.current.stop();
    });
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.chunks).toHaveLength(0);
    expect(result.current.batches).toHaveLength(0);
    expect(result.current.messages).toHaveLength(0);

    await act(async () => {
      await result.current.stop();
    });
  });

  test("two clicks in the same tick create exactly one demo session", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes("/api/demo/session")
        ? new Response(JSON.stringify({ id: "s1" }), { status: 201 })
        : new Response(JSON.stringify({ transcript: "", suggestions: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDemoSession());

    // start() awaits getUserMedia before it touches any state, so a double
    // click lands entirely inside that window.
    await act(async () => {
      await Promise.all([result.current.start(), result.current.start()]);
    });

    const sessionPosts = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("/api/demo/session"),
    );
    expect(sessionPosts).toHaveLength(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(result.current.status).toBe("recording");
  });

  test("a chunk still in flight when stop() lands does not flip the demo into replay", async () => {
    vi.useFakeTimers();
    try {
      let releaseChunk!: (r: Response) => void;
      const inFlight = new Promise<Response>((resolve) => {
        releaseChunk = resolve;
      });
      const fetchMock = vi.fn(async (url: string) => {
        const u = String(url);
        if (u.includes("/api/demo/session")) return new Response(JSON.stringify({ id: "s1" }), { status: 201 });
        if (u.includes("/api/demo/end")) return new Response(JSON.stringify({ status: "ended" }), { status: 200 });
        return inFlight;
      });
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useDemoSession());

      await act(async () => {
        await result.current.start();
      });
      // Segment boundary: the chunk POST is now sitting in Whisper.
      await act(async () => {
        FakeMediaRecorder.instances[0].stop();
      });

      await act(async () => {
        await result.current.stop();
      });
      expect(result.current.status).toBe("complete");

      // The chunk lands on the session the visitor just ended — the platform
      // answers 404 session_not_found.
      await act(async () => {
        releaseChunk(
          new Response(JSON.stringify({ error: { code: "session_not_found", message: "gone" } }), {
            status: 404,
          }),
        );
        await vi.advanceTimersByTimeAsync(15000 * REPLAY_SESSION.length);
      });

      // Guard against the test passing because no chunk was ever uploaded.
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/demo/chunk"))).toHaveLength(1);
      expect(result.current.status).toBe("complete");
      expect(result.current.chunks).toHaveLength(0);
      expect(result.current.batches).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("replay does not answer chat against the previous live session", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (url: string) =>
        String(url).includes("/api/demo/session")
          ? new Response(JSON.stringify({ id: "s1" }), { status: 201 })
          : new Response(JSON.stringify({ reply: "from the real meeting" }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { result } = renderHook(() => useDemoSession());

      await act(async () => {
        await result.current.start();
      });
      // A real session id is now held; the fixture takes over from here.
      expect(result.current.status).toBe("recording");
      await act(async () => {
        FakeMediaRecorder.instances[0].onerror?.();
      });
      expect(result.current.status).toBe("replay");

      // The visitor clicks a fixture suggestion. Answering it against the
      // earlier real session would describe a transcript nobody can see.
      await act(async () => {
        await result.current.ask("why is verification failing?");
      });

      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/demo/chat"))).toHaveLength(0);
      expect(result.current.messages.at(-1)?.content).toMatch(/live session/i);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a recorder that throws on start() degrades to replay instead of latching the mic", async () => {
    // getUserMedia succeeded, but the stream died before the recorder could
    // start — a permission revoked from the browser's site controls, or a USB
    // mic unplugged. The constructor accepts the dead stream; start() is where
    // it surfaces.
    class DeadStreamRecorder extends FakeMediaRecorder {
      start(): never {
        throw new DOMException("The MediaStream is inactive", "InvalidStateError");
      }
    }
    vi.stubGlobal("MediaRecorder", DeadStreamRecorder);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/api/demo/session")
          ? new Response(JSON.stringify({ id: "s1" }), { status: 201 })
          : new Response(JSON.stringify({ transcript: "", suggestions: [] }), { status: 200 }),
      ),
    );
    const { result } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });

    expect(result.current.status).toBe("replay");
    expect(result.current.error).toMatch(/recorded session/i);
    await waitFor(() => expect(result.current.chunks.length).toBeGreaterThan(0));

    // And the re-entry guard was released, so the visitor is not locked out:
    // clicking again with a working recorder still reaches a live session.
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("recording");

    await act(async () => {
      await result.current.stop();
    });
  });

  test("unmounting while recording stops the media tracks and clears the elapsed interval", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/api/demo/session")
          ? new Response(JSON.stringify({ id: "s1" }), { status: 201 })
          : new Response(JSON.stringify({ transcript: "", suggestions: [] }), { status: 200 }),
      ),
    );
    const stopTrack = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      },
    });
    const clearIntervalSpy = vi.spyOn(global, "clearInterval");

    const { result, unmount } = renderHook(() => useDemoSession());

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.status).toBe("recording");
    clearIntervalSpy.mockClear();

    unmount();

    expect(stopTrack).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });
});
