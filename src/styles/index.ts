import type { StyleSpecification } from "maplibre-gl";
import { cyberpunkStyle } from "./cyberpunk";
import { gothicStyle } from "./gothic";
import { hybridStyle } from "./hybrid";
import { morandiStyle } from "./morandi";
import { pixelRpgStyle } from "./pixelRpg";
import { softAnimeStyle } from "./softAnime";
import { steampunkStyle } from "./steampunk";
import { xianxiaStyle } from "./xianxia";

export const STYLE_CATALOG = {
  "soft-anime": softAnimeStyle,
  "pixel-rpg": pixelRpgStyle,
  hybrid: hybridStyle,
  morandi: morandiStyle,
  gothic: gothicStyle,
  cyberpunk: cyberpunkStyle,
  xianxia: xianxiaStyle,
  steampunk: steampunkStyle,
} satisfies Record<string, StyleSpecification>;

export type StyleKey = keyof typeof STYLE_CATALOG;
