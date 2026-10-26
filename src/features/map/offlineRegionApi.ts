import { invoke } from "@tauri-apps/api/core";

export type RegionBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type CachedRegion = {
  id: string;
  label: string;
  displayName: string;
  locale: string;
  west: number;
  south: number;
  east: number;
  north: number;
  centerLongitude: number;
  centerLatitude: number;
  returnZoom: number;
  tileMinZoom: number;
  tileMaxZoom: number;
  providerUrl: string;
  tileTemplate: string;
  providerVersion: string;
  attribution: string;
  tileCount: number;
  byteSize: number;
  status: "ready";
  createdAtMs: number;
  updatedAtMs: number;
};

export type RegionEstimate = {
  bounds: RegionBounds;
  centerLongitude: number;
  centerLatitude: number;
  returnZoom: number;
  tileMinZoom: number;
  tileMaxZoom: number;
  tileCount: number;
  estimatedBytes: number;
  providerUrl: string;
  tileTemplate: string;
  providerVersion: string;
  attribution: string;
};

export type GeocodedPlace = {
  displayName: string;
  latitude: number;
  longitude: number;
  placeType?: string | null;
  category?: string | null;
};

export type CreateCachedRegionInput = RegionEstimate & {
  label: string;
  displayName: string;
  locale?: string;
};

export const offlineRegionApi = {
  list: () => invoke<CachedRegion[]>("list_cached_regions"),
  search: (query: string) => invoke<GeocodedPlace[]>("search_places", { input: { query } }),
  reverse: (longitude: number, latitude: number) =>
    invoke<GeocodedPlace>("resolve_nearby_place", { input: { longitude, latitude } }),
  estimate: (input: Pick<RegionEstimate, "bounds" | "centerLongitude" | "centerLatitude" | "returnZoom">) =>
    invoke<RegionEstimate>("estimate_cached_region", { input }),
  create: (input: CreateCachedRegionInput) => invoke<CachedRegion>("create_cached_region", { input }),
  remove: (id: string) => invoke<boolean>("delete_cached_region", { input: { id } }),
};

export function regionBounds(region: Pick<CachedRegion, "west" | "south" | "east" | "north">): RegionBounds {
  return { west: region.west, south: region.south, east: region.east, north: region.north };
}

export function longitudeSpan(bounds: RegionBounds): number {
  return bounds.east >= bounds.west ? bounds.east - bounds.west : 360 - bounds.west + bounds.east;
}

export function boundsContain(outer: RegionBounds, inner: RegionBounds): boolean {
  if (inner.south < outer.south || inner.north > outer.north) return false;
  const intervals = (bounds: RegionBounds) =>
    bounds.east >= bounds.west
      ? [[bounds.west, bounds.east] as const]
      : [[bounds.west, 180] as const, [-180, bounds.east] as const];
  return intervals(outer).some(([outerWest, outerEast]) =>
    intervals(inner).every(([innerWest, innerEast]) => innerWest >= outerWest && innerEast <= outerEast),
  );
}

export const QUALIFIED_VIEWPORT_MIN_ZOOM = 13;
export const QUALIFIED_VIEWPORT_MAX_LON_SPAN = 0.12;
export const QUALIFIED_VIEWPORT_MAX_LAT_SPAN = 0.1;
export const QUALIFIED_VIEWPORT_MAX_AREA = 0.008;

export function isQualifiedViewport(bounds: RegionBounds, zoom: number): boolean {
  const latSpan = bounds.north - bounds.south;
  const lonSpan = longitudeSpan(bounds);
  return (
    Number.isFinite(zoom) &&
    zoom >= QUALIFIED_VIEWPORT_MIN_ZOOM &&
    Number.isFinite(latSpan) &&
    Number.isFinite(lonSpan) &&
    latSpan >= 0 &&
    latSpan <= QUALIFIED_VIEWPORT_MAX_LAT_SPAN &&
    lonSpan <= QUALIFIED_VIEWPORT_MAX_LON_SPAN &&
    lonSpan * latSpan <= QUALIFIED_VIEWPORT_MAX_AREA
  );
}

export function formatByteEstimate(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "估算不可用";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
