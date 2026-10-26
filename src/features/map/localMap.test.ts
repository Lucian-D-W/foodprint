import { afterEach, describe, expect, it, vi } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import {
  assertLocalUrls,
  createLocalMap,
  fetchLocalStyle,
  MAP_VIEW_MAX_ZOOM,
  rewriteStyleForCachedRegion,
} from "./localMap";

const { addProtocolMock, invokeMock, mapConstructorMock } = vi.hoisted(() => ({
  addProtocolMock: vi.fn(),
  invokeMock: vi.fn(),
  mapConstructorMock: vi.fn<(options: { maxZoom?: number; style: StyleSpecification }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-log", () => ({ error: vi.fn(), info: vi.fn() }));
vi.mock("maplibre-gl", () => ({
  default: {
    addProtocol: addProtocolMock,
    AttributionControl: class {},
    Map: class {
      addControl = vi.fn();
      dragRotate = { disable: vi.fn() };
      on = vi.fn();
      once = vi.fn();
      resize = vi.fn();
      touchZoomRotate = { disableRotation: vi.fn() };

      constructor(options: Parameters<typeof mapConstructorMock>[0]) {
        mapConstructorMock(options);
      }
    },
  },
}));
vi.mock("pmtiles", () => ({
  PMTiles: class {},
  Protocol: class {
    add = vi.fn();
    tile = vi.fn();
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe("createLocalMap", () => {
  it("keeps viewing zoom independent from the bundled tile maxzoom", async () => {
    invokeMock.mockResolvedValue({
      localAssetOrigin: "http://127.0.0.1:43123/token",
      foodIconBaseUrl: "http://127.0.0.1:43123/token/assets/food-icons",
      mapManifest: {
        tiles: "basemap.pmtiles",
        style: "style.json",
        sourceId: "openmaptiles",
        center: [113.3158, 23.122, 15.15],
        minZoom: 0,
        maxZoom: 16,
        attribution: "OpenFreeMap",
      },
      iconManifest: { icons: {}, overlays: {} },
      lastMapView: null,
      restaurantPositionLocked: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            version: 8,
            sources: { openmaptiles: { type: "vector", maxzoom: 16 } },
            layers: [],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn());

    await createLocalMap(document.createElement("div"), vi.fn());

    expect(MAP_VIEW_MAX_ZOOM).toBe(20);
    expect(mapConstructorMock).toHaveBeenCalledWith(expect.objectContaining({ minZoom: 0, maxZoom: 20 }));
    expect(mapConstructorMock.mock.calls[0]?.[0].maxZoom).not.toBe(16);
  });

  it("uses the selected map palette while keeping every map asset local", async () => {
    invokeMock.mockResolvedValue({
      localAssetOrigin: "http://127.0.0.1:43123/token",
      foodIconBaseUrl: "http://127.0.0.1:43123/token/assets/food-icons",
      mapManifest: {
        tiles: "basemap.pmtiles",
        style: "style.json",
        sourceId: "openmaptiles",
        center: [113.3158, 23.122, 15.15],
        minZoom: 0,
        maxZoom: 16,
        attribution: "OpenFreeMap",
      },
      iconManifest: { icons: {}, overlays: {} },
      lastMapView: null,
      restaurantPositionLocked: false,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            version: 8,
            sources: { openmaptiles: { type: "vector", maxzoom: 16 } },
            layers: [],
          }),
          { status: 200 },
        ),
      ),
    );
    vi.stubGlobal("requestAnimationFrame", vi.fn());

    await createLocalMap(document.createElement("div"), vi.fn(), null, "cyberpunk");

    const style = mapConstructorMock.mock.calls.at(-1)![0].style;
    expect(style.layers[0]).toEqual(expect.objectContaining({ paint: { "background-color": "#23232b" } }));
    expect(style.glyphs).toBe("http://127.0.0.1:43123/token/maps/default/fonts/{fontstack}/{range}.pbf");
    expect(style.sources.openmaptiles).toEqual(
      expect.objectContaining({
        url: "pmtiles://http://127.0.0.1:43123/token/maps/default/basemap.pmtiles",
      }),
    );
    expect(() => assertLocalUrls(style, "http://127.0.0.1:43123/token")).not.toThrow();
  });
});

describe("assertLocalUrls", () => {
  const origin = "http://127.0.0.1:43123/token";

  it("accepts rewritten local assets", () => {
    expect(() =>
      assertLocalUrls(
        {
          glyphs: `${origin}/maps/default/fonts/{fontstack}/{range}.pbf`,
          sources: { map: { url: `pmtiles://${origin}/maps/default/basemap.pmtiles` } },
        },
        origin,
      ),
    ).not.toThrow();
  });

  it("rejects an external URL at any nesting level", () => {
    expect(() =>
      assertLocalUrls({ layers: [{ paint: { sprite: "https://tiles.example/sprite" } }] }, origin),
    ).toThrow("external URL");
  });

  it("rewrites a cached vector source to the tokenized loopback region path", () => {
    const rewritten = rewriteStyleForCachedRegion(
      {
        version: 8,
        sources: {
          openmaptiles: {
            type: "vector",
            url: "pmtiles://" + origin + "/maps/default/basemap.pmtiles",
            tiles: [origin + "/maps/default/{z}/{x}/{y}.pbf"],
          },
        },
        layers: [],
      },
      origin,
      {
        id: "region-zhujiang",
        tileMinZoom: 12,
        tileMaxZoom: 14,
        attribution: "OpenFreeMap",
      },
    );
    const source = rewritten.sources.openmaptiles as {
      url?: string;
      tiles?: string[];
      minzoom?: number;
      maxzoom?: number;
      attribution?: string;
    };
    expect(source.url).toBeUndefined();
    expect(source.tiles).toEqual([origin + "/maps/regions/region-zhujiang/{z}/{x}/{y}.pbf"]);
    expect(source.minzoom).toBe(12);
    expect(source.maxzoom).toBe(14);
    expect(source.attribution).toBe("OpenFreeMap");
    expect(() => assertLocalUrls(rewritten, origin)).not.toThrow();
  });

  it("keeps the bundled default PMTiles path local", () => {
    const defaultStyle = {
      sources: {
        openmaptiles: {
          type: "vector",
          url: "pmtiles://" + origin + "/maps/default/basemap.pmtiles",
        },
      },
    };
    expect(defaultStyle.sources.openmaptiles.url).toBe(
      "pmtiles://" + origin + "/maps/default/basemap.pmtiles",
    );
    expect(() => assertLocalUrls(defaultStyle, origin)).not.toThrow();
  });
});

describe("fetchLocalStyle", () => {
  it("turns a browser fetch failure into local map feedback", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(fetchLocalStyle("http://127.0.0.1:43123/token/maps/default/style.json")).rejects.toThrow(
      "本地地图样式无法读取",
    );
  });

  it("keeps an HTTP status without exposing a raw browser error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(fetchLocalStyle("http://127.0.0.1:43123/token/maps/default/style.json")).rejects.toThrow(
      "本地地图样式无法读取（HTTP 404）",
    );
  });
});
