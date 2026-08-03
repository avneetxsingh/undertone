import { describe, expect, test } from "vitest";
import { assertHttpsPublicUrl, assertResolvesPublic, isBlockedIp } from "../../src/lib/webhookUrl";

describe("isBlockedIp", () => {
  test("blocks private / loopback / link-local / metadata / CGNAT", () => {
    for (const ip of [
      "10.0.0.1",
      "127.0.0.1",
      "0.0.0.0",
      "169.254.169.254",
      "172.16.5.4",
      "192.168.1.1",
      "100.64.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd12::1",
      "::ffff:127.0.0.1",
    ])
      expect(isBlockedIp(ip), ip).toBe(true);
  });
  test("allows public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700::1111"])
      expect(isBlockedIp(ip), ip).toBe(false);
  });
});

describe("assertHttpsPublicUrl", () => {
  test("accepts a public https url", () => {
    expect(() => assertHttpsPublicUrl("https://hooks.example.com/undertone")).not.toThrow();
  });
  test("rejects http, bad url, internal hostnames, and private IP literals", () => {
    for (const bad of [
      "http://example.com",
      "not a url",
      "https://localhost/x",
      "https://foo.internal/x",
      "https://127.0.0.1/x",
      "https://[::1]/x",
      "https://169.254.169.254/latest",
    ])
      expect(() => assertHttpsPublicUrl(bad), bad).toThrowError(/invalid_url|url must/i);
  });
});

describe("assertResolvesPublic", () => {
  test("throws when DNS resolves to a blocked address", async () => {
    await expect(
      assertResolvesPublic("https://rebind.example.com/x", async () => [{ address: "169.254.169.254" }]),
    ).rejects.toThrow(/blocked address/);
  });
  test("passes when DNS resolves to a public address", async () => {
    await expect(
      assertResolvesPublic("https://ok.example.com/x", async () => [{ address: "8.8.8.8" }]),
    ).resolves.toBeUndefined();
  });
});
