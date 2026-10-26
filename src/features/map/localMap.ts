import { invoke } from "@tauri-apps/api/core";
import { error, info as logInfo } from "@tauri-apps/plugin-log";
import maplibregl from "maplibre-gl";
import { PMTiles, Protocol } from "pmtiles";
import type { CachedRegion } from "./offlineRegionApi";
import { STYLE_CATALOG } from "../../styles";
import type { AppThemeKey } from "../settings/themeCatalog";

type MapManifest = {
  tiles: string;
  style: string;
  sourceId: string;
  center: [number, number, number];
  minZoom: number;
  maxZoom: number;
  attribution: string;
};
type Icon = { src: string; pixelRatio: number; sdf: boolean };
type BootstrapInfo = {
  localAssetOrigin: string;
  foodIconBaseUrl: string;
  mapManifest: MapManifest;
  iconManifest: { icons: Record<string, Icon>; overlays: Record<string, Icon> };
  lastMapView: MapView | null;
  restaurantPositionLocked: boolean;
};
export type MapView = { longitude: number; latitude: number; zoom: number };
export const MAP_VIEW_MAX_ZOOM = 20;

let protocolRegistered = false;
function localUrl(origin: string, path: string): string {
  if (!path || /^https?:/i.test(path) || path.startsWith("//"))
    throw new Error("Map assets must use the local FoodMap server");
  return `${origin}/${path.replace(/^\/+/, "")}`;
}
export function assertLocalUrls(value: unknown, origin: string): void {
  if (typeof value === "string") {
    if (/(?:https?:)?\/\//i.test(value) && !value.includes(origin)) {
      throw new Error("Local style contains an external URL");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => assertLocalUrls(item, origin));
    return;
  }
  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => assertLocalUrls(item, origin));
  }
}
function registerProtocol(url: string): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  protocol.add(new PMTiles(url));
  maplibregl.addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}
async function loadIcon(map: maplibregl.Map, name: string, icon: Icon, baseUrl: string): Promise<void> {
  if (map.hasImage(name)) return;
  const image = await map.loadImage(localUrl(baseUrl, icon.src));
  if (!map.hasImage(name)) map.addImage(name, image.data, { pixelRatio: icon.pixelRatio, sdf: icon.sdf });
}
export function rewriteStyleForCachedRegion(
  style: maplibregl.StyleSpecification,
  origin: string,
  region: Pick<CachedRegion, "id" | "tileMinZoom" | "tileMaxZoom" | "attribution">,
  sourceId = "openmaptiles",
): maplibregl.StyleSpecification {
  const rewritten = structuredClone(style);
  const source = rewritten.sources[sourceId] as maplibregl.VectorSourceSpecification | undefined;
  if (!source || source.type !== "vector") throw new Error("Local style has no verified vector source");
  source.url = undefined;
  source.tiles = [`${origin}/maps/regions/${encodeURIComponent(region.id)}/{z}/{x}/{y}.pbf`];
  source.minzoom = region.tileMinZoom;
  source.maxzoom = region.tileMaxZoom;
  if (region.attribution) source.attribution = region.attribution;
  return rewritten;
}

async function localStyle(
  info: BootstrapInfo,
  region: CachedRegion | null = null,
  theme: AppThemeKey = "hybrid",
): Promise<maplibregl.StyleSpecification> {
  const root = `${info.localAssetOrigin}/maps/default`;
  const bundledStyle = await fetchLocalStyle(localUrl(root, info.mapManifest.style));
  void logInfo("FoodMap local style fetched", { file: "map" });
  const bundledSource = bundledStyle.sources[
    info.mapManifest.sourceId
  ] as maplibregl.VectorSourceSpecification;
  if (!bundledSource || bundledSource.type !== "vector")
    throw new Error("Local style has no verified vector source");
  const style = structuredClone(theme === "hybrid" ? bundledStyle : STYLE_CATALOG[theme]);
  style.sources = { [info.mapManifest.sourceId]: structuredClone(bundledSource) };
  const source = style.sources[info.mapManifest.sourceId] as maplibregl.VectorSourceSpecification;
  if (!source || source.type !== "vector") throw new Error("Local style has no verified vector source");
  style.glyphs = localUrl(root, "fonts/{fontstack}/{range}.pbf");
  if (region) {
    const rewritten = rewriteStyleForCachedRegion(
      style,
      info.localAssetOrigin,
      region,
      info.mapManifest.sourceId,
    );
    assertLocalUrls(rewritten, info.localAssetOrigin);
    return rewritten;
  }
  const pmtilesUrl = localUrl(root, info.mapManifest.tiles);
  registerProtocol(pmtilesUrl);
  source.url = `pmtiles://${pmtilesUrl}`;
  assertLocalUrls(style, info.localAssetOrigin);
  return style;
}

export async function fetchLocalStyle(url: string): Promise<maplibregl.StyleSpecification> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`本地地图样式无法读取（HTTP ${response.status}）`);
    return (await response.json()) as maplibregl.StyleSpecification;
  } catch (reason) {
    if (reason instanceof Error && reason.message.startsWith("本地地图样式无法读取")) throw reason;
    throw new Error("本地地图样式无法读取", { cause: reason });
  }
}

export function activateCachedRegion(
  map: maplibregl.Map,
  localAssetOrigin: string,
  region: Pick<CachedRegion, "id" | "tileMinZoom" | "tileMaxZoom" | "attribution">,
  sourceId = "openmaptiles",
): void {
  const current = map.getStyle();
  map.setStyle(rewriteStyleForCachedRegion(current, localAssetOrigin, region, sourceId));
}

export async function createLocalMap(
  container: HTMLElement,
  onError: (message: string) => void,
  initialRegion: CachedRegion | null = null,
  theme: AppThemeKey = "hybrid",
): Promise<{ map: maplibregl.Map; restaurantPositionLocked: boolean; localAssetOrigin?: string }> {
  const info = await invoke<BootstrapInfo>("app_bootstrap");
  void logInfo("FoodMap local map bootstrap ready", { file: "map" });
  const style = await localStyle(info, initialRegion, theme);
  const initial = info.lastMapView ?? {
    longitude: info.mapManifest.center[0],
    latitude: info.mapManifest.center[1],
    zoom: info.mapManifest.center[2],
  };
  const map = new maplibregl.Map({
    container,
    style,
    center: [initial.longitude, initial.latitude],
    zoom: initial.zoom,
    minZoom: info.mapManifest.minZoom,
    maxZoom: MAP_VIEW_MAX_ZOOM,
    pitch: 0,
    bearing: 0,
    maxPitch: 0,
    localIdeographFontFamily: '"Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    attributionControl: false,
  });
  map.on("error", (event) => {
    const message = event.error instanceof Error ? event.error.message : "本地地图资源无法加载";
    void error(`FoodMap local map: ${message}`, { file: "map" });
    onError(message);
  });
  map.on("load", () => void logInfo("FoodMap local map style loaded", { file: "map" }));
  map.on("idle", () => void logInfo("FoodMap local map idle", { file: "map" }));
  requestAnimationFrame(() => map.resize());
  map.dragRotate.disable();
  map.touchZoomRotate.disableRotation();
  map.addControl(
    new maplibregl.AttributionControl({ compact: true, customAttribution: info.mapManifest.attribution }),
    "bottom-right",
  );
  void map.once("load", () => {
    void Promise.all(
      Object.entries({ ...info.iconManifest.icons, ...info.iconManifest.overlays }).map(([name, icon]) =>
        loadIcon(map, name, icon, info.foodIconBaseUrl),
      ),
    ).catch(() => undefined);
  });
  return {
    map,
    restaurantPositionLocked: info.restaurantPositionLocked,
    localAssetOrigin: info.localAssetOrigin,
  };
}
export function saveView(map: maplibregl.Map): void {
  const center = map.getCenter();
  void invoke("save_last_map_view", {
    view: { longitude: center.lng, latitude: center.lat, zoom: map.getZoom() },
  });
}
