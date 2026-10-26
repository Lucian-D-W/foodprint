# Third-party notices

随食记 (foodprint, formerly FoodMap) distributes open-source software and local map resources. This file is a notice index, not a replacement for upstream license texts. Versions are locked in `pnpm-lock.yaml` and `src-tauri/Cargo.lock`.

The original application code is licensed under GPL-3.0-only. Copyright (C) 2026 Lucian W. (lucian-d-w). Third-party software, map data and fonts retain their own licenses and notices; the project license does not replace them.

## Map data and fonts

- **OpenStreetMap contributors** — map data is available under the Open Database License (ODbL). Attribution: © OpenStreetMap contributors. Terms: <https://www.openstreetmap.org/copyright>.
- **OpenMapTiles** — the bundled map package records OpenMapTiles 3.16.0 cartography/schema provenance. Attribution: © OpenMapTiles. The package manifest records CC BY 4.0 for schema/cartography; see <https://openmaptiles.org/>.
- **Planetiler / planetiler-openmaptiles** — used to prepare the frozen PMTiles package; upstream licensing and provenance are recorded in `resources/map-default/manifest.json`.
- **Noto Sans** — bundled glyph ranges originate from the Noto Sans family, licensed under SIL Open Font License 1.1. See <https://openfontlicense.org/>.
- **PMTiles** — the PMTiles v3 archive format and tooling are used for local maps. The exact generator version and source are recorded in `resources/map-default/manifest.json`; see <https://github.com/protomaps/PMTiles>.

## Application software

随食记 uses, among others, Tauri, React, MapLibre GL JS, PMTiles JS, Axum, rusqlite/SQLite, Tokio, image, zip, serde, uuid and their transitive dependencies. Their exact resolved versions are in the lock files. The accompanying [license collection](resources/licenses/THIRD_PARTY_LICENSES.txt) preserves license texts and notices from the locked production npm graph and target-filtered Windows Rust metadata, including its build/development dependencies. Installed copies include this collection under `resources/licenses/`; it is a notice superset, not a claim that every listed tool is linked into the application. Regenerate the collection when dependency lock files or bundled fonts/map sources change.

MPL-covered crate source is available from the exact name/version links described in the collection. The application license does not replace the upstream source-availability obligations.

### Rust dependency audit scope

The Windows release dependency audit is target-filtered to
`x86_64-pc-windows-msvc`: Linux-only GTK/WebKit transitive code in the shared
lockfile is not treated as Windows-release reachability. The unpublished
`foodmap` workspace crate now declares GPL-3.0-only. The private-crate audit
exclusion applies only to the workspace crate, never registry dependencies. The reviewed SPDX
allowlist is in `deny.toml`. Five `rust-unic` unmaintained advisories remain
reachable through locked Tauri `tauri-utils -> urlpattern`; no safe upstream
upgrade is available, so their exact RustSec IDs are recorded as reviewed
exceptions in that file rather than accepting a broad advisory class.

## Food icons

`resources/food-icons` contains project-authored, AI-assisted raster assets adopted from the approved cuisine icon set. Their manifest records the generation provenance and states: “Project-owned; no third-party artwork embedded.” The earlier deterministic generator in `scripts/prepare-food-icons.mjs` is a historical prototype tool; it does not reproduce the adopted artwork. The frozen prototype SVGs remain design references.

## Attribution display

The shipped map displays: `OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors`. 随食记 must retain this attribution with the bundled map.
