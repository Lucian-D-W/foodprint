import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restaurantApi, type Media } from "../restaurants/api";
import { MediaGrid, MediaImportButton } from "./MediaGrid";
import { dispatchMediaDrop } from "./mediaDropDispatcher";

const mocks = vi.hoisted(() => ({ open: vi.fn(), onDragDropEvent: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: mocks.onDragDropEvent }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue({ localAssetOrigin: "http://local" }),
}));

const photo: Media = {
  id: "media-1",
  restaurantId: "restaurant-1",
  foodLogId: null,
  category: "food",
  originalName: "lunch.jpg",
  mimeType: "image/jpeg",
  originalRelPath: "original/a.jpg",
  previewRelPath: "preview/a.jpg",
  thumbnailRelPath: "thumbnail/a.jpg",
  width: 800,
  height: 600,
  fileSizeBytes: 20,
  capturedAtMs: null,
  caption: null,
  createdAtMs: 1,
};

const video: Media = {
  ...photo,
  id: "media-video",
  category: "other",
  originalName: "dinner.mp4",
  mimeType: "video/mp4",
  originalRelPath: "original/video.mp4",
  previewRelPath: "preview/video.jpg",
  thumbnailRelPath: "thumbnail/video.jpg",
};

describe("MediaGrid", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
    Reflect.deleteProperty(window, "devicePixelRatio");
  });

  it("converts physical drop coordinates and routes each drop to exactly one matching zone", async () => {
    const unlisten = vi.fn();
    mocks.onDragDropEvent.mockResolvedValue(unlisten);
    const imported = vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({
      results: [],
    });
    render(
      <>
        <MediaImportButton restaurantId="restaurant-1" onImported={vi.fn()} />
        <MediaImportButton restaurantId="restaurant-1" foodLogId="log-1" onImported={vi.fn()} compact />
      </>,
    );

    await vi.waitFor(() => expect(mocks.onDragDropEvent).toHaveBeenCalledTimes(1));
    const zones = screen.getAllByLabelText("导入媒体");
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number) => (x === 10 ? zones[0] : zones[1]),
    });
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
    dispatchMediaDrop({ x: 20, y: 16 }, ["C:/images/gallery.jpg"]);
    dispatchMediaDrop({ x: 40, y: 16 }, ["C:/images/log.jpg"]);

    await vi.waitFor(() =>
      expect(imported).toHaveBeenNthCalledWith(1, {
        restaurantId: "restaurant-1",
        foodLogId: undefined,
        category: "food",
        paths: ["C:/images/gallery.jpg"],
      }),
    );
    expect(imported).toHaveBeenNthCalledWith(2, {
      restaurantId: "restaurant-1",
      foodLogId: "log-1",
      category: "food",
      paths: ["C:/images/log.jpg"],
    });
    expect(imported).toHaveBeenCalledTimes(2);
  });

  it("imports selected files with the chosen category and reports each result", async () => {
    mocks.open.mockResolvedValue(["C:/images/lunch.jpg"]);
    const imported = vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({
      results: [{ sourcePath: "C:/images/lunch.jpg", media: photo, error: null }],
    });
    render(<MediaImportButton restaurantId="restaurant-1" onImported={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "menu" } });
    fireEvent.click(screen.getByRole("button", { name: "选择图片或视频" }));
    expect(mocks.open).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: "图片与视频", extensions: ["jpg", "jpeg", "png", "webp", "mp4", "webm"] }],
    });

    await vi.waitFor(() =>
      expect(imported).toHaveBeenCalledWith(
        expect.objectContaining({
          restaurantId: "restaurant-1",
          category: "menu",
          paths: ["C:/images/lunch.jpg"],
        }),
      ),
    );
    expect(await screen.findByText("已导入")).toBeInTheDocument();
  });

  it("uses thumbnails in the grid and preview only inside the lightbox", async () => {
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({ items: [photo], nextCursor: null });
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    render(<MediaGrid restaurantId="restaurant-1" onMutation={vi.fn()} />);

    const card = await screen.findByRole("button", { name: "预览 lunch.jpg" });
    expect(card.querySelector("img")?.getAttribute("src")).toContain("thumbnail/a.jpg");
    fireEvent.click(card);
    expect((await screen.findByRole("dialog")).querySelector("img")?.getAttribute("src")).toContain(
      "preview/a.jpg",
    );
  });

  it("reports a duplicate with its existing media record", async () => {
    mocks.open.mockResolvedValue(["C:/images/lunch.jpg"]);
    vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({
      results: [
        {
          sourcePath: "C:/images/lunch.jpg",
          media: null,
          error: "duplicate",
          code: "DUPLICATE_MEDIA",
          existingMedia: photo,
        },
      ],
    });
    render(<MediaImportButton restaurantId="restaurant-1" onImported={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择图片或视频" }));

    expect(await screen.findByText("已存在：lunch.jpg")).toBeInTheDocument();
  });

  it("identifies when a duplicate belongs to another restaurant", async () => {
    mocks.open.mockResolvedValue(["C:/images/lunch.jpg"]);
    vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({
      results: [
        {
          sourcePath: "C:/images/lunch.jpg",
          media: null,
          error: "duplicate",
          code: "DUPLICATE_MEDIA",
          existingMedia: { ...photo, restaurantId: "restaurant-elsewhere" },
        },
      ],
    });
    render(<MediaImportButton restaurantId="restaurant-1" onImported={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择图片或视频" }));

    expect(await screen.findByText("其他餐厅已有相同媒体：lunch.jpg")).toBeInTheDocument();
  });

  it("shows each selected batch as processing or queued immediately", async () => {
    let finishFirst: ((result: { results: [] }) => void) | undefined;
    const first = new Promise<{ results: [] }>((resolve) => {
      finishFirst = resolve;
    });
    mocks.open.mockResolvedValueOnce(["C:/images/first.jpg"]).mockResolvedValueOnce(["C:/images/second.jpg"]);
    const imported = vi
      .spyOn(restaurantApi, "importMedia")
      .mockImplementationOnce(() => first)
      .mockResolvedValueOnce({
        results: [],
      });
    render(<MediaImportButton restaurantId="restaurant-1" onImported={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择图片或视频" }));
    await vi.waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "继续选择图片或视频" }));

    expect(await screen.findByText("正在导入…")).toBeInTheDocument();
    expect(await screen.findByText("排队等待导入…")).toBeInTheDocument();

    finishFirst?.({ results: [] });
    await vi.waitFor(() => expect(imported).toHaveBeenCalledTimes(2));
  });

  it("shows the six centered filters in order and aggregates environment categories", async () => {
    const environmentExterior = { ...photo, id: "media-exterior", category: "exterior" as const };
    const environmentCheckin = { ...photo, id: "media-checkin", category: "checkin" as const };
    const menu = { ...photo, id: "media-menu", category: "menu" as const };
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({
      items: [photo, menu, environmentExterior, environmentCheckin, video],
      nextCursor: null,
    });
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    render(<MediaGrid restaurantId="restaurant-1" onMutation={vi.fn()} />);

    const filters = await screen.findByRole("navigation", { name: "相册类型筛选" });
    expect([...filters.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "所有",
      "食物",
      "餐牌",
      "环境",
      "视频",
      "其他",
    ]);
    expect(filters).toHaveClass("media-section__filters");
    expect(filters.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "环境" }));
    expect(document.querySelectorAll(".media-card__preview")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "预览 dinner.mp4" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "视频" }));
    expect(document.querySelectorAll(".media-card__preview")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "预览 dinner.mp4" })).toBeInTheDocument();
  });

  it("uploads images directly into the selected category from an equal grid tile", async () => {
    mocks.open.mockResolvedValue(["C:/images/new-food.jpg"]);
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({ items: [photo], nextCursor: null });
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    const imported = vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({
      results: [{ sourcePath: "C:/images/new-food.jpg", media: photo, error: null }],
    });
    render(<MediaGrid restaurantId="restaurant-1" onMutation={vi.fn()} />);

    await screen.findByRole("button", { name: "预览 lunch.jpg" });
    expect(screen.queryByLabelText("分类")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /添加.*媒体/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "食物" }));
    const addTile = screen.getByRole("button", { name: "添加食物媒体" });
    expect(addTile.closest(".media-import--tile")).toHaveClass("media-card");
    expect(screen.queryByLabelText("分类")).not.toBeInTheDocument();
    fireEvent.click(addTile);

    expect(mocks.open).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp"] }],
    });
    await vi.waitFor(() =>
      expect(imported).toHaveBeenCalledWith({
        restaurantId: "restaurant-1",
        foodLogId: undefined,
        category: "food",
        paths: ["C:/images/new-food.jpg"],
      }),
    );
  });

  it("uses a video-only chooser from the video category tile", async () => {
    mocks.open.mockResolvedValue(["C:/videos/new.mp4"]);
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({ items: [video], nextCursor: null });
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    const imported = vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({
      results: [{ sourcePath: "C:/videos/new.mp4", media: video, error: null }],
    });
    render(<MediaGrid restaurantId="restaurant-1" onMutation={vi.fn()} />);

    await screen.findByRole("button", { name: "预览 dinner.mp4" });
    fireEvent.click(screen.getByRole("button", { name: "视频" }));
    fireEvent.click(screen.getByRole("button", { name: "添加视频媒体" }));

    expect(mocks.open).toHaveBeenCalledWith({
      multiple: true,
      filters: [{ name: "视频", extensions: ["mp4", "webm"] }],
    });
    await vi.waitFor(() =>
      expect(imported).toHaveBeenCalledWith({
        restaurantId: "restaurant-1",
        foodLogId: undefined,
        category: "other",
        paths: ["C:/videos/new.mp4"],
      }),
    );
  });

  it("rejects image drops on the video category tile", async () => {
    const unlisten = vi.fn();
    mocks.onDragDropEvent.mockResolvedValue(unlisten);
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({ items: [video], nextCursor: null });
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    const imported = vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({ results: [] });
    render(<MediaGrid restaurantId="restaurant-1" onMutation={vi.fn()} />);

    await screen.findByRole("button", { name: "预览 dinner.mp4" });
    fireEvent.click(screen.getByRole("button", { name: "视频" }));
    const addButton = screen.getByRole("button", { name: "添加视频媒体" });
    const dropZone = addButton.closest<HTMLElement>("[data-media-drop-zone]");
    expect(dropZone).not.toBeNull();
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => dropZone,
    });
    dispatchMediaDrop({ x: 10, y: 10 }, ["C:/images/wrong.jpg"]);

    expect(await screen.findByRole("alert")).toHaveTextContent("视频分类只接受 MP4 或 WebM 文件");
    expect(imported).not.toHaveBeenCalled();
  });

  it("deletes a thumbnail from its top-right remove control", async () => {
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({ items: [photo], nextCursor: null });
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    const removed = vi.spyOn(restaurantApi, "softDeleteMedia").mockResolvedValue(undefined);
    const onMutation = vi.fn();
    render(<MediaGrid restaurantId="restaurant-1" onMutation={onMutation} />);

    await screen.findByRole("button", { name: "预览 lunch.jpg" });
    const removeButton = screen.getByRole("button", { name: "删除 lunch.jpg" });
    expect(removeButton).toHaveClass("media-card__remove");
    fireEvent.click(removeButton);

    await vi.waitFor(() => expect(removed).toHaveBeenCalledWith("media-1"));
    await vi.waitFor(() =>
      expect(screen.queryByRole("button", { name: "预览 lunch.jpg" })).not.toBeInTheDocument(),
    );
    expect(onMutation).toHaveBeenCalledTimes(1);
  });

  it("uses a poster and native original video in the lightbox", async () => {
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({ items: [video], nextCursor: null });
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    render(<MediaGrid restaurantId="restaurant-1" onMutation={vi.fn()} />);

    const card = await screen.findByRole("button", { name: "预览 dinner.mp4" });
    expect(card.querySelector("img")?.getAttribute("src")).toContain("thumbnail/video.jpg");
    expect(card.querySelector(".media-card__play")).toBeInTheDocument();
    fireEvent.click(card);
    const dialog = await screen.findByRole("dialog", { name: "视频预览" });
    const player = dialog.querySelector("video");
    expect(player).toHaveAttribute("controls");
    expect(player).toHaveAttribute("preload", "metadata");
    expect(player?.querySelector("source")).toHaveAttribute("src", "http://local/media/original/video.mp4");
    expect(screen.getByRole("button", { name: "打开原视频" })).toBeInTheDocument();
  });
});
