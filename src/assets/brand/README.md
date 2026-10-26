# 随食记 · foodprint 品牌素材

2026-10-26，用户选定三版对比图中的 **B：餐具折叠地图**。正式图标由折叠地图、定位点和木勺组成，沿用项目现有美食小店、中心房屋素材的暖色像素画风。旧店铺 Logo 不再用于当前应用。

- `foodprint.png`：AI 辅助生成的 1254 × 1254 RGBA 位图原稿，真实透明背景；不是 SVG 或矢量源文件。
- `foodprint-128.png`：由 Tauri CLI 从原稿导出的界面与 README 图片。
- `foodprint-32.png`：同源导出的页面图标。
- `../../../src-tauri/icons/icon.ico`：Windows 图标，包含 16、24、32、48、64、128、256 像素 PNG 帧。

这些项目自有素材随项目采用 GPL-3.0-only。署名：Lucian W. (lucian-d-w)。第三方地图、字体和软件保留各自许可。

## 制作来源

使用内置 ImageGen，未使用 CLI/API fallback。风格参考：

- `resources/food-icons/dimsum_dumpling/dimsum_dumpling-shop-01.png`
- `resources/food-icons/pasta_pizza/pasta_pizza-shop-01.png`
- `src/assets/center-icons/home-01.png`

三版对比图只是选型预览，正式消费文件是本目录中的独立透明 Logo。导出使用 `pnpm tauri icon` 的指定 PNG 尺寸，再将这些同源 PNG 帧写入 Windows ICO 容器；未改变所选图案。

最终生成提示词如下。参考图是本轮生成的 A/B/C 对比图：

> Create the FINAL single standalone application logo for 随食记 / foodprint by extracting and faithfully refining ONLY candidate B (the CENTER logo) from the reference concept sheet. Reference is an EDIT TARGET: keep the chosen B design identity and pixel-art style. One folded parchment map, warm dark-brown pixel outline, sage green terrain and a winding pale road/river, a terracotta red map location pin near the upper right, and a single wooden spoon running diagonally along the right edge with its handle toward lower center, small sage ribbon with a cream button. Keep exactly this compact silhouette and warm hand-crafted pixel-art aesthetic, comparable proportions and clear fold geometry. Simplify tiny map decoration slightly so the symbol remains readable as a Windows app icon. Sharp intentional pixel-art edges, no blurry halo, no new objects, no store/building. Remove ALL text, labels, A/B/C, brand names, and the neighboring candidates entirely. One centered icon ONLY, fully visible with a small even transparent margin, maximally using the square canvas (about 84% icon width/height), no clipping. True transparent RGBA background with clean alpha; no ivory background, no baked checkerboard, no ground plane or cast shadow beyond the icon. High quality square 1024x1024 master if available. This is final icon artwork, not a presentation sheet.
