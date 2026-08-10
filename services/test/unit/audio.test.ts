import { describe, expect, test } from "vitest";
import { extFromContentType } from "../../src/lib/audio";

describe("extFromContentType", () => {
  test.each([
    ["audio/webm", "webm"],
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/ogg", "ogg"],
    ["audio/webm;codecs=opus", "webm"],
  ])("%s → %s", (ct, ext) => expect(extFromContentType(ct)).toBe(ext));
  test("unknown type throws 422", () => {
    expect(() => extFromContentType("text/plain")).toThrowError(/content-type/);
    expect(() => extFromContentType(undefined)).toThrowError();
  });
});
