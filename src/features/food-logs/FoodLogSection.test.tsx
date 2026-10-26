import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../styles/components.css";
import { FoodLogEditor, FoodLogSection } from "./FoodLogSection";
import { restaurantApi, type FoodLog, type Media } from "../restaurants/api";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  open: vi.fn(),
  onDragDropEvent: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ onDragDropEvent: mocks.onDragDropEvent }),
}));

const log: FoodLog = {
  id: "log-1",
  restaurantId: "restaurant-1",
  occurredAtMs: 1_700_000_000_000,
  tzOffsetMinutes: 480,
  mealType: "lunch",
  diningMode: "dine_in",
  title: null,
  note: "和朋友一起吃饭",
  rating: 4,
};

const photo: Media = {
  id: "media-1",
  restaurantId: "restaurant-1",
  foodLogId: "log-1",
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

describe("FoodLogEditor", () => {
  beforeEach(() => {
    mocks.invoke.mockResolvedValue({ localAssetOrigin: "http://local" });
    mocks.onDragDropEvent.mockResolvedValue(vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("creates a nullable log without exposing the retired title field", async () => {
    const create = vi.spyOn(restaurantApi, "createFoodLog").mockResolvedValue({} as never);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(<FoodLogEditor restaurantId="restaurant-1" onCancel={vi.fn()} onSave={onSave} />);

    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText("备注"), { key: "Enter", ctrlKey: true });

    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create.mock.calls[0][0]).toMatchObject({
      restaurantId: "restaurant-1",
      title: null,
      mealType: null,
      diningMode: null,
      rating: null,
    });
  });

  it("keeps a legacy title when editing another field", async () => {
    const update = vi.spyOn(restaurantApi, "updateFoodLog").mockResolvedValue({} as never);
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <FoodLogEditor
        restaurantId="restaurant-1"
        log={{ ...log, title: "历史标题" }}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );

    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "更新备注" } });
    fireEvent.keyDown(screen.getByLabelText("备注"), { key: "Enter", ctrlKey: true });

    await vi.waitFor(() => expect(update).toHaveBeenCalledOnce());
    expect(update).toHaveBeenCalledWith(
      "log-1",
      expect.objectContaining({ title: "历史标题", note: "更新备注" }),
    );
  });

  it("cancels with Escape and allows rating to be cleared", () => {
    const onCancel = vi.fn();
    render(<FoodLogEditor restaurantId="restaurant-1" onCancel={onCancel} onSave={vi.fn()} />);

    const rating = screen.getByLabelText("评分");
    fireEvent.change(rating, { target: { value: "5" } });
    expect(rating).toHaveValue("5");
    fireEvent.change(rating, { target: { value: "" } });
    expect(rating).toHaveValue("");
    fireEvent.keyDown(screen.getByLabelText("备注"), { key: "Escape" });

    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("FoodLogSection", () => {
  beforeEach(() => {
    mocks.invoke.mockResolvedValue({ localAssetOrigin: "http://local" });
    mocks.onDragDropEvent.mockResolvedValue(vi.fn());
    vi.spyOn(restaurantApi, "listMedia").mockResolvedValue({ items: [], nextCursor: null });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function renderSection(
    items: FoodLog[] = [log],
    props: Partial<React.ComponentProps<typeof FoodLogSection>> = {},
  ) {
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items, nextCursor: null });
    return render(<FoodLogSection restaurantId="restaurant-1" onMutation={vi.fn()} {...props} />);
  }

  it("renders a semantic table with column headers and no title column", async () => {
    renderSection([{ ...log, title: "历史标题" }]);

    const table = await screen.findByRole("table", { name: "用餐记录表" });
    expect(table.querySelectorAll("thead th")).toHaveLength(6);
    expect(screen.getByRole("columnheader", { name: "日期时间" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "行操作" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "餐次" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "方式" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "评分" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "备注" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "操作" })).not.toBeInTheDocument();
    expect(screen.queryByText("历史标题")).not.toBeInTheDocument();
    expect(screen.queryByText("未命名记录")).not.toBeInTheDocument();
  });

  it("uses a persistent table row for direct entry without a detached add button", async () => {
    const create = vi.spyOn(restaurantApi, "createFoodLog").mockResolvedValue({} as never);
    const onMutation = vi.fn();
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [], nextCursor: null });
    render(<FoodLogSection restaurantId="restaurant-1" onMutation={onMutation} />);

    expect(screen.queryByRole("button", { name: "+ 记录" })).not.toBeInTheDocument();
    const entryRow = await screen.findByRole("row", { name: "新增用餐记录" });
    expect(entryRow).toBeInTheDocument();
    const leadingAdd = screen.getByRole("button", { name: "新增用餐记录" });
    expect(entryRow.querySelector("td:first-child button")).toBe(leadingAdd);
    expect(leadingAdd).toHaveTextContent("+");
    expect(getComputedStyle(leadingAdd).width).toBe("20px");
    expect(getComputedStyle(leadingAdd).opacity).toBe("0.38");
    expect(screen.queryByLabelText("标题")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("新记录餐次"), { target: { value: "dinner" } });
    fireEvent.change(screen.getByLabelText("新记录用餐方式"), { target: { value: "takeaway" } });
    fireEvent.change(screen.getByLabelText("新记录评分"), { target: { value: "5" } });
    const note = screen.getByLabelText("新记录备注");
    fireEvent.change(note, { target: { value: "表格里直接写" } });
    fireEvent.click(screen.getByRole("button", { name: "新增用餐记录" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        restaurantId: "restaurant-1",
        title: null,
        mealType: "dinner",
        diningMode: "takeaway",
        rating: 5,
        note: "表格里直接写",
      }),
    );
    await waitFor(() => expect(onMutation).toHaveBeenCalledOnce());
    expect(screen.getByLabelText("新记录备注")).toHaveValue("");
  });

  it("deletes from a subtle leading cross without opening the row", async () => {
    const remove = vi.spyOn(restaurantApi, "softDeleteFoodLog").mockResolvedValue(undefined);
    const onMutation = vi.fn();
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [log], nextCursor: null });
    render(<FoodLogSection restaurantId="restaurant-1" onMutation={onMutation} />);

    const row = await screen.findByRole("row", { name: /和朋友一起吃饭/ });
    const leadingDelete = screen.getByRole("button", { name: /删除 .* 用餐记录/ });
    expect(row.querySelector("td:first-child button")).toBe(leadingDelete);
    expect(leadingDelete).toHaveTextContent("×");
    expect(getComputedStyle(leadingDelete).opacity).toBe("0.38");
    fireEvent.click(leadingDelete);

    expect(screen.queryByRole("dialog", { name: "用餐记录" })).not.toBeInTheDocument();
    await waitFor(() => expect(remove).toHaveBeenCalledWith("log-1"));
    await waitFor(() => expect(onMutation).toHaveBeenCalledOnce());
  });

  it("keeps the native horizontal scroller at the FoodLog frame bottom as rows grow", async () => {
    const manyLogs = Array.from({ length: 24 }, (_, index) => ({
      ...log,
      id: `log-${index + 1}`,
      occurredAtMs: log.occurredAtMs + index * 60_000,
    }));
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({
      items: manyLogs,
      nextCursor: "next-page",
    });
    const view = render(<FoodLogSection restaurantId="restaurant-1" onMutation={vi.fn()} />);

    const section = view.container.querySelector<HTMLElement>(".food-log-section")!;
    const scroller = view.container.querySelector<HTMLElement>(".food-log-table-wrap")!;
    await waitFor(() => expect(scroller.querySelectorAll("tbody .food-log-row")).toHaveLength(24));
    expect(getComputedStyle(section).display).toBe("flex");
    expect(getComputedStyle(section).height).toBe("100%");
    expect(getComputedStyle(section).minHeight).toBe("0px");
    expect(getComputedStyle(scroller).flex).toBe("1 1 auto");
    expect(getComputedStyle(scroller).minHeight).toBe("0px");
    expect(getComputedStyle(scroller).overflow).toBe("auto");
    expect(scroller).toContainElement(screen.getByRole("button", { name: "加载更多" }));
  });

  it("keeps inline entry values visible when saving fails", async () => {
    vi.spyOn(restaurantApi, "createFoodLog").mockRejectedValue(new Error("保存失败"));
    renderSection([]);

    const note = await screen.findByLabelText("新记录备注");
    fireEvent.change(note, { target: { value: "不要丢掉这段" } });
    fireEvent.click(screen.getByRole("button", { name: "新增用餐记录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("保存失败");
    expect(note).toHaveValue("不要丢掉这段");
  });

  it("opens rows in a centered top-level dialog by click and keyboard", async () => {
    renderSection();

    const row = await screen.findByRole("row", { name: /和朋友一起吃饭/ });
    expect(row).toHaveAttribute("aria-haspopup", "dialog");

    fireEvent.click(row);
    let dialog = screen.getByRole("dialog", { name: "用餐记录" });
    expect(getComputedStyle(dialog).position).toBe("fixed");
    expect(getComputedStyle(dialog).zIndex).toBe("50");
    expect(dialog.parentElement).toBe(document.body);
    expect(document.querySelector(".food-log-detail-row")).not.toBeInTheDocument();

    fireEvent.click(document.querySelector<HTMLButtonElement>(".food-log-modal__close")!);
    expect(screen.queryByRole("dialog", { name: "用餐记录" })).not.toBeInTheDocument();
    fireEvent.keyDown(row, { key: "Enter" });
    dialog = screen.getByRole("dialog", { name: "用餐记录" });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "用餐记录" })).not.toBeInTheDocument();
    fireEvent.keyDown(row, { key: " " });
    expect(screen.getByRole("dialog", { name: "用餐记录" })).toBeInTheDocument();
  });

  it("automatically opens a dialog and scrolls the focused row", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    renderSection([{ ...log, id: "log-focused", title: "需要定位的记录" }], {
      focusedFoodLogId: "log-focused",
    });

    const row = await screen.findByRole("row", { name: /和朋友一起吃饭/ });
    expect(row).toHaveAttribute("data-focused", "true");
    await screen.findByRole("dialog", { name: "用餐记录" });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" }));
  });

  it("edits directly in the dialog and imports media into the current record", async () => {
    const listMedia = vi.mocked(restaurantApi.listMedia);
    listMedia
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ items: [photo], nextCursor: null });
    mocks.open.mockResolvedValue(["C:/images/lunch.jpg"]);
    const imported = vi.spyOn(restaurantApi, "importMedia").mockResolvedValue({
      results: [{ sourcePath: "C:/images/lunch.jpg", media: photo, error: null }],
    });
    const onMutation = vi.fn();
    const update = vi.spyOn(restaurantApi, "updateFoodLog").mockResolvedValue({} as never);
    vi.spyOn(restaurantApi, "listFoodLogs").mockResolvedValue({ items: [log], nextCursor: null });
    vi.spyOn(restaurantApi, "softDeleteFoodLog").mockResolvedValue(undefined);

    render(<FoodLogSection restaurantId="restaurant-1" onMutation={onMutation} />);
    const row = await screen.findByRole("row", { name: /和朋友一起吃饭/ });
    fireEvent.click(row);

    const dialog = await screen.findByRole("dialog", { name: "用餐记录" });
    expect(dialog).toContainElement(screen.getByRole("form", { name: "编辑用餐记录" }));
    expect(screen.getByLabelText("备注")).toHaveValue("和朋友一起吃饭");
    expect(dialog).toHaveTextContent("上传内容会自动关联到这条用餐记录");

    fireEvent.click(screen.getByRole("button", { name: "添加记录图片或视频" }));
    await vi.waitFor(() =>
      expect(imported).toHaveBeenCalledWith({
        restaurantId: "restaurant-1",
        foodLogId: "log-1",
        category: "food",
        paths: ["C:/images/lunch.jpg"],
      }),
    );
    expect(onMutation).toHaveBeenCalledOnce();
    expect(listMedia).toHaveBeenCalledWith({ restaurantId: "restaurant-1", foodLogId: "log-1", limit: 100 });
    const thumbnail = await screen.findByAltText("lunch.jpg");
    expect(thumbnail).toHaveAttribute("src", "http://local/media/thumbnail/a.jpg");

    fireEvent.change(screen.getByLabelText("备注"), { target: { value: "窗口里直接修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("log-1", expect.objectContaining({ note: "窗口里直接修改" })),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "用餐记录" })).not.toBeInTheDocument());
    expect(screen.getByRole("table", { name: "用餐记录表" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /和朋友一起吃饭/ })).toBeInTheDocument();
  });
});
