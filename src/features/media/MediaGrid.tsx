import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MEDIA_CATEGORIES,
  restaurantApi,
  type Media,
  type MediaCategory,
  type MediaImportItem,
} from "../restaurants/api";
import { registerMediaDropZone } from "./mediaDropDispatcher";

const categoryLabels: Record<MediaCategory, string> = {
  food: "食物",
  menu: "菜单",
  exterior: "门面",
  interior: "环境",
  checkin: "打卡",
  other: "其他",
};

type Bootstrap = { localAssetOrigin: string };
type PendingImportItem = MediaImportItem & {
  key: string;
  phase: "queued" | "processing" | "complete";
};
type ImportBatch = {
  category: MediaCategory;
  foodLogId?: string;
  keys: string[];
  paths: string[];
};

type MediaFilter = "all" | "food" | "menu" | "environment" | "video" | "other";

const MEDIA_FILTERS: ReadonlyArray<{ value: MediaFilter; label: string }> = [
  { value: "all", label: "所有" },
  { value: "food", label: "食物" },
  { value: "menu", label: "餐牌" },
  { value: "environment", label: "环境" },
  { value: "video", label: "视频" },
  { value: "other", label: "其他" },
];

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function mediaUrl(origin: string, path: string) {
  return `${origin}/media/${path.split("/").filter(Boolean).join("/")}`;
}

function isVideo(media: Pick<Media, "mimeType">) {
  return media.mimeType.startsWith("video/");
}

function matchesMediaFilter(media: Media, filter: MediaFilter) {
  if (filter === "all") return true;
  if (filter === "video") return isVideo(media);
  if (isVideo(media)) return false;
  if (filter === "environment") return ["exterior", "interior", "checkin"].includes(media.category);
  return media.category === filter;
}

export function MediaImportButton({
  restaurantId,
  foodLogId,
  onImported,
  compact = false,
  fixedCategory,
  variant = "panel",
  mediaKind = "all",
  tileLabel = "添加媒体",
}: {
  restaurantId: string;
  foodLogId?: string;
  onImported: () => void;
  compact?: boolean;
  fixedCategory?: MediaCategory;
  variant?: "panel" | "tile";
  mediaKind?: "all" | "image" | "video";
  tileLabel?: string;
}) {
  const [selectedCategory, setSelectedCategory] = useState<MediaCategory>("food");
  const category = fixedCategory ?? selectedCategory;
  const [pending, setPending] = useState(false);
  const [results, setResults] = useState<PendingImportItem[]>([]);
  const [error, setError] = useState("");
  const [dropZone, setDropZone] = useState<HTMLElement | null>(null);
  const batchQueue = useRef<ImportBatch[]>([]);
  const isProcessingQueue = useRef(false);
  const nextImportKey = useRef(0);
  const processQueue = useCallback(async () => {
    if (isProcessingQueue.current) return;
    isProcessingQueue.current = true;
    setPending(true);
    try {
      while (true) {
        const batch = batchQueue.current.shift();
        if (!batch) break;
        setResults((current) =>
          current.map((item) => (batch.keys.includes(item.key) ? { ...item, phase: "processing" } : item)),
        );
        try {
          const response = await restaurantApi.importMedia({
            restaurantId,
            foodLogId: batch.foodLogId,
            category: batch.category,
            paths: batch.paths,
          });
          setResults((current) =>
            current.map((item) => {
              const index = batch.keys.indexOf(item.key);
              if (index < 0) return item;
              const result = response.results[index];
              return result
                ? { ...result, key: item.key, phase: "complete" }
                : { ...item, error: "导入未返回结果", phase: "complete" };
            }),
          );
          if (response.results.some((item) => item.media)) onImported();
        } catch (reason) {
          const message = errorText(reason);
          setError(message);
          setResults((current) =>
            current.map((item) =>
              batch.keys.includes(item.key) ? { ...item, error: message, phase: "complete" } : item,
            ),
          );
        }
      }
    } finally {
      isProcessingQueue.current = false;
      setPending(false);
    }
  }, [onImported, restaurantId]);
  const importPaths = useCallback(
    (paths: string[]) => {
      if (!paths.length) return;
      const acceptedPaths = paths.filter((path) => {
        if (mediaKind === "all") return true;
        const extension = path.split(".").pop()?.toLowerCase() ?? "";
        return mediaKind === "video"
          ? ["mp4", "webm"].includes(extension)
          : ["jpg", "jpeg", "png", "webp"].includes(extension);
      });
      const rejectedCount = paths.length - acceptedPaths.length;
      setError(
        rejectedCount
          ? mediaKind === "video"
            ? "视频分类只接受 MP4 或 WebM 文件。"
            : "此分类只接受 JPG、PNG 或 WebP 图片。"
          : "",
      );
      if (!acceptedPaths.length) return;
      const keys = acceptedPaths.map(() => `import-${nextImportKey.current++}`);
      setResults((current) => [
        ...current,
        ...acceptedPaths.map((sourcePath, index) => ({
          key: keys[index],
          sourcePath,
          media: null,
          error: null,
          phase: "queued" as const,
        })),
      ]);
      batchQueue.current.push({ category, foodLogId, keys, paths: acceptedPaths });
      void processQueue();
    },
    [category, foodLogId, mediaKind, processQueue],
  );
  useEffect(() => {
    if (!dropZone) return;
    return registerMediaDropZone(dropZone, (paths) => void importPaths(paths));
  }, [dropZone, importPaths]);
  async function chooseFiles() {
    const filters =
      mediaKind === "video"
        ? [{ name: "视频", extensions: ["mp4", "webm"] }]
        : mediaKind === "image"
          ? [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }]
          : [{ name: "图片与视频", extensions: ["jpg", "jpeg", "png", "webp", "mp4", "webm"] }];
    const selection = await open({
      multiple: true,
      filters,
    });
    if (Array.isArray(selection)) void importPaths(selection);
  }
  const feedback = (
    <>
      {error && (
        <p className="media-import__error" role="alert">
          {error}
        </p>
      )}
      {results.length > 0 && (
        <ul className="media-import__results" aria-label="导入结果">
          {results.map((item) => (
            <li key={item.key} data-error={item.error ? true : undefined}>
              <span>{item.sourcePath.split(/[\\/]/).pop()}</span>
              <small>
                {item.phase === "queued"
                  ? "排队等待导入…"
                  : item.phase === "processing"
                    ? "正在导入…"
                    : item.code === "DUPLICATE_MEDIA"
                      ? item.existingMedia?.restaurantId !== restaurantId
                        ? `其他餐厅已有相同媒体：${item.existingMedia?.originalName ?? "已有媒体"}`
                        : `已存在：${item.existingMedia?.originalName ?? "已有媒体"}`
                      : (item.error ?? "已导入")}
              </small>
            </li>
          ))}
        </ul>
      )}
    </>
  );
  if (variant === "tile") {
    return (
      <>
        <section
          className="media-import media-import--tile media-card"
          aria-label={tileLabel}
          data-media-drop-zone
          ref={setDropZone}
        >
          <button type="button" aria-label={tileLabel} onClick={() => void chooseFiles()}>
            <span aria-hidden="true">＋</span>
            {pending && <small>导入中…</small>}
          </button>
        </section>
        {(error || results.length > 0) && <div className="media-import__tile-feedback">{feedback}</div>}
      </>
    );
  }
  return (
    <section
      className={compact ? "media-import media-import--compact" : "media-import"}
      aria-label="导入媒体"
      data-media-drop-zone
      ref={setDropZone}
    >
      <div className="media-import__controls">
        <label>
          分类
          <select
            value={selectedCategory}
            onChange={(event) => setSelectedCategory(event.target.value as MediaCategory)}
          >
            {MEDIA_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {categoryLabels[item]}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => void chooseFiles()}>
          {pending ? "继续选择图片或视频" : "选择图片或视频"}
        </button>
      </div>
      {!compact && <p className="media-import__hint">也可以把图片或视频拖到这里；每个文件将分别显示结果。</p>}
      {feedback}
    </section>
  );
}

export function MediaGrid({ restaurantId, onMutation }: { restaurantId: string; onMutation: () => void }) {
  const [items, setItems] = useState<Media[]>([]);
  const [foodLogs, setFoodLogs] = useState<import("../restaurants/api").FoodLog[]>([]);
  const [origin, setOrigin] = useState("");
  const [selected, setSelected] = useState<Media | null>(null);
  const [filter, setFilter] = useState<MediaFilter>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [page, logPage, bootstrap] = await Promise.all([
        restaurantApi.listMedia({ restaurantId, limit: 100 }),
        restaurantApi.listFoodLogs(restaurantId, null, 100),
        invoke<Bootstrap>("app_bootstrap"),
      ]);
      setItems(page.items);
      setFoodLogs(logPage.items);
      setOrigin(bootstrap.localAssetOrigin);
      setError("");
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setLoading(false);
    }
  }, [restaurantId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function changeCategory(id: string, category: MediaCategory) {
    try {
      const updated = await restaurantApi.updateMediaCategory(id, category);
      setItems((current) => current.map((item) => (item.id === id ? updated : item)));
      setSelected((current) => (current?.id === id ? updated : current));
      onMutation();
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  async function associate(id: string, foodLogId: string | null) {
    try {
      const updated = await restaurantApi.attachMediaToLog(id, foodLogId);
      setItems((current) => current.map((item) => (item.id === id ? updated : item)));
      setSelected((current) => (current?.id === id ? updated : current));
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  async function remove(id: string) {
    try {
      await restaurantApi.softDeleteMedia(id);
      setItems((current) => current.filter((item) => item.id !== id));
      setSelected(null);
      onMutation();
    } catch (reason) {
      setError(errorText(reason));
    }
  }
  const visibleItems = items.filter((item) => matchesMediaFilter(item, filter));
  const activeFilterLabel = MEDIA_FILTERS.find((item) => item.value === filter)?.label ?? "所有";
  const uploadSpec =
    filter === "all"
      ? null
      : filter === "video"
        ? { category: "other" as const, mediaKind: "video" as const }
        : filter === "environment"
          ? { category: "interior" as const, mediaKind: "image" as const }
          : { category: filter, mediaKind: "image" as const };
  return (
    <section className="media-section" aria-labelledby="media-heading">
      <header className="media-section__header">
        <div>
          <p className="panel-kicker">MEDIA</p>
          <h4 id="media-heading">餐厅相册</h4>
        </div>
      </header>
      <nav className="media-section__filters" aria-label="相册类型筛选">
        {MEDIA_FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={filter === item.value}
            data-active={filter === item.value || undefined}
            onClick={() => {
              setFilter(item.value);
              setSelected(null);
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {error && (
        <p className="media-import__error" role="alert">
          {error}
        </p>
      )}
      {loading ? <p className="food-log-empty">正在读取相册…</p> : null}
      {!loading && !visibleItems.length ? (
        <p className="food-log-empty">
          {items.length ? `“${activeFilterLabel}”筛选下暂无媒体。` : "还没有媒体。"}
        </p>
      ) : null}
      <div className="media-grid" aria-label="餐厅媒体网格">
        {visibleItems.map((item) => (
          <article key={item.id} className="media-card">
            <button
              type="button"
              className="media-card__preview"
              aria-label={`预览 ${item.originalName}`}
              onClick={() => setSelected(item)}
            >
              {origin && (
                <img src={mediaUrl(origin, item.thumbnailRelPath)} alt={item.caption || item.originalName} />
              )}
              {isVideo(item) && (
                <span className="media-card__play" aria-hidden="true">
                  ▶
                </span>
              )}
              <span className="media-card__category">{categoryLabels[item.category]}</span>
            </button>
            <button
              type="button"
              className="media-card__remove"
              aria-label={`删除 ${item.originalName}`}
              onClick={() => void remove(item.id)}
            >
              ×
            </button>
          </article>
        ))}
        {uploadSpec && (
          <MediaImportButton
            restaurantId={restaurantId}
            fixedCategory={uploadSpec.category}
            mediaKind={uploadSpec.mediaKind}
            variant="tile"
            tileLabel={`添加${activeFilterLabel}媒体`}
            onImported={() => void load()}
          />
        )}
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
            onClick={() => setSelected(null)}
          />
          <section className="media-lightbox__content">
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
              <strong>{selected.originalName}</strong>
              <label>
                分类
                <select
                  value={selected.category}
                  onChange={(event) => void changeCategory(selected.id, event.target.value as MediaCategory)}
                >
                  {MEDIA_CATEGORIES.map((item) => (
                    <option key={item} value={item}>
                      {categoryLabels[item]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                关联用餐记录
                <select
                  value={selected.foodLogId ?? ""}
                  onChange={(event) => void associate(selected.id, event.target.value || null)}
                >
                  <option value="">不关联</option>
                  {foodLogs.map((log) => (
                    <option key={log.id} value={log.id}>
                      {log.title || new Date(log.occurredAtMs).toLocaleString()}
                    </option>
                  ))}
                </select>
              </label>
              <div className="media-lightbox__actions">
                <button type="button" onClick={() => void restaurantApi.openMediaOriginal(selected.id)}>
                  {isVideo(selected) ? "打开原视频" : "打开原图"}
                </button>
                <button type="button" className="delete-button" onClick={() => void remove(selected.id)}>
                  移至回收站
                </button>
                <button type="button" onClick={() => setSelected(null)}>
                  关闭
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
