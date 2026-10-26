import { describe, expect, it } from "vitest";
import {
  FOOD_ICON_OPACITY,
  FOOD_FREQUENT_GLOW_ICON_SIZE,
  FOOD_FREQUENT_GLOW_LAYER,
  FOOD_MAP_ICON_SCALE,
  FOOD_LOG_ICON_SIZE,
  FOOD_LOG_SIZE_MULTIPLIER,
  FOOD_MARKER_ZOOM_STOPS,
  FOOD_RATING_STARS_EXPRESSION,
  FOOD_RATING_SIZE,
  FOOD_SELECTED_RATING_LAYER,
  FOOD_STATUS_BADGE_LAYER,
  FOOD_STATUS_BADGE_SIZE,
  FOOD_STATUS_BADGE_TEXT,
  FOOD_STATUS_PRIORITY_EXPRESSION,
  foodFeatureId,
  markerPresentation,
  mapPriority,
  restaurantsGeoJson,
  installFoodLayers,
} from "./foodLayers";

describe("food restaurant GeoJSON", () => {
  const restaurant = {
    id: "r-1",
    name: "测试店",
    longitude: 113.3,
    latitude: 23.1,
    cuisineKey: "coffee",
    iconKey: "coffee-cup",
    overallRating: null,
    visitStatus: "unknown" as const,
    affectionStatus: "neutral" as const,
    isBookmarked: false,
    mapIconScale: 1,
    positionLocked: false,
    logCount: 0,
  };

  it("marks the selected feature and retains its selection id", () => {
    const feature = restaurantsGeoJson([restaurant], restaurant.id).features[0];

    expect(feature.properties?.selected).toBe(true);
    expect(feature.properties?.mapIconScale).toBe(1);
    expect(feature.properties?.markerBodyTone).toBe("unvisited");
    expect(feature.properties?.markerBadge).toBe("none");
    expect(foodFeatureId(feature)).toBe(restaurant.id);
  });

  it("ignores features without a string id", () => {
    expect(
      foodFeatureId({
        type: "Feature",
        geometry: { type: "Point", coordinates: [0, 0] },
        properties: { id: 4 },
      }),
    ).toBeNull();
  });

  it("centralizes map priority and star expressions", () => {
    expect(mapPriority({ ...restaurant, affectionStatus: "favorite" })).toBeGreaterThan(
      mapPriority({ ...restaurant, visitStatus: "frequent" }),
    );
    expect(FOOD_STATUS_PRIORITY_EXPRESSION).toEqual(["get", "mapPriority"]);
    expect(FOOD_RATING_STARS_EXPRESSION).toContain("★★★★★");
    expect(mapPriority({ ...restaurant, affectionStatus: "avoid", isBookmarked: true })).toBe(80);
    expect(mapPriority({ ...restaurant, affectionStatus: "favorite", isBookmarked: true })).toBe(80);
    expect(mapPriority({ ...restaurant, isBookmarked: true, visitStatus: "frequent" })).toBe(70);
    expect(mapPriority({ ...restaurant, visitStatus: "frequent", logCount: 99 })).toBe(60);
    expect(mapPriority({ ...restaurant, logCount: 11 })).toBe(11);
    expect(mapPriority({ ...restaurant, logCount: 10 })).toBe(6);
    expect(mapPriority({ ...restaurant, logCount: 6 })).toBe(6);
    expect(mapPriority({ ...restaurant, logCount: 5 })).toBe(3);
    expect(mapPriority({ ...restaurant, logCount: 3 })).toBe(3);
    expect(mapPriority({ ...restaurant, logCount: 2 })).toBe(1);
    expect(mapPriority({ ...restaurant, logCount: 1 })).toBe(1);
    expect(mapPriority({ ...restaurant, logCount: 0 })).toBe(0);
    expect(
      restaurantsGeoJson([{ ...restaurant, affectionStatus: "avoid" }], restaurant.id).features[0].properties
        ?.mapPriority,
    ).toBe(100);
    expect(FOOD_LOG_SIZE_MULTIPLIER).toEqual([
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
    ]);
    expect(FOOD_MAP_ICON_SCALE).toEqual(["get", "mapIconScale"]);
    expect(FOOD_MARKER_ZOOM_STOPS).toEqual([
      [10, 0.16],
      [14, 0.32],
      [17, 0.55],
      [20, 1],
    ]);
    expect(FOOD_LOG_ICON_SIZE).toEqual([
      "interpolate",
      ["exponential", 1.35],
      ["zoom"],
      10,
      ["*", 0.16, 0.7, FOOD_MAP_ICON_SCALE, FOOD_LOG_SIZE_MULTIPLIER],
      14,
      ["*", 0.32, 0.7, FOOD_MAP_ICON_SCALE, FOOD_LOG_SIZE_MULTIPLIER],
      17,
      ["*", 0.55, 0.7, FOOD_MAP_ICON_SCALE, FOOD_LOG_SIZE_MULTIPLIER],
      20,
      ["*", 1, 0.7, FOOD_MAP_ICON_SCALE, FOOD_LOG_SIZE_MULTIPLIER],
    ]);
    expect(FOOD_ICON_OPACITY).toEqual([
      "match",
      ["get", "markerBodyTone"],
      "unvisited",
      0.46,
      "frequent",
      1,
      0.9,
    ]);
  });

  it("resolves exactly one top badge with affection overriding want-to-go", () => {
    expect(markerPresentation({ visitStatus: "unknown", affectionStatus: "neutral" })).toEqual({
      bodyTone: "unvisited",
      badge: "none",
    });
    expect(markerPresentation({ visitStatus: "want_to_go", affectionStatus: "neutral" })).toEqual({
      bodyTone: "unvisited",
      badge: "target",
    });
    expect(markerPresentation({ visitStatus: "visited", affectionStatus: "neutral" })).toEqual({
      bodyTone: "visited",
      badge: "none",
    });
    expect(markerPresentation({ visitStatus: "frequent", affectionStatus: "neutral" })).toEqual({
      bodyTone: "frequent",
      badge: "none",
    });
    expect(markerPresentation({ visitStatus: "want_to_go", affectionStatus: "like" })).toEqual({
      bodyTone: "visited",
      badge: "like",
    });
    expect(markerPresentation({ visitStatus: "unknown", affectionStatus: "favorite" })).toEqual({
      bodyTone: "visited",
      badge: "favorite",
    });
    expect(markerPresentation({ visitStatus: "frequent", affectionStatus: "avoid" })).toEqual({
      bodyTone: "frequent",
      badge: "avoid",
    });
    expect(FOOD_STATUS_BADGE_TEXT).toEqual([
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
    ]);
    expect(FOOD_STATUS_BADGE_SIZE[0]).toBe("interpolate");
    expect(FOOD_STATUS_BADGE_SIZE[2]).toEqual(["zoom"]);
    expect(FOOD_STATUS_BADGE_SIZE.at(-2)).toBe(20);
    expect(FOOD_STATUS_BADGE_SIZE.at(-1)).toEqual([
      "*",
      1,
      ["match", ["get", "markerBadge"], "favorite", 18, "avoid", 16, 14],
      FOOD_MAP_ICON_SCALE,
      FOOD_LOG_SIZE_MULTIPLIER,
    ]);
  });

  it("installs a silhouette glow, one top badge layer, and bottom rating stars", () => {
    const layers: {
      id: string;
      type?: string;
      filter?: unknown;
      minzoom?: number;
      layout?: Record<string, unknown>;
      paint?: Record<string, unknown>;
    }[] = [];
    const map = {
      getSource: () => undefined,
      addSource: () => undefined,
      addLayer: (layer: {
        id: string;
        filter?: unknown;
        layout?: Record<string, unknown>;
        paint?: Record<string, unknown>;
      }) => layers.push(layer),
    };
    installFoodLayers(map as never, [restaurant], null);
    const symbol = layers.find((layer) => layer.id === "food-restaurants-symbol");
    expect(symbol?.paint?.["icon-opacity"]).toEqual(FOOD_ICON_OPACITY);
    expect(layers.some((layer) => layer.type === "circle")).toBe(false);
    expect(layers.find((layer) => layer.id === FOOD_FREQUENT_GLOW_LAYER)?.filter).toEqual([
      "==",
      ["get", "markerBodyTone"],
      "frequent",
    ]);
    expect(layers.find((layer) => layer.id === FOOD_FREQUENT_GLOW_LAYER)?.layout?.["icon-size"]).toEqual(
      FOOD_FREQUENT_GLOW_ICON_SIZE,
    );
    const statusBadges = layers.filter((layer) => layer.id === FOOD_STATUS_BADGE_LAYER);
    expect(statusBadges).toHaveLength(1);
    expect(statusBadges[0].filter).toEqual(["!=", ["get", "markerBadge"], "none"]);
    expect(statusBadges[0].layout?.["text-anchor"]).toBe("bottom");
    expect(statusBadges[0].layout?.["text-size"]).toEqual(FOOD_STATUS_BADGE_SIZE);
    expect(statusBadges[0].layout?.["text-offset"]).toEqual([0, -3.45]);
    expect(JSON.stringify(layers)).not.toContain("bookmark-badge");
    const detailRating = layers.find((layer) => layer.id === "food-restaurants-rating");
    expect(detailRating?.minzoom).toBe(14);
    expect(detailRating?.layout?.["text-anchor"]).toBe("top");
    expect(detailRating?.layout?.["text-size"]).toEqual(FOOD_RATING_SIZE);
    expect(detailRating?.layout?.["text-field"]).toEqual(FOOD_RATING_STARS_EXPRESSION);
    expect(detailRating?.filter).toEqual([
      "all",
      [">=", ["get", "overallRating"], 1],
      ["!=", ["get", "selected"], true],
    ]);
    expect(JSON.stringify(detailRating?.filter)).not.toContain("zoom");
    expect(layers.find((layer) => layer.id === FOOD_SELECTED_RATING_LAYER)?.filter).toEqual([
      "all",
      [">=", ["get", "overallRating"], 1],
      ["==", ["get", "selected"], true],
    ]);
  });
});
