import { describe, expect, it } from "vitest";
import { isQualifiedViewport } from "./offlineRegionApi";

describe("isQualifiedViewport", () => {
  const neighborhood = { west: 113.3, south: 23.11, east: 113.38, north: 23.16 };

  it("accepts a settled neighborhood at zoom 13", () => {
    expect(isQualifiedViewport(neighborhood, 13)).toBe(true);
  });

  it("rejects zoomed-out and geographically broad viewports", () => {
    expect(isQualifiedViewport(neighborhood, 12.99)).toBe(false);
    expect(isQualifiedViewport({ west: 113.3, south: 23.11, east: 113.5, north: 23.16 }, 13)).toBe(false);
  });
});
