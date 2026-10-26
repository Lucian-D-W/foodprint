import { describe, expect, it } from "vitest";
import { CENTER_ICON_SIZE } from "./centerLayers";

describe("map center marker scale", () => {
  it("uses the restaurant marker zoom curve and reaches its baseline only at maximum street zoom", () => {
    expect(CENTER_ICON_SIZE).toEqual([
      "interpolate",
      ["exponential", 1.35],
      ["zoom"],
      10,
      ["*", 0.16, 0.56, ["get", "mapIconScale"]],
      14,
      ["*", 0.32, 0.56, ["get", "mapIconScale"]],
      17,
      ["*", 0.55, 0.56, ["get", "mapIconScale"]],
      20,
      ["*", 1, 0.56, ["get", "mapIconScale"]],
    ]);
  });
});
