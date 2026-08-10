import { describe, expect, test } from "vitest";
import { acctPk, chunkSk, sessPk, sessSk } from "../../src/lib/keys";

describe("dynamo key builders", () => {
  test("account partition key", () => expect(acctPk("A1")).toBe("ACCT#A1"));
  test("session sort key", () => expect(sessSk("S1")).toBe("SESS#S1"));
  test("session partition key for chunks", () => expect(sessPk("S1")).toBe("SESS#S1"));
  test("chunk sort key zero-pads so lexical sort = numeric sort", () => {
    expect(chunkSk(7)).toBe("CHUNK#000007");
    expect(chunkSk(12) > chunkSk(7)).toBe(true); // would be false without padding
  });
});
