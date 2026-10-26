import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { restaurantApi, type BackupResult, type RestorePreview } from "../restaurants/api";
import { settingsApi } from "./settingsApi";
import { APP_THEMES, readTheme, writeTheme, type AppThemeKey } from "./themeCatalog";

function errorText(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

export function SettingsView({
  theme = readTheme(),
  onThemeChange = writeTheme,
}: {
  theme?: AppThemeKey;
  onThemeChange?: (theme: AppThemeKey) => void;
}) {
  const [backup, setBackup] = useState<BackupResult | null>(null);
  const [restore, setRestore] = useState<RestorePreview | null>(null);
  const [busy, setBusy] = useState<"backup" | "inspect" | "restore" | null>(null);
  const [positionLocked, setPositionLocked] = useState(false);
  const [positionLockBusy, setPositionLockBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void settingsApi
      .getRestaurantPositionLocked()
      .then((value) => {
        if (active) setPositionLocked(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      });
    return () => {
      active = false;
    };
  }, []);

  const togglePositionLock = async (next: boolean) => {
    const previous = positionLocked;
    setPositionLocked(next);
    setPositionLockBusy(true);
    setError("");
    try {
      await settingsApi.setRestaurantPositionLocked(next);
    } catch (reason) {
      setPositionLocked(previous);
      setError(errorText(reason));
    } finally {
      setPositionLockBusy(false);
    }
  };

  const exportBackup = async () => {
    const destination = await save({
      defaultPath: "foodprint.foodmap-backup.zip",
      filters: [{ name: "随食记备份", extensions: ["zip"] }],
    });
    if (!destination) return;
    setBusy("backup");
    setError("");
    try {
      setBackup(await restaurantApi.createBackup(destination));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  };
  const selectRestore = async () => {
    const source = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "随食记备份", extensions: ["zip"] }],
    });
    if (!source || Array.isArray(source)) return;
    setBusy("inspect");
    setError("");
    try {
      setRestore(await restaurantApi.inspectBackup(source));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  };
  const confirmRestore = async () => {
    if (!restore) return;
    setBusy("restore");
    setError("");
    try {
      await restaurantApi.restoreBackup(restore.path);
      setRestore(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="settings-view" aria-labelledby="settings-title">
      <header>
        <p className="view-kicker">LOCAL FIRST</p>
        <h2 id="settings-title">数据与备份</h2>
        <p>你的地图、记录和图片只保留在这台设备上。</p>
      </header>
      {error ? (
        <p className="view-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-stack">
        <section className="settings-card settings-card--themes" aria-labelledby="theme-settings-title">
          <div className="settings-card__heading">
            <h3 id="theme-settings-title">视觉主题</h3>
            <p>同时改变地图、侧边栏、详情窗口与全部操作界面。</p>
          </div>
          <div className="theme-grid" role="radiogroup" aria-label="视觉主题">
            {APP_THEMES.map((option) => (
              <button
                key={option.key}
                type="button"
                className="theme-card"
                role="radio"
                aria-checked={theme === option.key}
                data-active={theme === option.key || undefined}
                onClick={() => onThemeChange(option.key)}
              >
                <span className="theme-card__swatches" aria-hidden="true">
                  {option.swatches.map((color) => (
                    <span key={color} style={{ background: color }} />
                  ))}
                </span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
        </section>
        <section className="settings-card settings-card--lock">
          <div>
            <h3>全部位置锁定</h3>
            <p>一次锁定全部餐厅，单店锁定可在各自详情中设置。</p>
          </div>
          <label className="settings-lock-control">
            <input
              type="checkbox"
              aria-label="全部位置锁定"
              checked={positionLocked}
              disabled={positionLockBusy}
              onChange={(event) => void togglePositionLock(event.target.checked)}
            />
            <span>{positionLocked ? "已锁定" : "可拖动"}</span>
          </label>
        </section>
        <section className="settings-card">
          <div>
            <h3>应用数据目录</h3>
            <p>打开随食记在此设备上的真实资料位置。</p>
          </div>
          <button
            type="button"
            className="button-secondary"
            onClick={() =>
              void restaurantApi.openDataDirectory().catch((reason: unknown) => setError(errorText(reason)))
            }
          >
            打开资料目录
          </button>
        </section>
        <section className="settings-card">
          <div>
            <h3>导出备份</h3>
            <p>创建一个可携带的 .foodmap-backup.zip，其中包含资料库和现有图片，不包含离线地图包。</p>
          </div>
          <button
            type="button"
            className="button-primary"
            disabled={busy !== null}
            onClick={() => void exportBackup()}
          >
            {busy === "backup" ? "正在导出…" : "导出备份"}
          </button>
          {backup ? (
            <small className="settings-card__result">
              已导出 {backup.restaurants} 间餐厅、{backup.foodLogs} 条记录与 {backup.media} 张图片。
            </small>
          ) : null}
        </section>
        <section className="settings-card settings-card--restore">
          <div>
            <h3>从备份恢复</h3>
            <p>先检查备份内容；确认后会先为当前资料创建安全备份，再替换本地资料。</p>
          </div>
          <button
            type="button"
            className="button-secondary"
            disabled={busy !== null}
            onClick={() => void selectRestore()}
          >
            {busy === "inspect" ? "正在检查…" : "选择备份文件"}
          </button>
        </section>
      </div>
      {restore ? (
        <div className="confirm-scrim" role="presentation">
          <section
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="restore-title"
          >
            <p className="view-kicker">RESTORE BACKUP</p>
            <h3 id="restore-title">要恢复这份备份吗？</h3>
            <p>
              这份备份包含 {restore.restaurants} 间餐厅、{restore.foodLogs} 条用餐记录与 {restore.media}{" "}
              张图片。
            </p>
            {restore.mapReinstallHint ? <p>离线地图包不在备份内；恢复完成后可重新安装地图包。</p> : null}
            <p className="confirm-dialog__second-check">恢复前会自动备份当前资料。完成后应用会重新载入。</p>
            <div className="confirm-dialog__actions">
              <button
                type="button"
                className="button-secondary"
                disabled={busy === "restore"}
                onClick={() => setRestore(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="button-danger"
                disabled={busy === "restore"}
                onClick={() => void confirmRestore()}
              >
                {busy === "restore" ? "正在恢复…" : "确认恢复"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
