import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restaurantApi } from "../restaurants/api";
import { SettingsView } from "./SettingsView";
import { settingsApi } from "./settingsApi";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../restaurants/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restaurants/api")>();
  return {
    ...actual,
    restaurantApi: {
      createBackup: vi.fn(),
      inspectBackup: vi.fn(),
      restoreBackup: vi.fn(),
      openDataDirectory: vi.fn(),
    },
  };
});
vi.mock("./settingsApi", () => ({
  settingsApi: {
    getRestaurantPositionLocked: vi.fn(),
    setRestaurantPositionLocked: vi.fn(),
  },
}));
import { open, save } from "@tauri-apps/plugin-dialog";

const summary = {
  path: "C:/backup.zip",
  restaurants: 2,
  foodLogs: 4,
  media: 6,
  bytes: 100,
  mapReinstallHint: true,
};

describe("SettingsView", () => {
  beforeEach(() => {
    vi.mocked(settingsApi.getRestaurantPositionLocked).mockResolvedValue(false);
    vi.mocked(settingsApi.setRestaurantPositionLocked).mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });
  it("exports a backup only after the user chooses a destination", async () => {
    vi.mocked(save).mockResolvedValue("C:/backup.zip");
    vi.mocked(restaurantApi.createBackup).mockResolvedValue(summary);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "导出备份" }));
    await waitFor(() => expect(restaurantApi.createBackup).toHaveBeenCalledWith("C:/backup.zip"));
    expect(await screen.findByText("已导出 2 间餐厅、4 条记录与 6 张图片。")).toBeInTheDocument();
  });
  it("previews a backup and waits for an explicit restore confirmation", async () => {
    vi.mocked(open).mockResolvedValue("C:/backup.zip");
    vi.mocked(restaurantApi.inspectBackup).mockResolvedValue(summary);
    vi.mocked(restaurantApi.restoreBackup).mockResolvedValue(summary);
    render(<SettingsView />);
    fireEvent.click(screen.getByRole("button", { name: "选择备份文件" }));
    expect(await screen.findByText("这份备份包含 2 间餐厅、4 条用餐记录与 6 张图片。")).toBeInTheDocument();
    expect(restaurantApi.restoreBackup).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认恢复" }));
    await waitFor(() => expect(restaurantApi.restoreBackup).toHaveBeenCalledWith("C:/backup.zip"));
  });

  it("loads the saved position lock and exposes it as an accessible checkbox", async () => {
    vi.mocked(settingsApi.getRestaurantPositionLocked).mockResolvedValue(true);
    render(<SettingsView />);

    const lock = await screen.findByRole("checkbox", { name: "全部位置锁定" });
    expect(lock).toBeChecked();
    expect(screen.getByText("已锁定")).toBeInTheDocument();
  });

  it("persists position lock changes immediately", async () => {
    render(<SettingsView />);
    const lock = await screen.findByRole("checkbox", { name: "全部位置锁定" });

    fireEvent.click(lock);

    await waitFor(() => expect(settingsApi.setRestaurantPositionLocked).toHaveBeenCalledWith(true));
    expect(lock).toBeChecked();
  });

  it("reverts the switch and reports an error when position lock saving fails", async () => {
    vi.mocked(settingsApi.setRestaurantPositionLocked).mockRejectedValue(new Error("设置未保存"));
    render(<SettingsView />);
    const lock = await screen.findByRole("checkbox", { name: "全部位置锁定" });

    fireEvent.click(lock);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("设置未保存"));
    expect(lock).not.toBeChecked();
  });

  it("changes the complete visual theme immediately without a save action", () => {
    const onThemeChange = vi.fn();
    render(<SettingsView theme="hybrid" onThemeChange={onThemeChange} />);

    const morandi = screen.getByRole("radio", { name: /莫兰迪/ });
    expect(morandi).toHaveAttribute("aria-checked", "false");
    fireEvent.click(morandi);

    expect(onThemeChange).toHaveBeenCalledWith("morandi");
    expect(screen.queryByRole("button", { name: /保存主题/ })).not.toBeInTheDocument();
    expect(screen.getByText("同时改变地图、侧边栏、详情窗口与全部操作界面。")).toBeInTheDocument();
  });
});
