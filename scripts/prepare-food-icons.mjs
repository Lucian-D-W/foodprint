#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const OUTPUT_ROOT = join(REPO_ROOT, "resources", "food-icons");
const ASSET_VERSION = "2026.08.31.1";

const CUISINES = [
  ["dimsum_dumpling", "点心饺子", ["#d45d79", "#f4bf7b", "#fff0d2"]],
  ["burger", "汉堡", ["#a85a3c", "#e6ad55", "#fff0c5"]],
  ["pasta_pizza", "意面披萨", ["#c54f45", "#e2a44c", "#f8e6c0"]],
  ["buns", "包子", ["#c27a57", "#efd39c", "#fff4db"]],
  ["fast_meal", "快餐便当", ["#2f7d63", "#efb84e", "#f7efd2"]],
  ["rice_noodles", "米粉面馆", ["#4f8392", "#e7bd73", "#eff3da"]],
  ["malatang", "麻辣烫", ["#cf473e", "#e78b3b", "#fff0c4"]],
  ["sichuan_hunan", "川湘菜馆", ["#b33936", "#d7a347", "#f6e6c5"]],
  ["cantonese", "粤菜", ["#b64545", "#e8b04a", "#f8e7c0"]],
  ["jinghu_lu", "京沪鲁菜", ["#6f5572", "#d99a53", "#f4e6cf"]],
  ["fried_chicken", "炸鸡", ["#d48a28", "#e45f4b", "#fff0cf"]],
  ["snacks", "小吃", ["#bf6a4b", "#dca052", "#fff1cf"]],
  ["braised_duck", "鸭脖卤味", ["#6d4652", "#b77048", "#f4dfc2"]],
  ["japanese", "日式料理", ["#3d7295", "#e3af80", "#f5ead5"]],
  ["korean", "韩式料理", ["#6473a7", "#e6b151", "#f8efcf"]],
  ["dry_pot", "香锅", ["#8c4b32", "#de9a39", "#ffedc1"]],
  ["hotpot", "火锅", ["#b94a3c", "#f2c14e", "#fff1d0"]],
  ["lobster_bbq", "龙虾烧烤", ["#d75843", "#ed9b4a", "#ffeed3"]],
  ["salad", "沙拉", ["#3c9568", "#e4bf5b", "#f4f2cf"]],
  ["milk_tea_juice", "奶茶果汁", ["#7c5b92", "#e4a986", "#f7e4da"]],
  ["coffee", "咖啡", ["#6e4d3a", "#c99562", "#f3dfc2"]],
  ["bakery_pastry", "面包糕点", ["#a85e69", "#e8b76a", "#fff0cf"]],
  ["dessert", "甜品", ["#a85d97", "#efa8a0", "#fff0d8"]],
  ["south_asian", "南亚菜系", ["#d36b2c", "#f2b84b", "#fff0c2"]],
  ["southeast_asian", "东南亚菜系", ["#438a5e", "#e9b872", "#f7f3df"]],
];
const LEGACY_CUISINE_KEYS = [
  "thai", "vietnamese", "indian", "noodles", "congee", "dimsum", "cafe", "bakery", "western", "other",
];

const rgba = (hex, alpha = 255) => {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, alpha];
};

function canvas(width, height) {
  const pixels = Buffer.alloc(width * height * 4);
  const set = (x, y, color) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const offset = (Math.floor(y) * width + Math.floor(x)) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = color[3];
  };
  const rect = (x, y, w, h, color) => {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy += 1) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx += 1) set(xx, yy, color);
    }
  };
  const circle = (cx, cy, radius, color) => {
    const r2 = radius * radius;
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r2) set(x, y, color);
      }
    }
  };
  const polygon = (points, color) => {
    const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point[1]))));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((point) => point[1]))));
    for (let y = minY; y <= maxY; y += 1) {
      const intersections = [];
      for (let index = 0; index < points.length; index += 1) {
        const first = points[index];
        const second = points[(index + 1) % points.length];
        if ((first[1] <= y && second[1] > y) || (second[1] <= y && first[1] > y)) {
          intersections.push(first[0] + ((y - first[1]) * (second[0] - first[0])) / (second[1] - first[1]));
        }
      }
      intersections.sort((a, b) => a - b);
      for (let index = 0; index < intersections.length; index += 2) {
        for (let x = Math.ceil(intersections[index]); x <= Math.floor(intersections[index + 1]); x += 1) set(x, y, color);
      }
    }
  };
  const line = (x0, y0, x1, y1, thickness, color) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let step = 0; step <= steps; step += 1) {
      const x = x0 + ((x1 - x0) * step) / steps;
      const y = y0 + ((y1 - y0) * step) / steps;
      circle(x, y, thickness / 2, color);
    }
  };
  return { width, height, pixels, set, rect, circle, polygon, line };
}

function drawEmblem(d, cuisine, variant) {
  const dark = rgba("#493b35");
  const light = rgba("#fff5d6");
  const accent = rgba(variant === 1 ? "#e85d4a" : variant === 2 ? "#4f9f76" : "#e2a53b");
  const cx = 64;
  const cy = 72;
  if (cuisine === "dimsum_dumpling") {
    d.rect(50, 70, 28, 15, accent); d.rect(48, 68, 32, 4, dark); d.line(55, 72, 55, 83, 2, light); d.line(64, 72, 64, 83, 2, light); d.line(73, 72, 73, 83, 2, light); return;
  }
  if (cuisine === "burger") {
    d.polygon([[49, 69], [54, 62], [74, 62], [79, 69]], accent); d.rect(49, 70, 30, 5, dark); d.rect(52, 76, 24, 4, light); d.rect(49, 81, 30, 5, accent); return;
  }
  if (cuisine === "pasta_pizza") {
    d.circle(cx, 76, 14, light); d.polygon([[51, 80], [64, 61], [77, 80]], accent); d.circle(59, 76, 2, dark); d.circle(67, 70, 2, dark); d.circle(70, 78, 2, dark); return;
  }
  if (cuisine === "buns") {
    d.circle(56, 75, 9, accent); d.circle(72, 75, 9, accent); d.circle(64, 67, 9, light); d.line(58, 67, 56, 73, 2, dark); d.line(70, 67, 72, 73, 2, dark); return;
  }
  if (cuisine === "fast_meal") {
    d.rect(49, 66, 30, 20, accent); d.line(64, 67, 64, 85, 2, dark); d.line(50, 76, 78, 76, 2, dark); d.circle(56, 71, 2, light); d.circle(71, 81, 3, light); return;
  }
  if (cuisine === "rice_noodles") {
    d.rect(50, 72, 28, 4, dark); d.polygon([[52, 76], [76, 76], [72, 85], [56, 85]], accent); d.line(57, 67, 54, 61, 2, light); d.line(64, 67, 63, 60, 2, light); d.line(71, 67, 74, 61, 2, light); d.line(77, 60, 68, 77, 2, dark); d.line(82, 61, 73, 78, 2, dark); return;
  }
  if (cuisine === "malatang") {
    d.rect(50, 73, 28, 4, dark); d.polygon([[52, 77], [76, 77], [72, 85], [56, 85]], accent); d.line(56, 61, 58, 77, 2, dark); d.line(64, 59, 64, 77, 2, dark); d.line(72, 61, 70, 77, 2, dark); d.circle(56, 63, 3, light); d.circle(64, 61, 3, light); d.circle(72, 63, 3, light); return;
  }
  if (cuisine === "sichuan_hunan") {
    d.line(53, 84, 59, 64, 4, accent); d.line(64, 84, 68, 61, 4, accent); d.line(75, 84, 77, 67, 4, accent); d.circle(58, 63, 3, dark); d.circle(67, 60, 3, dark); d.circle(77, 66, 3, dark); return;
  }
  if (cuisine === "cantonese") {
    d.circle(61, 74, 10, accent); d.rect(54, 65, 14, 4, dark); d.line(70, 70, 79, 75, 3, dark); d.circle(79, 75, 3, dark); d.line(52, 70, 47, 75, 3, dark); return;
  }
  if (cuisine === "jinghu_lu") {
    d.rect(49, 70, 30, 13, accent); d.rect(46, 67, 36, 4, dark); d.circle(56, 76, 4, light); d.circle(72, 76, 4, light); d.line(53, 84, 75, 84, 2, dark); return;
  }
  if (cuisine === "fried_chicken") {
    d.circle(62, 74, 11, accent); d.circle(72, 68, 7, light); d.line(55, 81, 47, 86, 5, dark); d.line(58, 80, 51, 87, 4, accent); return;
  }
  if (cuisine === "snacks") {
    d.line(52, 61, 61, 84, 2, dark); d.line(64, 60, 64, 84, 2, dark); d.line(76, 61, 67, 84, 2, dark); d.circle(54, 66, 5, accent); d.circle(64, 69, 5, light); d.circle(74, 66, 5, accent); return;
  }
  if (cuisine === "braised_duck") {
    d.circle(61, 73, 10, accent); d.circle(72, 68, 7, accent); d.polygon([[78, 68], [85, 71], [78, 74]], light); d.line(55, 81, 52, 87, 3, dark); d.line(66, 81, 69, 87, 3, dark); return;
  }
  if (cuisine === "japanese") {
    d.polygon([[50, 74], [78, 74], [73, 83], [55, 83]], accent); d.rect(53, 70, 22, 5, light); d.line(58, 68, 58, 61, 2, dark); d.line(70, 68, 70, 61, 2, dark); return;
  }
  if (cuisine === "korean") {
    d.rect(50, 70, 28, 4, dark); d.polygon([[52, 74], [76, 74], [72, 85], [56, 85]], accent); d.circle(59, 77, 2, light); d.circle(69, 80, 2, light); d.line(55, 66, 51, 61, 2, dark); d.line(73, 66, 77, 61, 2, dark); return;
  }
  if (cuisine === "dry_pot") {
    d.rect(50, 72, 28, 12, accent); d.rect(46, 74, 5, 7, dark); d.rect(77, 74, 5, 7, dark); d.circle(56, 75, 3, light); d.circle(64, 80, 3, light); d.circle(72, 75, 3, light); return;
  }
  if (cuisine === "hotpot") {
    d.rect(50, 72, 28, 4, dark); d.polygon([[52, 76], [76, 76], [72, 85], [56, 85]], accent); d.line(57, 67, 54, 61, 2, light); d.line(64, 67, 63, 60, 2, light); d.line(71, 67, 74, 61, 2, light); return;
  }
  if (cuisine === "lobster_bbq") {
    d.line(52, 78, 76, 68, 4, accent); d.circle(76, 68, 6, accent); d.line(53, 78, 47, 72, 3, dark); d.line(55, 82, 47, 84, 3, dark); d.line(76, 65, 83, 60, 2, dark); d.line(78, 71, 84, 75, 2, dark); return;
  }
  if (cuisine === "salad") {
    d.polygon([[49, 79], [79, 79], [74, 85], [54, 85]], light); d.line(64, 82, 57, 63, 3, dark); d.polygon([[58, 70], [47, 63], [58, 61], [64, 70]], accent); d.polygon([[67, 72], [78, 62], [80, 72], [70, 77]], accent); return;
  }
  if (cuisine === "milk_tea_juice") {
    d.rect(54, 68, 20, 18, accent); d.rect(57, 72, 14, 11, light); d.line(64, 68, 68, 58, 2, dark); d.circle(59, 78, 2, dark); d.circle(65, 78, 2, dark); return;
  }
  if (cuisine === "coffee") {
    d.rect(52, 66, 21, 17, accent); d.circle(73, 74, 7, dark); d.circle(73, 74, 4, light); d.line(57, 63, 55, 58, 2, light); d.line(65, 63, 67, 57, 2, light); return;
  }
  if (cuisine === "bakery_pastry") {
    d.circle(64, 73, 14, accent); d.circle(64, 68, 11, light); d.circle(64, 70, 8, accent); d.line(53, 79, 75, 79, 3, dark); return;
  }
  if (cuisine === "dessert") {
    d.rect(50, 79, 28, 5, accent); d.polygon([[53, 79], [76, 79], [69, 66], [60, 66]], light); d.circle(64, 63, 4, accent); return;
  }
  if (cuisine === "south_asian") {
    d.circle(cx, 74, 12, light); d.circle(cx, 74, 8, accent); d.circle(59, 75, 2, dark); d.circle(69, 72, 2, dark); d.line(53, 61, 54, 68, 2, dark); d.line(75, 61, 74, 68, 2, dark); return;
  }
  if (cuisine === "southeast_asian") {
    d.rect(50, 72, 28, 4, dark); d.polygon([[52, 76], [76, 76], [72, 85], [56, 85]], accent); d.line(57, 67, 54, 61, 2, light); d.line(64, 67, 63, 60, 2, light); d.line(71, 67, 74, 61, 2, light); d.polygon([[64, 69], [53, 63], [56, 75]], light); return;
  }
  const points = [];
  for (let index = 0; index < 10; index += 1) {
    const radius = index % 2 === 0 ? 14 : 6;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  d.polygon(points, accent);
}

function drawShop(cuisine, palette, variant) {
  const d = canvas(128, 128);
  const outline = rgba("#493b35");
  const wall = rgba(palette[2]);
  const primary = rgba(palette[0]);
  const secondary = rgba(palette[1]);
  d.rect(23, 54, 82, 62, outline);
  d.rect(27, 58, 74, 54, wall);
  if (variant === 1) {
    d.rect(18, 42, 92, 18, outline); d.rect(22, 45, 84, 11, secondary);
    for (let x = 22; x < 106; x += 14) d.rect(x, 45, 7, 11, primary);
  } else if (variant === 2) {
    d.polygon([[16, 58], [64, 27], [112, 58]], outline); d.polygon([[23, 54], [64, 33], [105, 54]], primary); d.circle(64, 43, 5, secondary);
  } else {
    d.polygon([[17, 55], [25, 43], [103, 43], [111, 55]], outline); d.polygon([[23, 52], [29, 47], [99, 47], [105, 52]], secondary);
    d.rect(30, 35, 68, 10, outline); d.rect(34, 38, 60, 5, primary);
  }
  d.rect(33, 65, 24, 25, outline); d.rect(37, 69, 16, 17, rgba("#9fd3d7"));
  d.rect(71, 65, 24, 47, outline); d.rect(75, 69, 16, 43, primary); d.circle(86, 91, 2, secondary);
  d.rect(44, 92, 40, 5, outline); d.rect(48, 96, 32, 15, secondary);
  drawEmblem(d, cuisine, variant);
  d.rect(19, 114, 90, 3, rgba("#6b625b"));
  return d;
}

function drawRating(count) {
  const d = canvas(64, 64);
  const dark = rgba("#554331");
  d.circle(32, 32, 27, rgba("#fff1c9", 238)); d.circle(32, 32, 24, rgba("#d88938", 245));
  const spacing = count <= 3 ? 16 : 11;
  const start = 32 - ((count - 1) * spacing) / 2;
  for (let star = 0; star < count; star += 1) {
    const points = [];
    for (let index = 0; index < 10; index += 1) {
      const radius = index % 2 === 0 ? (count <= 3 ? 7 : 5) : (count <= 3 ? 3 : 2.2);
      const angle = -Math.PI / 2 + (index * Math.PI) / 5;
      points.push([start + star * spacing + Math.cos(angle) * radius, 32 + Math.sin(angle) * radius]);
    }
    d.polygon(points, dark);
  }
  return d;
}

function drawBadge(kind) {
  const d = canvas(64, 64);
  const outline = rgba("#493b35");
  if (kind === "bookmark-badge") {
    d.polygon([[18, 8], [46, 8], [46, 55], [32, 45], [18, 55]], outline);
    d.polygon([[23, 13], [41, 13], [41, 45], [32, 38], [23, 45]], rgba("#e8b84f"));
  } else {
    d.circle(32, 32, 25, outline); d.circle(32, 32, 19, rgba("#d6534d")); d.line(20, 20, 44, 44, 8, rgba("#fff1d0"));
  }
  return d;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(d) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(d.width, 0); ihdr.writeUInt32BE(d.height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < d.height; y += 1) rows.push(Buffer.from([0]), d.pixels.subarray(y * d.width * 4, (y + 1) * d.width * 4));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function save(relativePath, drawing) {
  const output = encodePng(drawing);
  const absolutePath = join(OUTPUT_ROOT, ...relativePath.split("/"));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, output);
  return sha256(output);
}

async function main() {
  await Promise.all(
    LEGACY_CUISINE_KEYS.map((key) => rm(join(OUTPUT_ROOT, key), { recursive: true, force: true })),
  );
  const cuisines = [];
  const icons = {};
  for (let cuisineIndex = 0; cuisineIndex < CUISINES.length; cuisineIndex += 1) {
    const [key, label, palette] = CUISINES[cuisineIndex];
    const cuisineIcons = [];
    for (let variant = 1; variant <= 3; variant += 1) {
      const suffix = String(variant).padStart(2, "0");
      const iconKey = `${key}.shop.${suffix}`;
      const src = `${key}/${key}-shop-${suffix}.png`;
      cuisineIcons.push(iconKey);
      icons[iconKey] = { src, width: 128, height: 128, pixelRatio: 2, anchor: "bottom", sdf: false, sha256: await save(src, drawShop(key, palette, variant)) };
    }
    cuisines.push({ key, label, sortOrder: cuisineIndex === CUISINES.length - 1 ? 999 : (cuisineIndex + 1) * 10, icons: cuisineIcons });
  }

  const overlays = {};
  for (let rating = 1; rating <= 5; rating += 1) {
    const key = `rating-${rating}`;
    const src = `overlays/${key}.png`;
    overlays[key] = { src, width: 64, height: 64, pixelRatio: 2, anchor: "center", sdf: false, sha256: await save(src, drawRating(rating)) };
  }
  for (const key of ["bookmark-badge", "avoid-badge"]) {
    const src = `overlays/${key}.png`;
    overlays[key] = { src, width: 64, height: 64, pixelRatio: 2, anchor: "center", sdf: false, sha256: await save(src, drawBadge(key)) };
  }

  const manifest = {
    schemaVersion: 1,
    assetVersion: ASSET_VERSION,
    fallbackIconKey: "snacks.shop.01",
    cuisines,
    icons,
    aliases: {
      cuisines: {
        thai: "southeast_asian",
        vietnamese: "southeast_asian",
        indian: "south_asian",
        noodles: "rice_noodles",
        congee: "fast_meal",
        dimsum: "dimsum_dumpling",
        cafe: "coffee",
        bakery: "bakery_pastry",
        western: "pasta_pizza",
        other: "snacks",
      },
      icons: {
        "food-hotpot": "hotpot.shop.01",
        "food-coffee": "coffee.shop.01",
        "food-noodles": "rice_noodles.shop.01",
        "food-thai": "southeast_asian.shop.01",
        "food-vietnamese": "southeast_asian.shop.01",
        "food-western": "pasta_pizza.shop.01",
        "thai.shop.01": "southeast_asian.shop.01",
        "thai.shop.02": "southeast_asian.shop.02",
        "thai.shop.03": "southeast_asian.shop.03",
        "vietnamese.shop.01": "southeast_asian.shop.01",
        "vietnamese.shop.02": "southeast_asian.shop.02",
        "vietnamese.shop.03": "southeast_asian.shop.03",
        "indian.shop.01": "south_asian.shop.01",
        "indian.shop.02": "south_asian.shop.02",
        "indian.shop.03": "south_asian.shop.03",
        "noodles.shop.01": "rice_noodles.shop.01",
        "noodles.shop.02": "rice_noodles.shop.02",
        "noodles.shop.03": "rice_noodles.shop.03",
        "congee.shop.01": "fast_meal.shop.01",
        "congee.shop.02": "fast_meal.shop.02",
        "congee.shop.03": "fast_meal.shop.03",
        "dimsum.shop.01": "dimsum_dumpling.shop.01",
        "dimsum.shop.02": "dimsum_dumpling.shop.02",
        "dimsum.shop.03": "dimsum_dumpling.shop.03",
        "cafe.shop.01": "coffee.shop.01",
        "cafe.shop.02": "coffee.shop.02",
        "cafe.shop.03": "coffee.shop.03",
        "bakery.shop.01": "bakery_pastry.shop.01",
        "bakery.shop.02": "bakery_pastry.shop.02",
        "bakery.shop.03": "bakery_pastry.shop.03",
        "western.shop.01": "pasta_pizza.shop.01",
        "western.shop.02": "pasta_pizza.shop.02",
        "western.shop.03": "pasta_pizza.shop.03",
        "other.shop.01": "snacks.shop.01",
        "other.shop.02": "snacks.shop.02",
        "other.shop.03": "snacks.shop.03"
      }
    },
    overlays,
    provenance: {
      kind: "project-authored-deterministic-raster",
      generator: "scripts/prepare-food-icons.mjs",
      generatedAt: "2026-08-30T00:00:00+08:00",
      license: "Project-owned; no third-party artwork embedded",
    derivation: "Original pixel-inspired storefronts derived from the confirmed V1 cuisine/icon contract; existing prototype SVGs were visual references only and were not copied as binary assets."
    }
  };
  await writeFile(join(OUTPUT_ROOT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`PASS food-icons: generated ${Object.keys(icons).length} canonical icons and ${Object.keys(overlays).length} overlays`);
  console.log(`PASS manifest: ${join(OUTPUT_ROOT, "manifest.json")}`);
}

main().catch((error) => {
  console.error(`FAIL food-icons: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
