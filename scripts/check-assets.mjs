#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const MAP_ROOT = join(REPO_ROOT, "resources", "map-default");
const FOOD_ROOT = join(REPO_ROOT, "resources", "food-icons");
const MAP_MANIFEST_PATH = join(MAP_ROOT, "manifest.json");
const FOOD_MANIFEST_PATH = join(FOOD_ROOT, "manifest.json");
const FROZEN_BOUNDS = [113.3, 23.11, 113.33, 23.135];
const FROZEN_CENTER = [113.3158, 23.122, 15.15];
const FROZEN_LAYERS = [
  "building", "housenumber", "landcover", "landuse", "park", "place", "poi",
  "transportation", "transportation_name", "water", "water_name", "waterway",
];
const CUISINES = [
  "dimsum_dumpling", "burger", "pasta_pizza", "buns", "fast_meal",
  "rice_noodles", "malatang", "sichuan_hunan", "cantonese", "jinghu_lu",
  "fried_chicken", "snacks", "braised_duck", "japanese", "korean", "dry_pot",
  "hotpot", "lobster_bbq", "salad", "milk_tea_juice", "coffee", "bakery_pastry",
  "dessert", "south_asian", "southeast_asian",
];
const CUISINE_LABELS = [
  "点心饺子", "汉堡", "意面披萨", "包子", "快餐便当", "米粉面馆", "麻辣烫", "川湘菜馆", "粤菜", "京沪鲁菜",
  "炸鸡", "小吃", "鸭脖卤味", "日式料理", "韩式料理", "香锅", "火锅", "龙虾烧烤", "沙拉", "奶茶果汁", "咖啡", "面包糕点", "甜品", "南亚菜系", "东南亚菜系",
];
const OVERLAYS = ["rating-1", "rating-2", "rating-3", "rating-4", "rating-5", "bookmark-badge", "avoid-badge"];

const results = [];
let currentGroup = "General";

function group(name) {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}

function record(status, message) {
  results.push({ group: currentGroup, status, message });
  console.log(`${status} ${message}`);
}

const pass = (message) => record("PASS", message);
const fail = (message) => record("FAIL", message);
const blocked = (message) => record("BLOCKED", message);
const info = (message) => console.log(`INFO ${message}`);

function parseArgs() {
  const options = { pmtiles: process.env.PMTILES_BIN || null };
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === "--pmtiles" && process.argv[index + 1]) {
      options.pmtiles = process.argv[index + 1];
      index += 1;
    } else {
      fail(`unknown or incomplete argument: ${process.argv[index]}`);
    }
  }
  return options;
}

function readJson(path, label) {
  if (!existsSync(path)) {
    blocked(`${label} is missing: ${relative(REPO_ROOT, path).replaceAll("\\", "/")}`);
    return null;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    pass(`${label} exists and is valid JSON`);
    return value;
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function sameNumbers(actual, expected, tolerance = 1e-7) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => typeof value === "number" && Math.abs(value - expected[index]) <= tolerance);
}

function validateRelativePath(value, label, { placeholders = false } = {}) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty relative path`);
    return false;
  }
  const candidate = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) || candidate.startsWith("//")) {
    fail(`${label} must not be an external URL or URI: ${candidate}`);
    return false;
  }
  if (isAbsolute(candidate) || win32.isAbsolute(candidate) || posix.isAbsolute(candidate)) {
    fail(`${label} must not be absolute: ${candidate}`);
    return false;
  }
  if (candidate.includes("\\")) {
    fail(`${label} must use normalized forward slashes: ${candidate}`);
    return false;
  }
  const pathForSegments = placeholders ? candidate.replaceAll("{fontstack}", "fontstack").replaceAll("{range}", "range") : candidate;
  if (pathForSegments.split("/").includes("..")) {
    fail(`${label} must not contain '..': ${candidate}`);
    return false;
  }
  if (posix.normalize(pathForSegments) !== pathForSegments || pathForSegments.startsWith("./")) {
    fail(`${label} must be a canonical relative path: ${candidate}`);
    return false;
  }
  return true;
}

function resolveInside(root, relativePath, label) {
  const absolute = resolve(root, ...relativePath.split("/"));
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    fail(`${label} resolves outside its resource root: ${relativePath}`);
    return null;
  }
  return absolute;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function checkFileAndHash(root, relativePath, expectedHash, label) {
  if (!validateRelativePath(relativePath, `${label}.path`)) return false;
  const absolute = resolveInside(root, relativePath, label);
  if (!absolute) return false;
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    fail(`${label} referenced file is missing: ${relativePath}`);
    return false;
  }
  if (!isSha256(expectedHash)) {
    fail(`${label}.sha256 must be 64 lowercase hexadecimal characters`);
    return false;
  }
  const actualHash = sha256(absolute);
  if (actualHash !== expectedHash) {
    fail(`${label} SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`);
    return false;
  }
  return true;
}

function findExternalUrls(value, pointer = "$") {
  const findings = [];
  if (typeof value === "string" && (/https?:\/\//i.test(value) || value.startsWith("//"))) findings.push(`${pointer}=${value}`);
  if (Array.isArray(value)) value.forEach((item, index) => findings.push(...findExternalUrls(item, `${pointer}[${index}]`)));
  else if (isPlainObject(value)) Object.entries(value).forEach(([key, item]) => findings.push(...findExternalUrls(item, `${pointer}.${key}`)));
  return findings;
}

function inspectPng(path) {
  const buffer = readFileSync(path);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature) || buffer.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("not a valid PNG with an IHDR chunk");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  let offset = 8;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  let transparentBorder = false;
  if (bitDepth === 8 && colorType === 6 && idat.length > 0) {
    const bytesPerPixel = 4;
    const rowBytes = width * bytesPerPixel;
    const raw = inflateSync(Buffer.concat(idat));
    const rows = [];
    let cursor = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[cursor++];
      const source = raw.subarray(cursor, cursor + rowBytes);
      cursor += rowBytes;
      const row = Buffer.alloc(rowBytes);
      const previous = rows[y - 1] ?? Buffer.alloc(rowBytes);
      for (let x = 0; x < rowBytes; x += 1) {
        const left = x >= bytesPerPixel ? row[x - bytesPerPixel] : 0;
        const up = previous[x];
        const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;
        let predictor = 0;
        if (filter === 1) predictor = left;
        else if (filter === 2) predictor = up;
        else if (filter === 3) predictor = Math.floor((left + up) / 2);
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
          predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        } else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
        row[x] = (source[x] + predictor) & 255;
      }
      rows.push(row);
    }
    const alphaAt = (x, y) => rows[y][x * bytesPerPixel + 3];
    transparentBorder = true;
    for (let x = 0; x < width; x += 1) if (alphaAt(x, 0) !== 0 || alphaAt(x, height - 1) !== 0) transparentBorder = false;
    for (let y = 0; y < height; y += 1) if (alphaAt(0, y) !== 0 || alphaAt(width - 1, y) !== 0) transparentBorder = false;
  }
  return { width, height, bitDepth, colorType, hasAlphaChannel: colorType === 4 || colorType === 6, transparentBorder };
}

function checkMapManifest(manifest, options) {
  group("Map manifest contract");
  if (!manifest) return;
  if (manifest.schemaVersion === 1) pass("schemaVersion is 1"); else fail("schemaVersion must be 1");
  if (manifest.packageId === "personal-default") pass("packageId is personal-default"); else fail("packageId must be personal-default");
  if (typeof manifest.packageVersion === "string" && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(manifest.packageVersion)) pass(`packageVersion is concrete: ${manifest.packageVersion}`); else fail("packageVersion must be a concrete YYYY.MM.DD.N value");
  if (manifest.pmtilesSpecVersion === 3) pass("pmtilesSpecVersion is 3"); else fail("pmtilesSpecVersion must be 3");
  if (typeof manifest.basemapSchema === "string" && /OpenMapTiles/i.test(manifest.basemapSchema) && !/(prototype|placeholder|\.\.\.)/i.test(manifest.basemapSchema)) pass(`basemapSchema is explicit: ${manifest.basemapSchema}`); else fail("basemapSchema must identify a concrete OpenMapTiles-compatible schema/version");
  if (manifest.sourceId === "openmaptiles") pass("sourceId is openmaptiles"); else fail("sourceId must be openmaptiles");

  const layers = Array.isArray(manifest.sourceLayers) ? manifest.sourceLayers : [];
  const missingLayers = FROZEN_LAYERS.filter((layer) => !layers.includes(layer));
  const extraLayers = layers.filter((layer) => !FROZEN_LAYERS.includes(layer));
  if (missingLayers.length === 0 && extraLayers.length === 0 && new Set(layers).size === FROZEN_LAYERS.length) pass("sourceLayers exactly match the 12 bundled layers");
  else fail(`sourceLayers mismatch; missing=[${missingLayers.join(", ")}], extra=[${extraLayers.join(", ")}]`);

  if (sameNumbers(manifest.bounds, FROZEN_BOUNDS)) pass("bounds match the frozen Zhujiang New Town bounds"); else fail(`bounds must equal [${FROZEN_BOUNDS.join(", ")}]`);
  if (sameNumbers(manifest.center, FROZEN_CENTER)) pass("center matches the frozen camera"); else fail(`center must equal [${FROZEN_CENTER.join(", ")}]`);
  if (manifest.pitch === 0 && manifest.bearing === 0) pass("pitch and bearing are both 0"); else fail("pitch and bearing must both be 0");
  if (manifest.minZoom === 0) pass("minZoom is 0"); else fail("minZoom must be 0");
  if (manifest.maxZoom === 16) pass("maxZoom reaches the frozen target 16"); else blocked(`maxZoom is ${manifest.maxZoom}; frozen stage-0 target is 16`);
  if (manifest.releaseStatus === "PASS" && (!Array.isArray(manifest.blockers) || manifest.blockers.length === 0)) pass("manifest releaseStatus is PASS with no blockers");
  else blocked(`manifest releaseStatus is ${JSON.stringify(manifest.releaseStatus)}; blockers=${JSON.stringify(manifest.blockers ?? [])}`);

  const hashes = isPlainObject(manifest.sha256) ? manifest.sha256 : null;
  if (!hashes) fail("sha256 must be an object keyed by normalized resource path");
  const directReferences = [manifest.tiles, manifest.style];
  for (const [index, relativePath] of directReferences.entries()) {
    const label = index === 0 ? "tiles" : "style";
    if (typeof relativePath === "string" && hashes) {
      if (!(relativePath in hashes)) fail(`sha256 is missing ${label} entry: ${relativePath}`);
      else if (checkFileAndHash(MAP_ROOT, relativePath, hashes[relativePath], label)) pass(`${label} exists and SHA-256 matches: ${relativePath}`);
    } else validateRelativePath(relativePath, label);
  }

  if (!isPlainObject(manifest.glyphs)) {
    fail("glyphs must describe a local template, font stacks, ranges, and coverage");
  } else {
    const glyphs = manifest.glyphs;
    const templateOkay = validateRelativePath(glyphs.template, "glyphs.template", { placeholders: true });
    if (templateOkay && glyphs.template.includes("{fontstack}") && glyphs.template.includes("{range}")) pass("glyph template is local and parameterized"); else fail("glyphs.template must contain {fontstack} and {range}");
    if (!Array.isArray(glyphs.fontStacks) || glyphs.fontStacks.length === 0 || !Array.isArray(glyphs.ranges) || glyphs.ranges.length === 0) {
      fail("glyphs.fontStacks and glyphs.ranges must be non-empty arrays");
    } else if (hashes) {
      const expectedStacks = ["Noto Sans Regular", "Noto Sans Bold", "Noto Sans Italic"];
      const missingStacks = expectedStacks.filter((stack) => !glyphs.fontStacks.includes(stack));
      if (missingStacks.length > 0) fail(`glyphs missing frozen font stack(s): ${missingStacks.join(", ")}`);
      else pass("glyphs list all three frozen font stacks");
      for (const stack of glyphs.fontStacks) {
        for (const rangeName of glyphs.ranges) {
          const glyphPath = glyphs.template.replace("{fontstack}", stack).replace("{range}", rangeName);
          if (!(glyphPath in hashes)) fail(`sha256 is missing glyph entry: ${glyphPath}`);
          else if (checkFileAndHash(MAP_ROOT, glyphPath, hashes[glyphPath], `glyph ${stack}/${rangeName}`)) pass(`glyph exists and SHA-256 matches: ${stack}/${rangeName}`);
        }
      }
    }
    if (typeof glyphs.coverage === "string" && glyphs.coverage.trim()) pass("glyph coverage is documented"); else fail("glyphs.coverage must be documented");
  }

  if (manifest.sprite === null) pass("sprite is explicitly null"); else fail("sprite must be explicitly null for the frozen Hybrid style");
  if (Array.isArray(manifest.textures) && manifest.textures.length === 0) pass("textures is explicitly empty"); else fail("textures must be an explicit empty array for the frozen Hybrid style");

  if (hashes) {
    for (const [path, hash] of Object.entries(hashes)) {
      if (checkFileAndHash(MAP_ROOT, path, hash, `sha256[${path}]`)) info(`verified declared hash ${path}`);
    }
  }

  group("Hybrid style and PMTiles structure");
  if (typeof manifest.style === "string") {
    const stylePath = resolveInside(MAP_ROOT, manifest.style, "style");
    if (stylePath && existsSync(stylePath)) {
      try {
        const style = JSON.parse(readFileSync(stylePath, "utf8"));
        if (style.version === 8 && style.name === "Hybrid") pass("style is MapLibre v8 and named Hybrid"); else fail("style must be MapLibre v8 and named Hybrid");
        if (style.glyphs === manifest.glyphs?.template) pass("style glyph template matches manifest"); else fail("style glyph template does not match manifest");
        const source = style.sources?.[manifest.sourceId];
        if (source?.type === "vector" && source.url === `pmtiles://${manifest.tiles}`) pass("Hybrid source is the frozen vector source and points to local PMTiles"); else fail("Hybrid source must be vector and point to pmtiles://<manifest.tiles>");
        const styleLayers = [...new Set((style.layers ?? []).map((layer) => layer["source-layer"]).filter(Boolean))];
        const missing = FROZEN_LAYERS.filter((layer) => !styleLayers.includes(layer));
        const extra = styleLayers.filter((layer) => !FROZEN_LAYERS.includes(layer));
        if (missing.length === 0 && extra.length === 0) pass("Hybrid style references exactly the 10 frozen source-layers"); else fail(`Hybrid source-layer mismatch; missing=[${missing.join(", ")}], extra=[${extra.join(", ")}]`);
        const external = findExternalUrls(style);
        if (external.length === 0) pass("Hybrid style has no external HTTP(S) resource URL"); else fail(`Hybrid style contains external URL(s): ${external.join("; ")}`);
      } catch (error) {
        fail(`style.json cannot be parsed: ${error.message}`);
      }
    }
  }

  if (typeof manifest.tiles === "string") {
    const archivePath = resolveInside(MAP_ROOT, manifest.tiles, "tiles");
    if (archivePath && existsSync(archivePath)) {
      const header = readFileSync(archivePath).subarray(0, 8);
      if (header.subarray(0, 7).toString("ascii") === "PMTiles" && header[7] === 3) pass("archive magic declares PMTiles spec v3"); else fail("archive does not declare PMTiles spec v3");
      if (isPlainObject(manifest.pmtilesHeader)) {
        const h = manifest.pmtilesHeader;
        if (h.tile_type === "mvt") pass("PMTiles header tile_type is mvt"); else fail("PMTiles header tile_type must be mvt");
        if (h.minzoom === manifest.minZoom && h.maxzoom === manifest.maxZoom) pass("PMTiles header zooms match manifest"); else fail("PMTiles header zooms do not match manifest");
        if (sameNumbers(h.bounds, manifest.bounds)) pass("PMTiles header bounds match manifest"); else fail("PMTiles header bounds do not match manifest");
      } else fail("pmtilesHeader evidence is missing from manifest");

      const pmtilesCommand = options.pmtiles || "pmtiles";
      const versionResult = spawnSync(pmtilesCommand, ["version"], { encoding: "utf8", windowsHide: true });
      if (versionResult.error?.code === "ENOENT") {
        blocked(`PMTiles CLI is unavailable (${pmtilesCommand}); verify cannot be silently skipped`);
      } else if (versionResult.status !== 0) {
        fail(`PMTiles CLI version failed: ${(versionResult.stderr || versionResult.stdout || versionResult.error?.message || "unknown error").trim()}`);
      } else {
        pass(`PMTiles CLI available: ${(versionResult.stdout || versionResult.stderr).trim()}`);
        const verifyResult = spawnSync(pmtilesCommand, ["verify", archivePath], { encoding: "utf8", windowsHide: true });
        if (verifyResult.status === 0) pass(`pmtiles verify passed: ${(verifyResult.stdout || verifyResult.stderr).trim() || "exit 0"}`);
        else fail(`pmtiles verify failed: ${(verifyResult.stderr || verifyResult.stdout || verifyResult.error?.message || "unknown error").trim()}`);
      }
    }
  }
}

function resolveAlias(aliasMap, key, canonical, label) {
  const seen = new Set();
  let current = key;
  while (Object.hasOwn(aliasMap, current)) {
    if (seen.has(current)) {
      fail(`${label} alias cycle detected at ${current}`);
      return null;
    }
    seen.add(current);
    const next = aliasMap[current];
    if (next === current) {
      fail(`${label} alias self-reference: ${current}`);
      return null;
    }
    current = next;
  }
  if (!canonical.has(current)) {
    fail(`${label} alias ${key} resolves to missing canonical key ${current}`);
    return null;
  }
  return current;
}

function checkFoodManifest(manifest) {
  group("Food icon manifest contract");
  if (!manifest) return;
  if (manifest.schemaVersion === 1) pass("schemaVersion is 1"); else fail("schemaVersion must be 1");
  if (typeof manifest.assetVersion === "string" && /^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(manifest.assetVersion)) pass(`assetVersion is concrete: ${manifest.assetVersion}`); else fail("assetVersion must be a concrete YYYY.MM.DD.N value");
  const cuisineEntries = Array.isArray(manifest.cuisines) ? manifest.cuisines : [];
  const cuisineKeys = cuisineEntries.map((item) => item?.key);
  const missingCuisines = CUISINES.filter((key) => !cuisineKeys.includes(key));
  const extraCuisines = cuisineKeys.filter((key) => !CUISINES.includes(key));
  if (missingCuisines.length === 0 && extraCuisines.length === 0 && new Set(cuisineKeys).size === CUISINES.length && cuisineKeys.every((key, index) => key === CUISINES[index])) pass("cuisines exactly match the 25 canonical keys in order");
  else fail(`cuisine mismatch; missing=[${missingCuisines.join(", ")}], extra=[${extraCuisines.join(", ")}]`);
  if (!isPlainObject(manifest.icons)) fail("icons must be an object keyed by canonical iconKey");

  const icons = isPlainObject(manifest.icons) ? manifest.icons : {};
  const iconKeys = new Set(Object.keys(icons));
  const referenced = new Set();
  for (const cuisine of cuisineEntries) {
    if (!isPlainObject(cuisine) || typeof cuisine.label !== "string" || !Number.isInteger(cuisine.sortOrder) || !Array.isArray(cuisine.icons)) {
      fail(`cuisine entry ${JSON.stringify(cuisine?.key)} must contain label, integer sortOrder, and icons[]`);
      continue;
    }
    const cuisineIndex = CUISINES.indexOf(cuisine.key);
    if (cuisineIndex >= 0 && cuisine.label !== CUISINE_LABELS[cuisineIndex]) fail(`${cuisine.key} label/order mismatch; expected ${CUISINE_LABELS[cuisineIndex]}`);
    if (cuisineIndex >= 0 && cuisine.sortOrder !== (cuisineIndex === CUISINES.length - 1 ? 999 : (cuisineIndex + 1) * 10)) fail(`${cuisine.key} sortOrder mismatch`);
    if (cuisine.icons.length !== 3) fail(`${cuisine.key} must contain exactly 3 icons`);
    else pass(`${cuisine.key} declares exactly 3 icons`);
    for (const iconKey of cuisine.icons) {
      if (!new RegExp(`^${cuisine.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.shop\\.\\d{2}$`).test(iconKey)) fail(`${iconKey} is not a canonical ${cuisine.key}.shop.NN iconKey`);
      if (!iconKeys.has(iconKey)) fail(`${cuisine.key} references missing icon ${iconKey}`);
      if (referenced.has(iconKey)) fail(`iconKey is referenced more than once: ${iconKey}`);
      referenced.add(iconKey);
    }
  }
  for (const iconKey of iconKeys) if (!referenced.has(iconKey)) fail(`unreferenced canonical icon entry: ${iconKey}`);

  const paths = new Set();
  let validIconCount = 0;
  for (const [iconKey, entry] of Object.entries(icons)) {
    const label = `icon ${iconKey}`;
    if (!isPlainObject(entry)) { fail(`${label} must be an object`); continue; }
    if (entry.width !== 128 || entry.height !== 128) fail(`${label} manifest dimensions must be 128x128`);
    if (entry.pixelRatio !== 2) fail(`${label} pixelRatio must be 2`);
    if (entry.anchor !== "bottom") fail(`${label} anchor must be bottom`);
    if (entry.sdf !== false) fail(`${label} sdf must be false`);
    if (paths.has(entry.src)) fail(`${label} duplicates src path ${entry.src}`); else paths.add(entry.src);
    if (checkFileAndHash(FOOD_ROOT, entry.src, entry.sha256, label)) {
      try {
        const png = inspectPng(resolveInside(FOOD_ROOT, entry.src, label));
        if (png.width === 128 && png.height === 128) pass(`${label} PNG dimensions are 128x128`); else fail(`${label} actual PNG dimensions are ${png.width}x${png.height}`);
        if (png.bitDepth === 8 && png.hasAlphaChannel) pass(`${label} is 8-bit PNG with alpha channel`); else fail(`${label} must be an 8-bit PNG with alpha channel`);
        if (png.transparentBorder) pass(`${label} retains a transparent safety margin`); else fail(`${label} must retain a transparent safety margin on every canvas edge`);
        validIconCount += 1;
      } catch (error) { fail(`${label} PNG validation failed: ${error.message}`); }
    }
  }
  if (validIconCount === CUISINES.length * 3) pass(`validated exactly ${validIconCount} canonical PNG icons`); else fail(`validated ${validIconCount} canonical PNG icons; exactly ${CUISINES.length * 3} required`);

  if (manifest.fallbackIconKey === "snacks.shop.01" && iconKeys.has(manifest.fallbackIconKey)) pass("fallbackIconKey is the existing canonical snacks.shop.01"); else fail("fallbackIconKey must resolve to existing canonical snacks.shop.01");
  const cuisineAliases = manifest.aliases?.cuisines;
  const iconAliases = manifest.aliases?.icons;
  if (!isPlainObject(cuisineAliases) || !isPlainObject(iconAliases)) fail("aliases must contain cuisines and icons objects");
  else {
    const canonicalCuisines = new Set(CUISINES);
    for (const key of Object.keys(cuisineAliases)) resolveAlias(cuisineAliases, key, canonicalCuisines, "cuisine");
    for (const key of Object.keys(iconAliases)) resolveAlias(iconAliases, key, iconKeys, "icon");
    if (resolveAlias(cuisineAliases, "cafe", canonicalCuisines, "cuisine") === "coffee") pass("cafe cuisine alias resolves to coffee"); else fail("cafe cuisine alias must resolve to coffee");
    if (resolveAlias(iconAliases, "food-coffee", iconKeys, "icon")?.startsWith("coffee.shop.")) pass("food-coffee icon alias resolves to a canonical coffee icon"); else fail("food-coffee icon alias must resolve to a canonical coffee icon");
  }

  if (!isPlainObject(manifest.overlays)) fail("overlays must be an object");
  else {
    const overlayKeys = Object.keys(manifest.overlays);
    const missing = OVERLAYS.filter((key) => !overlayKeys.includes(key));
    if (missing.length === 0) pass("all 7 required overlay entries exist"); else fail(`missing overlay entries: ${missing.join(", ")}`);
    for (const [key, entry] of Object.entries(manifest.overlays)) {
      const label = `overlay ${key}`;
      if (!isPlainObject(entry)) { fail(`${label} must be an object`); continue; }
      if (!Number.isInteger(entry.width) || entry.width <= 0 || !Number.isInteger(entry.height) || entry.height <= 0) fail(`${label} dimensions must be positive integers`);
      if (typeof entry.pixelRatio !== "number" || entry.pixelRatio <= 0) fail(`${label} pixelRatio must be positive`);
      if (typeof entry.anchor !== "string" || !entry.anchor) fail(`${label} anchor must be declared`);
      if (typeof entry.sdf !== "boolean") fail(`${label} sdf must be boolean`);
      if (paths.has(entry.src)) fail(`${label} duplicates src path ${entry.src}`); else paths.add(entry.src);
      if (checkFileAndHash(FOOD_ROOT, entry.src, entry.sha256, label)) {
        try {
          const png = inspectPng(resolveInside(FOOD_ROOT, entry.src, label));
          if (png.width === entry.width && png.height === entry.height && png.hasAlphaChannel) pass(`${label} PNG dimensions/alpha match manifest`);
          else fail(`${label} PNG dimensions/alpha do not match manifest`);
        } catch (error) { fail(`${label} PNG validation failed: ${error.message}`); }
      }
    }
  }
}

function main() {
  const options = parseArgs();
  group("Required manifests");
  const mapManifest = readJson(MAP_MANIFEST_PATH, "map manifest");
  const foodManifest = readJson(FOOD_MANIFEST_PATH, "food icon manifest");
  checkMapManifest(mapManifest, options);
  checkFoodManifest(foodManifest);

  group("Summary");
  const failures = results.filter((result) => result.status === "FAIL");
  const blockers = results.filter((result) => result.status === "BLOCKED");
  const passes = results.filter((result) => result.status === "PASS");
  info(`PASS=${passes.length} FAIL=${failures.length} BLOCKED=${blockers.length}`);
  if (failures.length > 0 || blockers.length > 0) {
    console.log("BLOCKED asset package is not acceptable for stage-0 release");
    process.exitCode = 1;
  } else {
    console.log("PASS all stage-0 asset checks completed");
  }
}

try {
  main();
} catch (error) {
  fail(`unexpected checker error: ${error.stack ?? error.message}`);
  console.log("BLOCKED asset checker failed closed");
  process.exitCode = 1;
}
