import { invoke } from "@tauri-apps/api/core";
import type { RegionBounds } from "./offlineRegionApi";

export const CENTER_KINDS = ["home", "company", "school"] as const;
export type CenterKind = (typeof CENTER_KINDS)[number];

export type MapCenter = {
  id: string;
  name: string;
  kind: CenterKind;
  iconVariant: 1 | 2 | 3;
  mapIconScale: number;
  longitude: number;
  latitude: number;
  cachedRegionIds: string[];
  primaryRegionId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type CenterIdentity = Pick<MapCenter, "name" | "kind" | "iconVariant" | "mapIconScale">;
export type CenterLocation = Pick<MapCenter, "longitude" | "latitude"> & {
  coverageBounds: RegionBounds;
};

export const centerApi = {
  list: () => invoke<MapCenter[]>("list_map_centers"),
  create: (input: CenterIdentity & CenterLocation) => invoke<MapCenter>("create_map_center", { input }),
  update: (input: CenterIdentity & Pick<MapCenter, "id">) =>
    invoke<MapCenter>("update_map_center", { input }),
  move: (input: CenterLocation & Pick<MapCenter, "id">) => invoke<MapCenter>("move_map_center", { input }),
  attachRegion: (id: string, regionId: string) =>
    invoke<MapCenter>("attach_map_center_region", { input: { id, regionId } }),
  remove: (id: string) => invoke<void>("delete_map_center", { input: { id } }),
};

export const CENTER_KIND_LABELS: Record<CenterKind, string> = {
  home: "家",
  company: "公司",
  school: "学校",
};

export function centerIconKey(center: Pick<MapCenter, "kind" | "iconVariant">): string {
  return `center.${center.kind}.${center.iconVariant}`;
}
