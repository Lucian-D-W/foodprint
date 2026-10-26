import type { StyleSpecification } from "maplibre-gl";

export const BASEMAP_SOURCE = "https://tiles.openfreemap.org/planet";

export const CAMERA = {
  center: [113.3158, 23.1220] as [number, number],
  zoom: 15.15,
  pitch: 0,
  bearing: 0,
};

export type Palette = {
  background: string;
  residential: string;
  grass: string;
  wood: string;
  park: string;
  parkOutline: string;
  water: string;
  waterLine: string;
  building: string;
  buildingShadow: string;
  buildingEdge: string;
  roadMajorCasing: string;
  roadMajor: string;
  roadMinorCasing: string;
  roadMinor: string;
  label: string;
  labelHalo: string;
  districtLabel: string;
};

const majorRoads = ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"];
const minorRoads = ["service", "track", "path", "pedestrian"];
const namedPlaceClasses = ["neighbourhood", "suburb", "town", "village", "city"];

// OpenMapTiles keeps language-specific names as name:xx. Prefer Guangzhou's
// local-language values, then fall back to the source name and English.
const nameField = [
  "coalesce",
  ["get", "name:zh-Hans"],
  ["get", "name:zh"],
  ["get", "name"],
  ["get", "name:en"],
];

const zoomWidth = (base: number, detail: number) => [
  "interpolate",
  ["exponential", 1.2],
  ["zoom"],
  10,
  base,
  15,
  detail,
  18,
  detail * 1.45,
];

export function makeStyle(name: string, palette: Palette, pixelInspired = false): StyleSpecification {
  return {
    version: 8,
    name,
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      openmaptiles: {
        type: "vector",
        url: BASEMAP_SOURCE,
        attribution: "© OpenStreetMap contributors · © OpenFreeMap",
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": palette.background },
      },
      {
        id: "landuse-residential",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landuse",
        filter: ["==", ["get", "class"], "residential"],
        paint: {
          "fill-color": palette.residential,
          "fill-opacity": 0.52,
        },
      },
      {
        id: "landcover-grass",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        filter: ["match", ["get", "class"], ["grass", "scrub", "heath"], true, false],
        paint: {
          "fill-color": palette.grass,
          "fill-opacity": pixelInspired ? 0.88 : 0.72,
          "fill-antialias": !pixelInspired,
        },
      },
      {
        id: "landcover-wood",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "landcover",
        filter: ["match", ["get", "class"], ["wood", "forest"], true, false],
        paint: {
          "fill-color": palette.wood,
          "fill-opacity": pixelInspired ? 0.94 : 0.8,
        },
      },
      {
        id: "park-fill",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "park",
        paint: {
          "fill-color": palette.park,
          "fill-opacity": pixelInspired ? 0.96 : 0.84,
          "fill-outline-color": palette.parkOutline,
        },
      },
      {
        id: "park-outline",
        type: "line",
        source: "openmaptiles",
        "source-layer": "park",
        paint: {
          "line-color": palette.parkOutline,
          "line-width": pixelInspired ? 1.4 : 1,
          "line-opacity": 0.78,
          ...(pixelInspired ? { "line-dasharray": [1.5, 1.5] } : {}),
        },
      },
      {
        id: "water-fill",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "water",
        paint: {
          "fill-color": palette.water,
          "fill-opacity": 0.94,
        },
      },
      {
        id: "waterway",
        type: "line",
        source: "openmaptiles",
        "source-layer": "waterway",
        paint: {
          "line-color": palette.waterLine,
          "line-width": zoomWidth(0.4, 2.4),
          "line-opacity": 0.75,
        },
      },
      {
        id: "road-area",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": palette.roadMinor,
          "fill-opacity": 0.72,
        },
      },
      {
        id: "road-casing-major",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["match", ["get", "class"], majorRoads, true, false],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": palette.roadMajorCasing,
          "line-width": zoomWidth(1.5, 8.8),
          "line-opacity": 0.94,
        },
      },
      {
        id: "road-major",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["match", ["get", "class"], majorRoads, true, false],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": palette.roadMajor,
          "line-width": zoomWidth(0.75, 6.2),
          "line-opacity": 0.98,
        },
      },
      {
        id: "road-casing-minor",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["match", ["get", "class"], minorRoads, true, false],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": palette.roadMinorCasing,
          "line-width": zoomWidth(0.6, 4.2),
          "line-opacity": 0.9,
        },
      },
      {
        id: "road-minor",
        type: "line",
        source: "openmaptiles",
        "source-layer": "transportation",
        filter: ["match", ["get", "class"], minorRoads, true, false],
        layout: {
          "line-cap": "round",
          "line-join": "round",
        },
        paint: {
          "line-color": palette.roadMinor,
          "line-width": zoomWidth(0.35, 2.8),
          "line-opacity": 0.98,
          ...(pixelInspired ? { "line-blur": 0 } : {}),
        },
      },
      {
        id: "building-shadows",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        paint: {
          "fill-color": palette.buildingShadow,
          "fill-translate": pixelInspired ? [1.5, 1.5] : [2, 2],
          "fill-opacity": 0.5,
        },
      },
      {
        id: "buildings",
        type: "fill",
        source: "openmaptiles",
        "source-layer": "building",
        paint: {
          "fill-color": palette.building,
          "fill-opacity": pixelInspired ? 0.94 : 0.88,
          "fill-antialias": !pixelInspired,
        },
      },
      {
        id: "building-edges",
        type: "line",
        source: "openmaptiles",
        "source-layer": "building",
        paint: {
          "line-color": palette.buildingEdge,
          "line-width": pixelInspired ? 1.15 : 0.65,
          "line-opacity": pixelInspired ? 0.8 : 0.58,
        },
      },
      {
        id: "water-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "water_name",
        minzoom: 13,
        layout: {
          "text-field": nameField,
          "text-font": ["Noto Sans Italic"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 16, 13],
          "text-letter-spacing": 0.05,
        },
        paint: {
          "text-color": palette.waterLine,
          "text-halo-color": palette.water,
          "text-halo-width": 1.5,
        },
      },
      {
        id: "road-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "transportation_name",
        minzoom: 14,
        filter: ["all", ["has", "name"], ["match", ["get", "class"], [...majorRoads, ...minorRoads], true, false]],
        layout: {
          "symbol-placement": "line",
          "text-field": nameField,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 14, 9.5, 16, 11.5, 18, 13],
          "text-max-angle": 35,
          "text-padding": 3,
        },
        paint: {
          "text-color": palette.label,
          "text-halo-color": palette.labelHalo,
          "text-halo-width": pixelInspired ? 2.1 : 1.6,
          "text-halo-blur": 0.2,
        },
      },
      {
        id: "district-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "place",
        minzoom: 12,
        filter: ["all", ["has", "name"], ["match", ["get", "class"], namedPlaceClasses, true, false]],
        layout: {
          "text-field": nameField,
          "text-font": ["Noto Sans Bold"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 12, 11, 15, 15, 17, 18],
          "text-allow-overlap": false,
        },
        paint: {
          "text-color": palette.districtLabel,
          "text-halo-color": palette.labelHalo,
          "text-halo-width": 2.4,
          "text-halo-blur": 0.35,
        },
      },
      {
        id: "poi-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "poi",
        minzoom: 17,
        filter: ["has", "name"],
        layout: {
          "text-field": nameField,
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 17, 9, 20, 12],
          "text-max-width": 8,
          "text-padding": 4,
          "text-optional": true,
          "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
        },
        paint: {
          "text-color": palette.label,
          "text-halo-color": palette.labelHalo,
          "text-halo-width": pixelInspired ? 1.8 : 1.4,
          "text-halo-blur": 0.15,
        },
      },
      {
        id: "housenumber-labels",
        type: "symbol",
        source: "openmaptiles",
        "source-layer": "housenumber",
        minzoom: 19,
        filter: ["has", "housenumber"],
        layout: {
          "text-field": ["get", "housenumber"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 19, 8, 20, 10],
          "text-padding": 2,
        },
        paint: {
          "text-color": palette.label,
          "text-halo-color": palette.labelHalo,
          "text-halo-width": 1.2,
        },
      },
    ],
  } as StyleSpecification;
}
