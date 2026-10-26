import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GalleryView, galleryWindow } from "./GalleryView";

const items = Array.from({ length: 5_000 }, (_, index) => ({
  id: `m-${index}`,
  restaurantId: index % 2 ? "r-1" : "r-2",
  foodLogId: null,
  category: "food" as const,
  originalName: `photo-${index}.jpg`,
  mimeType: "image/jpeg",
  originalRelPath: `original/${index}.jpg`,
  previewRelPath: `preview/${index}.jpg`,
  thumbnailRelPath: `thumb/${index}.jpg`,
  width: 1200,
  height: 800,
  fileSizeBytes: 100,
  capturedAtMs: index,
  caption: null,
  createdAtMs: index,
  restaurant: { id: index % 2 ? "r-1" : "r-2", name: index % 2 ? "第一家" : "第二家" },
}));
const videoItem = {
  ...items[0],
  id: "video-1",
  originalName: "clip.mp4",
  mimeType: "video/mp4",
  originalRelPath: "original/clip.mp4",
  previewRelPath: "preview/clip.jpg",
  thumbnailRelPath: "thumbnail/clip.jpg",
};

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
invoke.mockImplementation(
  (command: string, args?: { input?: { restaurantId?: string; id?: string; foodLogId?: string | null } }) => {
    if (command === "app_bootstrap") return Promise.resolve({ localAssetOrigin: "http://local" });
    if (command === "list_restaurant_map") {
      return Promise.resolve([
        { id: "r-1", name: "第一家" },
        { id: "r-2", name: "第二家" },
        { id: "r-empty", name: "没有照片的餐厅" },
      ]);
    }
    if (command === "list_media") {
      const restaurantId = args?.input?.restaurantId;
      return Promise.resolve({
        items: restaurantId ? items.filter((item) => item.restaurantId === restaurantId) : items,
        nextCursor: null,
      });
    }
    if (command === "list_food_logs") {
      return Promise.resolve({
        items: [{ id: "log-1", restaurantId: "r-2", title: "午餐", occurredAtMs: 1_700_000_000_000 }],
        nextCursor: null,
      });
    }
    if (command === "open_media_original") return Promise.resolve();
    if (command === "update_media_category") return Promise.resolve({ ...items[0], category: "menu" });
    if (command === "attach_media_to_log") {
      const media = items.find((item) => item.id === args?.input?.id);
      return Promise.resolve({ ...media, foodLogId: args?.input?.foodLogId ?? null });
    }
    return Promise.resolve();
  },
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

describe("GalleryView", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("windows a 5000-image collection instead of rendering every card", () => {
    const windowed = galleryWindow(5_000, 0, 600, 5);
    expect(windowed.height).toBe(1_000 * 184);
    expect(windowed.end).toBeLessThan(100);
  });

  it("keeps actual DOM cards below 100 at both the top and deep scroll positions", async () => {
    render(<GalleryView />);
    await screen.findByText("5,000 项已加载媒体");
    const viewport = screen.getByLabelText("全部媒体网格");
    Object.defineProperties(viewport, {
      clientWidth: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 600 },
    });
    fireEvent(window, new Event("resize"));
    expect(viewport.querySelectorAll(".gallery-card").length).toBeLessThan(100);
    Object.defineProperty(viewport, "scrollTop", { configurable: true, value: 80_000 });
    fireEvent.scroll(viewport);
    expect(viewport.querySelectorAll(".gallery-card").length).toBeLessThan(100);
    expect(screen.queryByRole("button", { name: /photo-0\.jpg/ })).not.toBeInTheDocument();
  });

  it("filters by restaurant and navigates the lightbox", async () => {
    render(<GalleryView />);
    await waitFor(() => expect(screen.getByText("5,000 项已加载媒体")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("餐厅筛选"), { target: { value: "r-1" } });
    await waitFor(() => expect(screen.getByText("2,500 项已加载媒体")).toBeInTheDocument());
    expect(invoke).toHaveBeenCalledWith("list_media", {
      // Vitest asymmetric matcher intentionally accepts the command's untyped bridge payload.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      input: expect.objectContaining({ restaurantId: "r-1" }),
    });
    fireEvent.click(screen.getByRole("button", { name: /photo-1\.jpg第一家/ }));
    expect(await screen.findByRole("dialog", { name: "图片预览" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(screen.getByText("2 / 2500")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "图片预览" })).not.toBeInTheDocument());
  });

  it("resets server filters, updates lightbox metadata, and hands the image context to the map", async () => {
    const onOpenMap = vi.fn();
    render(<GalleryView onOpenMap={onOpenMap} />);
    await screen.findByText("5,000 项已加载媒体");
    fireEvent.change(screen.getByLabelText("图片分类"), { target: { value: "menu" } });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("list_media", {
        // Vitest asymmetric matcher intentionally accepts the command's untyped bridge payload.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        input: expect.objectContaining({ category: "menu", limit: 100 }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /photo-0\.jpg第二家/ }));
    await screen.findByRole("dialog", { name: "图片预览" });
    fireEvent.change(screen.getByLabelText("预览图片分类"), { target: { value: "menu" } });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("update_media_category", {
        input: { id: "m-0", category: "menu" },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "在地图中查看" }));
    expect(onOpenMap).toHaveBeenCalledWith({ restaurantId: "r-2", foodLogId: null });
    fireEvent.click(screen.getByRole("button", { name: "重置筛选" }));
    expect(screen.getByRole("combobox", { name: /^图片分类$/ })).toHaveValue("all");
    expect(screen.getByLabelText("餐厅筛选")).toHaveValue("all");
  });

  it("always shows import time, shows captured time when present, associates only the selected restaurant's logs, and removes media", async () => {
    render(<GalleryView />);
    await screen.findByText("5,000 项已加载媒体");
    fireEvent.click(screen.getByRole("button", { name: /photo-0\.jpg第二家/ }));
    await screen.findByRole("dialog", { name: "图片预览" });
    expect(screen.getByText(/导入时间：/)).toBeInTheDocument();
    expect(screen.getByText(/拍摄时间：/)).toBeInTheDocument();
    const association = await screen.findByLabelText("关联用餐记录");
    expect(screen.getByRole("option", { name: /午餐/ })).toHaveValue("log-1");
    fireEvent.change(association, { target: { value: "log-1" } });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("attach_media_to_log", {
        input: { id: "m-0", foodLogId: "log-1" },
      }),
    );
    fireEvent.change(association, { target: { value: "" } });
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("attach_media_to_log", {
        input: { id: "m-0", foodLogId: null },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "移至回收站" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("soft_delete_media", { input: { id: "m-0" } }));
    expect(screen.queryByRole("dialog", { name: "图片预览" })).not.toBeInTheDocument();
  });

  it("keeps import time visible when a photo has no captured timestamp", async () => {
    invoke.mockImplementation((command: string, args?: { input?: { restaurantId?: string } }) => {
      if (command === "app_bootstrap") return Promise.resolve({ localAssetOrigin: "http://local" });
      if (command === "list_restaurant_map") return Promise.resolve([{ id: "r-1", name: "第一家" }]);
      if (command === "list_media") {
        return Promise.resolve({ items: [{ ...items[1], capturedAtMs: null }], nextCursor: null });
      }
      if (command === "list_food_logs") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.resolve(args);
    });
    render(<GalleryView />);
    await screen.findByText("1 项已加载媒体");
    fireEvent.click(screen.getByRole("button", { name: /photo-1\.jpg第一家/ }));
    await screen.findByRole("dialog", { name: "图片预览" });
    expect(screen.getByText(/导入时间：/)).toBeInTheDocument();
    expect(screen.queryByText(/拍摄时间：/)).not.toBeInTheDocument();
  });

  it("uses the thumbnail poster and original URL for a video lightbox", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "app_bootstrap") return Promise.resolve({ localAssetOrigin: "http://local" });
      if (command === "list_restaurant_map") return Promise.resolve([videoItem.restaurant]);
      if (command === "list_media") return Promise.resolve({ items: [videoItem], nextCursor: null });
      if (command === "list_food_logs") return Promise.resolve({ items: [], nextCursor: null });
      return Promise.resolve();
    });
    render(<GalleryView />);

    const card = await screen.findByRole("button", { name: /clip\.mp4/ });
    expect(card.querySelector("img")?.getAttribute("src")).toContain("thumbnail/clip.jpg");
    expect(card.querySelector(".gallery-card__play")).toBeInTheDocument();
    fireEvent.click(card);
    const dialog = await screen.findByRole("dialog", { name: "视频预览" });
    const player = dialog.querySelector("video");
    expect(player).toHaveAttribute("controls");
    expect(player).toHaveAttribute("preload", "metadata");
    expect(player?.querySelector("source")).toHaveAttribute("src", "http://local/media/original/clip.mp4");
    expect(screen.getByRole("button", { name: "打开原视频" })).toBeInTheDocument();
  });
});
