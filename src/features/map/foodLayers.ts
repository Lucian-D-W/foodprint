import type { Feature, FeatureCollection, Point } from "geojson";
import type maplibregl from "maplibre-gl";
import type { MapRestaurant } from "../restaurants/api";
import { MAP_VIEW_MAX_ZOOM } from "./localMap";

export const FOOD_SOURCE = "food-restaurants";
export const FOOD_SYMBOL_LAYER = "food-restaurants-symbol";
export const FOOD_FREQUENT_GLOW_LAYER = "food-restaurants-frequent-glow";
export const FOOD_STATUS_BADGE_LAYER = "food-restaurants-status-badge";
export const FOOD_RATING_LAYER = "food-restaurants-rating";
export const FOOD_SELECTED_RATING_LAYER = "food-restaurants-rating-selected";

export type MarkerBodyTone = "unvisited" | "visited" | "frequent";
export type MarkerBadge = "none" | "target" | "like" | "favorite" | "avoid";
type FoodProperties = MapRestaurant & {
  selected: boolean;
  mapPriority: number;
  markerBodyTone: MarkerBodyTone;
  markerBadge: MarkerBadge;
};

const FOOD_BASE_ICON_SIZE = 0.7;
export const FOOD_MAP_ICON_SCALE: maplibregl.ExpressionSpecification = ["get", "mapIconScale"];

/** The manual's bounded visit-frequency tiers: 0, 1–2, 3–5, 6–10, 11+. */
export const FOOD_LOG_SIZE_MULTIPLIER: maplibregl.ExpressionSpecification = [
  "step",
  ["get", "logCount"],
  0.9,
  1,
  1,
  3,
  1.06,
  6,
  1.12,
  11,
  1.18,
];
export const FOOD_MARKER_ZOOM_STOPS = [
  [10, 0.16],
  [14, 0.32],
  [17, 0.55],
  [MAP_VIEW_MAX_ZOOM, 1],
] as const;

export function zoomScaledMapIconExpression(
  firstSizeFactor: number | maplibregl.ExpressionSpecification,
  ...remainingSizeFactors: (number | maplibregl.ExpressionSpecification)[]
): maplibregl.ExpressionSpecification {
  const sizeFactors = [firstSizeFactor, ...remainingSizeFactors] as [
    number | maplibregl.ExpressionSpecification,
    ...(number | maplibregl.ExpressionSpecification)[],
  ];
  const [[farZoom, farScale], [districtZoom, districtScale], [streetZoom, streetScale], [maxZoom, maxScale]] =
    FOOD_MARKER_ZOOM_STOPS;
  return [
    "interpolate",
    ["exponential", 1.35],
    ["zoom"],
    farZoom,
    ["*", farScale, ...sizeFactors],
    districtZoom,
    ["*", districtScale, ...sizeFactors],
    streetZoom,
    ["*", streetScale, ...sizeFactors],
    maxZoom,
    ["*", maxScale, ...sizeFactors],
  ];
}

function zoomScaledMarkerExpression(
  baseSize: number | maplibregl.ExpressionSpecification,
): maplibregl.ExpressionSpecification {
  return zoomScaledMapIconExpression(baseSize, FOOD_MAP_ICON_SCALE, FOOD_LOG_SIZE_MULTIPLIER);
}

export const FOOD_LOG_ICON_SIZE = zoomScaledMarkerExpression(FOOD_BASE_ICON_SIZE);
export const FOOD_FREQUENT_GLOW_ICON_SIZE = zoomScaledMarkerExpression(FOOD_BASE_ICON_SIZE * 1.1);
/** Quiet unvisited buildings, normal visited buildings, and bright frequent buildings. */
export const FOOD_ICON_OPACITY: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "markerBodyTone"],
  "unvisited",
  0.46,
  "frequent",
  1,
  0.9,
];
export const FOOD_STATUS_BADGE_TEXT: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "markerBadge"],
  "target",
  "◎",
  "like",
  "♥",
  "favorite",
  "♥",
  "avoid",
  "⚡",
  "",
];
const FOOD_STATUS_BADGE_BASE_SIZE: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "markerBadge"],
  "favorite",
  18,
  "avoid",
  16,
  14,
];
export const FOOD_STATUS_BADGE_SIZE = zoomScaledMarkerExpression(FOOD_STATUS_BADGE_BASE_SIZE);
export const FOOD_RATING_SIZE = zoomScaledMarkerExpression(10);
export const FOOD_STATUS_BADGE_COLOR: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "markerBadge"],
  "target",
  "#4f7891",
  "avoid",
  "#d26a3d",
  "#d85e71",
];

export function markerPresentation(restaurant: Pick<MapRestaurant, "visitStatus" | "affectionStatus">): {
  bodyTone: MarkerBodyTone;
  badge: MarkerBadge;
} {
  const badge: MarkerBadge =
    restaurant.affectionStatus === "like"
      ? "like"
      : restaurant.affectionStatus === "favorite"
        ? "favorite"
        : restaurant.affectionStatus === "avoid"
          ? "avoid"
          : restaurant.visitStatus === "want_to_go"
            ? "target"
            : "none";
  const bodyTone: MarkerBodyTone =
    restaurant.visitStatus === "frequent"
      ? "frequent"
      : restaurant.affectionStatus !== "neutral" || restaurant.visitStatus === "visited"
        ? "visited"
        : "unvisited";
  return { bodyTone, badge };
}

/**
 * Keeps busy map labels deterministic: favorites/bookmarks rise first, then
 * rated and visited places. The same priority is stored in GeoJSON so every
 * Food layer reads one value rather than reimplementing business ordering.
 */
export function mapPriority(restaurant: MapRestaurant): number {
  if (restaurant.affectionStatus === "avoid" || restaurant.affectionStatus === "favorite") return 80;
  if (restaurant.isBookmarked) return 70;
  if (restaurant.visitStatus === "frequent") return 60;
  if (restaurant.logCount >= 11) return 11;
  if (restaurant.logCount >= 6) return 6;
  if (restaurant.logCount >= 3) return 3;
  if (restaurant.logCount >= 1) return 1;
  return 0;
}

export const FOOD_STATUS_PRIORITY_EXPRESSION: maplibregl.ExpressionSpecification = ["get", "mapPriority"];
export const FOOD_RATING_STARS_EXPRESSION: maplibregl.ExpressionSpecification = [
  "match",
  ["get", "overallRating"],
  1,
  "★",
  2,
  "★★",
  3,
  "★★★",
  4,
  "★★★★",
  5,
  "★★★★★",
  "",
] as const;

export function restaurantsGeoJson(
  restaurants: MapRestaurant[],
  selectedId: string | null,
): FeatureCollection<Point, FoodProperties> {
  return {
    type: "FeatureCollection",
    features: restaurants.map((restaurant) => {
      const presentation = markerPresentation(restaurant);
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [restaurant.longitude, restaurant.latitude] },
        properties: {
          ...restaurant,
          selected: restaurant.id === selectedId,
          mapPriority: restaurant.id === selectedId ? 100 : mapPriority(restaurant),
          markerBodyTone: presentation.bodyTone,
          markerBadge: presentation.badge,
        },
      };
    }),
  };
}

/** The sole Food source/layer installation path. */
export function installFoodLayers(
  map: maplibregl.Map,
  restaurants: MapRestaurant[],
  selectedId: string | null,
): void {
  const data = restaurantsGeoJson(restaurants, selectedId);
  const current: maplibregl.GeoJSONSource | undefined = map.getSource(FOOD_SOURCE);
  if (current) {
    current.setData(data);
    return;
  }
  map.addSource(FOOD_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: FOOD_FREQUENT_GLOW_LAYER,
    type: "symbol",
    source: FOOD_SOURCE,
    filter: ["==", ["get", "markerBodyTone"], "frequent"],
    layout: {
      "icon-image": ["get", "iconKey"],
      "icon-size": FOOD_FREQUENT_GLOW_ICON_SIZE,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": FOOD_STATUS_PRIORITY_EXPRESSION,
    },
    paint: { "icon-opacity": 0.22 },
  });
  map.addLayer({
    id: FOOD_SYMBOL_LAYER,
    type: "symbol",
    source: FOOD_SOURCE,
    layout: {
      "icon-image": ["get", "iconKey"],
      "icon-size": FOOD_LOG_ICON_SIZE,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "symbol-sort-key": FOOD_STATUS_PRIORITY_EXPRESSION,
    },
    paint: {
      "icon-opacity": FOOD_ICON_OPACITY,
    },
  });
  map.addLayer({
    id: FOOD_STATUS_BADGE_LAYER,
    type: "symbol",
    source: FOOD_SOURCE,
    filter: ["!=", ["get", "markerBadge"], "none"],
    layout: {
      "text-field": FOOD_STATUS_BADGE_TEXT,
      "text-size": FOOD_STATUS_BADGE_SIZE,
      "text-anchor": "bottom",
      // text-offset is measured in ems. Scaling text-size with the same marker
      // expression keeps the physical badge gap proportional to the building.
      "text-offset": [0, -3.45],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "symbol-sort-key": FOOD_STATUS_PRIORITY_EXPRESSION,
    },
    paint: {
      "text-color": FOOD_STATUS_BADGE_COLOR,
      "text-halo-color": "#fff8e8",
      "text-halo-width": 1.5,
    },
  });
  map.addLayer({
    id: FOOD_RATING_LAYER,
    type: "symbol",
    source: FOOD_SOURCE,
    minzoom: 14,
    filter: ["all", [">=", ["get", "overallRating"], 1], ["!=", ["get", "selected"], true]],
    layout: {
      "text-field": FOOD_RATING_STARS_EXPRESSION,
      "text-size": FOOD_RATING_SIZE,
      "text-anchor": "top",
      "text-offset": [0, 0.25],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "symbol-sort-key": FOOD_STATUS_PRIORITY_EXPRESSION,
    },
    paint: {
      "text-color": "#7a4e18",
      "text-halo-color": "#fffaf0",
      "text-halo-width": 1.2,
    },
  });
  // MapLibre filters cannot inspect zoom. Selected ratings remain visible at
  // every zoom; the preceding all-ratings layer uses minzoom for detail mode.
  map.addLayer({
    id: FOOD_SELECTED_RATING_LAYER,
    type: "symbol",
    source: FOOD_SOURCE,
    filter: ["all", [">=", ["get", "overallRating"], 1], ["==", ["get", "selected"], true]],
    layout: {
      "text-field": FOOD_RATING_STARS_EXPRESSION,
      "text-size": FOOD_RATING_SIZE,
      "text-anchor": "top",
      "text-offset": [0, 0.25],
      "text-allow-overlap": true,
      "text-ignore-placement": true,
      "symbol-sort-key": FOOD_STATUS_PRIORITY_EXPRESSION,
    },
    paint: {
      "text-color": "#7a4e18",
      "text-halo-color": "#fffaf0",
      "text-halo-width": 1.2,
    },
  });
}

export function foodFeatureId(feature: Feature): string | null {
  const properties: unknown = feature.properties;
  if (!properties || typeof properties !== "object") return null;
  const id = (properties as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}
