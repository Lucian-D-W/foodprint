# 开发与维护

以下命令在项目根目录执行。普通使用者的安装与操作入口见[项目介绍](../README.md)。

从源码启动需要 Windows、Node.js 24、Corepack、Rust 1.98.0、Microsoft C++ Build Tools（MSVC 与 Windows SDK）和 WebView2。项目固定使用 pnpm 11.24.0；JavaScript 与 Rust 依赖分别由 `pnpm-lock.yaml` 和 `src-tauri/Cargo.lock` 锁定。`esbuild` 是 Vite 当前压缩配置和地图资源准备脚本直接使用的开发依赖。

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm tauri dev
```

构建与检查：

```powershell
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-fail-fast
corepack pnpm tauri build
```

Tauri 的正式配置直接调用 `corepack pnpm`。`pnpm build` 生成前端 `dist/`；`pnpm tauri build` 另外编译 Windows 桌面程序和安装包，产物位于 `src-tauri/target/release/bundle/`。

地图与图标检查还需要独立的 PMTiles CLI 1.31.2。这个工具只用于资源制作和校验，应用运行时由 `pmtiles` JavaScript 库读取地图包。通过参数提供实际工具位置：

```powershell
corepack pnpm check:assets --pmtiles 'C:\tools\pmtiles.exe'
# 也可以设置当前终端的 PMTILES_BIN 后运行 corepack pnpm check:assets。
```


## 数据、图片与备份

随食记的数据库、原图、预览图、缩略图、自动安全备份和恢复暂存目录位于 Windows AppLocalData 下、应用标识 `com.dean.foodmap` 的目录。手工导出的备份可保存到用户选择的位置。Settings 页面中的“打开数据目录”会打开实际数据位置。

- 支持 JPEG、PNG、WebP 图片及 MP4、WebM 视频导入。导入时应用保留自己的受管副本，之后移动或删除源文件不会影响已导入内容。视频采用统一封面和 WebView2 原生播放；目前不做转码或视频帧提取，播放能力取决于系统支持的编码。
- 删除的项目会先进入回收站，可恢复；永久删除会移除数据库项目，并把受管图片交给可重试的本地清理队列。
- 在 Settings 中创建 `.foodmap-backup.zip` 备份。备份使用 SQLite 一致性快照，并包含数据库、受管媒体和带 SHA-256 校验值的 manifest。
- 恢复前会先检查归档路径、manifest、hash、数据库完整性和可用空间；确认恢复时会自动创建一份可检查的安全备份。恢复失败会保留原有数据。

请在更新应用、清理 Windows 用户目录或永久删除内容前创建备份。不要直接编辑数据库或受管媒体目录。完整的边界与恢复说明见 [DATA_SAFETY.md](../DATA_SAFETY.md)。

## 本地地图与隐私

默认地图从本地 PMTiles、style、glyph 和 Food 图标资源加载；已下载区域从本地瓦片缓存读取。地点搜索和逆地理编码使用 Nominatim，新增区域下载使用 OpenFreeMap。搜索文本或待识别坐标会发送给相应服务，餐饮记录和媒体仍保存在本机。

运行时临时资源服务只监听 `127.0.0.1` 随机端口，并要求每次启动生成的随机 token；它只暴露所需的地图、媒体和 Food 图标路径。应用不以餐饮记录正文、完整图片路径、图像内容或详细 EXIF 写入日志。日志会滚动保存（单个 1 MB、最多 5 个）。

底图归属：OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors。详见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 工程结构与维护

| 路径                                                   | 职责                                                     |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `src/app/`                                             | 应用壳层、导航和跨视图状态                               |
| `src/features/`                                        | 地图、餐厅、用餐记录、媒体、设置和回收站界面             |
| `src/styles/`、`src/assets/`                           | 界面主题、地图样式与前端素材                             |
| `src-tauri/src/commands/`                              | 前端可调用的 Tauri 命令                                  |
| `src-tauri/src/services/`                              | 业务流程、地图资源服务、媒体、备份与恢复                 |
| `src-tauri/src/repositories/`、`src-tauri/migrations/` | SQLite 数据访问与业务迁移历史                            |
| `resources/`                                           | 随桌面程序分发的地图、图标及其 manifest                  |
| `scripts/`                                             | 资源制作、校验和可重复的桌面验证工具                     |
| `docs/`                                                | 开发说明、研究材料与演示素材，参见[资料说明](README.md) |

`dist/`、`node_modules/`、`src-tauri/target/` 和 `src-tauri/gen/` 是本机生成物，不纳入 Git。

`scripts/verify-stage9-disposable.ps1` 汇总运行临时数据下的 Rust 测试及前端检查，任一步失败都会中止并返回失败。桌面地图诊断使用 `scripts/probe-desktop-map-fetch.mjs`：先执行 `corepack pnpm tauri build --debug --no-bundle`，再运行脚本；它使用支持临时数据目录的 debug 程序。普通 release 程序始终使用用户 AppLocalData。

`knip.jsonc` 为可选的 Knip 检查说明手工脚本入口。检查未引用代码时仍需核对动态调用和历史用途；未在模块外使用的导出不自动构成删除理由。完整安装包的人工视觉体验另行验证。
