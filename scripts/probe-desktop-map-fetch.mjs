import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
// FOODMAP_TEST_DATA_ROOT is supported by debug binaries. Build with
// `corepack pnpm tauri build --debug --no-bundle` before running this probe.
const executable = join(root, "src-tauri", "target", "debug", "foodmap.exe");
const sandbox = await mkdtemp(join(tmpdir(), "foodmap-desktop-map-probe-"));
const logPath = join(process.env.LOCALAPPDATA, "com.dean.foodmap", "logs", "foodmap.log");
const logBefore = await readFile(logPath, "utf8").catch(() => "");
const port = 9232;
let child;
let browser;

try {
  child = spawn(executable, [], {
    env: {
      ...process.env,
      FOODMAP_TEST_DATA_ROOT: sandbox,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
      WEBVIEW2_USER_DATA_FOLDER: join(sandbox, "webview2-profile"),
    },
    windowsHide: true,
    stdio: "ignore",
  });
  const deadline = Date.now() + 20_000;
  let page;
  while (Date.now() < deadline && !page) {
    if (child.exitCode !== null) throw new Error("The isolated FoodMap process exited before startup");
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url() !== "about:blank");
      if (!page) {
        await browser.close();
        browser = undefined;
      }
    } catch {
      // WebView2 has not exposed the page yet.
    }
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!page) throw new Error("WebView2 did not expose the FoodMap page");
  await stat(join(sandbox, "db", "foodmap.sqlite3"));
  const cdp = await page.context().newCDPSession(page);
  const requestExtraInfo = [];
  const responseExtraInfo = [];
  const styleRequestIds = new Set();
  cdp.on("Network.requestWillBeSent", (event) => {
    if (event.request.url.includes("/maps/default/style.json")) styleRequestIds.add(event.requestId);
  });
  cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
    if (styleRequestIds.has(event.requestId)) requestExtraInfo.push(event);
  });
  cdp.on("Network.responseReceivedExtraInfo", (event) => {
    if (styleRequestIds.has(event.requestId)) responseExtraInfo.push(event);
  });
  await cdp.send("Network.enable");
  const failures = [];
  const requests = [];
  const responses = [];
  const regionTileZooms = [];
  page.on("request", (request) => {
    const regionTile = request.url().match(/\/maps\/regions\/[^/]+\/(\d+)\//);
    if (regionTile) regionTileZooms.push(Number(regionTile[1]));
    if (request.url().includes("/maps/default/style.json")) {
      requests.push({ method: request.method(), url: request.url(), headers: request.headers() });
    }
  });
  page.on("response", (response) => {
    if (response.url().includes("/maps/default/style.json")) {
      responses.push({ status: response.status(), url: response.url(), headers: response.headers() });
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/maps/default/style.json")) {
      failures.push({ url: request.url(), error: request.failure()?.errorText ?? null });
    }
  });
  await page.waitForLoadState("domcontentloaded");
  const fetchProbe = await page.evaluate(async () => {
    try {
      const bootstrap = await globalThis.window.__TAURI_INTERNALS__.invoke("app_bootstrap");
      const styleUrl = `${bootstrap.localAssetOrigin}/maps/default/${bootstrap.mapManifest.style}`;
      const response = await fetch(styleUrl);
      return {
        pageOrigin: globalThis.location.origin,
        styleUrl,
        ok: response.ok,
        status: response.status,
        bodyLength: (await response.text()).length,
      };
    } catch (error) {
      return { pageOrigin: globalThis.location.origin, error: String(error) };
    }
  });
  let log = "";
  const logDeadline = Date.now() + 20_000;
  while (Date.now() < logDeadline) {
    const currentLog = await readFile(logPath, "utf8").catch(() => "");
    log = currentLog
      .slice(logBefore.length)
      .split(/\r?\n/)
      .filter((line) => /FoodMap (?:0\.1\.0 started|local map bootstrap ready|local style fetched|local map style loaded|local map idle)/.test(line))
      .join("\n");
    if (log.includes("FoodMap local map style loaded") && log.includes("FoodMap local map idle")) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const canvas = page.locator(".maplibregl-canvas");
  await canvas.waitFor({ state: "visible" });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("MapLibre canvas has no visible bounds");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let step = 0; step < 14; step += 1) {
    await page.mouse.wheel(0, -1200);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const zoomedIn = await page.evaluate(async () => {
    const bootstrap = await globalThis.window.__TAURI_INTERNALS__.invoke("app_bootstrap");
    return bootstrap.lastMapView?.zoom ?? null;
  });
  for (let step = 0; step < 12; step += 1) {
    await page.mouse.wheel(0, 1200);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const zoomedOut = await page.evaluate(async () => {
    const bootstrap = await globalThis.window.__TAURI_INTERNALS__.invoke("app_bootstrap");
    return bootstrap.lastMapView?.zoom ?? null;
  });
  const cacheProposalVisible = await page
    .getByRole("heading", { name: "缓存此处周边" })
    .isVisible()
    .catch(() => false);
  const maxRequestedRegionTileZoom =
    regionTileZooms.length > 0 ? Math.max(...regionTileZooms) : null;
  const zoomProbe = {
    zoomedIn,
    zoomedOut,
    cacheProposalVisible,
    maxRequestedRegionTileZoom,
  };
  console.log(
    JSON.stringify(
      { fetchProbe, zoomProbe, requests, responses, failures, requestExtraInfo, responseExtraInfo, log },
      null,
      2,
    ),
  );
  if (!fetchProbe.ok || !log.includes("FoodMap local map style loaded") || !log.includes("FoodMap local map idle")) {
    throw new Error("desktop local-map cold-start probe failed");
  }
  if (
    !(zoomedIn > 16) ||
    !(zoomedOut < 13) ||
    cacheProposalVisible ||
    (maxRequestedRegionTileZoom !== null && maxRequestedRegionTileZoom > 14)
  ) {
    throw new Error("desktop map zoom/proposal probe failed");
  }
} finally {
  if (browser) await browser.close();
  if (child) {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await rm(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
}
