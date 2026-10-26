import { useCallback, useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import {
  restaurantApi,
  type Cuisine,
  type CuisineIcon,
  type MapRestaurant,
  type Restaurant,
  type Tag,
} from "../restaurants/api";
import { FoodLogSection } from "../food-logs/FoodLogSection";
import { MediaGrid } from "../media/MediaGrid";
import type { GalleryMapTarget } from "../media/GalleryView";
import { FOOD_SYMBOL_LAYER, foodFeatureId, installFoodLayers } from "./foodLayers";
import { CENTER_SYMBOL_LAYER, centerFeatureId, centerIconUrl, installCenterLayers } from "./centerLayers";
import {
  CENTER_KINDS,
  CENTER_KIND_LABELS,
  centerApi,
  type CenterIdentity,
  type MapCenter,
} from "./centerApi";
import { activateCachedRegion, createLocalMap, saveView } from "./localMap";
import type { AppThemeKey } from "../settings/themeCatalog";
import {
  boundsContain,
  formatByteEstimate,
  isQualifiedViewport,
  offlineRegionApi,
  regionBounds,
  type CachedRegion,
  type GeocodedPlace,
  type RegionBounds,
  type RegionEstimate,
} from "./offlineRegionApi";

type CreateLocation = { longitude: number; latitude: number };
type MapContextMenu = CreateLocation & { x: number; y: number; centerId?: string };
type CenterEditor = { location: CreateLocation; x: number; y: number; center?: MapCenter };
type CacheProposal = RegionEstimate & {
  label: string;
  displayName: string;
  locale: string;
};
type DragState = {
  id: string;
  original: [number, number];
  position: [number, number];
  startPoint: { x: number; y: number };
  dragging: boolean;
  mapIconScale: number;
  wasDragPanEnabled: boolean;
};
type CenterDragState = {
  id: string;
  original: [number, number];
  position: [number, number];
  startPoint: { x: number; y: number };
  dragging: boolean;
  wasDragPanEnabled: boolean;
};
type ProfileUpdateInput = {
  id: string;
  name: string;
  cuisineKey: string;
  iconKey: string;
  mapIconScale: number;
  phone?: string | null;
  openingHoursText?: string | null;
  addressNote?: string | null;
};
const statusLabels = { unknown: "未设置", want_to_go: "想去", visited: "去过", frequent: "常去" } as const;
const affectionLabels = { neutral: "普通", like: "喜欢", favorite: "最爱", avoid: "避雷" } as const;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function localIconUrl(baseUrl: string | undefined, icon: CuisineIcon): string {
  const path = icon.src.replace(/^\/+/, "");
  return baseUrl ? `${baseUrl.replace(/\/+$/, "")}/${path}` : path;
}
const INTRO_CARD_FADE_DELAY_MS = 4000;
const INTRO_CARD_FADE_DURATION_MS = 220;
const REGION_SETTLE_DELAY_MS = 900;
const MARKER_DRAG_THRESHOLD_PX = 5;

type BoundsReader = {
  getWest?: () => number;
  getSouth?: () => number;
  getEast?: () => number;
  getNorth?: () => number;
  _sw?: { lng: number; lat: number };
  _ne?: { lng: number; lat: number };
};

function mapBounds(map: maplibregl.Map): RegionBounds | null {
  const reader = map as maplibregl.Map & { getBounds?: () => BoundsReader };
  const bounds = reader.getBounds?.();
  if (!bounds) return null;
  const west = bounds.getWest?.() ?? bounds._sw?.lng;
  const south = bounds.getSouth?.() ?? bounds._sw?.lat;
  const east = bounds.getEast?.() ?? bounds._ne?.lng;
  const north = bounds.getNorth?.() ?? bounds._ne?.lat;
  if (west === undefined || south === undefined || east === undefined || north === undefined) return null;
  return { west, south, east, north };
}

function coverageBoundsAt(map: maplibregl.Map, longitude: number, latitude: number): RegionBounds | null {
  const bounds = mapBounds(map);
  if (!bounds) return null;
  const lonSpan = bounds.east >= bounds.west ? bounds.east - bounds.west : 360 - bounds.west + bounds.east;
  const latSpan = bounds.north - bounds.south;
  const west = longitude - lonSpan / 2;
  const east = longitude + lonSpan / 2;
  return {
    west: west < -180 ? west + 360 : west,
    east: east > 180 ? east - 360 : east,
    south: Math.max(-90, latitude - latSpan / 2),
    north: Math.min(90, latitude + latSpan / 2),
  };
}

function boundsContainPoint(bounds: RegionBounds, longitude: number, latitude: number): boolean {
  const longitudeInside =
    bounds.west <= bounds.east
      ? longitude >= bounds.west && longitude <= bounds.east
      : longitude >= bounds.west || longitude <= bounds.east;
  return longitudeInside && latitude >= bounds.south && latitude <= bounds.north;
}

function placeLabel(place: GeocodedPlace): string {
  const first = place.displayName.split(",")[0]?.trim();
  return first || place.displayName;
}

function placeLocale(place: GeocodedPlace): string {
  return /[\u3400-\u9fff]/u.test(place.displayName) ? "zh" : "en";
}

function installMapOverlays(
  map: maplibregl.Map,
  restaurants: MapRestaurant[],
  selectedId: string | null,
  centers: MapCenter[],
): void {
  installFoodLayers(map, restaurants, selectedId);
  void installCenterLayers(map, centers).catch(() => undefined);
}

function focusCachedRegion(
  map: maplibregl.Map,
  origin: string,
  region: CachedRegion,
  onStyleReady: () => void,
  destination?: { longitude: number; latitude: number; zoom?: number },
): void {
  const candidate = map as unknown as {
    flyTo?: (options: { center: [number, number]; zoom: number }) => void;
    jumpTo?: (options: { center: [number, number]; zoom: number }) => void;
    getStyle?: () => maplibregl.StyleSpecification;
    setStyle?: (style: maplibregl.StyleSpecification) => void;
  };
  if (origin && candidate.getStyle && candidate.setStyle) {
    void map.once("style.load", onStyleReady);
    activateCachedRegion(map, origin, region);
  } else {
    onStyleReady();
  }
  const options = {
    center: [
      destination?.longitude ?? region.centerLongitude,
      destination?.latitude ?? region.centerLatitude,
    ] as [number, number],
    zoom: destination?.zoom ?? region.returnZoom,
  };
  if (candidate.flyTo) candidate.flyTo(options);
  else candidate.jumpTo?.(options);
}

export function MapView({
  target = null,
  onTargetHandled,
  cachedRegions = [],
  onRegionsChanged,
  regionTarget = null,
  onRegionTargetHandled,
  openRegionSearch = false,
  onRegionSearchHandled,
  centers = [],
  onCentersChanged,
  centerTarget = null,
  onCenterTargetHandled,
  theme = "hybrid",
}: {
  target?: GalleryMapTarget | null;
  onTargetHandled?: () => void;
  cachedRegions?: CachedRegion[];
  onRegionsChanged?: () => void | Promise<void>;
  regionTarget?: CachedRegion | null;
  onRegionTargetHandled?: () => void;
  openRegionSearch?: boolean;
  onRegionSearchHandled?: () => void;
  centers?: MapCenter[];
  onCentersChanged?: () => void | Promise<void>;
  centerTarget?: MapCenter | null;
  onCenterTargetHandled?: () => void;
  theme?: AppThemeKey;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const timerRef = useRef<number | null>(null);
  const regionSettleTimerRef = useRef<number | null>(null);
  const regionRequestRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const centerDragRef = useRef<CenterDragState | null>(null);
  const centerContextHandledRef = useRef(false);
  const suppressClickRef = useRef(false);
  const restaurantsRef = useRef<MapRestaurant[]>([]);
  const selectedRef = useRef<Restaurant | null>(null);
  const initialTargetRef = useRef(target);
  const handledTargetRef = useRef(target);
  const onTargetHandledRef = useRef(onTargetHandled);
  const onRegionTargetHandledRef = useRef(onRegionTargetHandled);
  const onRegionsChangedRef = useRef(onRegionsChanged);
  const onCentersChangedRef = useRef(onCentersChanged);
  const onCenterTargetHandledRef = useRef(onCenterTargetHandled);
  const cachedRegionsRef = useRef(cachedRegions);
  const centersRef = useRef(centers);
  const pendingCenterIdRef = useRef<string | null>(null);
  const cacheCreatingRef = useRef(false);
  const localAssetOriginRef = useRef("");
  const activeRegionIdRef = useRef<string | null>(null);
  const activeCenterIdRef = useRef<string | null>(null);
  const initialRegionTargetRef = useRef(regionTarget);
  const initialCenterTargetRef = useRef(centerTarget);
  const [message, setMessage] = useState("正在加载离线地图…");
  const [cuisines, setCuisines] = useState<Cuisine[]>([]);
  const [foodIconBaseUrl, setFoodIconBaseUrl] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [selected, setSelected] = useState<Restaurant | null>(null);
  const [focusedFoodLogId, setFocusedFoodLogId] = useState<string | null>(target?.foodLogId ?? null);
  const [createAt, setCreateAt] = useState<CreateLocation | null>(null);
  const [contextMenu, setContextMenu] = useState<MapContextMenu | null>(null);
  const [centerEditor, setCenterEditor] = useState<CenterEditor | null>(null);
  const [showIntroCard, setShowIntroCard] = useState(true);
  const [introCardFading, setIntroCardFading] = useState(false);
  const [cacheProposal, setCacheProposal] = useState<CacheProposal | null>(null);
  const [cacheCreating, setCacheCreating] = useState(false);
  const [activeRegionLabel, setActiveRegionLabel] = useState("本地地图");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<GeocodedPlace[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    onTargetHandledRef.current = onTargetHandled;
    onRegionTargetHandledRef.current = onRegionTargetHandled;
    onRegionsChangedRef.current = onRegionsChanged;
    onCentersChangedRef.current = onCentersChanged;
    onCenterTargetHandledRef.current = onCenterTargetHandled;
    cachedRegionsRef.current = cachedRegions;
    centersRef.current = centers;
  }, [
    cachedRegions,
    centers,
    onRegionTargetHandled,
    onRegionsChanged,
    onCentersChanged,
    onCenterTargetHandled,
    onTargetHandled,
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (map) void installCenterLayers(map, centers).catch((reason) => setMessage(errorText(reason)));
  }, [centers]);

  const resolveRegionProposal = useCallback(async (map: maplibregl.Map) => {
    if (cacheCreatingRef.current) return;
    const bounds = mapBounds(map);
    const center = map.getCenter();
    const zoom = map.getZoom();
    if (!bounds || !center || !isQualifiedViewport(bounds, zoom)) {
      setCacheProposal(null);
      return;
    }
    const requestId = ++regionRequestRef.current;
    setCacheProposal(null);
    const activeCenter = activeCenterIdRef.current
      ? centersRef.current.find((item) => item.id === activeCenterIdRef.current)
      : null;
    if (
      activeCenter &&
      activeCenter.cachedRegionIds.length > 0 &&
      boundsContainPoint(bounds, activeCenter.longitude, activeCenter.latitude)
    ) {
      return;
    }
    try {
      const place = await offlineRegionApi.reverse(center.lng, center.lat);
      if (requestId !== regionRequestRef.current || cacheCreatingRef.current) return;
      const estimate = await offlineRegionApi.estimate({
        bounds,
        centerLongitude: center.lng,
        centerLatitude: center.lat,
        returnZoom: zoom,
      });
      if (requestId !== regionRequestRef.current || cacheCreatingRef.current) return;
      if (cachedRegionsRef.current.some((region) => boundsContain(regionBounds(region), estimate.bounds))) {
        setCacheProposal(null);
        return;
      }
      setCacheProposal({
        ...estimate,
        label: placeLabel(place),
        displayName: place.displayName,
        locale: placeLocale(place),
      });
    } catch (reason) {
      if (requestId === regionRequestRef.current) setMessage(`无法识别此处：${errorText(reason)}`);
    }
  }, []);

  const createCache = useCallback(async () => {
    const proposal = cacheProposal;
    if (!proposal || cacheCreatingRef.current) return;
    cacheCreatingRef.current = true;
    setCacheCreating(true);
    try {
      const region = await offlineRegionApi.create(proposal);
      const centerId = pendingCenterIdRef.current;
      if (centerId) {
        const center = await centerApi.attachRegion(centerId, region.id);
        centersRef.current = centersRef.current.map((item) => (item.id === center.id ? center : item));
        if (mapRef.current) {
          await installCenterLayers(mapRef.current, centersRef.current);
        }
        pendingCenterIdRef.current = null;
        await onCentersChangedRef.current?.();
      }
      setCacheProposal(null);
      setMessage("周边地图已缓存");
      await onRegionsChangedRef.current?.();
    } catch (reason) {
      setMessage(`缓存失败：${errorText(reason)}`);
    } finally {
      cacheCreatingRef.current = false;
      setCacheCreating(false);
    }
  }, [cacheProposal]);

  const submitRegionSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query || searching) return;
    setSearching(true);
    try {
      setSearchResults(await offlineRegionApi.search(query));
    } catch (reason) {
      setMessage(`搜索失败：${errorText(reason)}`);
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }, [searchQuery, searching]);

  const choosePlace = useCallback(
    (place: GeocodedPlace) => {
      const map = mapRef.current;
      if (!map) {
        setMessage("地图尚未就绪，请稍后再试");
        return;
      }
      const zoom = Math.max(14, map.getZoom());
      map.flyTo({ center: [place.longitude, place.latitude], zoom });
      activeCenterIdRef.current = null;
      setActiveRegionLabel(placeLabel(place));
      onRegionSearchHandled?.();
      setSearchResults([]);
      setCacheProposal(null);
    },
    [onRegionSearchHandled],
  );

  const refreshMap = useCallback(
    async (chosenId?: string) => {
      const next = await restaurantApi.listMap();
      restaurantsRef.current = next;
      installMapOverlays(
        mapRef.current!,
        next,
        chosenId ?? selected?.id ?? initialTargetRef.current?.restaurantId ?? null,
        centersRef.current,
      );
    },
    [selected?.id],
  );
  const select = useCallback(async (id: string) => {
    try {
      const restaurant = await restaurantApi.get(id);
      if (!restaurant) throw new Error("Restaurant no longer exists");
      setSelected(restaurant);
      if (mapRef.current) installMapOverlays(mapRef.current, restaurantsRef.current, id, centersRef.current);
    } catch (reason) {
      setMessage(errorText(reason));
    }
  }, []);

  const focusRegion = useCallback((region: CachedRegion) => {
    const map = mapRef.current;
    if (!map) return;
    activeCenterIdRef.current = null;
    activeRegionIdRef.current = region.id;
    try {
      focusCachedRegion(map, localAssetOriginRef.current, region, () =>
        installMapOverlays(map, restaurantsRef.current, selectedRef.current?.id ?? null, centersRef.current),
      );
      setActiveRegionLabel(region.label);
      onRegionTargetHandledRef.current?.();
    } catch (reason) {
      setMessage(`离线地图无法打开：${errorText(reason)}`);
    }
  }, []);

  const focusCenter = useCallback((center: MapCenter) => {
    const map = mapRef.current;
    if (!map) return;
    activeCenterIdRef.current = center.id;
    setActiveRegionLabel(center.name);
    const region = center.primaryRegionId
      ? cachedRegionsRef.current.find((item) => item.id === center.primaryRegionId)
      : undefined;
    const restoreOverlays = () =>
      installMapOverlays(map, restaurantsRef.current, selectedRef.current?.id ?? null, centersRef.current);
    if (region && localAssetOriginRef.current) {
      activeRegionIdRef.current = region.id;
      focusCachedRegion(map, localAssetOriginRef.current, region, restoreOverlays, {
        longitude: center.longitude,
        latitude: center.latitude,
      });
    } else {
      map.flyTo({
        center: [center.longitude, center.latitude],
        zoom: Math.max(14, map.getZoom()),
      });
    }
  }, []);

  const persistCenter = useCallback(
    async (identity: CenterIdentity, editor: CenterEditor) => {
      const map = mapRef.current;
      if (!map) return;
      const coverageBounds = coverageBoundsAt(map, editor.location.longitude, editor.location.latitude);
      if (!coverageBounds) throw new Error("地图范围尚未就绪");
      const center = editor.center
        ? await centerApi.update({ id: editor.center.id, ...identity })
        : await centerApi.create({ ...identity, ...editor.location, coverageBounds });
      centersRef.current = editor.center
        ? centersRef.current.map((item) => (item.id === center.id ? center : item))
        : [...centersRef.current, center];
      await installCenterLayers(map, centersRef.current);
      setCenterEditor(null);
      setContextMenu(null);
      pendingCenterIdRef.current = center.cachedRegionIds.length === 0 ? center.id : null;
      focusCenter(center);
      await onCentersChangedRef.current?.();
    },
    [focusCenter],
  );

  const previewCenterScale = useCallback((center: MapCenter | undefined, mapIconScale: number) => {
    const map = mapRef.current;
    if (!map || !center) return;
    centersRef.current = centersRef.current.map((item) =>
      item.id === center.id ? { ...item, mapIconScale } : item,
    );
    void installCenterLayers(map, centersRef.current).catch(() => undefined);
  }, []);

  const cancelCenterEdit = useCallback(() => {
    const original = centerEditor?.center;
    const map = mapRef.current;
    if (original && map) {
      centersRef.current = centersRef.current.map((item) => (item.id === original.id ? original : item));
      void installCenterLayers(map, centersRef.current).catch(() => undefined);
    }
    setCenterEditor(null);
  }, [centerEditor]);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    void createLocalMap(container, setMessage, null, theme)
      .then(async ({ map, restaurantPositionLocked, localAssetOrigin }) => {
        if (disposed) {
          map.remove();
          return;
        }
        mapRef.current = map;
        localAssetOriginRef.current = localAssetOrigin ?? "";
        const positionLocked = restaurantPositionLocked === true;
        map.on("idle", () => setMessage(""));
        map.on("moveend", () => {
          if (timerRef.current) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => saveView(map), 700);
          if (regionSettleTimerRef.current) window.clearTimeout(regionSettleTimerRef.current);
          regionSettleTimerRef.current = window.setTimeout(
            () => void resolveRegionProposal(map),
            REGION_SETTLE_DELAY_MS,
          );
        });
        map.on("load", () => {
          map.on("click", () => setContextMenu(null));
          map.on("contextmenu", CENTER_SYMBOL_LAYER, (event) => {
            const id = event.features?.[0] ? centerFeatureId(event.features[0]) : null;
            if (!id) return;
            event.preventDefault();
            centerContextHandledRef.current = true;
            setContextMenu({
              longitude: event.lngLat.lng,
              latitude: event.lngLat.lat,
              x: event.point.x,
              y: event.point.y,
              centerId: id,
            });
          });
          map.on("contextmenu", (event) => {
            if (centerContextHandledRef.current) {
              centerContextHandledRef.current = false;
              return;
            }
            setContextMenu({
              longitude: event.lngLat.lng,
              latitude: event.lngLat.lat,
              x: event.point.x,
              y: event.point.y,
            });
          });
          map.on("click", CENTER_SYMBOL_LAYER, (event) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            const id = event.features?.[0] ? centerFeatureId(event.features[0]) : null;
            const center = id ? centersRef.current.find((item) => item.id === id) : null;
            if (!center) return;
            setCenterEditor({
              center,
              location: { longitude: center.longitude, latitude: center.latitude },
              x: event.point.x,
              y: event.point.y,
            });
            setContextMenu(null);
          });
          map.on("mouseenter", CENTER_SYMBOL_LAYER, () => {
            map.getCanvas().style.cursor = "grab";
          });
          map.on("mouseleave", CENTER_SYMBOL_LAYER, () => {
            if (!centerDragRef.current && !dragRef.current) map.getCanvas().style.cursor = "";
          });
          map.on("mousedown", CENTER_SYMBOL_LAYER, (event) => {
            if (centerDragRef.current || dragRef.current) return;
            if (
              event.originalEvent &&
              event.originalEvent.button !== undefined &&
              event.originalEvent.button !== 0
            )
              return;
            const id = event.features?.[0] ? centerFeatureId(event.features[0]) : null;
            const center = id ? centersRef.current.find((item) => item.id === id) : null;
            if (!center) return;
            event.preventDefault();
            suppressClickRef.current = false;
            const original: [number, number] = [center.longitude, center.latitude];
            const wasDragPanEnabled = map.dragPan.isEnabled();
            map.dragPan.disable();
            centerDragRef.current = {
              id: center.id,
              original,
              position: original,
              startPoint: { x: event.point.x, y: event.point.y },
              dragging: false,
              wasDragPanEnabled,
            };
          });
          map.on("click", FOOD_SYMBOL_LAYER, (event) => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            const id = event.features?.[0] ? foodFeatureId(event.features[0]) : null;
            if (id) void select(id);
          });
          map.on("mouseenter", FOOD_SYMBOL_LAYER, (event) => {
            const id = event.features?.[0] ? foodFeatureId(event.features[0]) : null;
            const restaurant = id ? restaurantsRef.current.find((item) => item.id === id) : null;
            map.getCanvas().style.cursor = positionLocked || restaurant?.positionLocked ? "pointer" : "grab";
          });
          map.on("mouseleave", FOOD_SYMBOL_LAYER, () => {
            if (!dragRef.current) map.getCanvas().style.cursor = "";
          });
          map.on("mousedown", FOOD_SYMBOL_LAYER, (event) => {
            if (dragRef.current) return;
            if (
              event.originalEvent &&
              event.originalEvent.button !== undefined &&
              event.originalEvent.button !== 0
            )
              return;
            const id = event.features?.[0] ? foodFeatureId(event.features[0]) : null;
            const restaurant = id ? restaurantsRef.current.find((item) => item.id === id) : null;
            if (!restaurant || positionLocked || restaurant.positionLocked) return;
            const restaurantId = restaurant.id;
            event.preventDefault();
            suppressClickRef.current = false;
            const original: [number, number] = [restaurant.longitude, restaurant.latitude];
            const wasDragPanEnabled = map.dragPan.isEnabled();
            map.dragPan.disable();
            dragRef.current = {
              id: restaurantId,
              original,
              position: original,
              startPoint: { x: event.point.x, y: event.point.y },
              dragging: false,
              mapIconScale: restaurant.mapIconScale,
              wasDragPanEnabled,
            };
          });
          const previewPosition = (longitude: number, latitude: number) => {
            const drag = dragRef.current;
            if (!drag || (drag.position[0] === longitude && drag.position[1] === latitude)) return;
            drag.position = [longitude, latitude];
            restaurantsRef.current = restaurantsRef.current.map((item) =>
              item.id === drag.id ? { ...item, longitude, latitude } : item,
            );
            installMapOverlays(
              map,
              restaurantsRef.current,
              selectedRef.current?.id ?? null,
              centersRef.current,
            );
            map.getCanvas().style.cursor = "grabbing";
          };
          const previewCenterPosition = (longitude: number, latitude: number) => {
            const drag = centerDragRef.current;
            if (!drag || (drag.position[0] === longitude && drag.position[1] === latitude)) return;
            drag.position = [longitude, latitude];
            centersRef.current = centersRef.current.map((item) =>
              item.id === drag.id ? { ...item, longitude, latitude } : item,
            );
            void installCenterLayers(map, centersRef.current).catch(() => undefined);
            map.getCanvas().style.cursor = "grabbing";
          };
          map.on("mousemove", (event) => {
            const centerDrag = centerDragRef.current;
            if (centerDrag) {
              if (!centerDrag.dragging) {
                const distance = Math.hypot(
                  event.point.x - centerDrag.startPoint.x,
                  event.point.y - centerDrag.startPoint.y,
                );
                if (distance <= MARKER_DRAG_THRESHOLD_PX) return;
                centerDrag.dragging = true;
              }
              previewCenterPosition(event.lngLat.lng, event.lngLat.lat);
              return;
            }
            const drag = dragRef.current;
            if (!drag) return;
            if (!drag.dragging) {
              const distance = Math.hypot(
                event.point.x - drag.startPoint.x,
                event.point.y - drag.startPoint.y,
              );
              if (distance <= MARKER_DRAG_THRESHOLD_PX) return;
              drag.dragging = true;
            }
            previewPosition(event.lngLat.lng, event.lngLat.lat);
          });
          map.on("mouseup", (event) => {
            const centerDrag = centerDragRef.current;
            if (centerDrag) {
              if (centerDrag.dragging) previewCenterPosition(event.lngLat.lng, event.lngLat.lat);
              const completed = centerDragRef.current;
              centerDragRef.current = null;
              if (completed?.wasDragPanEnabled) map.dragPan.enable();
              map.getCanvas().style.cursor = "grab";
              if (!completed?.dragging) return;
              suppressClickRef.current = true;
              window.setTimeout(() => {
                suppressClickRef.current = false;
              }, 0);
              const [longitude, latitude] = completed.position;
              const coverageBounds = coverageBoundsAt(map, longitude, latitude);
              if (!coverageBounds) return;
              void centerApi
                .move({ id: completed.id, longitude, latitude, coverageBounds })
                .then(async (updated) => {
                  if (disposed) return;
                  centersRef.current = centersRef.current.map((item) =>
                    item.id === updated.id ? updated : item,
                  );
                  await installCenterLayers(map, centersRef.current);
                  pendingCenterIdRef.current = updated.cachedRegionIds.length === 0 ? updated.id : null;
                  setActiveRegionLabel(updated.name);
                  await onCentersChangedRef.current?.();
                  if (pendingCenterIdRef.current) {
                    map.flyTo({ center: [longitude, latitude], zoom: map.getZoom() });
                  }
                })
                .catch((reason: unknown) => {
                  if (disposed) return;
                  centersRef.current = centersRef.current.map((item) =>
                    item.id === completed.id
                      ? { ...item, longitude: completed.original[0], latitude: completed.original[1] }
                      : item,
                  );
                  void installCenterLayers(map, centersRef.current).catch(() => undefined);
                  setMessage(`中心位置未保存：${errorText(reason)}`);
                });
              return;
            }
            const drag = dragRef.current;
            if (!drag) return;
            if (drag.dragging) previewPosition(event.lngLat.lng, event.lngLat.lat);
            const completed = dragRef.current;
            dragRef.current = null;
            if (completed?.wasDragPanEnabled) map.dragPan.enable();
            map.getCanvas().style.cursor = positionLocked ? "pointer" : "grab";
            if (!completed?.dragging) return;
            suppressClickRef.current = true;
            window.setTimeout(() => {
              suppressClickRef.current = false;
            }, 0);
            const [longitude, latitude] = completed.position;
            void restaurantApi
              .move(completed.id, longitude, latitude)
              .then((updated) => {
                if (disposed) return;
                restaurantsRef.current = restaurantsRef.current.map((item) =>
                  item.id === updated.id
                    ? { ...item, longitude: updated.longitude, latitude: updated.latitude }
                    : item,
                );
                if (selectedRef.current?.id === updated.id) {
                  const stableUpdated = { ...updated, mapIconScale: completed.mapIconScale };
                  selectedRef.current = stableUpdated;
                  setSelected(stableUpdated);
                }
                installMapOverlays(
                  map,
                  restaurantsRef.current,
                  selectedRef.current?.id ?? null,
                  centersRef.current,
                );
              })
              .catch((reason: unknown) => {
                if (disposed) return;
                restaurantsRef.current = restaurantsRef.current.map((item) =>
                  item.id === completed.id
                    ? { ...item, longitude: completed.original[0], latitude: completed.original[1] }
                    : item,
                );
                installMapOverlays(
                  map,
                  restaurantsRef.current,
                  selectedRef.current?.id ?? null,
                  centersRef.current,
                );
                setMessage(`位置未保存：${errorText(reason)}`);
              });
          });
        });
        try {
          const [manifest, initialRestaurants, initialTags] = await Promise.all([
            restaurantApi.manifest(),
            restaurantApi.listMap(),
            restaurantApi.listTags(),
          ]);
          if (disposed) return;
          setCuisines(manifest.cuisines);
          setFoodIconBaseUrl(manifest.foodIconBaseUrl);
          restaurantsRef.current = initialRestaurants;
          setTags(initialTags);
          const initialTarget = initialTargetRef.current;
          void map.once("load", () =>
            installMapOverlays(
              map,
              initialRestaurants,
              initialTarget?.restaurantId ?? null,
              centersRef.current,
            ),
          );
          if (initialTarget) {
            await select(initialTarget.restaurantId);
            onTargetHandledRef.current?.();
          }
          const initialRegionTarget = initialRegionTargetRef.current;
          if (initialRegionTarget) {
            focusRegion(initialRegionTarget);
          }
          const initialCenterTarget = initialCenterTargetRef.current;
          if (initialCenterTarget) {
            focusCenter(initialCenterTarget);
            onCenterTargetHandledRef.current?.();
          }
        } catch (reason) {
          setMessage(errorText(reason));
        }
      })
      .catch((reason: unknown) => setMessage(errorText(reason)));
    return () => {
      disposed = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      if (regionSettleTimerRef.current) window.clearTimeout(regionSettleTimerRef.current);
      regionRequestRef.current += 1;
      dragRef.current = null;
      centerDragRef.current = null;
      suppressClickRef.current = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [focusCenter, focusRegion, resolveRegionProposal, select, theme]);
  useEffect(() => {
    if (!target || target === handledTargetRef.current) return;
    handledTargetRef.current = target;
    setFocusedFoodLogId(target.foodLogId);
    void select(target.restaurantId).finally(() => onTargetHandled?.());
  }, [onTargetHandled, select, target]);
  useEffect(() => {
    if (!regionTarget || regionTarget === initialRegionTargetRef.current) return;
    const map = mapRef.current;
    if (!map || !localAssetOriginRef.current) return;
    initialRegionTargetRef.current = regionTarget;
    focusRegion(regionTarget);
  }, [focusRegion, regionTarget]);
  useEffect(() => {
    if (!centerTarget) return;
    initialCenterTargetRef.current = centerTarget;
    focusCenter(centerTarget);
    onCenterTargetHandled?.();
  }, [centerTarget, focusCenter, onCenterTargetHandled]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const center = mapRef.current?.getCenter();
        if (center) setCreateAt({ longitude: center.lng, latitude: center.lat });
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);
  useEffect(() => {
    let removeTimer: number | null = null;
    const fadeTimer = window.setTimeout(() => {
      setIntroCardFading(true);
      removeTimer = window.setTimeout(() => setShowIntroCard(false), INTRO_CARD_FADE_DURATION_MS);
    }, INTRO_CARD_FADE_DELAY_MS);
    return () => {
      window.clearTimeout(fadeTimer);
      if (removeTimer !== null) window.clearTimeout(removeTimer);
    };
  }, []);
  async function saveStatus(
    input: Partial<Pick<MapRestaurant, "overallRating" | "visitStatus" | "affectionStatus" | "isBookmarked">>,
  ) {
    if (!selected) return;
    try {
      setSelected(await restaurantApi.updateStatus({ id: selected.id, ...input }));
      await refreshMap(selected.id);
    } catch (reason) {
      setMessage(errorText(reason));
    }
  }
  return (
    <section className="map-view" aria-label="本地离线地图">
      <header className="map-view__header">
        <div>
          <p>LOCAL / OFFLINE MAP</p>
          <h2>{activeRegionLabel}</h2>
        </div>
        <span>
          <i aria-hidden="true" /> local PMTiles · north-up
        </span>
      </header>
      <div className="map-stage">
        <div ref={containerRef} className="map-canvas" aria-label="Interactive offline food map" />
        <div className="map-grain" aria-hidden="true" />
        {contextMenu && (
          <aside
            className="map-context-menu"
            aria-label={contextMenu.centerId ? "中心点菜单" : "地图菜单"}
            style={{
              left: `min(${contextMenu.x}px, calc(100% - 176px))`,
              top: `min(${contextMenu.y}px, calc(100% - 112px))`,
            }}
          >
            {contextMenu.centerId ? (
              <button
                type="button"
                className="map-context-menu__danger"
                onClick={() => {
                  const id = contextMenu.centerId;
                  if (!id) return;
                  setContextMenu(null);
                  void centerApi
                    .remove(id)
                    .then(async () => {
                      centersRef.current = centersRef.current.filter((item) => item.id !== id);
                      if (mapRef.current) await installCenterLayers(mapRef.current, centersRef.current);
                      await onCentersChangedRef.current?.();
                      await onRegionsChangedRef.current?.();
                    })
                    .catch((reason) => setMessage(`中心点未删除：${errorText(reason)}`));
                }}
              >
                删除中心点
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setCreateAt({ longitude: contextMenu.longitude, latitude: contextMenu.latitude });
                    setContextMenu(null);
                  }}
                >
                  在此添加餐厅
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCenterEditor({
                      location: {
                        longitude: contextMenu.longitude,
                        latitude: contextMenu.latitude,
                      },
                      x: contextMenu.x,
                      y: contextMenu.y,
                    });
                    setContextMenu(null);
                  }}
                >
                  设为中心点
                </button>
              </>
            )}
          </aside>
        )}
        {centerEditor && (
          <CenterEditorPanel
            editor={centerEditor}
            onCancel={cancelCenterEdit}
            onScalePreview={(mapIconScale) => previewCenterScale(centerEditor.center, mapIconScale)}
            onSave={(identity) => persistCenter(identity, centerEditor)}
          />
        )}
        {showIntroCard && (
          <section
            className="intro-card"
            data-fading={introCardFading || undefined}
            aria-label="Map description"
          >
            <span className="card-kicker">FOOD MAP</span>
            <p>右键地图添加餐厅或常用中心；Ctrl/⌘ + N 可直接添加餐厅。</p>
          </section>
        )}
        <div className="loading-note" data-hidden={!message || undefined} role="status">
          {message}
        </div>
        {openRegionSearch && (
          <RegionSearchPanel
            query={searchQuery}
            results={searchResults}
            searching={searching}
            onQueryChange={setSearchQuery}
            onSubmit={() => void submitRegionSearch()}
            onChoose={choosePlace}
            onClose={() => {
              onRegionSearchHandled?.();
              setSearchResults([]);
            }}
          />
        )}
        {cacheProposal && !cacheCreating && (
          <CacheProposalPanel
            proposal={cacheProposal}
            onCreate={() => void createCache()}
            onDismiss={() => setCacheProposal(null)}
          />
        )}
        {cacheCreating && cacheProposal && (
          <aside className="cache-proposal" aria-label="正在缓存地图">
            <p className="panel-kicker">OFFLINE CACHE</p>
            <strong>{cacheProposal.label}</strong>
            <small>正在保存 {cacheProposal.tileCount} 张地图瓦片…</small>
          </aside>
        )}
        {createAt && (
          <CreatePanel
            cuisines={cuisines}
            foodIconBaseUrl={foodIconBaseUrl}
            location={createAt}
            onCancel={() => setCreateAt(null)}
            onSave={(input) => {
              void (async () => {
                try {
                  const restaurant = await restaurantApi.create({ ...input, ...createAt });
                  setCreateAt(null);
                  await refreshMap(restaurant.id);
                  await select(restaurant.id);
                } catch (reason) {
                  setMessage(errorText(reason));
                }
              })();
            }}
          />
        )}
        {selected && (
          <DetailPanel
            restaurant={selected}
            cuisines={cuisines}
            foodIconBaseUrl={foodIconBaseUrl}
            tags={tags}
            onClose={() => {
              setSelected(null);
              void refreshMap("");
            }}
            onStatus={(input) => {
              void saveStatus(input);
            }}
            onPositionLock={(locked) => {
              return (async () => {
                try {
                  const updated = await restaurantApi.setPositionLocked(selected.id, locked);
                  setSelected(updated);
                  await refreshMap(updated.id);
                } catch (reason) {
                  setMessage(errorText(reason));
                  throw reason;
                }
              })();
            }}
            onProfile={(input) => {
              return (async () => {
                try {
                  const updated = await restaurantApi.updateProfile(input);
                  setSelected((current) => (current?.id === input.id ? updated : current));
                  await refreshMap(input.id);
                } catch (reason) {
                  setMessage(errorText(reason));
                  throw reason;
                }
              })();
            }}
            onMapIconScalePreview={(scale) => {
              const id = selected.id;
              restaurantsRef.current = restaurantsRef.current.map((item) =>
                item.id === id ? { ...item, mapIconScale: scale } : item,
              );
              setSelected((current) => (current?.id === id ? { ...current, mapIconScale: scale } : current));
              if (mapRef.current) {
                installMapOverlays(mapRef.current, restaurantsRef.current, id, centersRef.current);
              }
            }}
            onMapIconPreview={(cuisineKey, iconKey) => {
              const id = selected.id;
              restaurantsRef.current = restaurantsRef.current.map((item) =>
                item.id === id ? { ...item, cuisineKey, iconKey } : item,
              );
              setSelected((current) => (current?.id === id ? { ...current, cuisineKey, iconKey } : current));
              if (mapRef.current) {
                installMapOverlays(mapRef.current, restaurantsRef.current, id, centersRef.current);
              }
            }}
            onDelete={() => {
              void (async () => {
                try {
                  await restaurantApi.softDelete(selected.id);
                  setSelected(null);
                  await refreshMap("");
                } catch (reason) {
                  setMessage(errorText(reason));
                }
              })();
            }}
            onTags={() =>
              (async () => {
                setTags(await restaurantApi.listTags());
                const fresh = await restaurantApi.get(selected.id);
                if (fresh) setSelected(fresh);
              })()
            }
            onLogMutation={() => {
              void (async () => {
                const fresh = await restaurantApi.get(selected.id);
                if (fresh) setSelected(fresh);
                await refreshMap(selected.id);
              })();
            }}
            focusedFoodLogId={focusedFoodLogId}
          />
        )}
      </div>
    </section>
  );
}

export function CenterEditorPanel({
  editor,
  onSave,
  onCancel,
  onScalePreview,
}: {
  editor: CenterEditor;
  onSave: (identity: CenterIdentity) => Promise<void>;
  onCancel: () => void;
  onScalePreview?: (mapIconScale: number) => void;
}) {
  const [kind, setKind] = useState(editor.center?.kind ?? "home");
  const [iconVariant, setIconVariant] = useState<1 | 2 | 3>(editor.center?.iconVariant ?? 1);
  const [name, setName] = useState(editor.center?.name ?? CENTER_KIND_LABELS.home);
  const [mapIconScale, setMapIconScale] = useState(editor.center?.mapIconScale ?? 1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const chooseIcon = (nextKind: (typeof CENTER_KINDS)[number], nextVariant: 1 | 2 | 3) => {
    const currentDefault = CENTER_KIND_LABELS[kind];
    setKind(nextKind);
    setIconVariant(nextVariant);
    if (!name.trim() || name === currentDefault) setName(CENTER_KIND_LABELS[nextKind]);
  };

  return (
    <form
      className="center-editor"
      aria-label={editor.center ? "编辑中心点" : "设置中心点"}
      style={{
        left: `min(${editor.x}px, calc(100% - 326px))`,
        top: `min(${editor.y}px, calc(100% - 346px))`,
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (saving || !name.trim()) return;
        setSaving(true);
        setError("");
        void onSave({ name: name.trim(), kind, iconVariant, mapIconScale })
          .catch((reason) => setError(errorText(reason)))
          .finally(() => setSaving(false));
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
      }}
    >
      <div className="center-editor__heading">
        <span>常用中心</span>
        <button type="button" aria-label="取消设置中心点" onClick={onCancel}>
          ×
        </button>
      </div>
      <label>
        名称
        <input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="center-editor__icons" aria-label="中心点图标">
        {CENTER_KINDS.map((candidateKind) => (
          <div className="center-editor__icon-row" key={candidateKind}>
            <span>{CENTER_KIND_LABELS[candidateKind]}</span>
            {[1, 2, 3].map((candidateVariant) => {
              const variant = candidateVariant as 1 | 2 | 3;
              const chosen = kind === candidateKind && iconVariant === variant;
              return (
                <button
                  type="button"
                  key={variant}
                  data-active={chosen || undefined}
                  aria-label={`${CENTER_KIND_LABELS[candidateKind]}图标 ${variant}`}
                  aria-pressed={chosen}
                  onClick={() => chooseIcon(candidateKind, variant)}
                >
                  <img src={centerIconUrl({ kind: candidateKind, iconVariant: variant })} alt="" />
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <label className="map-icon-scale-control">
        <span className="map-icon-scale-control__heading">
          地图图标大小
          <output>{mapIconScale.toFixed(2)}×</output>
        </span>
        <input
          aria-label="地图图标大小"
          type="range"
          min="0.25"
          max="2.5"
          step="0.05"
          value={mapIconScale}
          onChange={(event) => {
            const next = Number(event.target.value);
            setMapIconScale(next);
            onScalePreview?.(next);
          }}
        />
      </label>
      <div className="center-editor__footer">
        {error ? <small>{error}</small> : <small>Enter 保存 · Esc 取消</small>}
        <button type="submit" aria-label="保存中心点" disabled={saving || !name.trim()}>
          {saving ? "…" : "✓"}
        </button>
      </div>
    </form>
  );
}

export function CacheProposalPanel({
  proposal,
  onCreate,
  onDismiss,
}: {
  proposal: CacheProposal;
  onCreate: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className="cache-proposal" aria-label="缓存此处周边">
      <p className="panel-kicker">NEARBY CACHE</p>
      <h3>缓存此处周边</h3>
      <strong>{proposal.label}</strong>
      <small>
        约 {formatByteEstimate(proposal.estimatedBytes)} · {proposal.tileCount} 张地图瓦片
      </small>
      <div className="panel-actions">
        <button type="button" onClick={onDismiss}>
          稍后
        </button>
        <button type="button" className="button-primary" onClick={onCreate}>
          缓存此处周边
        </button>
      </div>
    </aside>
  );
}

export function RegionSearchPanel({
  query,
  results,
  searching,
  onQueryChange,
  onSubmit,
  onChoose,
  onClose,
}: {
  query: string;
  results: GeocodedPlace[];
  searching: boolean;
  onQueryChange: (value: string) => void;
  onSubmit: () => void;
  onChoose: (place: GeocodedPlace) => void;
  onClose: () => void;
}) {
  return (
    <aside className="region-search" aria-label="地点搜索">
      <div className="region-search__heading">
        <div>
          <p className="panel-kicker">PLACE SEARCH</p>
          <h3>搜索地点</h3>
        </div>
        <button type="button" className="panel-close" aria-label="关闭地点搜索" onClick={onClose}>
          ×
        </button>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label>
          地点
          <input
            autoFocus
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="街道、社区或餐厅 · 街道 · Street"
          />
        </label>
        <button type="submit" className="button-primary" disabled={searching || !query.trim()}>
          {searching ? "搜索中…" : "搜索"}
        </button>
      </form>
      {results.length > 0 && (
        <ul className="region-search__results">
          {results.map((place, index) => (
            <li key={`${place.longitude}:${place.latitude}:${index}`}>
              <button type="button" onClick={() => onChoose(place)}>
                <strong>{place.displayName}</strong>
                <small>
                  {place.latitude.toFixed(4)}, {place.longitude.toFixed(4)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.length === 0 && !searching && query.trim() && (
        <p className="region-search__empty">提交搜索后显示地点结果。</p>
      )}
    </aside>
  );
}

function IconPicker({
  cuisine,
  foodIconBaseUrl,
  name,
  selectedKey,
  onChange,
}: {
  cuisine: Cuisine | undefined;
  foodIconBaseUrl?: string;
  name: string;
  selectedKey: string;
  onChange: (iconKey: string) => void;
}) {
  if (!cuisine) return null;
  return (
    <div className="icon-options icon-options--visual">
      {cuisine.icons.map((icon, index) => {
        const choiceLabel = `${cuisine.label}图标 ${index + 1}`;
        return (
          <label
            className="icon-option"
            key={icon.key}
            title={choiceLabel}
            data-selected={selectedKey === icon.key || undefined}
          >
            <input
              type="radio"
              name={name}
              value={icon.key}
              aria-label={choiceLabel}
              checked={selectedKey === icon.key}
              onChange={() => onChange(icon.key)}
            />
            <span className="icon-option__image">
              <img src={localIconUrl(foodIconBaseUrl, icon)} alt="" />
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function CreatePanel({
  cuisines,
  foodIconBaseUrl,
  location,
  onCancel,
  onSave,
}: {
  cuisines: Cuisine[];
  foodIconBaseUrl?: string;
  location: CreateLocation;
  onCancel: () => void;
  onSave: (input: { name: string; cuisineKey: string; iconKey: string }) => void;
}) {
  const first = cuisines[0];
  const [name, setName] = useState("");
  const [cuisineKey, setCuisineKey] = useState(first?.key ?? "");
  const cuisine = cuisines.find((item) => item.key === cuisineKey) ?? first;
  const [iconKey, setIconKey] = useState(first?.icons[0]?.key ?? "");
  return (
    <form
      className="restaurant-panel create-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ name, cuisineKey, iconKey });
      }}
    >
      <p className="panel-kicker">NEW RESTAURANT</p>
      <h3>在这里吃什么？</h3>
      <small>
        {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
      </small>
      <label>
        名称
        <input required autoFocus value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        菜式
        <select
          value={cuisineKey}
          onChange={(event) => {
            const next = cuisines.find((item) => item.key === event.target.value);
            setCuisineKey(event.target.value);
            setIconKey(next?.icons[0]?.key ?? "");
          }}
        >
          {cuisines.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>预制图标</legend>
        <IconPicker
          cuisine={cuisine}
          foodIconBaseUrl={foodIconBaseUrl}
          name="create-icon"
          selectedKey={iconKey}
          onChange={setIconKey}
        />
      </fieldset>
      <div className="panel-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="submit">创建地点</button>
      </div>
    </form>
  );
}

export function DetailPanel({
  restaurant,
  cuisines,
  foodIconBaseUrl,
  tags,
  onClose,
  onStatus,
  onPositionLock = () => {},
  onProfile,
  onMapIconScalePreview,
  onMapIconPreview = () => {},
  onDelete,
  onTags,
  onLogMutation,
  focusedFoodLogId,
}: {
  restaurant: Restaurant;
  cuisines: Cuisine[];
  foodIconBaseUrl?: string;
  tags: Tag[];
  onClose: () => void;
  onStatus: (
    input: Partial<Pick<MapRestaurant, "overallRating" | "visitStatus" | "affectionStatus" | "isBookmarked">>,
  ) => void;
  onPositionLock?: (locked: boolean) => void | Promise<void>;
  onProfile: (input: ProfileUpdateInput) => void | Promise<void>;
  onMapIconScalePreview: (scale: number) => void;
  onMapIconPreview?: (cuisineKey: string, iconKey: string) => void;
  onDelete: () => void;
  onTags: () => Promise<void>;
  onLogMutation: () => void;
  focusedFoodLogId: string | null;
}) {
  const [newTag, setNewTag] = useState("");
  const attached = new Set(restaurant.tags.map((tag) => tag.id));
  const cuisine = cuisines.find((item) => item.key === restaurant.cuisineKey);
  return (
    <aside className="restaurant-panel detail-panel">
      <button className="panel-close" onClick={onClose} aria-label="关闭详情">
        ×
      </button>
      <section className="detail-zone detail-zone--red" data-detail-zone="red" aria-label="基本资料">
        <p className="panel-kicker">{cuisine?.label ?? restaurant.cuisineKey}</p>
        <h3>{restaurant.name}</h3>
        <ProfileEditor
          key={restaurant.id}
          restaurant={restaurant}
          cuisines={cuisines}
          foodIconBaseUrl={foodIconBaseUrl}
          onSave={onProfile}
          onMapIconScalePreview={onMapIconScalePreview}
          onMapIconPreview={onMapIconPreview}
        />
        <div className="overall-rating">
          <span>总体评分</span>
          <div className="overall-rating__stars" role="group" aria-label="总体评分">
            {[1, 2, 3, 4, 5].map((number) => {
              const active = number <= (restaurant.overallRating ?? 0);
              return (
                <button
                  key={number}
                  type="button"
                  aria-label={`${number} 星`}
                  aria-pressed={restaurant.overallRating === number}
                  data-active={active || undefined}
                  onClick={() =>
                    onStatus({ overallRating: restaurant.overallRating === number ? null : number })
                  }
                >
                  {active ? "★" : "☆"}
                </button>
              );
            })}
          </div>
        </div>
        <div className="status-grid">
          <label>
            去过状态
            <select
              value={restaurant.visitStatus}
              onChange={(event) => onStatus({ visitStatus: event.target.value as Restaurant["visitStatus"] })}
            >
              {Object.entries(statusLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            喜爱度
            <select
              value={restaurant.affectionStatus}
              onChange={(event) =>
                onStatus({ affectionStatus: event.target.value as Restaurant["affectionStatus"] })
              }
            >
              {Object.entries(affectionLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button
          className="bookmark-toggle"
          data-active={restaurant.isBookmarked || undefined}
          onClick={() => onStatus({ isBookmarked: !restaurant.isBookmarked })}
        >
          ★ {restaurant.isBookmarked ? "已收藏" : "加入收藏"}
        </button>
        <section className="tag-editor">
          <strong>标签</strong>
          <div className="tag-list">
            {restaurant.tags.map((tag) => (
              <button
                key={tag.id}
                onClick={() => void restaurantApi.setTag(restaurant.id, tag.id, false).then(onTags)}
              >
                #{tag.name} ×
              </button>
            ))}
          </div>
          <div className="tag-add">
            {tags
              .filter((tag) => !attached.has(tag.id))
              .map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => void restaurantApi.setTag(restaurant.id, tag.id, true).then(onTags)}
                >
                  + {tag.name}
                </button>
              ))}
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (newTag.trim())
                void restaurantApi
                  .createTag(newTag.trim())
                  .then((tag) => restaurantApi.setTag(restaurant.id, tag.id, true))
                  .then(onTags);
              setNewTag("");
            }}
          >
            <input
              aria-label="新标签"
              placeholder="新标签"
              value={newTag}
              onChange={(event) => setNewTag(event.target.value)}
            />
            <button>添加</button>
          </form>
        </section>
        <label className="restaurant-position-lock">
          <span>
            <strong>锁定地图位置</strong>
            <small>仅锁定这家餐厅，普通点击仍可打开详情。</small>
          </span>
          <input
            type="checkbox"
            aria-label="锁定这家餐厅的位置"
            checked={restaurant.positionLocked}
            onChange={(event) => void onPositionLock(event.target.checked)}
          />
        </label>
        <button className="delete-button" onClick={onDelete}>
          移至回收站
        </button>
      </section>
      <div className="detail-panel__right" data-detail-column="right" aria-label="用餐记录与相册">
        <section
          className="detail-zone detail-zone--green"
          data-detail-zone="green"
          aria-label="FoodLogSection 用餐记录"
        >
          <FoodLogSection
            key={restaurant.id}
            restaurantId={restaurant.id}
            focusedFoodLogId={focusedFoodLogId}
            onMutation={onLogMutation}
          />
        </section>
        <section
          className="detail-zone detail-zone--blue"
          data-detail-zone="blue"
          aria-label="MediaGrid 媒体"
        >
          <MediaGrid restaurantId={restaurant.id} onMutation={onLogMutation} />
        </section>
      </div>
    </aside>
  );
}

export function ProfileEditor({
  restaurant,
  cuisines,
  foodIconBaseUrl,
  onSave,
  onMapIconScalePreview,
  onMapIconPreview = () => {},
}: {
  restaurant: Restaurant;
  cuisines: Cuisine[];
  foodIconBaseUrl?: string;
  onSave: (input: ProfileUpdateInput) => void | Promise<void>;
  onMapIconScalePreview: (scale: number) => void;
  onMapIconPreview?: (cuisineKey: string, iconKey: string) => void;
}) {
  const [name, setName] = useState(restaurant.name);
  const [cuisineKey, setCuisineKey] = useState(restaurant.cuisineKey);
  const [iconKey, setIconKey] = useState(restaurant.iconKey);
  const [mapIconScale, setMapIconScale] = useState(restaurant.mapIconScale ?? 1);
  const [phone, setPhone] = useState(restaurant.phone ?? "");
  const [openingHoursText, setOpeningHoursText] = useState(restaurant.openingHoursText ?? "");
  const [addressNote, setAddressNote] = useState(restaurant.addressNote ?? "");
  const cuisine = cuisines.find((item) => item.key === cuisineKey);
  const draftRef = useRef({
    name,
    cuisineKey,
    iconKey,
    mapIconScale,
    phone,
    openingHoursText,
    addressNote,
  });
  const initialInput = {
    id: restaurant.id,
    name: restaurant.name,
    cuisineKey: restaurant.cuisineKey,
    iconKey: restaurant.iconKey,
    mapIconScale: restaurant.mapIconScale ?? 1,
    phone: restaurant.phone || null,
    openingHoursText: restaurant.openingHoursText || null,
    addressNote: restaurant.addressNote || null,
  };
  const lastQueuedRef = useRef(JSON.stringify(initialInput));
  const saveQueueRef = useRef(Promise.resolve());
  const queueSave = useCallback(
    (draft = draftRef.current) => {
      if (!draft.name.trim()) return;
      const input: ProfileUpdateInput = {
        id: restaurant.id,
        name: draft.name,
        cuisineKey: draft.cuisineKey,
        iconKey: draft.iconKey,
        mapIconScale: draft.mapIconScale,
        phone: draft.phone || null,
        openingHoursText: draft.openingHoursText || null,
        addressNote: draft.addressNote || null,
      };
      const serialized = JSON.stringify(input);
      if (serialized === lastQueuedRef.current) return;
      lastQueuedRef.current = serialized;
      saveQueueRef.current = saveQueueRef.current
        .catch(() => undefined)
        .then(() => Promise.resolve(onSave(input)))
        .catch(() => {
          if (lastQueuedRef.current === serialized) lastQueuedRef.current = "";
        });
    },
    [onSave, restaurant.id],
  );
  const queueSaveLatestRef = useRef(queueSave);
  useEffect(() => {
    queueSaveLatestRef.current = queueSave;
  }, [queueSave]);
  useEffect(() => () => queueSaveLatestRef.current(), []);
  return (
    <div className="profile-editor">
      <label>
        名称
        <input
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            draftRef.current = { ...draftRef.current, name: event.target.value };
          }}
          onBlur={() => queueSave()}
        />
      </label>
      <label>
        菜式
        <select
          value={cuisineKey}
          onChange={(event) => {
            const next = cuisines.find((item) => item.key === event.target.value);
            const nextIconKey = next?.icons[0]?.key ?? "";
            setCuisineKey(event.target.value);
            setIconKey(nextIconKey);
            const nextDraft = {
              ...draftRef.current,
              cuisineKey: event.target.value,
              iconKey: nextIconKey,
            };
            draftRef.current = nextDraft;
            onMapIconPreview(event.target.value, nextIconKey);
            queueSave(nextDraft);
          }}
        >
          {cuisines.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>图标</legend>
        <IconPicker
          cuisine={cuisine}
          foodIconBaseUrl={foodIconBaseUrl}
          name={`profile-icon-${restaurant.id}`}
          selectedKey={iconKey}
          onChange={(nextIconKey) => {
            setIconKey(nextIconKey);
            const nextDraft = { ...draftRef.current, iconKey: nextIconKey };
            draftRef.current = nextDraft;
            onMapIconPreview(cuisineKey, nextIconKey);
            queueSave(nextDraft);
          }}
        />
      </fieldset>
      <label className="map-icon-scale-control">
        <span className="map-icon-scale-control__heading">
          <span>地图图标大小</span>
          <output>{mapIconScale.toFixed(2)}×</output>
        </span>
        <input
          aria-label="地图图标大小"
          type="range"
          min="0.75"
          max="1.5"
          step="0.05"
          value={mapIconScale}
          onChange={(event) => {
            const next = Number(event.target.value);
            setMapIconScale(next);
            draftRef.current = { ...draftRef.current, mapIconScale: next };
            onMapIconScalePreview(next);
          }}
          onBlur={() => queueSave()}
          onPointerUp={() => queueSave()}
          onKeyUp={() => queueSave()}
        />
      </label>
      <div className="profile-details" role="group" aria-label="联系信息">
        <label>
          电话
          <input
            value={phone}
            onChange={(event) => {
              setPhone(event.target.value);
              draftRef.current = { ...draftRef.current, phone: event.target.value };
            }}
            onBlur={() => queueSave()}
          />
        </label>
        <label>
          营业时间
          <input
            value={openingHoursText}
            onChange={(event) => {
              setOpeningHoursText(event.target.value);
              draftRef.current = { ...draftRef.current, openingHoursText: event.target.value };
            }}
            onBlur={() => queueSave()}
          />
        </label>
        <label>
          地址备注
          <input
            value={addressNote}
            onChange={(event) => {
              setAddressNote(event.target.value);
              draftRef.current = { ...draftRef.current, addressNote: event.target.value };
            }}
            onBlur={() => queueSave()}
          />
        </label>
      </div>
    </div>
  );
}
