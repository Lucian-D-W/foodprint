import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import "../../styles/components.css";
import { DetailPanel, MapView, CreatePanel } from "./MapView";
import { createLocalMap } from "./localMap";
import { foodFeatureId, installFoodLayers } from "./foodLayers";
import { installCenterLayers } from "./centerLayers";
import { centerApi, type MapCenter } from "./centerApi";
import { restaurantApi } from "../restaurants/api";
import {
  boundsContain,
  isQualifiedViewport,
  offlineRegionApi,
  type GeocodedPlace,
  type RegionEstimate,
} from "./offlineRegionApi";

vi.mock("../restaurants/api", () => ({
  restaurantApi: {
    listMap: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    manifest: vi
      .fn()
      .mockResolvedValue({ cuisines: [], foodIconBaseUrl: "http://127.0.0.1/assets/food-icons" }),
    listTags: vi.fn().mockResolvedValue([]),
    setPositionLocked: vi.fn(),
    move: vi.fn(),
  },
}));

vi.mock("./foodLayers", () => ({
  FOOD_SYMBOL_LAYER: "food-symbol-layer",
  foodFeatureId: vi.fn(),
  installFoodLayers: vi.fn(),
}));

vi.mock("./centerLayers", () => ({
  CENTER_SYMBOL_LAYER: "center-symbol-layer",
  centerFeatureId: vi.fn((feature: { properties?: { id?: string } }) => feature.properties?.id ?? null),
  centerIconUrl: vi.fn(() => "center-icon.png"),
  installCenterLayers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./centerApi", () => ({
  CENTER_KINDS: ["home", "company", "school"],
  CENTER_KIND_LABELS: { home: "家", company: "公司", school: "学校" },
  centerApi: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    attachRegion: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock("./localMap", () => ({
  MAP_VIEW_MAX_ZOOM: 19,
  createLocalMap: vi.fn(),
  saveView: vi.fn(),
  activateCachedRegion: vi.fn(),
}));

vi.mock("./offlineRegionApi", () => ({
  offlineRegionApi: {
    list: vi.fn(),
    search: vi.fn(),
    reverse: vi.fn(),
    estimate: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
  },
  boundsContain: vi.fn(),
  formatByteEstimate: (bytes: number) => String(bytes) + " B",
  isQualifiedViewport: vi.fn(),
  regionBounds: vi.fn(),
}));

vi.mock("../food-logs/FoodLogSection", () => ({
  FoodLogSection: () => <div data-testid="food-log-section" />,
}));

vi.mock("../media/MediaGrid", () => ({
  MediaGrid: () => <div data-testid="media-grid" />,
}));

type MapHandler = (...args: unknown[]) => void;

type FakeMapOptions = {
  bounds?: { west: number; south: number; east: number; north: number };
  center?: { lng: number; lat: number };
  zoom?: number;
};

function createFakeMap(options: FakeMapOptions = {}) {
  const handlers = new Map<string, MapHandler[]>();
  const canvas = { style: { cursor: "" } };
  let center = options.center ?? { lng: 113.3, lat: 23.1 };
  let zoom = options.zoom ?? 14;
  let bounds = options.bounds ?? { west: 113.26, south: 23.06, east: 113.34, north: 23.11 };
  let dragPanEnabled = true;
  const dragPan = {
    disable: vi.fn(() => {
      dragPanEnabled = false;
    }),
    enable: vi.fn(() => {
      dragPanEnabled = true;
    }),
    isEnabled: vi.fn(() => dragPanEnabled),
  };
  const addHandler = (event: string, handler: MapHandler | undefined, layer?: string) => {
    if (!handler) return;
    const key = layer ? `${event}:${layer}` : event;
    handlers.set(key, [...(handlers.get(key) ?? []), handler]);
  };
  const map = {
    on: vi.fn((event: string, layerOrHandler: string | MapHandler, maybeHandler?: MapHandler) => {
      if (typeof layerOrHandler === "string") addHandler(event, maybeHandler, layerOrHandler);
      else addHandler(event, layerOrHandler);
    }),
    once: vi.fn((event: string, handler: MapHandler) => {
      addHandler(event, handler);
    }),
    remove: vi.fn(),
    getCenter: vi.fn(() => center),
    getZoom: vi.fn(() => zoom),
    getBounds: vi.fn(() => ({
      getWest: () => bounds.west,
      getSouth: () => bounds.south,
      getEast: () => bounds.east,
      getNorth: () => bounds.north,
    })),
    getStyle: vi.fn(() => ({ version: 8, sources: {}, layers: [] })),
    setStyle: vi.fn(),
    flyTo: vi.fn((next: { center: [number, number]; zoom: number }) => {
      center = { lng: next.center[0], lat: next.center[1] };
      zoom = next.zoom;
    }),
    jumpTo: vi.fn(),
    getCanvas: vi.fn(() => canvas),
    dragPan,
  };
  return {
    map,
    canvas,
    dragPan,
    setViewport(next: FakeMapOptions) {
      if (next.center) center = next.center;
      if (next.zoom !== undefined) zoom = next.zoom;
      if (next.bounds) bounds = next.bounds;
    },
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.forEach((handler) => handler(...args));
      handlers.get(`${event}:food-symbol-layer`)?.forEach((handler) => handler(...args));
    },
    emitLayer(event: string, layer: string, ...args: unknown[]) {
      handlers.get(`${event}:${layer}`)?.forEach((handler) => handler(...args));
    },
  };
}

type MapViewProps = Parameters<typeof MapView>[0];

async function renderMap(positionLocked = false, props: Partial<MapViewProps> = {}) {
  const fakeMap = createFakeMap();
  vi.mocked(createLocalMap).mockResolvedValue({
    map: fakeMap.map as never,
    restaurantPositionLocked: positionLocked,
  });
  function Harness() {
    const [searchOpen, setSearchOpen] = useState(props.openRegionSearch ?? false);
    return (
      <MapView
        {...props}
        openRegionSearch={searchOpen}
        onRegionSearchHandled={() => {
          setSearchOpen(false);
          props.onRegionSearchHandled?.();
        }}
      />
    );
  }
  render(<Harness />);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return fakeMap;
}

const placeResult: GeocodedPlace = {
  displayName: "珠江新城, 广州",
  latitude: 23.135,
  longitude: 113.34,
  placeType: "suburb",
  category: "place",
};

const regionEstimate: RegionEstimate = {
  bounds: { west: 113.26, south: 23.06, east: 113.34, north: 23.11 },
  centerLongitude: 113.3,
  centerLatitude: 23.1,
  returnZoom: 14,
  tileMinZoom: 12,
  tileMaxZoom: 14,
  tileCount: 42,
  estimatedBytes: 42 * 64 * 1024,
  providerUrl: "https://tiles.openfreemap.org/planet",
  tileTemplate: "https://tiles.openfreemap.org/planet/{z}/{x}/{y}.pbf",
  providerVersion: "2026.08",
  attribution: "OpenFreeMap",
};

const cuisineDefinitions = [
  ["dimsum_dumpling", "点心饺子"],
  ["burger", "汉堡"],
  ["pasta_pizza", "意面披萨"],
  ["buns", "包子"],
  ["fast_meal", "快餐便当"],
  ["rice_noodles", "米粉面馆"],
  ["malatang", "麻辣烫"],
  ["sichuan_hunan", "川湘菜馆"],
  ["cantonese", "粤菜"],
  ["jinghu_lu", "京沪鲁菜"],
  ["fried_chicken", "炸鸡"],
  ["snacks", "小吃"],
  ["braised_duck", "鸭脖卤味"],
  ["japanese", "日式料理"],
  ["korean", "韩式料理"],
  ["dry_pot", "香锅"],
  ["hotpot", "火锅"],
  ["lobster_bbq", "龙虾烧烤"],
  ["salad", "沙拉"],
  ["milk_tea_juice", "奶茶果汁"],
  ["coffee", "咖啡"],
  ["bakery_pastry", "面包糕点"],
  ["dessert", "甜品"],
  ["south_asian", "南亚菜系"],
  ["southeast_asian", "东南亚菜系"],
] as const;
const cuisines = cuisineDefinitions.map(([key, label]) => ({
  key,
  label,
  icons: [1, 2, 3].map((variant) => ({
    key: `${key}.shop.${String(variant).padStart(2, "0")}`,
    src: `${key}/${key}-shop-${String(variant).padStart(2, "0")}.png`,
  })),
}));

const detailRestaurant = {
  id: "r-1",
  name: "测试店",
  longitude: 113.3,
  latitude: 23.1,
  cuisineKey: "coffee",
  iconKey: "coffee.shop.01",
  phone: null,
  openingHoursText: null,
  addressNote: null,
  overallRating: 4,
  visitStatus: "visited" as const,
  affectionStatus: "like" as const,
  isBookmarked: false,
  mapIconScale: 1,
  positionLocked: false,
  logCount: 2,
  tags: [],
};

describe("DetailPanel semantic zones and map icon scale", () => {
  afterEach(cleanup);

  it("renders Figure 5 as a left red column and a green-over-blue right stack", () => {
    const onSave = vi.fn();
    const view = render(
      <DetailPanel
        restaurant={detailRestaurant}
        cuisines={cuisines}
        tags={[]}
        onClose={vi.fn()}
        onStatus={vi.fn()}
        onProfile={onSave}
        onMapIconScalePreview={vi.fn()}
        onDelete={vi.fn()}
        onTags={vi.fn().mockResolvedValue(undefined)}
        onLogMutation={vi.fn()}
        focusedFoodLogId={null}
      />,
    );

    const panel = view.container.querySelector<HTMLElement>(".detail-panel");
    const red = view.container.querySelector<HTMLElement>('[data-detail-zone="red"]');
    const right = view.container.querySelector<HTMLElement>('[data-detail-column="right"]');
    expect(panel).not.toBeNull();
    expect(red).not.toBeNull();
    expect(right).not.toBeNull();
    const panelStyle = getComputedStyle(panel!);
    expect(panelStyle.width).toBe("75%");
    expect(panelStyle.maxWidth).toBe("1440px");
    expect(panelStyle.gridTemplateColumns).toBe("minmax(180px, 220px) minmax(0, 1fr)");
    expect(panelStyle.overflow).toBe("hidden");
    expect(getComputedStyle(red!).overflow).toBe("auto");
    expect([...panel!.children]).toEqual([expect.any(HTMLButtonElement), red, right]);
    expect([...right!.children].map((zone) => (zone as HTMLElement).dataset.detailZone)).toEqual([
      "green",
      "blue",
    ]);
    expect(
      view.container.querySelector('[data-detail-zone="red"] [aria-label="总体评分"]'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toHaveValue("测试店");
    expect(screen.getByTestId("food-log-section")).toBeInTheDocument();
    expect(screen.getByTestId("media-grid")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /调整地图位置|完成位置调整/ })).not.toBeInTheDocument();
  });

  it("previews slider changes and autosaves the selected scale", async () => {
    const onSave = vi.fn();
    const onPreview = vi.fn();
    const onIconPreview = vi.fn();
    render(
      <DetailPanel
        restaurant={detailRestaurant}
        cuisines={cuisines}
        tags={[]}
        onClose={vi.fn()}
        onStatus={vi.fn()}
        onProfile={onSave}
        onMapIconScalePreview={onPreview}
        onMapIconPreview={onIconPreview}
        onDelete={vi.fn()}
        onTags={vi.fn().mockResolvedValue(undefined)}
        onLogMutation={vi.fn()}
        focusedFoodLogId={null}
      />,
    );

    const slider = screen.getByRole("slider", { name: "地图图标大小" });
    const selectedIcon = screen.getByRole("radio", { name: "咖啡图标 1" });
    const iconCard = selectedIcon.closest<HTMLElement>(".icon-option");
    expect(iconCard).toHaveAttribute("data-selected", "true");
    expect(getComputedStyle(iconCard!).aspectRatio).toBe("1 / 1");
    expect(getComputedStyle(selectedIcon).position).toBe("absolute");
    expect(getComputedStyle(selectedIcon).opacity).toBe("0");
    expect(iconCard?.parentElement?.parentElement?.nextElementSibling).toBe(slider.closest("label"));
    fireEvent.click(screen.getByTitle("咖啡图标 2"));
    expect(screen.getByRole("radio", { name: "咖啡图标 2" })).toBeChecked();
    expect(onIconPreview).toHaveBeenCalledWith("coffee", "coffee.shop.02");
    expect(slider).toHaveValue("1");
    fireEvent.change(slider, { target: { value: "1.25" } });
    expect(onPreview).toHaveBeenCalledWith(1.25);
    expect(screen.getByText("1.25×")).toBeInTheDocument();
    fireEvent.blur(slider);
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ mapIconScale: 1.25 }));
    });
    expect(screen.queryByRole("button", { name: "保存资料" })).not.toBeInTheDocument();
  });

  it("shows compact contact fields immediately and autosaves each completed edit", async () => {
    const onProfile = vi.fn().mockResolvedValue(undefined);
    const onStatus = vi.fn();
    const view = render(
      <DetailPanel
        restaurant={detailRestaurant}
        cuisines={cuisines}
        tags={[]}
        onClose={vi.fn()}
        onStatus={onStatus}
        onProfile={onProfile}
        onMapIconScalePreview={vi.fn()}
        onDelete={vi.fn()}
        onTags={vi.fn().mockResolvedValue(undefined)}
        onLogMutation={vi.fn()}
        focusedFoodLogId={null}
      />,
    );

    const contactFields = screen.getByRole("group", { name: "联系信息" });
    expect(screen.getByLabelText("电话")).toBeVisible();
    expect(screen.getByLabelText("营业时间")).toBeVisible();
    expect(screen.getByLabelText("地址备注")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /补充联系信息|收起联系信息|保存资料/ }),
    ).not.toBeInTheDocument();
    expect(getComputedStyle(contactFields).gridTemplateColumns).toContain("repeat(2");
    expect(
      getComputedStyle(view.container.querySelector<HTMLElement>('[data-detail-zone="red"]')!).fontSize,
    ).toBe("12px");

    const phone = screen.getByLabelText("电话");
    fireEvent.change(phone, { target: { value: "020-12345678" } });
    fireEvent.blur(phone);
    await waitFor(() => {
      expect(onProfile).toHaveBeenCalledWith(expect.objectContaining({ phone: "020-12345678" }));
    });
    fireEvent.blur(phone);
    await act(async () => Promise.resolve());
    expect(onProfile).toHaveBeenCalledTimes(1);

    expect(screen.getByRole("group", { name: "总体评分" })).toBeInTheDocument();
    expect(screen.queryByText(/\/ 5/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "5 星" }));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ overallRating: 5 }));
  });

  it("flushes an unfinished contact edit when the detail panel is left", async () => {
    const onProfile = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <DetailPanel
        restaurant={detailRestaurant}
        cuisines={cuisines}
        tags={[]}
        onClose={vi.fn()}
        onStatus={vi.fn()}
        onProfile={onProfile}
        onMapIconScalePreview={vi.fn()}
        onDelete={vi.fn()}
        onTags={vi.fn().mockResolvedValue(undefined)}
        onLogMutation={vi.fn()}
        focusedFoodLogId={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("营业时间"), { target: { value: "09:00-21:00" } });
    view.unmount();
    await waitFor(() => {
      expect(onProfile).toHaveBeenCalledWith(expect.objectContaining({ openingHoursText: "09:00-21:00" }));
    });
  });

  it("removes the empty More Information affordance without hiding useful fields", () => {
    render(
      <DetailPanel
        restaurant={detailRestaurant}
        cuisines={cuisines}
        tags={[]}
        onClose={vi.fn()}
        onStatus={vi.fn()}
        onProfile={vi.fn()}
        onMapIconScalePreview={vi.fn()}
        onDelete={vi.fn()}
        onTags={vi.fn().mockResolvedValue(undefined)}
        onLogMutation={vi.fn()}
        focusedFoodLogId={null}
      />,
    );

    expect(screen.queryByRole("button", { name: /更多信息|收起更多信息/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("名称")).toBeVisible();
    expect(screen.getByLabelText("菜式")).toBeVisible();
    expect(screen.getByRole("group", { name: "图标" })).toBeVisible();
    expect(screen.getByRole("group", { name: "联系信息" })).toBeVisible();
    expect(screen.getByRole("group", { name: "总体评分" })).toBeVisible();
    expect(screen.getByLabelText("去过状态")).toBeVisible();
    expect(screen.getByLabelText("喜爱度")).toBeVisible();
    expect(screen.getByRole("button", { name: "★ 加入收藏" })).toBeVisible();
    expect(screen.getByText("标签")).toBeVisible();
  });

  it("places the per-restaurant position lock between tags and trash and saves immediately", () => {
    const onPositionLock = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <DetailPanel
        restaurant={detailRestaurant}
        cuisines={cuisines}
        tags={[]}
        onClose={vi.fn()}
        onStatus={vi.fn()}
        onPositionLock={onPositionLock}
        onProfile={vi.fn()}
        onMapIconScalePreview={vi.fn()}
        onDelete={vi.fn()}
        onTags={vi.fn().mockResolvedValue(undefined)}
        onLogMutation={vi.fn()}
        focusedFoodLogId={null}
      />,
    );

    const tags = view.container.querySelector(".tag-editor");
    const lock = screen.getByRole("checkbox", { name: "锁定这家餐厅的位置" });
    const trash = screen.getByRole("button", { name: "移至回收站" });
    expect(tags?.nextElementSibling).toBe(lock.closest("label"));
    expect(lock.closest("label")?.nextElementSibling).toBe(trash);
    fireEvent.click(lock);
    expect(onPositionLock).toHaveBeenCalledWith(true);
  });
});

describe("CreatePanel", () => {
  afterEach(cleanup);

  it("requires a name before creating", () => {
    const onSave = vi.fn();
    render(
      <CreatePanel
        cuisines={cuisines}
        location={{ longitude: 113.3, latitude: 23.1 }}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "创建地点" }));

    expect(onSave).not.toHaveBeenCalled();
  });

  it("switches to the first compatible icon when cuisine changes", () => {
    const onSave = vi.fn();
    const view = render(
      <CreatePanel
        cuisines={cuisines}
        location={{ longitude: 113.3, latitude: 23.1 }}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    fireEvent.change(view.getByLabelText("菜式"), { target: { value: "rice_noodles" } });
    fireEvent.change(view.getByLabelText("名称"), { target: { value: "牛肉面" } });
    fireEvent.click(view.getByRole("button", { name: "创建地点" }));

    expect(onSave).toHaveBeenCalledWith({
      name: "牛肉面",
      cuisineKey: "rice_noodles",
      iconKey: "rice_noodles.shop.01",
    });
  });
});

describe("local cuisine icon choices", () => {
  afterEach(cleanup);

  it("renders the exact ordered cuisine taxonomy and local icon images", () => {
    const view = render(
      <CreatePanel
        cuisines={cuisines}
        foodIconBaseUrl="http://127.0.0.1/assets/food-icons"
        location={{ longitude: 113.3, latitude: 23.1 }}
        onCancel={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    const cuisineSelect = view.getByLabelText("菜式") as HTMLSelectElement;
    expect([...cuisineSelect.options].map((option) => [option.value, option.textContent])).toEqual(
      cuisineDefinitions.map(([key, label]) => [key, label]),
    );

    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual([
      "点心饺子图标 1",
      "点心饺子图标 2",
      "点心饺子图标 3",
    ]);
    expect(radios[0]).toBeChecked();
    expect(screen.queryByText("01")).not.toBeInTheDocument();
    expect(screen.queryByText("dimsum_dumpling.shop.01")).not.toBeInTheDocument();

    expect([...view.container.querySelectorAll<HTMLImageElement>("img")].map((image) => image.src)).toEqual([
      "http://127.0.0.1/assets/food-icons/dimsum_dumpling/dimsum_dumpling-shop-01.png",
      "http://127.0.0.1/assets/food-icons/dimsum_dumpling/dimsum_dumpling-shop-02.png",
      "http://127.0.0.1/assets/food-icons/dimsum_dumpling/dimsum_dumpling-shop-03.png",
    ]);

    fireEvent.click(radios[1]);
    expect(radios[1]).toBeChecked();
    expect(radios[0]).not.toBeChecked();
  });

  it("previews and autosaves profile cuisine and icon changes immediately", async () => {
    const onPreview = vi.fn();
    const onProfile = vi.fn();
    const view = render(
      <DetailPanel
        restaurant={detailRestaurant}
        cuisines={cuisines}
        foodIconBaseUrl="http://127.0.0.1/assets/food-icons"
        tags={[]}
        onClose={vi.fn()}
        onStatus={vi.fn()}
        onProfile={onProfile}
        onMapIconScalePreview={vi.fn()}
        onMapIconPreview={onPreview}
        onDelete={vi.fn()}
        onTags={vi.fn().mockResolvedValue(undefined)}
        onLogMutation={vi.fn()}
        focusedFoodLogId={null}
      />,
    );

    const profileSelect = view.container.querySelector(".profile-editor select") as HTMLSelectElement;
    fireEvent.change(profileSelect, { target: { value: "burger" } });
    expect(onPreview).toHaveBeenLastCalledWith("burger", "burger.shop.01");

    const profileRadios = view.container.querySelectorAll<HTMLInputElement>(
      '.profile-editor input[type="radio"]',
    );
    expect(profileRadios).toHaveLength(3);
    expect(profileRadios[0]).toBeChecked();
    fireEvent.click(profileRadios[1]);
    expect(onPreview).toHaveBeenLastCalledWith("burger", "burger.shop.02");
    await waitFor(() => {
      expect(onProfile).toHaveBeenCalledWith(
        expect.objectContaining({ cuisineKey: "burger", iconKey: "burger.shop.02" }),
      );
    });
    expect(screen.queryByRole("button", { name: "保存资料" })).not.toBeInTheDocument();
  });
});

describe("MapView intro card", () => {
  beforeEach(() => {
    vi.mocked(createLocalMap).mockImplementation(() => new Promise<never>(() => {}));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("is visible when the map view mounts", () => {
    vi.useFakeTimers();
    render(<MapView />);

    expect(screen.getByRole("region", { name: "Map description" })).toBeInTheDocument();
  });

  it("uses a neutral initial title instead of the development test location", () => {
    render(<MapView />);

    expect(screen.getByRole("heading", { name: "本地地图" })).toBeInTheDocument();
    expect(screen.queryByText(/珠江新城 · Zhujiang New Town/)).not.toBeInTheDocument();
  });

  it("does not start fading before four seconds", () => {
    vi.useFakeTimers();
    render(<MapView />);
    const introCard = screen.getByRole("region", { name: "Map description" });

    void act(() => vi.advanceTimersByTime(3999));

    expect(introCard).not.toHaveAttribute("data-fading");
    expect(introCard).toBeInTheDocument();
  });

  it("starts fading at four seconds", () => {
    vi.useFakeTimers();
    render(<MapView />);
    const introCard = screen.getByRole("region", { name: "Map description" });

    void act(() => vi.advanceTimersByTime(4000));

    expect(introCard).toHaveAttribute("data-fading", "true");
  });

  it("removes the card after its fade transition", () => {
    vi.useFakeTimers();
    render(<MapView />);

    void act(() => vi.advanceTimersByTime(4000));
    void act(() => vi.advanceTimersByTime(220));

    expect(screen.queryByRole("region", { name: "Map description" })).not.toBeInTheDocument();
  });

  it("cleans up its timers when the map view unmounts", () => {
    vi.useFakeTimers();
    const view = render(<MapView />);

    view.unmount();
    void act(() => vi.advanceTimersByTime(5000));

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("MapView offline region feedback", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("lets the parent close and reopen place search after the map has mounted", async () => {
    const fakeMap = createFakeMap();
    vi.mocked(createLocalMap).mockResolvedValue({
      map: fakeMap.map as never,
      restaurantPositionLocked: false,
    });
    const onClose = vi.fn();
    const view = render(<MapView onRegionSearchHandled={onClose} />);
    await act(async () => {
      await Promise.resolve();
    });

    view.rerender(<MapView openRegionSearch onRegionSearchHandled={onClose} />);
    expect(screen.getByRole("heading", { name: "搜索地点" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭地点搜索" }));
    expect(onClose).toHaveBeenCalledOnce();

    view.rerender(<MapView openRegionSearch={false} onRegionSearchHandled={onClose} />);
    expect(screen.queryByRole("heading", { name: "搜索地点" })).not.toBeInTheDocument();
    view.rerender(<MapView openRegionSearch onRegionSearchHandled={onClose} />);
    expect(screen.getByRole("heading", { name: "搜索地点" })).toBeInTheDocument();
  });

  it("flies to one returned place, closes search, and proposes its settled viewport", async () => {
    vi.useFakeTimers();
    vi.mocked(isQualifiedViewport).mockReturnValue(true);
    vi.mocked(boundsContain).mockReturnValue(false);
    vi.mocked(offlineRegionApi.search).mockResolvedValue([placeResult]);
    vi.mocked(offlineRegionApi.reverse).mockResolvedValue(placeResult);
    vi.mocked(offlineRegionApi.estimate).mockResolvedValue(regionEstimate);
    const fakeMap = await renderMap(false, { openRegionSearch: true });

    fireEvent.change(screen.getByLabelText("地点"), { target: { value: "珠江新城" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /珠江新城, 广州/ }));

    expect(fakeMap.map.flyTo).toHaveBeenCalledWith({ center: [113.34, 23.135], zoom: 14 });
    expect(screen.queryByRole("heading", { name: "搜索地点" })).not.toBeInTheDocument();

    act(() => fakeMap.emit("moveend"));
    await act(async () => {
      vi.advanceTimersByTime(900);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(offlineRegionApi.reverse).toHaveBeenCalledWith(113.34, 23.135);
    expect(screen.getByRole("heading", { name: "缓存此处周边" })).toBeInTheDocument();
  });

  it("explains when a returned place is clicked before the map is ready", async () => {
    vi.mocked(createLocalMap).mockImplementation(() => new Promise<never>(() => {}));
    vi.mocked(offlineRegionApi.search).mockResolvedValue([placeResult]);
    render(<MapView openRegionSearch />);

    fireEvent.change(screen.getByLabelText("地点"), { target: { value: "珠江新城" } });
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: /珠江新城, 广州/ }));

    expect(screen.getByRole("status")).toHaveTextContent("地图尚未就绪，请稍后再试");
    expect(screen.getByRole("heading", { name: "搜索地点" })).toBeInTheDocument();
  });

  it("offers a qualified settled viewport, creates only after explicit confirmation, and refreshes regions", async () => {
    vi.useFakeTimers();
    vi.mocked(isQualifiedViewport).mockReturnValue(true);
    vi.mocked(boundsContain).mockReturnValue(false);
    vi.mocked(offlineRegionApi.reverse).mockResolvedValue(placeResult);
    vi.mocked(offlineRegionApi.estimate).mockResolvedValue(regionEstimate);
    vi.mocked(offlineRegionApi.create).mockResolvedValue({} as never);
    const onRegionsChanged = vi.fn().mockResolvedValue(undefined);
    const fakeMap = await renderMap(false, { onRegionsChanged });

    act(() => fakeMap.emit("moveend"));
    await act(async () => {
      vi.advanceTimersByTime(900);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(offlineRegionApi.reverse).toHaveBeenCalledWith(113.3, 23.1);
    expect(offlineRegionApi.estimate).toHaveBeenCalledWith({
      bounds: regionEstimate.bounds,
      centerLongitude: 113.3,
      centerLatitude: 23.1,
      returnZoom: 14,
    });
    expect(screen.getByRole("heading", { name: "缓存此处周边" })).toBeInTheDocument();
    expect(offlineRegionApi.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "缓存此处周边" }));
    expect(offlineRegionApi.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ...regionEstimate,
        label: "珠江新城",
        displayName: placeResult.displayName,
        locale: "zh",
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onRegionsChanged).toHaveBeenCalledTimes(1);
  });

  it("suppresses the cache proposal for a broad viewport", async () => {
    vi.useFakeTimers();
    vi.mocked(isQualifiedViewport).mockReturnValue(false);
    const fakeMap = await renderMap();

    act(() => fakeMap.emit("moveend"));
    await act(async () => {
      vi.advanceTimersByTime(900);
      await Promise.resolve();
    });

    expect(offlineRegionApi.reverse).not.toHaveBeenCalled();
    expect(offlineRegionApi.estimate).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "缓存此处周边" })).not.toBeInTheDocument();
  });

  it("searches only after submit and keeps a created proposal immutable after a later move", async () => {
    vi.useFakeTimers();
    vi.mocked(isQualifiedViewport).mockReturnValue(true);
    vi.mocked(boundsContain).mockReturnValue(false);
    vi.mocked(offlineRegionApi.reverse).mockResolvedValue(placeResult);
    vi.mocked(offlineRegionApi.estimate).mockResolvedValue(regionEstimate);
    vi.mocked(offlineRegionApi.search).mockResolvedValue([placeResult]);
    vi.mocked(offlineRegionApi.create).mockResolvedValue({} as never);
    const fakeMap = await renderMap(false, { openRegionSearch: true });

    fireEvent.change(screen.getByLabelText("地点"), { target: { value: "Guangzhou" } });
    expect(offlineRegionApi.search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(offlineRegionApi.search).toHaveBeenCalledWith("Guangzhou");

    act(() => fakeMap.emit("moveend"));
    await act(async () => {
      vi.advanceTimersByTime(900);
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "缓存此处周边" }));
    const submitted = vi.mocked(offlineRegionApi.create).mock.calls[0]?.[0];
    expect(submitted).toEqual(
      expect.objectContaining({
        bounds: regionEstimate.bounds,
        centerLongitude: regionEstimate.centerLongitude,
        centerLatitude: regionEstimate.centerLatitude,
        returnZoom: regionEstimate.returnZoom,
        tileMinZoom: regionEstimate.tileMinZoom,
        tileMaxZoom: regionEstimate.tileMaxZoom,
      }),
    );

    fakeMap.setViewport({
      center: { lng: 113.5, lat: 23.3 },
      zoom: 15,
      bounds: { west: 113.46, south: 23.26, east: 113.54, north: 23.34 },
    });
    act(() => fakeMap.emit("moveend"));
    expect(submitted).toEqual(
      expect.objectContaining({
        bounds: regionEstimate.bounds,
        centerLongitude: regionEstimate.centerLongitude,
        centerLatitude: regionEstimate.centerLatitude,
        returnZoom: regionEstimate.returnZoom,
        tileMinZoom: regionEstimate.tileMinZoom,
        tileMaxZoom: regionEstimate.tileMaxZoom,
      }),
    );
  });
});

describe("MapView direct restaurant dragging", () => {
  beforeEach(() => {
    vi.mocked(createLocalMap).mockImplementation(() => new Promise<never>(() => {}));
    vi.mocked(restaurantApi.listMap).mockResolvedValue([detailRestaurant]);
    vi.mocked(restaurantApi.manifest).mockResolvedValue({
      cuisines,
      foodIconBaseUrl: "http://127.0.0.1/assets/food-icons",
    });
    vi.mocked(restaurantApi.listTags).mockResolvedValue([]);
    vi.mocked(restaurantApi.get).mockResolvedValue(detailRestaurant);
    vi.mocked(foodFeatureId).mockReturnValue(detailRestaurant.id);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  function markerEvent(
    longitude = detailRestaurant.longitude,
    latitude = detailRestaurant.latitude,
    point = { x: 100, y: 100 },
  ) {
    return {
      features: [{ properties: { id: detailRestaurant.id } }],
      lngLat: { lng: longitude, lat: latitude },
      point,
      originalEvent: { button: 0 },
      preventDefault: vi.fn(),
    };
  }

  it("shows a grab affordance and previews a direct drag before saving once", async () => {
    const updated = { ...detailRestaurant, longitude: 113.42, latitude: 23.22 };
    vi.mocked(restaurantApi.move).mockResolvedValue(updated);
    const fakeMap = await renderMap();
    act(() => fakeMap.emit("load"));

    act(() => fakeMap.emit("mouseenter", markerEvent()));
    expect(fakeMap.canvas.style.cursor).toBe("grab");
    act(() => fakeMap.emit("mousedown", markerEvent()));
    expect(fakeMap.canvas.style.cursor).toBe("grab");
    expect(fakeMap.dragPan.disable).toHaveBeenCalledTimes(1);

    act(() =>
      fakeMap.emit("mousemove", {
        lngLat: { lng: 113.42, lat: 23.22 },
        point: { x: 112, y: 100 },
      }),
    );
    expect(fakeMap.canvas.style.cursor).toBe("grabbing");
    const preview = vi.mocked(installFoodLayers).mock.calls.at(-1)?.[1] as (typeof detailRestaurant)[];
    expect(preview).toEqual([expect.objectContaining({ longitude: 113.42, latitude: 23.22 })]);

    act(() => {
      fakeMap.emit("mouseup", {
        lngLat: { lng: 113.42, lat: 23.22 },
        point: { x: 112, y: 100 },
      });
      fakeMap.emit("click", markerEvent(113.42, 23.22, { x: 112, y: 100 }));
    });
    await waitFor(() => expect(restaurantApi.move).toHaveBeenCalledTimes(1));
    expect(restaurantApi.move).toHaveBeenCalledWith(detailRestaurant.id, 113.42, 23.22);
    expect(screen.queryByRole("heading", { name: "测试店" })).not.toBeInTheDocument();
    expect(fakeMap.dragPan.enable).toHaveBeenCalledTimes(1);
  });

  it("restores the original location when saving fails", async () => {
    const scaledRestaurant = { ...detailRestaurant, mapIconScale: 1.35 };
    vi.mocked(restaurantApi.listMap).mockResolvedValue([scaledRestaurant]);
    vi.mocked(restaurantApi.move).mockRejectedValue(new Error("网络错误"));
    const fakeMap = await renderMap();
    act(() => fakeMap.emit("load"));
    act(() => fakeMap.emit("mousedown", markerEvent()));
    act(() =>
      fakeMap.emit("mousemove", {
        lngLat: { lng: 113.42, lat: 23.22 },
        point: { x: 112, y: 100 },
      }),
    );
    act(() =>
      fakeMap.emit("mouseup", {
        lngLat: { lng: 113.42, lat: 23.22 },
        point: { x: 112, y: 100 },
      }),
    );

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("位置未保存：网络错误"));
    const restored = vi.mocked(installFoodLayers).mock.calls.at(-1)?.[1] as (typeof detailRestaurant)[];
    expect(restored).toEqual([
      expect.objectContaining({ longitude: 113.3, latitude: 23.1, mapIconScale: 1.35 }),
    ]);
    expect(fakeMap.dragPan.enable).toHaveBeenCalledTimes(1);
  });

  it("does not drag while position locking is enabled", async () => {
    const fakeMap = await renderMap(true);
    act(() => fakeMap.emit("load"));
    act(() => fakeMap.emit("mouseenter", markerEvent()));
    expect(fakeMap.canvas.style.cursor).toBe("pointer");
    act(() => fakeMap.emit("mousedown", markerEvent()));
    expect(fakeMap.dragPan.disable).not.toHaveBeenCalled();
    expect(restaurantApi.move).not.toHaveBeenCalled();
  });

  it("keeps a per-restaurant locked marker clickable while preventing drag", async () => {
    vi.mocked(restaurantApi.listMap).mockResolvedValue([{ ...detailRestaurant, positionLocked: true }]);
    vi.mocked(restaurantApi.get).mockResolvedValue({ ...detailRestaurant, positionLocked: true });
    const fakeMap = await renderMap(false);
    act(() => fakeMap.emit("load"));
    act(() => fakeMap.emit("mouseenter", markerEvent()));
    expect(fakeMap.canvas.style.cursor).toBe("pointer");
    act(() => fakeMap.emit("mousedown", markerEvent()));
    act(() => fakeMap.emit("click", markerEvent()));

    expect(fakeMap.dragPan.disable).not.toHaveBeenCalled();
    expect(restaurantApi.move).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "测试店" })).toBeInTheDocument();
  });

  it("keeps an ordinary marker click selectable and restores map panning", async () => {
    const fakeMap = await renderMap();
    act(() => fakeMap.emit("load"));
    act(() => fakeMap.emit("mousedown", markerEvent()));
    act(() =>
      fakeMap.emit("mousemove", {
        lngLat: { lng: 113.3001, lat: 23.1001 },
        point: { x: 103, y: 103 },
      }),
    );
    act(() =>
      fakeMap.emit("mouseup", {
        lngLat: { lng: 113.3001, lat: 23.1001 },
        point: { x: 103, y: 103 },
      }),
    );
    expect(restaurantApi.move).not.toHaveBeenCalled();
    expect(fakeMap.dragPan.enable).toHaveBeenCalledTimes(1);
    act(() => fakeMap.emit("click", markerEvent()));
    expect(await screen.findByRole("heading", { name: "测试店" })).toBeInTheDocument();
  });

  it("keeps locked markers clickable while preventing drag", async () => {
    const fakeMap = await renderMap(true);
    act(() => fakeMap.emit("load"));
    act(() => fakeMap.emit("mousedown", markerEvent()));
    act(() => fakeMap.emit("click", markerEvent()));

    expect(restaurantApi.move).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "测试店" })).toBeInTheDocument();
  });

  it("preserves the custom icon scale through preview and the move response", async () => {
    const scaledRestaurant = { ...detailRestaurant, mapIconScale: 1.35 };
    vi.mocked(restaurantApi.listMap).mockResolvedValue([scaledRestaurant]);
    vi.mocked(restaurantApi.move).mockResolvedValue({
      ...scaledRestaurant,
      longitude: 113.42,
      latitude: 23.22,
      mapIconScale: 0.75,
    });
    const fakeMap = await renderMap();
    act(() => fakeMap.emit("load"));
    act(() => fakeMap.emit("mousedown", markerEvent()));
    act(() =>
      fakeMap.emit("mousemove", {
        lngLat: { lng: 113.42, lat: 23.22 },
        point: { x: 112, y: 100 },
      }),
    );

    let rendered = vi.mocked(installFoodLayers).mock.calls.at(-1)?.[1] as (typeof detailRestaurant)[];
    expect(rendered[0]?.mapIconScale).toBe(1.35);

    act(() =>
      fakeMap.emit("mouseup", {
        lngLat: { lng: 113.42, lat: 23.22 },
        point: { x: 112, y: 100 },
      }),
    );
    await waitFor(() => expect(restaurantApi.move).toHaveBeenCalledTimes(1));
    rendered = vi.mocked(installFoodLayers).mock.calls.at(-1)?.[1] as (typeof detailRestaurant)[];
    expect(rendered[0]?.mapIconScale).toBe(1.35);
  });
});

describe("MapView create interactions", () => {
  beforeEach(() => {
    vi.mocked(createLocalMap).mockImplementation(() => new Promise<never>(() => {}));
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers restaurant and center actions from the map context menu", async () => {
    const fakeMap = await renderMap();
    void act(() => fakeMap.emit("load"));
    void act(() =>
      fakeMap.emit("contextmenu", {
        lngLat: { lng: 113.3, lat: 23.1 },
        point: { x: 100, y: 100 },
      }),
    );

    expect(screen.getByRole("button", { name: "在此添加餐厅" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设为中心点" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在此添加餐厅" }));
    expect(screen.getByRole("heading", { name: "在这里吃什么？" })).toBeInTheDocument();
  });

  it("creates a named center from one of exactly nine icon choices", async () => {
    const center: MapCenter = {
      id: "center-1",
      name: "公司",
      kind: "company",
      iconVariant: 2,
      mapIconScale: 1,
      longitude: 113.3,
      latitude: 23.1,
      cachedRegionIds: [],
      primaryRegionId: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    vi.mocked(centerApi.create).mockResolvedValue(center);
    const fakeMap = await renderMap();
    void act(() => fakeMap.emit("load"));
    void act(() =>
      fakeMap.emit("contextmenu", {
        lngLat: { lng: 113.3, lat: 23.1 },
        point: { x: 100, y: 100 },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "设为中心点" }));

    expect(screen.getAllByRole("button", { name: /图标/ })).toHaveLength(9);
    fireEvent.click(screen.getByRole("button", { name: "公司图标 2" }));
    fireEvent.click(screen.getByRole("button", { name: "保存中心点" }));

    await waitFor(() =>
      expect(centerApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "公司",
          kind: "company",
          iconVariant: 2,
          mapIconScale: 1,
          longitude: 113.3,
          latitude: 23.1,
        }),
      ),
    );
  });

  it("opens center editing on a short left click and saves an independent 0.25–2.5 scale", async () => {
    const center: MapCenter = {
      id: "center-home",
      name: "家",
      kind: "home",
      iconVariant: 1,
      mapIconScale: 0.75,
      longitude: 113.3,
      latitude: 23.1,
      cachedRegionIds: [],
      primaryRegionId: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    vi.mocked(centerApi.update).mockResolvedValue({ ...center, mapIconScale: 2.5 });
    const fakeMap = await renderMap(false, { centers: [center] });
    act(() => fakeMap.emit("load"));
    act(() =>
      fakeMap.emitLayer("click", "center-symbol-layer", {
        features: [{ properties: { id: center.id } }],
        lngLat: { lng: center.longitude, lat: center.latitude },
        point: { x: 100, y: 100 },
      }),
    );

    expect(screen.getByRole("form", { name: "编辑中心点" })).toBeInTheDocument();
    const slider = screen.getByRole("slider", { name: "地图图标大小" });
    expect(slider).toHaveAttribute("min", "0.25");
    expect(slider).toHaveAttribute("max", "2.5");
    expect(slider).toHaveValue("0.75");
    fireEvent.change(slider, { target: { value: "2.5" } });

    await waitFor(() => {
      const rendered = vi.mocked(installCenterLayers).mock.calls.at(-1)?.[1];
      expect(rendered?.find((item) => item.id === center.id)?.mapIconScale).toBe(2.5);
    });
    fireEvent.click(screen.getByRole("button", { name: "保存中心点" }));
    await waitFor(() =>
      expect(centerApi.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: center.id, mapIconScale: 2.5 }),
      ),
    );

    act(() =>
      fakeMap.emitLayer("contextmenu", "center-symbol-layer", {
        preventDefault: vi.fn(),
        features: [{ properties: { id: center.id } }],
        lngLat: { lng: center.longitude, lat: center.latitude },
        point: { x: 100, y: 100 },
      }),
    );
    expect(screen.getByRole("button", { name: "删除中心点" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑中心点" })).not.toBeInTheDocument();
  });

  it("does not open center editing after the same pointer gesture becomes a drag", async () => {
    const center: MapCenter = {
      id: "center-school",
      name: "学校",
      kind: "school",
      iconVariant: 3,
      mapIconScale: 1.2,
      longitude: 113.3,
      latitude: 23.1,
      cachedRegionIds: [],
      primaryRegionId: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    };
    vi.mocked(centerApi.move).mockResolvedValue({
      ...center,
      longitude: 113.31,
      latitude: 23.11,
    });
    const fakeMap = await renderMap(false, { centers: [center] });
    act(() => fakeMap.emit("load"));
    act(() => {
      fakeMap.emitLayer("mousedown", "center-symbol-layer", {
        preventDefault: vi.fn(),
        originalEvent: { button: 0 },
        features: [{ properties: { id: center.id } }],
        lngLat: { lng: center.longitude, lat: center.latitude },
        point: { x: 100, y: 100 },
      });
      fakeMap.emit("mousemove", {
        lngLat: { lng: 113.31, lat: 23.11 },
        point: { x: 112, y: 100 },
      });
      fakeMap.emit("mouseup", {
        lngLat: { lng: 113.31, lat: 23.11 },
        point: { x: 112, y: 100 },
      });
      fakeMap.emitLayer("click", "center-symbol-layer", {
        features: [{ properties: { id: center.id } }],
        lngLat: { lng: 113.31, lat: 23.11 },
        point: { x: 112, y: 100 },
      });
    });

    await waitFor(() => expect(centerApi.move).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("form", { name: "编辑中心点" })).not.toBeInTheDocument();
  });

  it.each([{ modifier: "ctrlKey" }, { modifier: "metaKey" }])(
    "opens the create panel from $modifier + N",
    async ({ modifier }) => {
      const fakeMap = await renderMap();
      void act(() => fakeMap.emit("load"));
      void act(() => fireEvent.keyDown(window, { key: "n", [modifier]: true }));

      expect(screen.getByRole("heading", { name: "在这里吃什么？" })).toBeInTheDocument();
    },
  );
});
