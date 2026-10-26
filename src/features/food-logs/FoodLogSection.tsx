import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  restaurantApi,
  type DiningMode,
  type FoodLog,
  type FoodLogInput,
  type MealType,
  type Media,
} from "../restaurants/api";
import { MediaImportButton } from "../media/MediaGrid";

type Draft = Omit<FoodLogInput, "restaurantId">;
const mealLabels: Record<MealType, string> = {
  breakfast: "早餐",
  lunch: "午餐",
  dinner: "晚餐",
  late_night: "宵夜",
  other: "其他",
};
const modeLabels: Record<DiningMode, string> = {
  dine_in: "堂食",
  delivery: "外送",
  takeaway: "外带",
  other: "其他",
};

function localDateTime(ms = Date.now()): string {
  const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return date.toISOString().slice(0, 16);
}

function draftFrom(log?: FoodLog): Draft {
  const now = new Date();
  return {
    occurredAtMs: log?.occurredAtMs ?? now.getTime(),
    tzOffsetMinutes: log?.tzOffsetMinutes ?? -now.getTimezoneOffset(),
    mealType: log?.mealType ?? null,
    diningMode: log?.diningMode ?? null,
    title: log?.title ?? null,
    note: log?.note ?? "",
    rating: log?.rating ?? null,
  };
}

function displayTime(ms: number): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

type Bootstrap = { localAssetOrigin: string };

function mediaUrl(origin: string, path: string): string {
  const normalizedPath = path.split("/").filter(Boolean).join("/");
  return `${origin}/media/${normalizedPath}`;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function FoodLogModal({
  log,
  restaurantId,
  onClose,
  onSaved,
  onMutation,
}: {
  log: FoodLog;
  restaurantId: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
  onMutation: () => void;
}) {
  const [media, setMedia] = useState<Media[]>([]);
  const [origin, setOrigin] = useState("");
  const [loadingMedia, setLoadingMedia] = useState(true);
  const [mediaError, setMediaError] = useState("");
  const loadMedia = useCallback(async () => {
    setLoadingMedia(true);
    try {
      const [page, bootstrap] = await Promise.all([
        restaurantApi.listMedia({ restaurantId, foodLogId: log.id, limit: 100 }),
        invoke<Bootstrap>("app_bootstrap").catch(() => null),
      ]);
      setMedia(page.items.filter((item) => item.foodLogId === log.id));
      if (bootstrap) setOrigin(bootstrap.localAssetOrigin);
      setMediaError("");
    } catch (reason) {
      setMediaError(errorText(reason));
    } finally {
      setLoadingMedia(false);
    }
  }, [log.id, restaurantId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMedia(), 0);
    return () => window.clearTimeout(timer);
  }, [loadMedia]);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  return createPortal(
    <div
      className="food-log-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`food-log-title-${log.id}`}
    >
      <button
        className="food-log-modal__backdrop"
        type="button"
        aria-label="关闭用餐记录"
        onClick={onClose}
      />
      <article className="food-log-modal__sheet">
        <header className="food-log-modal__header">
          <div>
            <p className="panel-kicker">FOOD LOG</p>
            <h3 id={`food-log-title-${log.id}`}>用餐记录</h3>
          </div>
          <button className="food-log-modal__close" type="button" aria-label="关闭用餐记录" onClick={onClose}>
            ×
          </button>
        </header>
        <FoodLogEditor
          key={log.id}
          log={log}
          restaurantId={restaurantId}
          onCancel={onClose}
          onSave={onSaved}
        />
        <section className="food-log-modal__media" aria-labelledby={`food-log-media-${log.id}`}>
          <div className="food-log-modal__media-header">
            <strong id={`food-log-media-${log.id}`}>记录相册</strong>
            <small>上传内容会自动关联到这条用餐记录</small>
          </div>
          <div className="media-grid food-log-modal__media-grid">
            {media.map((item) => (
              <div className="media-card" key={item.id}>
                <img
                  src={mediaUrl(origin, item.thumbnailRelPath)}
                  alt={item.caption || item.originalName}
                  loading="lazy"
                />
              </div>
            ))}
            <MediaImportButton
              restaurantId={restaurantId}
              foodLogId={log.id}
              fixedCategory="food"
              variant="tile"
              mediaKind="all"
              tileLabel="添加记录图片或视频"
              onImported={() => {
                void loadMedia();
                onMutation();
              }}
            />
            {mediaError && (
              <p className="food-log-error" role="alert">
                {mediaError}
              </p>
            )}
            {loadingMedia ? <p className="food-log-empty">正在读取关联照片…</p> : null}
            {!loadingMedia && !media.length ? <p className="food-log-empty">暂无关联照片。</p> : null}
          </div>
        </section>
      </article>
    </div>,
    document.body,
  );
}

function FoodLogEntryRow({ restaurantId, onSave }: { restaurantId: string; onSave: () => Promise<void> }) {
  const [draft, setDraft] = useState(() => draftFrom());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function submit() {
    if (saving) return;
    setSaving(true);
    try {
      await restaurantApi.createFoodLog({ restaurantId, ...draft, title: null });
      setDraft(draftFrom());
      setError("");
      await onSave();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <tr
        className="food-log-entry-row"
        aria-label="新增用餐记录"
        onKeyDown={(event) => {
          const saveFromNote =
            event.key === "Enter" &&
            (event.target as HTMLElement).getAttribute("aria-label") === "新记录备注";
          if (!saveFromNote && !((event.ctrlKey || event.metaKey) && event.key === "Enter")) return;
          event.preventDefault();
          void submit();
        }}
      >
        <td className="food-log-row__leading-action">
          <button
            type="button"
            aria-label="新增用餐记录"
            title="新增"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? "…" : "+"}
          </button>
        </td>
        <td>
          <input
            aria-label="新记录日期时间"
            required
            type="datetime-local"
            value={localDateTime(draft.occurredAtMs)}
            onChange={(event) => set("occurredAtMs", new Date(event.target.value).getTime())}
          />
        </td>
        <td>
          <select
            aria-label="新记录餐次"
            value={draft.mealType ?? ""}
            onChange={(event) => set("mealType", (event.target.value || null) as MealType | null)}
          >
            <option value="">—</option>
            {Object.entries(mealLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </td>
        <td>
          <select
            aria-label="新记录用餐方式"
            value={draft.diningMode ?? ""}
            onChange={(event) => set("diningMode", (event.target.value || null) as DiningMode | null)}
          >
            <option value="">—</option>
            {Object.entries(modeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </td>
        <td>
          <select
            aria-label="新记录评分"
            value={draft.rating ?? ""}
            onChange={(event) => set("rating", event.target.value ? Number(event.target.value) : null)}
          >
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((rating) => (
              <option key={rating} value={rating}>
                {rating}
              </option>
            ))}
          </select>
        </td>
        <td>
          <input
            aria-label="新记录备注"
            placeholder="直接键入…"
            value={draft.note}
            onChange={(event) => set("note", event.target.value)}
          />
        </td>
      </tr>
      {error && (
        <tr className="food-log-entry-error">
          <td colSpan={6}>
            <p className="food-log-error" role="alert">
              {error}
            </p>
          </td>
        </tr>
      )}
    </>
  );
}

export function FoodLogSection({
  restaurantId,
  focusedFoodLogId = null,
  onMutation,
}: {
  restaurantId: string;
  focusedFoodLogId?: string | null;
  onMutation: () => void;
}) {
  const [logs, setLogs] = useState<FoodLog[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeFoodLog, setActiveFoodLog] = useState<FoodLog | null>(null);
  const [error, setError] = useState("");

  async function load(reset = true) {
    setLoading(true);
    try {
      const page = await restaurantApi.listFoodLogs(restaurantId, reset ? null : cursor);
      setLogs((current) => (reset ? page.items : [...current, ...page.items]));
      setCursor(page.nextCursor);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let active = true;
    void restaurantApi
      .listFoodLogs(restaurantId)
      .then((page) => {
        if (!active) return;
        setLogs(page.items);
        setCursor(page.nextCursor);
        setError("");
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [restaurantId]);
  useEffect(() => {
    if (!focusedFoodLogId) return;
    const focusedLog = logs.find((log) => log.id === focusedFoodLogId);
    if (!focusedLog) return;
    const timer = window.setTimeout(() => setActiveFoodLog(focusedLog), 0);
    document.getElementById(`food-log-${focusedFoodLogId}`)?.scrollIntoView({ block: "center" });
    return () => window.clearTimeout(timer);
  }, [focusedFoodLogId, logs]);
  async function remove(id: string) {
    try {
      await restaurantApi.softDeleteFoodLog(id);
      setActiveFoodLog((current) => (current?.id === id ? null : current));
      await load();
      onMutation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return (
    <section className="food-log-section" aria-labelledby="food-log-heading">
      <header className="food-log-section__header">
        <div>
          <p className="panel-kicker">FOOD LOG</p>
          <h4 id="food-log-heading">用餐记录</h4>
        </div>
      </header>
      {activeFoodLog && (
        <FoodLogModal
          log={activeFoodLog}
          restaurantId={restaurantId}
          onClose={() => setActiveFoodLog(null)}
          onSaved={async () => {
            await load();
            onMutation();
            setActiveFoodLog(null);
          }}
          onMutation={onMutation}
        />
      )}
      {error && (
        <p className="food-log-error" role="alert">
          {error}
        </p>
      )}
      {loading ? <p className="food-log-empty">正在读取记录…</p> : null}
      <div className="food-log-table-wrap">
        <table className="food-log-table" aria-label="用餐记录表">
          <caption className="sr-only">用餐记录</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">行操作</span>
              </th>
              <th scope="col">日期时间</th>
              <th scope="col">餐次</th>
              <th scope="col">方式</th>
              <th scope="col">评分</th>
              <th scope="col">备注</th>
            </tr>
          </thead>
          <tbody>
            <FoodLogEntryRow
              restaurantId={restaurantId}
              onSave={async () => {
                await load();
                onMutation();
              }}
            />
            {logs.map((log) => (
              <tr
                key={log.id}
                id={`food-log-${log.id}`}
                className="food-log-row"
                data-focused={log.id === focusedFoodLogId || undefined}
                tabIndex={0}
                aria-haspopup="dialog"
                onClick={() => setActiveFoodLog(log)}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Enter" &&
                    event.key !== " " &&
                    event.key !== "Space" &&
                    event.key !== "Spacebar"
                  )
                    return;
                  event.preventDefault();
                  setActiveFoodLog(log);
                }}
              >
                <td className="food-log-row__leading-action">
                  <button
                    type="button"
                    aria-label={`删除 ${displayTime(log.occurredAtMs)} 用餐记录`}
                    title="删除"
                    onKeyDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      void remove(log.id);
                    }}
                  >
                    ×
                  </button>
                </td>
                <td>
                  <time dateTime={new Date(log.occurredAtMs).toISOString()}>
                    {displayTime(log.occurredAtMs)}
                  </time>
                </td>
                <td>{log.mealType ? mealLabels[log.mealType] : "—"}</td>
                <td>{log.diningMode ? modeLabels[log.diningMode] : "—"}</td>
                <td aria-label={log.rating ? `${log.rating} 星` : "未评分"}>
                  {log.rating ? `★ ${log.rating}` : "—"}
                </td>
                <td>{log.note || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {cursor && (
          <button className="food-log-more" type="button" onClick={() => void load(false)} disabled={loading}>
            加载更多
          </button>
        )}
      </div>
    </section>
  );
}

export function FoodLogEditor({
  restaurantId,
  log,
  onCancel,
  onSave,
}: {
  restaurantId: string;
  log?: FoodLog;
  onCancel: () => void;
  onSave: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(() => draftFrom(log));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function submit() {
    setSaving(true);
    try {
      if (log) await restaurantApi.updateFoodLog(log.id, draft);
      else await restaurantApi.createFoodLog({ restaurantId, ...draft, title: null });
      await onSave();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="food-log-editor"
      aria-label="编辑用餐记录"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          void submit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <label>
        日期时间
        <input
          required
          type="datetime-local"
          value={localDateTime(draft.occurredAtMs)}
          onChange={(event) => set("occurredAtMs", new Date(event.target.value).getTime())}
        />
      </label>
      <label>
        餐次
        <select
          value={draft.mealType ?? ""}
          onChange={(event) => set("mealType", (event.target.value || null) as MealType | null)}
        >
          <option value="">未设置</option>
          {Object.entries(mealLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        用餐方式
        <select
          value={draft.diningMode ?? ""}
          onChange={(event) => set("diningMode", (event.target.value || null) as DiningMode | null)}
        >
          <option value="">未设置</option>
          {Object.entries(modeLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        评分
        <select
          value={draft.rating ?? ""}
          onChange={(event) => set("rating", event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">未评分</option>
          {[1, 2, 3, 4, 5].map((rating) => (
            <option key={rating} value={rating}>
              {rating} / 5
            </option>
          ))}
        </select>
      </label>
      <label className="food-log-editor__note">
        备注
        <textarea value={draft.note} onChange={(event) => set("note", event.target.value)} />
      </label>
      {error && (
        <p className="food-log-error" role="alert">
          {error}
        </p>
      )}
      <div className="food-log-editor__actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="submit" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
