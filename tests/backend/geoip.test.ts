import { describe, expect, test } from "vitest";
import { resolveGeo } from "../../src/backend/util/geoip.js";

describe("resolveGeo", () => {
  test("returns Unknown for localhost / private IPs", () => {
    expect(resolveGeo("127.0.0.1")).toBe("Unknown");
    expect(resolveGeo("::1")).toBe("Unknown");
    expect(resolveGeo("192.168.1.1")).toBe("Unknown");
  });

  test("returns Unknown for garbage input", () => {
    expect(resolveGeo("not-an-ip")).toBe("Unknown");
    expect(resolveGeo("")).toBe("Unknown");
  });

  test("returns location string for known public IP", () => {
    // 8.8.8.8 is Google DNS — geoip-lite has data for it
    const result = resolveGeo("8.8.8.8");
    // Should be a non-empty string (exact result depends on geoip-lite DB version)
    expect(result).not.toBe("Unknown");
    expect(result.length).toBeGreaterThan(0);
  });
});
