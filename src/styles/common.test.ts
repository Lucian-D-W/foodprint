import { describe, expect, it } from "vitest";
import { STYLE_CATALOG } from "./index";

describe("high-zoom map detail labels", () => {
  it.each(Object.entries(STYLE_CATALOG))(
    "%s keeps place names and house numbers out of the distant view",
    (_theme, style) => {
      const poi = style.layers.find((layer) => layer.id === "poi-labels");
      const housenumber = style.layers.find((layer) => layer.id === "housenumber-labels");

      expect(poi).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "poi",
        minzoom: 17,
      });
      expect(housenumber).toMatchObject({
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "housenumber",
        minzoom: 19,
      });
    },
  );
});
