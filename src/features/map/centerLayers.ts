import type { Feature, FeatureCollection, Point } from "geojson";
import type maplibregl from "maplibre-gl";
import company01 from "../../assets/center-icons/company-01.png";
import company02 from "../../assets/center-icons/company-02.png";
import company03 from "../../assets/center-icons/company-03.png";
import home01 from "../../assets/center-icons/home-01.png";
import home02 from "../../assets/center-icons/home-02.png";
import home03 from "../../assets/center-icons/home-03.png";
import school01 from "../../assets/center-icons/school-01.png";
import school02 from "../../assets/center-icons/school-02.png";
import school03 from "../../assets/center-icons/school-03.png";
import { centerIconKey, type MapCenter } from "./centerApi";
import { zoomScaledMapIconExpression } from "./foodLayers";

export const CENTER_SOURCE = "map-centers";
export const CENTER_SYMBOL_LAYER = "map-centers-symbol";

const CENTER_ICONS = new Map<string, string>([
  ["center.home.1", home01],
  ["center.home.2", home02],
  ["center.home.3", home03],
  ["center.company.1", company01],
  ["center.company.2", company02],
  ["center.company.3", company03],
  ["center.school.1", school01],
  ["center.school.2", school02],
  ["center.school.3", school03],
]);

export function centerIconUrl(center: Pick<MapCenter, "kind" | "iconVariant">): string {
  return CENTER_ICONS.get(centerIconKey(center)) ?? home01;
}

const CENTER_MAX_ICON_SIZE = 0.56;
export const CENTER_ICON_SIZE = zoomScaledMapIconExpression(
  CENTER_MAX_ICON_SIZE,
  ["get", "mapIconScale"],
);

export function centersGeoJson(centers: MapCenter[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: centers.map((center) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [center.longitude, center.latitude] },
      properties: { ...center, iconKey: centerIconKey(center) },
    })),
  };
}

export async function installCenterLayers(map: maplibregl.Map, centers: MapCenter[]): Promise<void> {
  const data = centersGeoJson(centers);
  const current: maplibregl.GeoJSONSource | undefined = map.getSource(CENTER_SOURCE);
  if (current) {
    current.setData(data);
    return;
  }
  for (const [key, url] of CENTER_ICONS) {
    if (map.hasImage(key)) continue;
    const image = await map.loadImage(url);
    if (!map.hasImage(key)) map.addImage(key, image.data, { pixelRatio: 2 });
  }
  if (map.getSource(CENTER_SOURCE)) return;
  map.addSource(CENTER_SOURCE, { type: "geojson", data });
  map.addLayer({
    id: CENTER_SYMBOL_LAYER,
    type: "symbol",
    source: CENTER_SOURCE,
    layout: {
      "icon-image": ["get", "iconKey"],
      "icon-size": CENTER_ICON_SIZE,
      "icon-anchor": "bottom",
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
    },
  });
}

export function centerFeatureId(feature: Feature): string | null {
  const properties: unknown = feature.properties;
  if (!properties || typeof properties !== "object") return null;
  const id = (properties as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}
