import { useCallback, useEffect, useState } from "react";
import {
  TRASH_ENTITY_TYPES,
  restaurantApi,
  type TrashEntityType,
  type TrashItem,
  type TrashSnapshot,
} from "../restaurants/api";

const entityLabels: Record<TrashEntityType, string> = {
  restaurant: "餐厅",
  foodLog: "用餐记录",
  media: "图片",
};

function formatTime(value: number) {
  return new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" }).format(value);
}

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function deleteDescription(item: TrashItem) {
  if (item.entity === "restaurant") {
    return `会永久移除这间餐厅，以及 ${item.logCount ?? 0} 条用餐记录和 ${item.mediaCount ?? 0} 张图片。此操作无法复原。`;
  }
  if (item.entity === "foodLog") {
    return "会永久移除这条用餐记录；已关联图片会保留在餐厅相册中。此操作无法复原。";
  }
  return "会永久移除这张图片及其应用内副本。此操作无法复原。";
}

export function TrashView() {
  const [snapshot, setSnapshot] = useState<TrashSnapshot | null>(null);
  const [filter, setFilter] = useState<TrashEntityType | "all">("all");
  const [pending, setPending] = useState<TrashItem | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setSnapshot(await restaurantApi.listTrash());
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(initialLoad);
  }, [load]);

  const items = snapshot?.items.filter((item) => filter === "all" || item.entity === filter) ?? [];
  const restore = async (item: TrashItem) => {
    setWorkingId(item.id);
    setError("");
    try {
      await restaurantApi.restoreTrashItem(item.entity, item.id);
      await load();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setWorkingId(null);
    }
  };
  const permanentlyDelete = async () => {
    if (!pending) return;
    setWorkingId(pending.id);
    setError("");
    try {
      await restaurantApi.permanentlyDeleteTrashItem(pending.entity, pending.id);
      setPending(null);
      await load();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <section className="trash-view" aria-labelledby="trash-title">
      <header className="trash-view__header">
        <div>
          <p className="view-kicker">LOCAL RECOVERY</p>
          <h2 id="trash-title">回收站</h2>
          <p>已移除的资料会留在这里，直到你选择永久删除。</p>
        </div>
        <button type="button" className="button-secondary" onClick={() => void load()}>
          重新整理
        </button>
      </header>

      <div className="trash-tabs" role="tablist" aria-label="回收站类型">
        <button type="button" role="tab" aria-selected={filter === "all"} onClick={() => setFilter("all")}>
          全部 <span>{snapshot?.items.length ?? "–"}</span>
        </button>
        {TRASH_ENTITY_TYPES.map((entityType) => (
          <button
            key={entityType}
            type="button"
            role="tab"
            aria-selected={filter === entityType}
            onClick={() => setFilter(entityType)}
          >
            {entityLabels[entityType]}{" "}
            <span>{snapshot?.items.filter((item) => item.entity === entityType).length ?? "–"}</span>
          </button>
        ))}
      </div>

      {error ? (
        <p className="view-error" role="alert">
          {error}
        </p>
      ) : null}
      {snapshot && snapshot.cleanupPending > 0 ? (
        <p className="view-muted">有 {snapshot.cleanupPending} 个已删除文件正等待系统清理。</p>
      ) : null}
      {!snapshot ? <p className="view-muted">正在读取回收站…</p> : null}
      {snapshot && items.length === 0 ? <p className="trash-empty">这里很干净，没有已移除的资料。</p> : null}
      <div className="trash-list">
        {items.map((item) => (
          <article className="trash-item" key={`${item.entity}-${item.id}`}>
            <div className="trash-item__type">{entityLabels[item.entity]}</div>
            <div className="trash-item__body">
              <h3>{item.title}</h3>
              <small>移除于 {formatTime(item.deletedAtMs)}</small>
            </div>
            <div className="trash-item__actions">
              <button
                type="button"
                className="button-secondary"
                disabled={workingId === item.id}
                onClick={() => void restore(item)}
              >
                恢复
              </button>
              <button
                type="button"
                className="button-danger-quiet"
                disabled={workingId === item.id}
                onClick={() => setPending(item)}
              >
                永久删除
              </button>
            </div>
          </article>
        ))}
      </div>

      {pending ? (
        <div className="confirm-scrim" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="permanent-delete-title"
          >
            <p className="view-kicker">PERMANENT DELETE</p>
            <h3 id="permanent-delete-title">永久删除「{pending.title}」？</h3>
            <p>{deleteDescription(pending)}</p>
            {pending.entity === "restaurant" ? (
              <p className="confirm-dialog__second-check">请再次确认：这会移除该餐厅的所有相关资料。</p>
            ) : null}
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="button-secondary"
                disabled={workingId === pending.id}
                onClick={() => setPending(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={workingId === pending.id}
                onClick={() => void permanentlyDelete()}
              >
                {workingId === pending.id ? "正在删除…" : "确认永久删除"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
