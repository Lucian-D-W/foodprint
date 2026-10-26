export const APP_THEMES = [
  {
    key: "hybrid",
    label: "经典原野",
    description: "延续当前温润、自然的随食记视觉。",
    swatches: ["#263c34", "#78956d", "#f2c86b", "#fffaf0"],
  },
  {
    key: "cyberpunk",
    label: "赛博朋克",
    description: "深色街区配合青蓝与霓虹洋红。",
    swatches: ["#23232b", "#0b959f", "#d3167c", "#ececed"],
  },
  {
    key: "morandi",
    label: "莫兰迪",
    description: "低彩度灰绿、灰蓝与灰粉，安静柔和。",
    swatches: ["#4b5d52", "#99b9c6", "#dac5c3", "#d8d3c9"],
  },
  {
    key: "steampunk",
    label: "蒸汽朋克",
    description: "黄铜、皮革与旧纸张构成的复古机械感。",
    swatches: ["#433e37", "#83573e", "#c8975d", "#d8c9b0"],
  },
] as const;

export type AppThemeKey = (typeof APP_THEMES)[number]["key"];

const THEME_STORAGE_KEY = "foodmap.visual-theme";
const themeKeys = new Set<string>(APP_THEMES.map((theme) => theme.key));

export function readTheme(): AppThemeKey {
  if (typeof window === "undefined") return "hybrid";
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored && themeKeys.has(stored) ? (stored as AppThemeKey) : "hybrid";
}

export function writeTheme(theme: AppThemeKey): void {
  if (typeof window !== "undefined") window.localStorage.setItem(THEME_STORAGE_KEY, theme);
}
