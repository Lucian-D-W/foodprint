import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";
import { offlineRegionApi, type CachedRegion } from "../features/map/offlineRegionApi";
import { centerApi, type MapCenter } from "../features/map/centerApi";

vi.mock("../features/map/MapView", () => ({
  MapView: ({
    target,
    cachedRegions = [],
    regionTarget,
    openRegionSearch,
    theme,
    centers = [],
    centerTarget,
  }: {
    target?: { restaurantId: string; foodLogId: string | null } | null;
    cachedRegions?: CachedRegion[];
    regionTarget?: CachedRegion | null;
    openRegionSearch?: boolean;
    theme?: string;
    centers?: MapCenter[];
    centerTarget?: MapCenter | null;
  }) => (
    <div>
      <div>
        {target ? "地图定位 " + target.restaurantId + "/" + (target.foodLogId ?? "none") : "地图原型入口"}
      </div>
      <div data-testid="map-cached-regions">{cachedRegions.map((region) => region.id).join(",")}</div>
      {regionTarget && <div data-testid="map-region-target">{JSON.stringify(regionTarget)}</div>}
      {openRegionSearch && <div data-testid="map-region-search-open">地点搜索已打开</div>}
      <div data-testid="map-theme">{theme}</div>
      <div data-testid="map-centers">{centers.map((center) => center.id).join(",")}</div>
      {centerTarget && <div data-testid="map-center-target">{JSON.stringify(centerTarget)}</div>}
    </div>
  ),
}));
vi.mock("../features/media/GalleryView", () => ({
  GalleryView: ({
    onOpenMap,
  }: {
    onOpenMap?: (target: { restaurantId: string; foodLogId: string | null }) => void;
  }) => (
    <section>
      <h2>全部相册</h2>
      <button type="button" onClick={() => onOpenMap?.({ restaurantId: "r-1", foodLogId: "log-1" })}>
        打开图片地点
      </button>
    </section>
  ),
}));
vi.mock("../features/map/offlineRegionApi", () => ({
  offlineRegionApi: {
    list: vi.fn(),
    search: vi.fn(),
    reverse: vi.fn(),
    estimate: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  },
}));
vi.mock("../features/map/centerApi", () => ({
  centerApi: { list: vi.fn(), remove: vi.fn() },
}));
vi.mock("../features/map/centerLayers", () => ({
  centerIconUrl: vi.fn(() => "center-icon.png"),
}));

const cachedRegion: CachedRegion = {
  id: "region-zhujiang",
  label: "珠江新城",
  displayName: "珠江新城, 广州",
  locale: "zh",
  west: 113.31,
  south: 23.11,
  east: 113.37,
  north: 23.16,
  centerLongitude: 113.34,
  centerLatitude: 23.135,
  returnZoom: 14,
  tileMinZoom: 12,
  tileMaxZoom: 14,
  providerUrl: "https://tiles.openfreemap.org/planet",
  tileTemplate: "https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf",
  providerVersion: "2026.08",
  attribution: "OpenFreeMap",
  tileCount: 42,
  byteSize: 1024,
  status: "ready",
  createdAtMs: 1,
  updatedAtMs: 2,
};

function renderShell() {
  return render(<AppShell />);
}

describe("AppShell", () => {
  afterEach(cleanup);

  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    vi.mocked(offlineRegionApi.list).mockResolvedValue([]);
    vi.mocked(offlineRegionApi.remove).mockResolvedValue(true);
    vi.mocked(centerApi.list).mockResolvedValue([]);
    vi.clearAllMocks();
  });

  it("groups associated cache regions under one center and keeps unrelated regions", async () => {
    const center: MapCenter = {
      id: "center-home",
      name: "家",
      kind: "home",
      iconVariant: 1,
      mapIconScale: 1,
      longitude: 113.34,
      latitude: 23.135,
      cachedRegionIds: [cachedRegion.id],
      primaryRegionId: cachedRegion.id,
      createdAtMs: 1,
      updatedAtMs: 2,
    };
    vi.mocked(centerApi.list).mockResolvedValue([center]);
    vi.mocked(offlineRegionApi.list).mockResolvedValue([cachedRegion]);
    renderShell();

    const centerButton = await screen.findByRole("button", { name: /^家/ });
    expect(centerButton).toHaveAccessibleName("家");
    expect(screen.queryByText(/已归并|尚未缓存周边/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^珠江新城/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("map-center-target")).toHaveTextContent(JSON.stringify(center));
    fireEvent.click(centerButton);
    expect(screen.getByTestId("map-center-target")).toHaveTextContent(JSON.stringify(center));
  });

  it("opens the first real offline region automatically when no cached center is available", async () => {
    vi.mocked(offlineRegionApi.list).mockResolvedValue([cachedRegion]);
    renderShell();

    expect(await screen.findByTestId("map-region-target")).toHaveTextContent(JSON.stringify(cachedRegion));
  });

  it("restores the active offline entry when returning to the map", async () => {
    vi.mocked(offlineRegionApi.list).mockResolvedValue([cachedRegion]);
    renderShell();
    expect(await screen.findByTestId("map-region-target")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /设置\s*Settings/ }));
    fireEvent.click(screen.getByRole("button", { name: /地图\s*Map/ }));

    expect(screen.getByTestId("map-region-target")).toHaveTextContent(JSON.stringify(cachedRegion));
  });

  it("starts on the map view", () => {
    renderShell();
    expect(screen.getByText("地图原型入口")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /地图\s*Map/ })).toHaveAttribute("aria-current", "page");
  });

  it("switches between the global gallery and settings", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /相册\s*Gallery/ }));
    expect(screen.getByRole("heading", { name: "全部相册" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /设置\s*Settings/ }));
    expect(screen.getByRole("heading", { name: "数据与备份" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /地图\s*Map/ }));
    expect(screen.getByText("地图原型入口")).toBeInTheDocument();
  });

  it("applies and remembers one theme across the shell and map", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /设置\s*Settings/ }));
    fireEvent.click(screen.getByRole("radio", { name: /赛博朋克/ }));

    expect(document.documentElement).toHaveAttribute("data-theme", "cyberpunk");
    expect(window.localStorage.getItem("foodmap.visual-theme")).toBe("cyberpunk");

    fireEvent.click(screen.getByRole("button", { name: /地图\s*Map/ }));
    expect(screen.getByTestId("map-theme")).toHaveTextContent("cyberpunk");
  });

  it("carries Restaurant and FoodLog context from Gallery into Map", () => {
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: /相册\s*Gallery/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开图片地点" }));
    expect(screen.getByText("地图定位 r-1/log-1")).toBeInTheDocument();
  });

  it("loads cached regions below Map, opens search, targets the exact region, and deletes separately", async () => {
    vi.mocked(offlineRegionApi.list).mockResolvedValueOnce([cachedRegion]).mockResolvedValueOnce([]);
    renderShell();

    expect(await screen.findByRole("button", { name: /^珠江新城/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "搜索地点并定位" }));
    expect(screen.getByTestId("map-region-search-open")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /相册\s*Gallery/ }));
    fireEvent.click(screen.getByRole("button", { name: /地图\s*Map/ }));
    expect(screen.queryByTestId("map-region-search-open")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "搜索地点并定位" }));
    expect(screen.getByTestId("map-region-search-open")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^珠江新城/ }));
    expect(screen.getByTestId("map-region-target")).toHaveTextContent(JSON.stringify(cachedRegion));

    fireEvent.click(screen.getByRole("button", { name: "删除珠江新城" }));
    expect(offlineRegionApi.remove).toHaveBeenCalledWith(cachedRegion.id);
    expect(screen.getByTestId("map-region-target")).toHaveTextContent(JSON.stringify(cachedRegion));
    await screen.findByTestId("map-cached-regions");
    expect(screen.getByTestId("map-cached-regions")).toHaveTextContent("");
  });
});
