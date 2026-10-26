import { useCallback, useEffect, useRef, useState } from "react";
import { MapView } from "../features/map/MapView";
import { GalleryView, type GalleryMapTarget } from "../features/media/GalleryView";
import { SettingsView } from "../features/settings/SettingsView";
import { readTheme, writeTheme, type AppThemeKey } from "../features/settings/themeCatalog";
import { TrashView } from "../features/trash/TrashView";
import { APP_VIEWS, VIEW_LABELS, type AppView } from "./navigation";
import { offlineRegionApi, type CachedRegion } from "../features/map/offlineRegionApi";
import { centerApi, type MapCenter } from "../features/map/centerApi";
import { centerIconUrl } from "../features/map/centerLayers";
import brandIcon from "../assets/brand/foodprint-128.png";

export function AppShell() {
  const [activeView, setActiveView] = useState<AppView>("map");
  const [mapTarget, setMapTarget] = useState<GalleryMapTarget | null>(null);
  const [cachedRegions, setCachedRegions] = useState<CachedRegion[]>([]);
  const [regionTarget, setRegionTarget] = useState<CachedRegion | null>(null);
  const [centers, setCenters] = useState<MapCenter[]>([]);
  const [centerTarget, setCenterTarget] = useState<MapCenter | null>(null);
  const [openRegionSearch, setOpenRegionSearch] = useState(false);
  const [regionError, setRegionError] = useState("");
  const [theme, setTheme] = useState<AppThemeKey>(readTheme);
  const startupMapTargetChosenRef = useRef(false);
  const lastMapEntryRef = useRef<{ kind: "center" | "region"; id: string } | null>(null);

  const selectTheme = useCallback((nextTheme: AppThemeKey) => {
    setTheme(nextTheme);
    writeTheme(nextTheme);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const refreshCachedRegions = useCallback(async () => {
    try {
      setCachedRegions(await offlineRegionApi.list());
      setRegionError("");
    } catch {
      // The map remains useful with the bundled default package if the cache
      // index is not available during startup.
      setCachedRegions([]);
    }
  }, []);

  const refreshCenters = useCallback(async () => {
    try {
      setCenters(await centerApi.list());
      setRegionError("");
    } catch (reason) {
      setCenters([]);
      setRegionError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([offlineRegionApi.list(), centerApi.list()]).then(
      ([regionResult, centerResult]) => {
        if (cancelled) return;
        const initialRegions = regionResult.status === "fulfilled" ? regionResult.value : [];
        const initialCenters = centerResult.status === "fulfilled" ? centerResult.value : [];
        setCachedRegions(initialRegions);
        setCenters(initialCenters);
        const failure: unknown =
          regionResult.status === "rejected"
            ? regionResult.reason
            : centerResult.status === "rejected"
              ? centerResult.reason
              : null;
        setRegionError(failure ? errorText(failure) : "");

        if (startupMapTargetChosenRef.current) return;
        startupMapTargetChosenRef.current = true;
        const cachedIds = new Set(initialRegions.map((region) => region.id));
        const cachedCenter = initialCenters.find(
          (center) => center.primaryRegionId && cachedIds.has(center.primaryRegionId),
        );
        if (cachedCenter) {
          lastMapEntryRef.current = { kind: "center", id: cachedCenter.id };
          setCenterTarget(cachedCenter);
        } else if (initialRegions[0]) {
          lastMapEntryRef.current = { kind: "region", id: initialRegions[0].id };
          setRegionTarget(initialRegions[0]);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const groupedRegionIds = new Set(centers.flatMap((center) => center.cachedRegionIds));
  const standaloneRegions = cachedRegions.filter((region) => !groupedRegionIds.has(region.id));

  const openView = (view: AppView) => {
    if (view !== "map") setOpenRegionSearch(false);
    if (view === "map" && activeView !== "map") {
      const lastEntry = lastMapEntryRef.current;
      if (lastEntry?.kind === "center") {
        const center = centers.find((candidate) => candidate.id === lastEntry.id);
        if (center) setCenterTarget(center);
      } else if (lastEntry?.kind === "region") {
        const region = cachedRegions.find((candidate) => candidate.id === lastEntry.id);
        if (region) setRegionTarget(region);
      }
    }
    setActiveView(view);
  };

  return (
    <div className="app-shell" data-theme={theme}>
      <aside className="app-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            <img src={brandIcon} alt="" width="38" height="38" />
          </div>
          <div>
            <p>foodprint</p>
            <h1>随食记</h1>
          </div>
        </div>

        <nav className="app-navigation" aria-label="主要视图">
          {APP_VIEWS.map((view) => {
            const item = VIEW_LABELS[view];
            const selected = view === activeView;
            return (
              <div key={view} className="app-navigation__group">
                <button
                  type="button"
                  className="app-navigation__item"
                  data-active={selected || undefined}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => openView(view)}
                >
                  <span className="app-navigation__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                </button>
                {view === "map" && (
                  <div className="cached-region-navigation" aria-label="离线周边地图">
                    <div className="cached-region-navigation__heading">
                      <span>离线周边</span>
                      <button
                        type="button"
                        aria-label="搜索地点并定位"
                        onClick={() => {
                          setActiveView("map");
                          setOpenRegionSearch(true);
                        }}
                      >
                        +
                      </button>
                    </div>
                    {centers.map((center) => (
                      <div className="cached-region-navigation__item" key={center.id}>
                        <button
                          type="button"
                          className="cached-region-navigation__target cached-region-navigation__target--center"
                          onClick={() => {
                            startupMapTargetChosenRef.current = true;
                            lastMapEntryRef.current = { kind: "center", id: center.id };
                            setActiveView("map");
                            setCenterTarget(center);
                          }}
                        >
                          <img src={centerIconUrl(center)} alt="" />
                          <strong>{center.name}</strong>
                        </button>
                      </div>
                    ))}
                    {standaloneRegions.map((region) => (
                      <div className="cached-region-navigation__item" key={region.id}>
                        <button
                          type="button"
                          className="cached-region-navigation__target"
                          onClick={() => {
                            startupMapTargetChosenRef.current = true;
                            lastMapEntryRef.current = { kind: "region", id: region.id };
                            setActiveView("map");
                            setRegionTarget(region);
                          }}
                        >
                          <strong>{region.label}</strong>
                          <small>{formatCachedBytes(region.byteSize)}</small>
                        </button>
                        <button
                          type="button"
                          className="cached-region-navigation__delete"
                          aria-label={`删除${region.label}`}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            void (async () => {
                              try {
                                await offlineRegionApi.remove(region.id);
                                if (regionTarget?.id === region.id) setRegionTarget(null);
                                await refreshCachedRegions();
                              } catch (reason) {
                                setRegionError(errorText(reason));
                              }
                            })();
                          }}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                    {regionError && <small className="cached-region-navigation__error">{regionError}</small>}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="app-sidebar__status">
          <span aria-hidden="true" />
          <p>
            LOCAL FIRST
            <small>阶段 1 工程壳</small>
          </p>
        </div>
      </aside>

      <main className="app-content">
        {activeView === "map" ? (
          <MapView
            theme={theme}
            target={mapTarget}
            onTargetHandled={() => setMapTarget(null)}
            cachedRegions={cachedRegions}
            onRegionsChanged={refreshCachedRegions}
            regionTarget={regionTarget}
            onRegionTargetHandled={() => setRegionTarget(null)}
            openRegionSearch={openRegionSearch}
            onRegionSearchHandled={() => setOpenRegionSearch(false)}
            centers={centers}
            onCentersChanged={refreshCenters}
            centerTarget={centerTarget}
            onCenterTargetHandled={() => setCenterTarget(null)}
          />
        ) : activeView === "gallery" ? (
          <GalleryView
            onOpenMap={(target) => {
              setMapTarget(target);
              setActiveView("map");
            }}
          />
        ) : activeView === "trash" ? (
          <TrashView />
        ) : (
          <SettingsView theme={theme} onThemeChange={selectTheme} />
        )}
      </main>
    </div>
  );
}

function formatCachedBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
