import { invoke } from "@tauri-apps/api/core";

export const settingsApi = {
  getRestaurantPositionLocked: () => invoke<boolean>("get_restaurant_position_locked"),
  setRestaurantPositionLocked: (locked: boolean) =>
    invoke<void>("set_restaurant_position_locked", { locked }),
};
