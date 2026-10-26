import { isTauri } from "@tauri-apps/api/core";

export async function logAppStarted(): Promise<void> {
  if (!isTauri()) return;

  const { info } = await import("@tauri-apps/plugin-log");
  await info("FoodMap frontend started", { file: "frontend" });
}
