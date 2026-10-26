import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEDIA_CATEGORIES,
  restaurantApi,
  type MapRestaurant,
  type Media,
  type MediaCategory,
} from "../restaurants/api";

const GRID_MIN_CARD_WIDTH = 156;
const CARD_HEIGHT = 184;
const OVERSCAN_ROWS = 3;

const categoryLabels: Record<MediaCategory, string> = {
  food: "食物",
  menu: "菜单",
  exterior: "门面",
  interior: "环境",
  checkin: "打卡",
  other: "其他",
};

type Bootstrap = { localAssetOrigin: string };

function mediaUrl(origin: string, path: string) {
  return `${origin}/media/${path.split("/").filter(Boolean).join("/")}`;
}

function isVideo(media: Pick<Media, "mimeType">) {
  return media.mimeType.startsWith("video/");
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

// eslint-disable-next-line react-refresh/only-export-components
export function galleryWindow(
  count: number,
  scrollTop: number,
  viewportHeight: number,
  columns: number,
): { start: number; end: number; offset: number; height: number } {
  const safeColumns = Math.max(1, columns);
  const rowCount = Math.ceil(count / safeColumns);
  const firstRow = Math.max(0, Math.floor(scrollTop / CARD_HEIGHT) - OVERSCAN_ROWS);
  const lastRow = Math.min(rowCount, Math.ceil((scrollTop + viewportHeight) / CARD_HEIGHT) + OVERSCAN_ROWS);
  return {
    start: firstRow * safeColumns,
    end: lastRow * safeColumns,
    offset: firstRow * CARD_HEIGHT,
    height: rowCount * CARD_HEIGHT,
  };
}

export type GalleryMapTarget = { restaurantId: string; foodLogId: string | null };

export function GalleryView({ onOpenMap }: { onOpenMap?: (target: GalleryMapTarget) => void }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState<Media[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [origin, setOrigin] = useState("");
  const [category, setCategory] = useState<MediaCategory | "all">("all");
  const [restaurantFilter, setRestaurantFilter] = useState("all");
  const [restaurants, setRestaurants] = useState<MapRestaurant[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [restaurantLogs, setRestaurantLogs] = useState<
    { id: string; title: string | null; occurredAtMs: number }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState({ width: 900, height: 600 });

  const load = useCallback(
    async (cursor: string | null, replace = false) => {
      if (cursor ? loadingMore : loading) return;
      if (cursor) setLoadingMore(true);
      else setLoading(true);
      try {
        if (replace) {
          setItems([]);
          setNextCursor(null);
          setSelectedId(null);
        }
        const [page, bootstrap] = await Promise.all([
          restaurantApi.listMedia({
            restaurantId: restaurantFilter === "all" ? undefined : restaurantFilter,
            category: category === "all" ? undefined : category,
            cursor,
            limit: 100,
          }),
          origin ? Promise.resolve(null) : invoke<Bootstrap>("app_bootstrap"),
        ]);
        setItems((current) => (replace ? page.items : [...current, ...page.items]));
        setNextCursor(page.nextCursor);
        if (bootstrap) setOrigin(bootstrap.localAssetOrigin);
        setError("");
      } catch (reason) {
        setError(errorText(reason));
      } finally {
        if (cursor) setLoadingMore(false);
        else setLoading(false);
      }
    },
    [category, loading, loadingMore, origin, restaurantFilter],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(null, true), 0);
    return () => window.clearTimeout(timer);
    // Loading is deliberately tied to filter changes, not the callback's transient
    // loading-state dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, restaurantFilter]);

  useEffect(() => {
    void restaurantApi
      .listMap()
      .then(setRestaurants)
      .catch((reason: unknown) => setError(errorText(reason)));
  }, []);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const update = () => setViewport({ width: node.clientWidth, height: node.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Restaurant filtering happens in the cursor query.  Client-side filtering would
  // make a selected restaurant disappear until every earlier global page was loaded.
  const filtered = items;
  const columns = Math.max(1, Math.floor(viewport.width / GRID_MIN_CARD_WIDTH));
  const windowed = galleryWindow(filtered.length, scrollTop, viewport.height, columns);
  const visible = filtered.slice(windowed.start, windowed.end);
  const selectedIndex = selectedId ? filtered.findIndex((item) => item.id === selectedId) : -1;
  const selected = selectedIndex >= 0 ? filtered[selectedIndex] : null;

  const moveLightbox = useCallback(
    (delta: number) => {
      if (!filtered.length) return;
      const current = selectedId ? filtered.findIndex((item) => item.id === selectedId) : 0;
      setSelectedId(filtered[(Math.max(0, current) + delta + filtered.length) % filtered.length].id);
    },
    [filtered, selectedId],
  );

  useEffect(() => {
    if (!selected) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
      if (event.key === "ArrowLeft") moveLightbox(-1);
      if (event.key === "ArrowRight") moveLightbox(1);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [moveLightbox, selected]);

  const selectedRestaurantId = selected?.restaurantId ?? null;
  useEffect(() => {
    if (!selectedRestaurantId) return;
    let active = true;
    void restaurantApi
      .listFoodLogs(selectedRestaurantId, null, 100)
      .then((page) => {
        if (active) setRestaurantLogs(page.items);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, [selected?.id, selectedRestaurantId]);

  function onScroll() {
    const node = viewportRef.current;
    if (!node) return;
    setScrollTop(node.scrollTop);
    if (
      nextCursor &&
      !loadingMore &&
      node.scrollTop + node.clientHeight >= node.scrollHeight - CARD_HEIGHT * 4
    ) {
      void load(nextCursor);
    }
  }

  async function changeSelectedCategory(next: MediaCategory) {
    if (!selected) return;
    const updated = await restaurantApi.updateMediaCategory(selected.id, next);
    setItems((current) => current.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
  }

  async function changeSelectedFoodLog(foodLogId: string | null) {
    if (!selected) return;
    const updated = await restaurantApi.attachMediaToLog(selected.id, foodLogId);
    const foodLog = foodLogId ? (restaurantLogs.find((log) => log.id === foodLogId) ?? null) : null;
    setItems((current) =>
      current.map((item) => (item.id === updated.id ? { ...item, ...updated, foodLogId, foodLog } : item)),
    );
  }

  async function removeSelected() {
    if (!selected) return;
    await restaurantApi.softDeleteMedia(selected.id);
    setItems((current) => current.filter((item) => item.id !== selected.id));
    setSelectedId(null);
  }

  function resetFilters() {
    setCategory("all");
    setRestaurantFilter("all");
  }

  return (
    <section className="gallery-view" aria-labelledby="gallery-title">
      <header className="gallery-view__header">
        <div>
          <p className="panel-kicker">FOOD MEMORIES</p>
          <h2 id="gallery-title">全部相册</h2>
          <small>{filtered.length.toLocaleString()} 项已加载媒体</small>
        </div>
        <div className="gallery-filters" aria-label="相册筛选">
          <label>
            分类
            <select
              aria-label="图片分类"
              value={category}
              onChange={(event) => setCategory(event.target.value as MediaCategory | "all")}
            >
              <option value="all">全部分类</option>
              {MEDIA_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {categoryLabels[value]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="gallery-filter-reset" onClick={resetFilters}>
            重置筛选
          </button>
          <label>
            餐厅
            <select
              aria-label="餐厅筛选"
              value={restaurantFilter}
              onChange={(event) => setRestaurantFilter(event.target.value)}
            >
              <option value="all">全部餐厅</option>
              {restaurants.map((restaurant) => (
                <option key={restaurant.id} value={restaurant.id}>
                  {restaurant.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      {error && (
        <p className="gallery-error" role="alert">
          {error}
        </p>
      )}
      {loading && <p className="gallery-empty">正在读取相册…</p>}
      {!loading && !filtered.length && <p className="gallery-empty">还没有符合筛选条件的媒体。</p>}
      <div ref={viewportRef} className="gallery-viewport" aria-label="全部媒体网格" onScroll={onScroll}>
        <div className="gallery-virtual-space" style={{ height: windowed.height }}>
          <div
            className="gallery-grid"
            style={{
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
              transform: `translateY(${windowed.offset}px)`,
            }}
          >
            {visible.map((item) => (
              <button
                key={item.id}
                type="button"
                className="gallery-card"
                onClick={() => setSelectedId(item.id)}
              >
                {origin && (
                  <img
                    src={mediaUrl(origin, item.thumbnailRelPath)}
                    alt={item.caption || item.originalName}
                  />
                )}
                {isVideo(item) && (
                  <span className="gallery-card__play" aria-hidden="true">
                    ▶
                  </span>
                )}
                <span>{item.restaurant?.name ?? "餐厅媒体"}</span>
              </button>
            ))}
          </div>
        </div>
        {loadingMore && <p className="gallery-loading-more">正在加载更多媒体…</p>}
      </div>
      {selected && origin && (
        <div
          className="media-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label={isVideo(selected) ? "视频预览" : "图片预览"}
        >
          <button
            className="media-lightbox__backdrop"
            aria-label="关闭预览"
            onClick={() => setSelectedId(null)}
          />
          <section className="media-lightbox__content gallery-lightbox__content">
            {isVideo(selected) ? (
              <video
                controls
                preload="metadata"
                poster={mediaUrl(origin, selected.previewRelPath)}
                aria-label={selected.caption || selected.originalName}
              >
                <source src={mediaUrl(origin, selected.originalRelPath)} type={selected.mimeType} />
              </video>
            ) : (
              <img
                src={mediaUrl(origin, selected.previewRelPath)}
                alt={selected.caption || selected.originalName}
              />
            )}
            <div className="media-lightbox__tools">
              <strong>{selected.caption || selected.originalName}</strong>
              <p>{selected.restaurant?.name ?? "餐厅媒体"}</p>
              <p>{categoryLabels[selected.category]}</p>
              <p>导入时间：{new Date(selected.createdAtMs).toLocaleString("zh-CN")}</p>
              {selected.capturedAtMs !== null && (
                <p>拍摄时间：{new Date(selected.capturedAtMs).toLocaleString("zh-CN")}</p>
              )}
              {selected.foodLog && (
                <p>
                  关联记录：{selected.foodLog.title || "未命名记录"} ·{" "}
                  {new Date(selected.foodLog.occurredAtMs).toLocaleDateString("zh-CN")}
                </p>
              )}
              <p>
                {selectedIndex + 1} / {filtered.length}
              </p>
              <div className="media-lightbox__actions">
                <button type="button" aria-label="上一张图片" onClick={() => moveLightbox(-1)}>
                  上一张
                </button>
                <button type="button" aria-label="下一张图片" onClick={() => moveLightbox(1)}>
                  下一张
                </button>
                <button type="button" onClick={() => void restaurantApi.openMediaOriginal(selected.id)}>
                  {isVideo(selected) ? "打开原视频" : "打开原图"}
                </button>
                <label>
                  图片分类
                  <select
                    aria-label="预览图片分类"
                    value={selected.category}
                    onChange={(event) => void changeSelectedCategory(event.target.value as MediaCategory)}
                  >
                    {MEDIA_CATEGORIES.map((value) => (
                      <option key={value} value={value}>
                        {categoryLabels[value]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  关联用餐记录
                  <select
                    aria-label="关联用餐记录"
                    value={selected.foodLogId ?? ""}
                    onChange={(event) => void changeSelectedFoodLog(event.target.value || null)}
                  >
                    <option value="">不关联用餐记录</option>
                    {restaurantLogs.map((log) => (
                      <option key={log.id} value={log.id}>
                        {log.title || "未命名记录"} · {new Date(log.occurredAtMs).toLocaleDateString("zh-CN")}
                      </option>
                    ))}
                  </select>
                </label>
                {onOpenMap && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenMap({ restaurantId: selected.restaurantId, foodLogId: selected.foodLogId })
                    }
                  >
                    在地图中查看
                  </button>
                )}
                <button type="button" onClick={() => setSelectedId(null)}>
                  关闭
                </button>
                <button type="button" onClick={() => void removeSelected()}>
                  移至回收站
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
