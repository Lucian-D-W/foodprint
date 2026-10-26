export const APP_VIEWS = ["map", "gallery", "trash", "settings"] as const;

export type AppView = (typeof APP_VIEWS)[number];

export const VIEW_LABELS: Record<AppView, { label: string; description: string; icon: string }> = {
  map: { label: "地图", description: "Map", icon: "⌖" },
  gallery: { label: "相册", description: "Gallery", icon: "▦" },
  trash: { label: "回收站", description: "Trash", icon: "♲" },
  settings: { label: "设置", description: "Settings", icon: "⚙" },
};
