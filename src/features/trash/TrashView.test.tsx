import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restaurantApi } from "../restaurants/api";
import { TrashView } from "./TrashView";

vi.mock("../restaurants/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../restaurants/api")>();
  return {
    ...actual,
    restaurantApi: { listTrash: vi.fn(), restoreTrashItem: vi.fn(), permanentlyDeleteTrashItem: vi.fn() },
  };
});

describe("TrashView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });
  it("shows entity counts and restores an item", async () => {
    vi.mocked(restaurantApi.listTrash).mockResolvedValue({
      cleanupPending: 0,
      items: [
        { id: "r1", entity: "restaurant", title: "小馆", deletedAtMs: 10, logCount: 2, mediaCount: 3 },
        { id: "m1", entity: "media", title: "noodles.jpg", deletedAtMs: 11 },
      ],
    });
    vi.mocked(restaurantApi.restoreTrashItem).mockResolvedValue();
    render(<TrashView />);
    expect(await screen.findByText("小馆")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /餐厅 1/ })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "恢复" })[0]);
    await waitFor(() => expect(restaurantApi.restoreTrashItem).toHaveBeenCalledWith("restaurant", "r1"));
  });
  it("requires an explicit permanent-delete confirmation with Restaurant cascade counts", async () => {
    vi.mocked(restaurantApi.listTrash).mockResolvedValue({
      cleanupPending: 0,
      items: [{ id: "r1", entity: "restaurant", title: "小馆", deletedAtMs: 10, logCount: 2, mediaCount: 3 }],
    });
    vi.mocked(restaurantApi.permanentlyDeleteTrashItem).mockResolvedValue();
    render(<TrashView />);
    await screen.findByText("小馆");
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(
      screen.getByText("会永久移除这间餐厅，以及 2 条用餐记录和 3 张图片。此操作无法复原。"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
    await waitFor(() =>
      expect(restaurantApi.permanentlyDeleteTrashItem).toHaveBeenCalledWith("restaurant", "r1"),
    );
  });
});
